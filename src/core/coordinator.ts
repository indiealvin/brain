/**
 * RepoCoordinator (spec §21.1, §12, §15, §16, §17). Single entry point per
 * knowledge repo; fixtures drive the engine through this interface.
 *
 * Locking model (I-11): one in-process mutex (`Serial`) serializes every
 * public operation so two executions never interleave; the cross-process
 * RepoWorktreeLock is taken only inside the bodies of sync / integrate /
 * rebuild and is never nested. No `*Unlocked` method ever re-enters the
 * mutex, so the two locks cannot deadlock.
 *
 * The index (Phase 6) and proposals (Phase 10) still throw `not implemented`.
 */
import { mkdirSync } from "node:fs";
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
import { withRepoWorktreeLock } from "../sync/lock";

function notImplemented(name: string, phase: number): never {
  throw new Error(`not implemented: ${name} (phase ${phase})`);
}

/** In-process single-writer mutex: serializes execute / integrate / sync / rebuild / recover. */
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
  private readonly mutex = new Serial();

  constructor(paths: RepoPaths, config: BrainConfig, queue: Queue, clock: Clock) {
    this.paths = paths;
    this.config = config;
    this.queue = queue;
    this.clock = clock;
  }

  // -- rebuild (§13) --------------------------------------------------------

  private rebuildUnlocked(): Promise<RebuildResult> {
    return withRepoWorktreeLock(this.paths.runtimeDir, () => rebuildAgentBranch({ paths: this.paths, queue: this.queue }));
  }

  /**
   * Bring `agent/repo` up to date with `main` before executing: with no
   * un-integrated commits this is a plain move (zero-pending rebuild);
   * otherwise the pending mutations are replayed under the lock.
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

  private async executeUnlocked(mutationId: string): Promise<ExecutionResult> {
    if (!isClean(this.paths.agentWorktree)) resetAgentWorktree(this.paths);
    await this.catchUpAgentBranch();
    return executeMutation(
      { paths: this.paths, queue: this.queue, afterCommit: async () => void (await this.reconcileIndexUnlocked()) },
      mutationId,
    );
  }

  async execute(mutationId: string): Promise<ExecutionResult> {
    return this.mutex.run(() => this.executeUnlocked(mutationId));
  }

  async submit(mutation: Mutation): Promise<ExecutionResult> {
    return this.mutex.run(async () => {
      this.queue.enqueue(mutation);
      const r = await this.executeUnlocked(mutation.mutationId);
      if (r.state === "COMMITTED") await this.integrateUnlocked();
      const row = this.queue.get(mutation.mutationId);
      return row ? { ...r, state: row.state, commitSha: row.commitSha ?? r.commitSha } : r;
    });
  }

  // -- integration (§15) ----------------------------------------------------

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
   * execute()/submit() or via drainQueued().
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
    return this.mutex.run(async () => {
      const out: ExecutionResult[] = [];
      for (const row of this.queue.listByState(["QUEUED"])) out.push(await this.executeUnlocked(row.mutationId));
      if (out.some((r) => r.state === "COMMITTED")) await this.integrateUnlocked();
      return out;
    });
  }

  async integrate(): Promise<IntegrationResult> {
    return this.mutex.run(() => this.integrateUnlocked());
  }

  async rebuild(): Promise<RebuildResult> {
    return this.mutex.run(() => this.rebuildUnlocked());
  }

  // -- human sync (§16) -----------------------------------------------------

  async syncOnce(now?: number): Promise<SyncResult> {
    const t = now ?? this.clock.now();
    return this.mutex.run(() => withRepoWorktreeLock(this.paths.runtimeDir, () => humanSyncOnce(this.paths, this.config, t)));
  }

  // -- recovery (§17 steps 1–4) ---------------------------------------------

  async recover(): Promise<void> {
    await this.mutex.run(async () => {
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

  // -- later phases ---------------------------------------------------------

  async reconcileIndex(): Promise<ReconcileResult> {
    return this.mutex.run(() => this.reconcileIndexUnlocked());
  }

  async submitProposal(_proposal: Proposal): Promise<void> {
    return notImplemented("submitProposal", 10);
  }

  async listProposals(): Promise<Proposal[]> {
    return notImplemented("listProposals", 10);
  }

  async acceptProposal(_proposalId: string): Promise<ExecutionResult> {
    return notImplemented("acceptProposal", 10);
  }

  async rejectProposal(_proposalId: string, _decisionNote?: string): Promise<void> {
    return notImplemented("rejectProposal", 10);
  }

  async negativeEvidenceFor(_noteIds: string[]): Promise<Proposal[]> {
    return notImplemented("negativeEvidenceFor", 10);
  }

  async close(): Promise<void> {
    await this.mutex.run(async () => this.queue.close());
  }
}

export async function openCoordinator(userWorktree: string, opts: { clock?: Clock } = {}): Promise<RepoCoordinator> {
  const config = loadConfig(userWorktree);
  const paths = repoPaths(userWorktree, config.repoId);
  for (const dir of [paths.stateDir, paths.conversationsDir, paths.runtimeDir]) mkdirSync(dir, { recursive: true });
  ensureAgentWorktree(paths);
  const queue = openQueue(paths.queueDb);
  const clock: Clock = opts.clock ?? { now: () => Date.now() };
  return new Coordinator(paths, config, queue, clock);
}
