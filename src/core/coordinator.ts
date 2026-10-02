/**
 * RepoCoordinator (spec §21.1, §12, §15, §16, §17). Single entry point per
 * knowledge repo; fixtures drive the engine through this interface.
 *
 * Locking model (spec §12, I-11; CR-1, docs/mac-app/design.md §5.2): every
 * public method that writes — `submit`, `execute`, `drainQueued`,
 * `integrate`, `rebuild`, `syncOnce`, `recover`, `reconcileIndex`,
 * `acceptProposal`, `rejectProposal` and `listProposals` (it writes STALE
 * marks) — runs through `exclusive()`: the in-process mutex (`Serial`) first,
 * then the cross-process RepoWorktreeLock, taken exactly once at the top.
 * Everything those methods call (`*Unlocked`, `integrateOnce`,
 * `rebuildAgentBranch`, `executeMutation`, Human Sync) runs without taking
 * either lock, so neither is ever nested. `exclusive()` refuses to start
 * inside a section that already holds the worktree lock: the nested call
 * would otherwise wait on the mutex (or the lock) forever.
 *
 * Outside the lock on purpose: `enqueue` and `submitProposal` (single inserts
 * that never touch a worktree, design §5.2), and the read-only queries.
 * `openCoordinator` takes the lock once, around `ensureAgentWorktree`.
 *
 * Proposals (§33–34) live in the proposal store; an accepted proposal
 * re-enters the queue as a mutation whose preconditions are its snapshots.
 * Every decision is a compare-and-set on the proposal's status, made inside
 * the locked section that checked it (CR-1), so of a concurrent accept and
 * reject of one proposal, in any two processes, exactly one takes effect.
 *
 * Recovery (§17) runs at startup (`recover()`) and again at the start of
 * every `drainQueued`, inside the drain's one locked section (CR-1, design
 * §5.2). Execution holds the worktree lock from start to finish, so a lock
 * holder knows every `RUNNING` row it sees was left by a dead process. Both
 * end with accept reconciliation (§17 step 6): an ACCEPTED proposal with no
 * queue row (a crash between the ACCEPTED write and the enqueue) gets the
 * same mutation rebuilt, enqueued, executed and integrated; one whose row is
 * `REPLAN` becomes STALE. Every proposal staleness refresh runs that second
 * check too.
 */
import { mkdirSync } from "node:fs";
import { basename } from "node:path";
import { AGENT_BRANCH } from "./types";
import type {
  BrainConfig,
  Clock,
  ExecutionResult,
  IntegrationResult,
  Mutation,
  Proposal,
  QueueRow,
  RebuildResult,
  ReconcileResult,
  RepoCoordinator,
  RepoPaths,
  SyncResult,
} from "./types";
import { repoPaths } from "./brainHome";
import { executeMutation } from "./executor";
import { integrateOnce, mainMoved } from "./integrate";
import { openQueue, type Queue } from "./queue";
import { openProposalStore, ProposalNotPendingError, UnknownProposalError, type ProposalStore } from "../proposal/store";
import { rebuildAgentBranch } from "./rebuild";
import { isClean, logGrepTrailer } from "../git/git";
import { agentHead, ensureAgentWorktree, fastForwardAgentToMain, mainHead, resetAgentWorktree } from "../git/worktree";
import { loadConfig } from "../markdown/repo";
import { parseNote } from "../markdown/parse";
import { serializeNote } from "../markdown/serialize";
import { slugKey } from "./slug";
import { mutationId as newMutationId } from "./ids";
import { blobAt, showFile } from "../git/git";
import { reconcileIndex as reconcileIndexFiles } from "../index/reconcile";
import { syncOnce as humanSyncOnce } from "../sync/humanSync";
import { assertLockNotHeldInThisChain, withRepoWorktreeLock, WORKTREE_LOCK } from "../sync/lock";

/**
 * Test-only crash hook (CR-1 acceptance test 4, docs/mac-app/design.md §5.2:
 * "a delay or crash hook used only in tests is acceptable"). When set to `1`,
 * `acceptProposal` SIGKILLs its own process right after the PENDING →
 * ACCEPTED compare-and-set and before the enqueue: the one point where an
 * accept is recorded in `proposals.sqlite` but has no row in `queue.sqlite`,
 * which accept reconciliation (spec §17 step 6) repairs. Nothing runs after
 * the kill (no `finally`, no lock release; the kernel drops the lock), as in a
 * real crash. Unset in production.
 */
export const ACCEPT_CRASH_ENV = "BRAIN_TEST_CRASH_AFTER_ACCEPT";

function crashAfterAcceptForTests(): void {
  if (process.env[ACCEPT_CRASH_ENV] === "1") process.kill(process.pid, "SIGKILL"); // test-only, see ACCEPT_CRASH_ENV
}

/**
 * The mutation an accepted proposal runs as (§34): its preconditions are the
 * proposal's target snapshots. `acceptProposal` and accept reconciliation
 * (§17 step 6) both build it here, so a reconciled accept runs exactly the
 * mutation the interrupted accept would have: same `mutationId`, writes,
 * preconditions, type, summary, evidence and reasoning.
 */
function mutationFromProposal(p: Proposal): Mutation {
  return {
    mutationId: p.mutationId,
    type: p.operation,
    summary: `${p.operation.toLowerCase()} ${p.targets.map((t) => basename(t.path)).join(", ")}`,
    targets: p.targets.map((t) => ({ kind: "present", noteId: t.noteId, path: t.path, blobHash: t.blobHash })),
    writes: p.writes,
    dependsOn: [],
    evidence: p.evidence,
    reasoning: p.reasoning,
  };
}

/** In-process single-writer mutex: serializes every locked public method (see `exclusive`). */
class Serial {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn);
    this.tail = next.catch(() => undefined);
    return next;
  }
}

class Coordinator implements RepoCoordinator {
  readonly paths: RepoPaths;
  readonly config: BrainConfig;
  readonly clock: Clock;
  private readonly queue: Queue;
  private readonly proposals: ProposalStore;
  private readonly mutex = new Serial();

  constructor(paths: RepoPaths, config: BrainConfig, queue: Queue, proposals: ProposalStore, clock: Clock) {
    this.paths = paths;
    this.config = config;
    this.queue = queue;
    this.proposals = proposals;
    this.clock = clock;
  }

  /**
   * The single-writer section of every public write (CR-1): the in-process
   * mutex, then the cross-process worktree lock, then `fn`. Called only at the
   * top of a public method, never from inside one: a call from a section that
   * already holds the lock throws `LockReentryError` at once, since it would
   * otherwise wait forever on the mutex that its own caller is running in.
   */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    try {
      assertLockNotHeldInThisChain(this.paths.runtimeDir, WORKTREE_LOCK);
    } catch (e) {
      return Promise.reject(e);
    }
    return this.mutex.run(() => withRepoWorktreeLock(this.paths.runtimeDir, fn));
  }

  // -- rebuild (§13) --------------------------------------------------------

  /** Caller holds the worktree lock. */
  private rebuildUnlocked(): Promise<RebuildResult> {
    return rebuildAgentBranch({ paths: this.paths, queue: this.queue });
  }

  /**
   * Bring `agent/repo` up to date with `main` before executing: with no
   * un-integrated commits this is a plain move (zero-pending rebuild);
   * otherwise the pending mutations are replayed. Caller holds the worktree lock.
   */
  private async catchUpAgentBranch(): Promise<void> {
    if (!mainMoved(this.paths)) return;
    if (this.queue.listByState(["COMMITTED"]).length === 0) {
      fastForwardAgentToMain(this.paths);
      if (!mainMoved(this.paths)) return;
    }
    await this.rebuildUnlocked();
  }

  // -- execution (§12) ------------------------------------------------------

  /** Caller holds the worktree lock. */
  private async executeUnlocked(mutationId: string): Promise<ExecutionResult> {
    if (!isClean(this.paths.agentWorktree)) resetAgentWorktree(this.paths);
    await this.catchUpAgentBranch();
    return executeMutation(
      { paths: this.paths, queue: this.queue, afterCommit: async () => void (await this.reconcileIndexUnlocked()) },
      mutationId,
    );
  }

  async execute(mutationId: string): Promise<ExecutionResult> {
    return this.exclusive(() => this.executeUnlocked(mutationId));
  }

  async submit(mutation: Mutation): Promise<ExecutionResult> {
    return this.exclusive(async () => {
      this.queue.enqueue(mutation);
      const r = await this.executeUnlocked(mutation.mutationId);
      if (r.state === "COMMITTED") await this.integrateUnlocked();
      const row = this.queue.get(mutation.mutationId);
      return row ? { ...r, state: row.state, commitSha: row.commitSha ?? r.commitSha } : r;
    });
  }

  // -- integration (§15) ----------------------------------------------------

  /** Caller holds the worktree lock. */
  private integrateUnlocked(): Promise<IntegrationResult> {
    return integrateOnce({
      paths: this.paths,
      config: this.config,
      queue: this.queue,
      clock: this.clock,
      afterIntegrate: async () => void (await this.reconcileIndexUnlocked()),
    });
  }

  // -- index projection (§41–43) --------------------------------------------

  /**
   * Reconcile the index to agent HEAD. A human rename (same id, new path)
   * enqueues an automatic ADD_ALIAS of the old slug (§21) unless the note
   * already carries it. The mutation is only queued; it executes on the next
   * execute()/submit() or via drainQueued(). Caller holds the worktree lock.
   */
  private async reconcileIndexUnlocked(): Promise<ReconcileResult> {
    const head = agentHead(this.paths);
    const result = await reconcileIndexFiles(this.paths, this.config.repoId, head);
    for (const r of result.renames) {
      const raw = showFile(this.paths.agentWorktree, head, r.newPath);
      if (raw === null) continue;
      let note;
      try {
        note = parseNote(r.newPath, raw);
      } catch {
        continue;
      }
      const oldKey = slugKey(r.oldSlug);
      if (note.slugKey === oldKey || note.frontmatter.aliases.some((a) => slugKey(a) === oldKey)) continue;
      const alreadyQueued = this.queue
        .listByState(["QUEUED", "RUNNING", "COMMITTED"])
        .some((row) => row.type === "ADD_ALIAS" && row.targets.some((t) => t.kind === "present" && t.noteId === r.noteId));
      if (alreadyQueued) continue;
      note.frontmatter.aliases = [...note.frontmatter.aliases, r.oldSlug];
      const blob = blobAt(this.paths.agentWorktree, head, r.newPath);
      if (!blob) continue;
      this.queue.enqueue({
        mutationId: newMutationId(),
        type: "ADD_ALIAS",
        summary: `alias ${r.oldSlug} for renamed note ${note.slug}`,
        targets: [{ kind: "present", noteId: r.noteId, path: r.newPath, blobHash: blob }],
        writes: [{ path: r.newPath, content: serializeNote(note) }],
        dependsOn: [],
        evidence: [`git://rename/${r.oldPath}->${r.newPath}`],
        reasoning: "human rename detected by index reconcile (§21)",
      });
    }
    return result;
  }

  /**
   * Recover (§17 steps 1, 2, 4 and 6), then execute every QUEUED mutation in
   * seq order, then integrate when anything committed. All in one locked
   * section (CR-1), so a `RUNNING` row or a dirty agent worktree left by a
   * process that died is resolved by the next drain in any process, without
   * a restart. Returns every execution this drain ran: recovery's
   * re-executions and reconciled accepts first, then the QUEUED rows.
   */
  async drainQueued(): Promise<ExecutionResult[]> {
    return this.exclusive(async () => {
      const out = await this.recoverUnlocked({ reconcileIndex: false });
      for (const row of this.queue.listByState(["QUEUED"])) out.push(await this.executeUnlocked(row.mutationId));
      if (out.some((r) => r.state === "COMMITTED")) await this.integrateUnlocked();
      return out;
    });
  }

  async integrate(): Promise<IntegrationResult> {
    return this.exclusive(() => this.integrateUnlocked());
  }

  async rebuild(): Promise<RebuildResult> {
    return this.exclusive(() => this.rebuildUnlocked());
  }

  // -- human sync (§16) -----------------------------------------------------

  /** `now` defaults to the clock once the lock is held, so quiescence is judged at commit time. */
  async syncOnce(now?: number): Promise<SyncResult> {
    return this.exclusive(() => humanSyncOnce(this.paths, this.config, now ?? this.clock.now()));
  }

  // -- recovery (§17) -------------------------------------------------------

  /**
   * Crash recovery (§17), shared by `recover()` (startup) and the start of
   * every `drainQueued`. Caller holds the worktree lock, so no other process
   * is executing: every `RUNNING` row is a dead holder's (CR-1). Steps, in
   * order:
   * 1. a dirty agent worktree is reset to `agent/repo` (I-12);
   * 2. a `RUNNING` row whose `Mutation-ID` is on `agent/repo` becomes
   *    COMMITTED; any other is re-executed (I-7);
   * 4. `BLOCKED` rows become `REPLAN` (step 3: `REPLAN` is never replayed);
   * 5. only when `reconcileIndex` (startup): the index projects agent HEAD;
   * 6. accept reconciliation (`reconcileAcceptsUnlocked`).
   * Integration is left to the caller, except for reconciled accepts. Returns
   * the executions run in steps 2 and 6.
   */
  private async recoverUnlocked(opts: { reconcileIndex: boolean }): Promise<ExecutionResult[]> {
    if (!isClean(this.paths.agentWorktree)) resetAgentWorktree(this.paths);
    const out: ExecutionResult[] = [];
    for (const row of this.queue.listByState(["RUNNING"])) {
      const shas = logGrepTrailer(this.paths.agentWorktree, AGENT_BRANCH, "Mutation-ID", row.mutationId);
      if (shas.length > 0) {
        this.queue.setState(row.mutationId, "COMMITTED", { commitSha: shas[0]!, lastError: null });
      } else {
        out.push(await this.executeUnlocked(row.mutationId));
      }
    }
    for (const row of this.queue.listByState(["BLOCKED"])) {
      this.queue.setState(row.mutationId, "REPLAN", { lastError: row.lastError ?? "BLOCKED: dependency invalidated" });
    }
    if (opts.reconcileIndex) await this.reconcileIndexUnlocked();
    out.push(...(await this.reconcileAcceptsUnlocked()));
    return out;
  }

  /**
   * Accept reconciliation (§17 step 6; design §5.2 "An accept completes after
   * a crash"). Each ACCEPTED proposal is matched to its queue row by its
   * stable `mutationId`:
   * - no row (the accept crashed between the ACCEPTED write and the enqueue):
   *   the same mutation is rebuilt and run as `acceptProposal` runs it —
   *   enqueued, executed, integrated, or STALE on `REPLAN`;
   * - row in `REPLAN`: the proposal becomes STALE;
   * - any other state: nothing to do.
   * Idempotent: `enqueue` is a no-op for an existing id, and a mutation whose
   * commit is already on `agent/repo` is recognised by its trailer. Caller
   * holds the worktree lock. Returns the executions it ran.
   */
  private async reconcileAcceptsUnlocked(): Promise<ExecutionResult[]> {
    const out: ExecutionResult[] = [];
    for (const p of this.proposals.list("ACCEPTED")) {
      if (this.queue.get(p.mutationId) === undefined) out.push(await this.runAcceptedUnlocked(p));
    }
    this.staleReplannedAccepts();
    return out;
  }

  /**
   * ACCEPTED → STALE for every accepted proposal whose mutation reached
   * `REPLAN`: at execution, or later when a rebuild invalidated it before it
   * integrated (§34 as amended by CR-1). Caller holds the worktree lock.
   * Returns the ids marked.
   */
  private staleReplannedAccepts(): string[] {
    const marked: string[] = [];
    for (const p of this.proposals.list("ACCEPTED")) {
      if (this.queue.get(p.mutationId)?.state !== "REPLAN") continue;
      if (this.proposals.decide(p.proposalId, "ACCEPTED", "STALE", { resolvedAt: this.nowIso() })) marked.push(p.proposalId);
    }
    return marked;
  }

  /** Startup recovery: §17 steps 1–6, after making sure the agent worktree exists. */
  async recover(): Promise<void> {
    await this.exclusive(async () => {
      ensureAgentWorktree(this.paths);
      await this.recoverUnlocked({ reconcileIndex: true });
    });
  }

  // -- queue ----------------------------------------------------------------

  async getMutation(mutationId: string): Promise<QueueRow | undefined> {
    return this.queue.get(mutationId);
  }

  async listMutations(): Promise<QueueRow[]> {
    return this.queue.list();
  }

  async enqueue(mutation: Mutation): Promise<void> {
    this.queue.enqueue(mutation);
  }

  async mainHead(): Promise<string> {
    return mainHead(this.paths);
  }

  async agentHead(): Promise<string> {
    return agentHead(this.paths);
  }

  // -- index projection API -------------------------------------------------

  async reconcileIndex(): Promise<ReconcileResult> {
    return this.exclusive(() => this.reconcileIndexUnlocked());
  }

  // -- proposals (§33–34) ---------------------------------------------------

  /**
   * Staleness refresh: I-19 marks PENDING proposals STALE when any target
   * blob differs at agent HEAD; then accepted proposals whose mutation is in
   * `REPLAN` go ACCEPTED → STALE (§17 step 6's check, design §5.2). Caller
   * holds the worktree lock. Returns the ids marked.
   */
  private refreshProposalStaleness(): string[] {
    const pending = this.proposals.refreshStaleness((path) => blobAt(this.paths.agentWorktree, AGENT_BRANCH, path));
    return [...pending, ...this.staleReplannedAccepts()];
  }

  async submitProposal(proposal: Proposal): Promise<void> {
    this.proposals.create(proposal);
  }

  /**
   * Every proposal, after a staleness refresh: changed targets (I-19) and
   * accepted mutations that reached `REPLAN` (§34) are marked STALE first.
   * Writes those marks, so it takes the worktree lock like every other write
   * (CR-1).
   */
  async listProposals(): Promise<Proposal[]> {
    return this.exclusive(async () => {
      this.refreshProposalStaleness();
      return this.proposals.list();
    });
  }

  /**
   * Accept: re-check staleness against agent HEAD (after catching up with
   * main), then re-enter the proposal as a mutation whose preconditions are
   * its target snapshots and run it like submit(). A stale or already
   * resolved proposal executes nothing and returns `REPLAN` / `"STALE"`;
   * that includes losing the PENDING → ACCEPTED compare-and-set to another
   * decision. If execution fails its preconditions (REPLAN) the proposal
   * goes ACCEPTED → STALE (§34). Throws `UnknownProposalError` for an
   * unknown id.
   *
   * The ACCEPTED write (`proposals.sqlite`) and the enqueue (`queue.sqlite`)
   * share no transaction. A crash between them is completed by accept
   * reconciliation at the next recovery (§17 step 6); `ACCEPT_CRASH_ENV`
   * injects that crash in tests.
   */
  async acceptProposal(proposalId: string): Promise<ExecutionResult> {
    return this.exclusive(async () => {
      const found = this.proposals.get(proposalId);
      if (!found) throw new UnknownProposalError(proposalId);
      if (!isClean(this.paths.agentWorktree)) resetAgentWorktree(this.paths);
      await this.catchUpAgentBranch();
      this.refreshProposalStaleness();
      const p = this.proposals.get(proposalId)!;
      if (p.status !== "PENDING" || !this.proposals.decide(proposalId, "PENDING", "ACCEPTED", { resolvedAt: this.nowIso() })) {
        return { mutationId: p.mutationId, state: "REPLAN", error: "STALE" };
      }
      // A crash here leaves ACCEPTED with no queue row; recovery's accept reconciliation completes it.
      crashAfterAcceptForTests();
      return this.runAcceptedUnlocked(p);
    });
  }

  /**
   * Run an ACCEPTED proposal's mutation (`mutationFromProposal`) as submit()
   * runs one: enqueue (a no-op when its row exists), execute, then integrate
   * when it committed. If execution fails its preconditions (REPLAN) the
   * proposal goes ACCEPTED → STALE (§34). Used by `acceptProposal` right after
   * its compare-and-set and by accept reconciliation after a crash. Caller
   * holds the worktree lock.
   */
  private async runAcceptedUnlocked(p: Proposal): Promise<ExecutionResult> {
    const mutation = mutationFromProposal(p);
    this.queue.enqueue(mutation);
    const r = await this.executeUnlocked(mutation.mutationId);
    if (r.state === "REPLAN") {
      // The proposal is ACCEPTED and this section holds the lock, so the compare-and-set holds.
      this.proposals.decide(p.proposalId, "ACCEPTED", "STALE", { resolvedAt: this.nowIso() });
      return r;
    }
    if (r.state === "COMMITTED") await this.integrateUnlocked();
    const row = this.queue.get(mutation.mutationId);
    return row ? { ...r, state: row.state, commitSha: row.commitSha ?? r.commitSha } : r;
  }

  /**
   * Reject a PENDING proposal. In one locked section: refresh staleness
   * against agent HEAD as `listProposals` does (I-19: a proposal whose target
   * changed is STALE and must never be recorded as REJECTED), then a
   * PENDING → REJECTED compare-and-set. Throws `ProposalNotPendingError`
   * (with the status found) when the proposal is no longer PENDING —
   * accepted, rejected, or STALE, including marked STALE by this refresh —
   * and `UnknownProposalError` for an unknown id.
   */
  async rejectProposal(proposalId: string, decisionNote?: string): Promise<void> {
    await this.exclusive(async () => {
      this.refreshProposalStaleness();
      if (this.proposals.decide(proposalId, "PENDING", "REJECTED", { decisionNote, resolvedAt: this.nowIso() })) return;
      throw new ProposalNotPendingError(proposalId, this.proposals.get(proposalId)!.status);
    });
  }

  async negativeEvidenceFor(noteIds: string[]): Promise<Proposal[]> {
    return this.proposals.negativeEvidenceFor(noteIds);
  }

  private nowIso(): string {
    return new Date(this.clock.now()).toISOString();
  }

  async close(): Promise<void> {
    await this.mutex.run(async () => {
      this.queue.close();
      this.proposals.close();
    });
  }
}

/**
 * Open the coordinator for the knowledge repo at `userWorktree`.
 *
 * `ensureAgentWorktree` can `checkout`, `rm -rf` or `reset --hard` the agent
 * worktree, so it runs under the worktree lock (CR-1): another process may be
 * in the middle of executing there (design §5.1). It stays here rather than in
 * `recover()` because callers (the fixture harness among them) open and
 * execute without recovering. Opening therefore waits while another process
 * holds the lock.
 */
export async function openCoordinator(userWorktree: string, opts: { clock?: Clock } = {}): Promise<RepoCoordinator> {
  const config = loadConfig(userWorktree);
  const paths = repoPaths(userWorktree, config.repoId);
  for (const dir of [paths.stateDir, paths.conversationsDir, paths.runtimeDir]) mkdirSync(dir, { recursive: true });
  await withRepoWorktreeLock(paths.runtimeDir, async () => ensureAgentWorktree(paths));
  const queue = openQueue(paths.queueDb);
  const proposals = openProposalStore(paths.proposalsDb);
  const clock: Clock = opts.clock ?? { now: () => Date.now() };
  return new Coordinator(paths, config, queue, proposals, clock);
}
