/**
 * Agent branch rebuild (spec §13–14; I-2, I-6, I-8, I-9, I-12).
 *
 * Moves `agent/repo` onto the current `main` and replays every pending
 * (COMMITTED, not yet INTEGRATED) mutation in agent-branch order by
 * cherry-picking its old commit, so Mutation-ID trailers survive while SHAs
 * change. Each mutation is validated against the rebuild tree so far (new
 * main plus the previously replayed mutations). Invalid mutations go to
 * REPLAN and park their dependency closure; a cherry-pick conflict is a bug
 * (abort, FAILED, never resolved). Runs in the disposable agent worktree.
 */
import { AGENT_BRANCH, MAIN_BRANCH } from "./types";
import type { Mutation, QueueRow, RebuildResult, RepoPaths } from "./types";
import type { Queue } from "./queue";
import { closure, dependencyGraph, type SlugTree } from "./deps";
import { declaredWriteSet } from "./executor";
import { describeFailures, validatePreconditions } from "./preconditions";
import { isNotePath, slugFromPath, slugKey } from "./slug";
import { git, isClean, logGrepTrailer, lsTree, revParse, runGit, trailersOf } from "../git/git";
import { agentCommitEnv, resetAgentWorktree } from "../git/worktree";

export interface RebuildContext {
  paths: RepoPaths;
  queue: Queue;
}

/** Slug keys of every note in `tree`, answering the §10 rule-3 absence check. */
export function slugTreeOf(repo: string, tree: string): SlugTree {
  const keys = new Set<string>();
  for (const e of lsTree(repo, tree)) if (isNotePath(e.path)) keys.add(slugKey(slugFromPath(e.path)));
  return { hasSlug: (k) => keys.has(k) };
}

/** Paths touched by commit `sha` (empty for a redundant/empty commit). */
function touchedPaths(repo: string, sha: string): string[] {
  const out = git(repo, "diff-tree", "--no-commit-id", "--name-only", "-r", "--root", sha);
  return out ? out.split("\n").filter(Boolean) : [];
}

interface Pending {
  row: QueueRow;
  mutation: Mutation;
  oldSha: string;
}

export async function rebuildAgentBranch(ctx: RebuildContext): Promise<RebuildResult> {
  const { paths, queue } = ctx;
  const repo = paths.userWorktree;
  const wt = paths.agentWorktree;
  const oldAgentHead = revParse(repo, AGENT_BRANCH);
  const newMain = revParse(repo, MAIN_BRANCH);
  const replayed: string[] = [];
  const replanned: string[] = [];
  const failed: string[] = [];

  // Pre-pass on the old head: drop rows already on main (a redundant
  // cherry-pick would duplicate them) and rows whose commit is gone.
  const pending: Pending[] = [];
  for (const row of queue.listByState(["COMMITTED"])) {
    if (logGrepTrailer(repo, newMain, "Mutation-ID", row.mutationId).length > 0) {
      queue.setState(row.mutationId, "INTEGRATED", { lastError: null });
      continue;
    }
    const shas = logGrepTrailer(repo, oldAgentHead, "Mutation-ID", row.mutationId);
    const mutation = queue.getMutation(row.mutationId);
    if (shas.length === 0 || !mutation) {
      queue.setState(row.mutationId, "FAILED", { lastError: `COMMIT_NOT_FOUND: no commit with Mutation-ID ${row.mutationId} on ${AGENT_BRANCH}` });
      failed.push(row.mutationId);
      continue;
    }
    pending.push({ row, mutation, oldSha: shas[0]! });
  }

  // The tree the pending mutations were planned against (rule 3, §10).
  const baseR = runGit(repo, ["merge-base", oldAgentHead, newMain]);
  const base = baseR.code === 0 && baseR.stdout.trim() ? baseR.stdout.trim() : newMain;
  const graph = dependencyGraph(
    pending.map((p) => p.row),
    new Map(pending.map((p) => [p.row.mutationId, p.mutation])),
    slugTreeOf(repo, base),
  );

  // Agent worktree is disposable: start clean on new main.
  if (!isClean(wt)) resetAgentWorktree(paths);
  git(wt, "checkout", "-q", "-B", AGENT_BRANCH, newMain);

  const invalid = new Set<string>();
  for (const p of pending) {
    const id = p.row.mutationId;
    const blocked = closure(graph, invalid);
    if (blocked.has(id)) {
      const deps = [...(graph.get(id) ?? [])].filter((d) => blocked.has(d));
      queue.setState(id, "REPLAN", { lastError: `BLOCKED_BY_DEPENDENCY: ${deps.join(", ")}` });
      replanned.push(id);
      continue;
    }
    // I-2: validate against new main plus everything replayed so far.
    const pre = validatePreconditions(wt, "HEAD", p.mutation.targets);
    if (!pre.ok) {
      queue.setState(id, "REPLAN", { lastError: `PRECONDITION_FAILED: ${describeFailures(pre.failures)}` });
      replanned.push(id);
      invalid.add(id);
      continue;
    }
    const before = revParse(wt, "HEAD");
    const cp = runGit(wt, ["cherry-pick", "--allow-empty", "--keep-redundant-commits", p.oldSha], { env: agentCommitEnv() });
    if (cp.code !== 0) {
      runGit(wt, ["cherry-pick", "--abort"]);
      if (!isClean(wt) || revParse(wt, "HEAD") !== before) {
        git(wt, "reset", "-q", "--hard", before);
        git(wt, "clean", "-fdq");
      }
      queue.setState(id, "FAILED", { lastError: `CHERRY_PICK_CONFLICT (bug): ${cp.stderr.trim() || cp.stdout.trim()}` });
      failed.push(id);
      invalid.add(id);
      continue;
    }
    const head = revParse(wt, "HEAD");
    const declared = declaredWriteSet(p.mutation).paths;
    const extra = touchedPaths(wt, head).filter((path) => !declared.has(path));
    const trailerId = head === before ? undefined : trailersOf(wt, head).mutationId;
    if (extra.length > 0 || trailerId !== id) {
      git(wt, "reset", "-q", "--hard", before);
      const why = extra.length > 0 ? `WRITE_SET_MISMATCH: undeclared paths touched: ${extra.join(", ")}` : `TRAILER_MISSING (bug): replayed commit lacks Mutation-ID ${id}`;
      queue.setState(id, "FAILED", { lastError: why });
      failed.push(id);
      invalid.add(id);
      continue;
    }
    queue.setState(id, "COMMITTED", { commitSha: head, lastError: null });
    replayed.push(id);
  }

  return { newAgentHead: revParse(wt, "HEAD"), replayed, replanned, failed };
}
