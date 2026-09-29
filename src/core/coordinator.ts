/**
 * RepoCoordinator (spec §21.1, §12, §15, §17). Single entry point per
 * knowledge repo; fixtures drive the engine through this interface.
 *
 * Phase 3 implements queue + execution + recovery and a minimal ff-only
 * integration. Human Sync (Phase 4), rebuild (Phase 5), the index (Phase 6)
 * and proposals (Phase 10) throw `not implemented` until their phase lands.
 */
import { mkdirSync } from "node:fs";
import { AGENT_BRANCH, MAIN_BRANCH } from "./types";
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
import { openQueue, type Queue } from "./queue";
import { GitError, logGrepTrailer, revParse, runGit } from "../git/git";
import { agentHead, ensureAgentWorktree, fastForwardAgentToMain, isAncestor, mainHead, resetAgentWorktree } from "../git/worktree";
import { isClean } from "../git/git";
import { loadConfig } from "../markdown/repo";

function notImplemented(name: string, phase: number): never {
  throw new Error(`not implemented: ${name} (phase ${phase})`);
}

/** In-process single-writer lock: serializes execute / integrate / recover. */
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
  private readonly lock = new Serial();

  constructor(paths: RepoPaths, config: BrainConfig, queue: Queue, clock: Clock) {
    this.paths = paths;
    this.config = config;
    this.queue = queue;
    this.clock = clock;
  }

  // -- execution ----------------------------------------------------------

  private async executeUnlocked(mutationId: string): Promise<ExecutionResult> {
    if (!isClean(this.paths.agentWorktree)) resetAgentWorktree(this.paths);
    fastForwardAgentToMain(this.paths);
    return executeMutation({ paths: this.paths, queue: this.queue }, mutationId);
  }

  async execute(mutationId: string): Promise<ExecutionResult> {
    return this.lock.run(() => this.executeUnlocked(mutationId));
  }

  async submit(mutation: Mutation): Promise<ExecutionResult> {
    return this.lock.run(async () => {
      this.queue.enqueue(mutation);
      const r = await this.executeUnlocked(mutation.mutationId);
      if (r.state === "COMMITTED") await this.integrateUnlocked();
      const row = this.queue.get(mutation.mutationId);
      return row ? { ...r, state: row.state, commitSha: row.commitSha ?? r.commitSha } : r;
    });
  }

  // -- integration (minimal; Phase 5 adds sync + rebuild) ------------------

  private markIntegrated(): string[] {
    const ids: string[] = [];
    for (const row of this.queue.listByState(["COMMITTED"])) {
      if (logGrepTrailer(this.paths.userWorktree, MAIN_BRANCH, "Mutation-ID", row.mutationId).length > 0) {
        this.queue.setState(row.mutationId, "INTEGRATED");
        ids.push(row.mutationId);
      }
    }
    return ids;
  }

  private async integrateUnlocked(): Promise<IntegrationResult> {
    const repo = this.paths.userWorktree;
    const main = mainHead(this.paths);
    const agent = agentHead(this.paths);
    if (main === agent) {
      return { status: "nothing-to-integrate", integratedMutationIds: this.markIntegrated(), mainSha: main };
    }
    if (!isAncestor(repo, main, agent)) {
      // main moved ahead (or diverged): rebuild is Phase 5.
      return { status: "nothing-to-integrate", integratedMutationIds: [], mainSha: main };
    }
    const r = runGit(repo, ["merge", "--ff-only", "-q", AGENT_BRANCH]);
    if (r.code !== 0) {
      const text = `${r.stderr}\n${r.stdout}`;
      if (/would be overwritten|local changes|untracked working tree files/i.test(text)) {
        return { status: "refused-dirty", integratedMutationIds: [], mainSha: main };
      }
      throw new GitError(repo, ["merge", "--ff-only", AGENT_BRANCH], r);
    }
    const newMain = revParse(repo, MAIN_BRANCH);
    return { status: "integrated", integratedMutationIds: this.markIntegrated(), mainSha: newMain };
  }

  async integrate(): Promise<IntegrationResult> {
    return this.lock.run(() => this.integrateUnlocked());
  }

  // -- recovery (§17 steps 1–4) -------------------------------------------

  async recover(): Promise<void> {
    await this.lock.run(async () => {
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

  // -- queue --------------------------------------------------------------

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

  // -- later phases -------------------------------------------------------

  async syncOnce(_now?: number): Promise<SyncResult> {
    return notImplemented("syncOnce", 4);
  }

  async rebuild(): Promise<RebuildResult> {
    return notImplemented("rebuild", 5);
  }

  async reconcileIndex(): Promise<ReconcileResult> {
    return notImplemented("reconcileIndex", 6);
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
    await this.lock.run(async () => this.queue.close());
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
