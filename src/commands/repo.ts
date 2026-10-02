/**
 * Service layer, repo and engine (CR-2; docs/mac-app/design.md §3): the open
 * sequence, `init`, `status`, the pending-integration paths (CR-4), one
 * Human Sync pass and one drain + integrate.
 *
 * Every function returns data. The adapters (src/cli.ts, later src/rpc/)
 * parse arguments, format output and map errors; no behaviour lives in only
 * one of them.
 */
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { openCoordinator, type ProposalsChangedListener } from "../core/coordinator";
import type { ExecutionResult, IntegrationResult, MutationState, ReconcileResult, RepoCoordinator, SyncResult } from "../core/types";
import { fastForwardAgentToMain, pendingIntegration, type PendingIntegration } from "../git/worktree";
import { indexedCommitOf, openIndex } from "../index/schema";
import { CONFIG_FILE, initKnowledgeRepo } from "../markdown/repo";
import { withRepoWorktreeLock } from "../sync/lock";
import { ServiceError } from "./errors";

// ---------------------------------------------------------------------------
// repo resolution and the open sequence
// ---------------------------------------------------------------------------

/** Walk up from `start` to the first directory containing brain.toml. */
export function findRepoRoot(start: string): string | null {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, CONFIG_FILE))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * `drainQueued` (execute every QUEUED mutation, then integrate) and
 * `onProposalsChanged` (this process's proposal writes, for the RPC
 * server's `proposals.changed`) are implemented by the concrete coordinator
 * but are not part of the read-only `RepoCoordinator` seam, so the open
 * sequence checks for them at runtime.
 */
export type Coord = RepoCoordinator & {
  drainQueued(): Promise<ExecutionResult[]>;
  onProposalsChanged(listener: ProposalsChangedListener): () => void;
};

export interface OpenedRepo {
  coord: Coord;
  /** The open sequence's reconcile to agent HEAD (§17 step 5). */
  reconciled: ReconcileResult;
}

/**
 * Open + recover (§17) the knowledge repo at `repoDir` (already resolved by
 * the caller). Callers must `close()` in a finally.
 *
 * After recovery, when `main` moved ahead of `agent/repo` and the agent branch
 * has nothing un-integrated (zero-pending rebuild, §13), the agent branch is
 * fast-forwarded so the index (step 5) reflects the human's latest commits.
 * `fastForwardAgentToMain` is a no-op otherwise; a real rebuild happens in
 * `integrate`.
 *
 * Each step takes the worktree lock on its own, one after the other (CR-1):
 * `recover()` and `reconcileIndex()` inside the coordinator, the fast-forward
 * here. None of them runs inside another, so the lock is never nested.
 */
export async function openRepo(repoDir: string): Promise<OpenedRepo> {
  const opened = await openCoordinator(repoDir);
  for (const method of ["drainQueued", "onProposalsChanged"] as const) {
    if (typeof (opened as Partial<Coord>)[method] !== "function") {
      await opened.close();
      throw new ServiceError("INTERNAL", `coordinator does not implement ${method}()`);
    }
  }
  const coord = opened as Coord;
  try {
    await coord.recover();
    await withRepoWorktreeLock(coord.paths.runtimeDir, async () => void fastForwardAgentToMain(coord.paths));
    const reconciled = await coord.reconcileIndex();
    return { coord, reconciled };
  } catch (e) {
    await coord.close();
    throw e;
  }
}

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------

/** `brain init` / `repo.init` (protocol.md §3). */
export interface RepoInitResult {
  path: string;
  repoId: string;
  createdConfig: boolean;
  createdRepo: boolean;
  written: string[];
  commitSha?: string;
}

/** Create or repair the knowledge repo at `dir`. Needs no open coordinator. */
export function initRepo(dir: string): RepoInitResult {
  const r = initKnowledgeRepo(dir);
  return { path: r.path, repoId: r.config.repoId, createdConfig: r.createdConfig, createdRepo: r.createdRepo, written: r.written, commitSha: r.commitSha };
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

/** Every `MutationState`, in lifecycle order; `RepoStatus.queue` has a count for each. */
export const QUEUE_STATES: readonly MutationState[] = [
  "QUEUED",
  "RUNNING",
  "COMMITTED",
  "INTEGRATED",
  "NOOP",
  "REPLAN",
  "BLOCKED",
  "FAILED_INVALID_EXECUTION",
  "FAILED",
];

/** `brain status` / `repo.status` (protocol.md §7). */
export interface RepoStatus {
  repo: string;
  repoId: string;
  stateDir: string;
  mainHead: string;
  agentHead: string;
  /** A count for every `MutationState` (0 when none), keys in `QUEUE_STATES` order. */
  queue: Record<MutationState, number>;
  /** Advisory: read without the worktree lock and without a staleness refresh (protocol.md §5). */
  pendingProposals: number;
  indexedCommit: string | null;
}

/**
 * Number of PENDING proposals in `proposals.sqlite`, read on a read-only
 * connection that takes no lock (0 when the file does not exist yet).
 *
 * Advisory (protocol.md §5): it skips the staleness refresh that
 * `listProposals()` runs under the worktree lock, so it never waits behind a
 * long execute or integrate, and it can briefly include a proposal that the
 * next refresh marks STALE.
 */
export function pendingProposalCount(proposalsDb: string): number {
  if (!existsSync(proposalsDb)) return 0;
  const db = new Database(proposalsDb, { readonly: true });
  try {
    db.exec("PRAGMA busy_timeout = 5000;");
    return (db.query("SELECT COUNT(*) AS n FROM proposals WHERE status = 'PENDING'").get() as { n: number }).n;
  } finally {
    db.close();
  }
}

/** Heads, queue counts, the advisory pending-proposal count and the indexed commit. Takes no lock. */
export async function repoStatus(coord: RepoCoordinator): Promise<RepoStatus> {
  const [main, agent, rows] = await Promise.all([coord.mainHead(), coord.agentHead(), coord.listMutations()]);
  const queue = Object.fromEntries(QUEUE_STATES.map((s) => [s, 0])) as Record<MutationState, number>;
  for (const r of rows) queue[r.state] = (queue[r.state] ?? 0) + 1;
  const pending = pendingProposalCount(coord.paths.proposalsDb);
  const db = openIndex(coord.paths.indexDb);
  let indexed: string | null;
  try {
    indexed = indexedCommitOf(db);
  } finally {
    db.close();
  }
  return { repo: coord.paths.userWorktree, repoId: coord.config.repoId, stateDir: coord.paths.stateDir, mainHead: main, agentHead: agent, queue, pendingProposals: pending, indexedCommit: indexed };
}

/**
 * The paths that differ between `main` and agent HEAD, with both heads (CR-4;
 * `repo.pendingIntegration`, docs/mac-app/protocol.md §4). Takes no lock.
 */
export function repoPendingIntegration(coord: RepoCoordinator): PendingIntegration {
  return pendingIntegration(coord.paths);
}
export type { PendingIntegration };

// ---------------------------------------------------------------------------
// engine: human sync, drain + integrate
// ---------------------------------------------------------------------------

/** One Human Sync pass: commit quiescent edits on main. */
export function syncOnce(coord: RepoCoordinator, now: number = Date.now()): Promise<SyncResult> {
  return coord.syncOnce(now);
}

export interface IntegrateResult {
  drained: ExecutionResult[];
  integration: IntegrationResult;
}

/** Execute every QUEUED mutation, then fast-forward main. */
export async function integrate(coord: Coord): Promise<IntegrateResult> {
  const drained = await coord.drainQueued();
  const integration = await coord.integrate();
  return { drained, integration };
}
