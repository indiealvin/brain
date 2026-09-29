/**
 * Mutation queue (spec §11, §52) over `queue.sqlite`.
 *
 * Holds orchestration state only; pending knowledge state is the agent
 * branch. Fixture 3.9 writes `state` directly on this table, so the shape is
 * part of the contract.
 */
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { FileWrite, Mutation, MutationState, MutationType, QueueRow, TargetPrecondition } from "./types";

export const QUEUE_SCHEMA = `
CREATE TABLE IF NOT EXISTS mutations (
  mutation_id TEXT PRIMARY KEY,
  seq INTEGER,
  state TEXT,
  type TEXT,
  summary TEXT,
  targets_json TEXT,
  writes_json TEXT,
  depends_on_json TEXT,
  replans TEXT NULL,
  evidence_json TEXT,
  reasoning TEXT NULL,
  attempt_count INTEGER,
  last_error TEXT NULL,
  commit_sha TEXT NULL,
  created_at TEXT,
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS mutations_seq ON mutations(seq);
CREATE INDEX IF NOT EXISTS mutations_state ON mutations(state);
`;

export interface StatePatch {
  lastError?: string | null;
  commitSha?: string | null;
  /** Increment attempt_count by this much (default 0). */
  attemptInc?: number;
}

interface DbRow {
  mutation_id: string;
  seq: number;
  state: string;
  type: string;
  summary: string;
  targets_json: string;
  writes_json: string;
  depends_on_json: string;
  replans: string | null;
  evidence_json: string;
  reasoning: string | null;
  attempt_count: number;
  last_error: string | null;
  commit_sha: string | null;
  created_at: string;
  updated_at: string;
}

function toRow(r: DbRow): QueueRow {
  const row: QueueRow = {
    mutationId: r.mutation_id,
    state: r.state as MutationState,
    type: r.type as MutationType,
    targets: JSON.parse(r.targets_json) as TargetPrecondition[],
    dependsOn: JSON.parse(r.depends_on_json) as string[],
    attemptCount: r.attempt_count,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    seq: r.seq,
  };
  if (r.replans !== null) row.replans = r.replans;
  if (r.last_error !== null) row.lastError = r.last_error;
  if (r.commit_sha !== null) row.commitSha = r.commit_sha;
  return row;
}

function toMutation(r: DbRow): Mutation {
  const m: Mutation = {
    mutationId: r.mutation_id,
    type: r.type as MutationType,
    summary: r.summary,
    targets: JSON.parse(r.targets_json) as TargetPrecondition[],
    writes: JSON.parse(r.writes_json) as FileWrite[],
    dependsOn: JSON.parse(r.depends_on_json) as string[],
    evidence: JSON.parse(r.evidence_json) as string[],
  };
  if (r.replans !== null) m.replans = r.replans;
  if (r.reasoning !== null) m.reasoning = r.reasoning;
  return m;
}

export class Queue {
  private readonly db: Database;
  private readonly now: () => string;

  constructor(dbPath: string, opts: { now?: () => string } = {}) {
    if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec(QUEUE_SCHEMA);
    this.now = opts.now ?? (() => new Date().toISOString());
  }

  /** Insert as QUEUED with seq = max+1. No-op when the id already exists. */
  enqueue(mutation: Mutation): void {
    const ts = this.now();
    const tx = this.db.transaction(() => {
      const existing = this.db.query("SELECT 1 FROM mutations WHERE mutation_id = ?").get(mutation.mutationId);
      if (existing) return;
      const max = this.db.query("SELECT COALESCE(MAX(seq), 0) AS m FROM mutations").get() as { m: number };
      this.db
        .query(
          `INSERT INTO mutations (mutation_id, seq, state, type, summary, targets_json, writes_json, depends_on_json,
             replans, evidence_json, reasoning, attempt_count, last_error, commit_sha, created_at, updated_at)
           VALUES (?, ?, 'QUEUED', ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, NULL, ?, ?)`,
        )
        .run(
          mutation.mutationId,
          max.m + 1,
          mutation.type,
          mutation.summary,
          JSON.stringify(mutation.targets),
          JSON.stringify(mutation.writes),
          JSON.stringify(mutation.dependsOn ?? []),
          mutation.replans ?? null,
          JSON.stringify(mutation.evidence ?? []),
          mutation.reasoning ?? null,
          ts,
          ts,
        );
    });
    tx();
  }

  private raw(id: string): DbRow | undefined {
    return (this.db.query("SELECT * FROM mutations WHERE mutation_id = ?").get(id) as DbRow | null) ?? undefined;
  }

  get(id: string): QueueRow | undefined {
    const r = this.raw(id);
    return r ? toRow(r) : undefined;
  }

  /** The stored mutation with its materialized writes. */
  getMutation(id: string): Mutation | undefined {
    const r = this.raw(id);
    return r ? toMutation(r) : undefined;
  }

  list(): QueueRow[] {
    const rows = this.db.query("SELECT * FROM mutations ORDER BY seq ASC").all() as DbRow[];
    return rows.map(toRow);
  }

  listByState(states: MutationState[]): QueueRow[] {
    if (states.length === 0) return [];
    const placeholders = states.map(() => "?").join(", ");
    const rows = this.db
      .query(`SELECT * FROM mutations WHERE state IN (${placeholders}) ORDER BY seq ASC`)
      .all(...states) as DbRow[];
    return rows.map(toRow);
  }

  /**
   * Transition `id` to `state`. `lastError`/`commitSha`: undefined keeps the
   * stored value, null clears it, a string replaces it.
   */
  setState(id: string, state: MutationState, patch: StatePatch = {}): void {
    const sets: string[] = ["state = ?", "updated_at = ?"];
    const args: (string | number | null)[] = [state, this.now()];
    if (patch.lastError !== undefined) {
      sets.push("last_error = ?");
      args.push(patch.lastError);
    }
    if (patch.commitSha !== undefined) {
      sets.push("commit_sha = ?");
      args.push(patch.commitSha);
    }
    if (patch.attemptInc) {
      sets.push("attempt_count = attempt_count + ?");
      args.push(patch.attemptInc);
    }
    args.push(id);
    const r = this.db.query(`UPDATE mutations SET ${sets.join(", ")} WHERE mutation_id = ?`).run(...args);
    if (r.changes === 0) throw new Error(`queue: unknown mutation ${id}`);
  }

  close(): void {
    this.db.close();
  }
}

export function openQueue(dbPath: string, opts: { now?: () => string } = {}): Queue {
  return new Queue(dbPath, opts);
}
