/**
 * Proposal store (spec §33–34, §51; I-19, I-20) over `proposals.sqlite`.
 *
 * Holds proposal-only operations awaiting a human decision. Staleness is
 * content-addressed: every target carries the blob hash it was proposed
 * against, and any target whose current blob differs (or is missing) marks
 * the proposal STALE. Rejections persist as negative evidence.
 *
 * Decisions are compare-and-set (§34; CR-1, docs/mac-app/design.md §5.2):
 * `decide` names the status it expects and updates only while that status
 * still holds, so an accept and a reject of one proposal can never both
 * take effect.
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

/** Error code for a decision on a proposal that does not exist (protocol.md §4). */
export const UNKNOWN_PROPOSAL = "UNKNOWN_PROPOSAL";
/** Error code for a reject of a proposal that is no longer PENDING (protocol.md §4; CR-1). */
export const PROPOSAL_NOT_PENDING = "PROPOSAL_NOT_PENDING";

/** No proposal has this id. */
export class UnknownProposalError extends Error {
  readonly code = UNKNOWN_PROPOSAL;
  readonly proposalId: string;
  constructor(proposalId: string) {
    super(`unknown proposal ${proposalId}`);
    this.name = "UnknownProposalError";
    this.proposalId = proposalId;
  }
}

/**
 * A reject found the proposal no longer PENDING: another decision (an
 * accept, a reject, or a staleness mark) took effect first. `status` is the
 * status it found. Adapters map it to `PROPOSAL_NOT_PENDING`.
 */
export class ProposalNotPendingError extends Error {
  readonly code = PROPOSAL_NOT_PENDING;
  readonly proposalId: string;
  readonly status: ProposalStatus;
  constructor(proposalId: string, status: ProposalStatus) {
    super(`proposal ${proposalId} is already ${status} (${PROPOSAL_NOT_PENDING})`);
    this.name = "ProposalNotPendingError";
    this.proposalId = proposalId;
    this.status = status;
  }
}

/**
 * The decisions `decide` allows (design §5.2): every PENDING decision, and
 * ACCEPTED → STALE when the accepted mutation cannot apply.
 */
function allowedDecision(from: ProposalStatus, to: ProposalDecision): boolean {
  if (from === "PENDING") return to === "ACCEPTED" || to === "REJECTED" || to === "STALE";
  return from === "ACCEPTED" && to === "STALE";
}

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

  /** Insert the proposal as given. No-op when the id already exists. Returns true when it inserted. */
  create(p: Proposal): boolean {
    const r = this.db
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
    return r.changes > 0;
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
   * Compare-and-set decision: move proposal `id` from status `from` to `to`
   * only if it is still `from` (`UPDATE … WHERE status = ?`). Returns true
   * when the decision took effect, false when the proposal is in another
   * status (a lost compare-and-set; nothing is written). Throws
   * `UnknownProposalError` for an unknown id. Allowed: PENDING → ACCEPTED /
   * REJECTED / STALE, and ACCEPTED → STALE. `decisionNote` is kept when
   * omitted.
   */
  decide(id: string, from: "PENDING", to: ProposalDecision, opts?: DecideOptions): boolean;
  decide(id: string, from: "ACCEPTED", to: "STALE", opts?: DecideOptions): boolean;
  decide(id: string, from: ProposalStatus, to: ProposalDecision, opts: DecideOptions = {}): boolean {
    if (!allowedDecision(from, to)) throw new Error(`proposals: ${from} → ${to} is not an allowed decision`);
    const sets = ["status = ?", "resolved_at = ?"];
    const args: (string | null)[] = [to, opts.resolvedAt ?? this.now()];
    if (opts.decisionNote !== undefined) {
      sets.push("decision_note = ?");
      args.push(opts.decisionNote);
    }
    args.push(id, from);
    const r = this.db.query(`UPDATE proposals SET ${sets.join(", ")} WHERE proposal_id = ? AND status = ?`).run(...args);
    if (r.changes > 0) return true;
    if (!this.get(id)) throw new UnknownProposalError(id);
    return false;
  }

  /**
   * I-19: every PENDING proposal with a target whose current blob differs
   * from its snapshot (a missing file counts) is marked STALE. Returns the
   * ids marked.
   */
  refreshStaleness(currentBlob: (path: string) => string | null): string[] {
    const marked: string[] = [];
    for (const p of this.list("PENDING")) {
      // Compare-and-set: a proposal decided since the list was read keeps that decision.
      if (p.targets.some((t) => currentBlob(t.path) !== t.blobHash) && this.decide(p.proposalId, "PENDING", "STALE")) {
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
