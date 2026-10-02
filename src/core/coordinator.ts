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
import { openProposalStore, type ProposalStore } from "../proposal/store";
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

  /** Execute every QUEUED automatic mutation in seq order, then integrate. */
  async drainQueued(): Promise<ExecutionResult[]> {
    return this.exclusive(async () => {
      const out: ExecutionResult[] = [];
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

  // -- recovery (§17 steps 1–4) ---------------------------------------------

  async recover(): Promise<void> {
    await this.exclusive(async () => {
      ensureAgentWorktree(this.paths);
      if (!isClean(this.paths.agentWorktree)) resetAgentWorktree(this.paths);
      for (const row of this.queue.listByState(["RUNNING"])) {
        const shas = logGrepTrailer(this.paths.agentWorktree, AGENT_BRANCH, "Mutation-ID", row.mutationId);
        if (shas.length > 0) {
          this.queue.setState(row.mutationId, "COMMITTED", { commitSha: shas[0]!, lastError: null });
        } else {
          await this.executeUnlocked(row.mutationId);
        }
      }
      for (const row of this.queue.listByState(["BLOCKED"])) {
        this.queue.setState(row.mutationId, "REPLAN", { lastError: row.lastError ?? "BLOCKED: dependency invalidated" });
      }
      // §17 step 5: index projects agent HEAD.
      await this.reconcileIndexUnlocked();
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

  /** I-19: mark PENDING proposals STALE when any target blob differs at agent HEAD. Caller holds the worktree lock. */
  private refreshProposalStaleness(): string[] {
    return this.proposals.refreshStaleness((path) => blobAt(this.paths.agentWorktree, AGENT_BRANCH, path));
  }

  async submitProposal(proposal: Proposal): Promise<void> {
    this.proposals.create(proposal);
  }

  /** Writes STALE marks, so it takes the worktree lock like every other write (CR-1). */
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
   * resolved proposal executes nothing. If execution fails its
   * preconditions (REPLAN) the proposal becomes STALE (§34).
   */
  async acceptProposal(proposalId: string): Promise<ExecutionResult> {
    return this.exclusive(async () => {
      const found = this.proposals.get(proposalId);
      if (!found) throw new Error(`acceptProposal: unknown proposal ${proposalId}`);
      if (!isClean(this.paths.agentWorktree)) resetAgentWorktree(this.paths);
      await this.catchUpAgentBranch();
      this.refreshProposalStaleness();
      const p = this.proposals.get(proposalId)!;
      if (p.status !== "PENDING") {
        return { mutationId: p.mutationId, state: "REPLAN", error: "STALE" };
      }
      this.proposals.decide(proposalId, "ACCEPTED", { resolvedAt: this.nowIso() });
      const mutation: Mutation = {
        mutationId: p.mutationId,
        type: p.operation,
        summary: `${p.operation.toLowerCase()} ${p.targets.map((t) => basename(t.path)).join(", ")}`,
        targets: p.targets.map((t) => ({ kind: "present", noteId: t.noteId, path: t.path, blobHash: t.blobHash })),
        writes: p.writes,
        dependsOn: [],
        evidence: p.evidence,
        reasoning: p.reasoning,
      };
      this.queue.enqueue(mutation);
      const r = await this.executeUnlocked(mutation.mutationId);
      if (r.state === "REPLAN") {
        this.proposals.decide(proposalId, "STALE", { resolvedAt: this.nowIso() });
        return r;
      }
      if (r.state === "COMMITTED") await this.integrateUnlocked();
      const row = this.queue.get(mutation.mutationId);
      return row ? { ...r, state: row.state, commitSha: row.commitSha ?? r.commitSha } : r;
    });
  }

  async rejectProposal(proposalId: string, decisionNote?: string): Promise<void> {
    await this.exclusive(async () => {
      this.proposals.decide(proposalId, "REJECTED", { decisionNote, resolvedAt: this.nowIso() });
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
