/**
 * Proposal store (spec §33–34, §51; I-19, I-20) over `proposals.sqlite`.
 *
 * Holds proposal-only operations awaiting a human decision. Staleness is
 * content-addressed: every target carries the blob hash it was proposed
 * against, and any target whose current blob differs (or is missing) marks
 * the proposal STALE. Rejections persist as negative evidence.
 */
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { FileWrite, Proposal, ProposalStatus, ProposalTargetSnapshot } from "../core/types";

export const PROPOSALS_SCHEMA = `
CREATE TABLE IF NOT EXISTS proposals (
  proposal_id TEXT PRIMARY KEY,
  mutation_id TEXT,
  operation TEXT,
  targets_json TEXT,
  writes_json TEXT,
  evidence_json TEXT,
  reasoning TEXT,
  created_at TEXT,
  status TEXT,
  resolved_at TEXT NULL,
  decision_note TEXT NULL
);
CREATE INDEX IF NOT EXISTS proposals_status ON proposals(status);
`;

export type ProposalDecision = Extract<ProposalStatus, "ACCEPTED" | "REJECTED" | "STALE">;

export interface DecideOptions {
  decisionNote?: string;
  resolvedAt?: string;
}

interface DbRow {
  proposal_id: string;
  mutation_id: string;
  operation: string;
  targets_json: string;
  writes_json: string;
  evidence_json: string;
  reasoning: string;
  created_at: string;
  status: string;
  resolved_at: string | null;
  decision_note: string | null;
}

function toProposal(r: DbRow): Proposal {
  const p: Proposal = {
    proposalId: r.proposal_id,
    mutationId: r.mutation_id,
    operation: r.operation as Proposal["operation"],
    targets: JSON.parse(r.targets_json) as ProposalTargetSnapshot[],
    writes: JSON.parse(r.writes_json) as FileWrite[],
    evidence: JSON.parse(r.evidence_json) as string[],
    reasoning: r.reasoning,
    createdAt: r.created_at,
    status: r.status as ProposalStatus,
  };
  if (r.resolved_at !== null) p.resolvedAt = r.resolved_at;
  if (r.decision_note !== null) p.decisionNote = r.decision_note;
  return p;
}

export class ProposalStore {
  private readonly db: Database;
  private readonly now: () => string;

  constructor(dbPath: string, opts: { now?: () => string } = {}) {
    if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec(PROPOSALS_SCHEMA);
    this.now = opts.now ?? (() => new Date().toISOString());
  }

  /** Insert the proposal as given. No-op when the id already exists. */
  create(p: Proposal): void {
    this.db
      .query(
        `INSERT OR IGNORE INTO proposals (proposal_id, mutation_id, operation, targets_json, writes_json, evidence_json,
           reasoning, created_at, status, resolved_at, decision_note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        p.proposalId,
        p.mutationId,
        p.operation,
        JSON.stringify(p.targets),
        JSON.stringify(p.writes),
        JSON.stringify(p.evidence ?? []),
        p.reasoning ?? "",
        p.createdAt,
        p.status,
        p.resolvedAt ?? null,
        p.decisionNote ?? null,
      );
  }

  get(id: string): Proposal | undefined {
    const r = this.db.query("SELECT * FROM proposals WHERE proposal_id = ?").get(id) as DbRow | null;
    return r ? toProposal(r) : undefined;
  }

  /** All proposals (or those in `status`), oldest first. */
  list(status?: ProposalStatus): Proposal[] {
    const rows = (
      status === undefined
        ? this.db.query("SELECT * FROM proposals ORDER BY created_at ASC, proposal_id ASC").all()
        : this.db.query("SELECT * FROM proposals WHERE status = ? ORDER BY created_at ASC, proposal_id ASC").all(status)
    ) as DbRow[];
    return rows.map(toProposal);
  }

  /**
   * Resolve a proposal. No from-status guard: an ACCEPTED proposal whose
   * execution fails its snapshot preconditions becomes STALE (§34).
   * `decisionNote` is kept when omitted.
   */
  decide(id: string, status: ProposalDecision, opts: DecideOptions = {}): void {
    const sets = ["status = ?", "resolved_at = ?"];
    const args: (string | null)[] = [status, opts.resolvedAt ?? this.now()];
    if (opts.decisionNote !== undefined) {
      sets.push("decision_note = ?");
      args.push(opts.decisionNote);
    }
    args.push(id);
    const r = this.db.query(`UPDATE proposals SET ${sets.join(", ")} WHERE proposal_id = ?`).run(...args);
    if (r.changes === 0) throw new Error(`proposals: unknown proposal ${id}`);
  }

  /**
   * I-19: every PENDING proposal with a target whose current blob differs
   * from its snapshot (a missing file counts) is marked STALE. Returns the
   * ids marked.
   */
  refreshStaleness(currentBlob: (path: string) => string | null): string[] {
    const marked: string[] = [];
    for (const p of this.list("PENDING")) {
      if (p.targets.some((t) => currentBlob(t.path) !== t.blobHash)) {
        this.decide(p.proposalId, "STALE");
        marked.push(p.proposalId);
      }
    }
    return marked;
  }

  /** I-20: REJECTED proposals touching any of `noteIds`, oldest first. */
  negativeEvidenceFor(noteIds: string[]): Proposal[] {
    if (noteIds.length === 0) return [];
    const ids = new Set(noteIds);
    return this.list("REJECTED").filter((p) => p.targets.some((t) => ids.has(t.noteId)));
  }

  close(): void {
    this.db.close();
  }
}

export function openProposalStore(dbPath: string, opts: { now?: () => string } = {}): ProposalStore {
  return new ProposalStore(dbPath, opts);
}
