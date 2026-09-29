/**
 * Integration (spec §15; I-10, I-11).
 *
 * Entirely under the RepoWorktreeLock: Human Sync first, then a rebuild if
 * `main` moved, then `git merge --ff-only agent/repo` in the user worktree.
 * Git's own overwrite check protects dirty human paths: a refusal is a
 * retry-later, never a state change. Never stash/reset/checkout there.
 */
import { AGENT_BRANCH, MAIN_BRANCH } from "./types";
import type { BrainConfig, Clock, IntegrationResult, RepoPaths } from "./types";
import type { Queue } from "./queue";
import { rebuildAgentBranch } from "./rebuild";
import { GitError, logGrepTrailer, revParse, runGit } from "../git/git";
import { isAncestor } from "../git/worktree";
import { syncOnce } from "../sync/humanSync";
import { withRepoWorktreeLock } from "../sync/lock";

export interface IntegrateContext {
  paths: RepoPaths;
  config: BrainConfig;
  queue: Queue;
  clock: Clock;
  /** §15 step 6 hook (index reconcile); called after a successful ff. */
  afterIntegrate?: () => Promise<void>;
}

const REFUSED_DIRTY_RE = /would be overwritten|local changes|Your local changes|untracked working tree files/i;

/** Mark COMMITTED rows whose commit is reachable from `main` as INTEGRATED. */
export function markIntegrated(paths: RepoPaths, queue: Queue): string[] {
  const ids: string[] = [];
  for (const row of queue.listByState(["COMMITTED"])) {
    if (logGrepTrailer(paths.userWorktree, MAIN_BRANCH, "Mutation-ID", row.mutationId).length > 0) {
      queue.setState(row.mutationId, "INTEGRATED", { lastError: null });
      ids.push(row.mutationId);
    }
  }
  return ids;
}

/** True when `agent/repo` must be rebuilt: it no longer descends from `main`. */
export function mainMoved(paths: RepoPaths): boolean {
  const repo = paths.userWorktree;
  const main = revParse(repo, MAIN_BRANCH);
  const agent = revParse(repo, AGENT_BRANCH);
  return main !== agent && !isAncestor(repo, main, agent);
}

export async function integrateOnce(ctx: IntegrateContext): Promise<IntegrationResult> {
  const { paths, config, queue, clock } = ctx;
  const repo = paths.userWorktree;
  return withRepoWorktreeLock(paths.runtimeDir, async () => {
    // 1. Quiescent human edits become a human-sync commit first.
    await syncOnce(paths, config, clock.now());

    // 2. Rebuild when main moved since the agent branch base.
    let rebuilt = false;
    if (mainMoved(paths)) {
      await rebuildAgentBranch({ paths, queue });
      rebuilt = true;
    }

    // 3. Nothing beyond main on the agent branch.
    const main = revParse(repo, MAIN_BRANCH);
    const agent = revParse(repo, AGENT_BRANCH);
    if (main === agent) {
      const ids = markIntegrated(paths, queue);
      return { status: rebuilt ? "rebuilt-and-integrated" : "nothing-to-integrate", integratedMutationIds: ids, mainSha: main };
    }

    // 4. Fast-forward only, in the user worktree.
    const args = ["merge", "--ff-only", "-q", AGENT_BRANCH];
    const r = runGit(repo, args);
    if (r.code !== 0) {
      if (REFUSED_DIRTY_RE.test(`${r.stderr}\n${r.stdout}`)) {
        return { status: "refused-dirty", integratedMutationIds: [], mainSha: main };
      }
      throw new GitError(repo, args, r);
    }

    // 5. Rows now on main are integrated.
    const newMain = revParse(repo, MAIN_BRANCH);
    const ids = markIntegrated(paths, queue);
    // 6. Index reconcile hook.
    if (ctx.afterIntegrate) await ctx.afterIntegrate();
    return { status: rebuilt ? "rebuilt-and-integrated" : "integrated", integratedMutationIds: ids, mainSha: newMain };
  });
}
