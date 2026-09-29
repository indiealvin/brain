/**
 * Agent worktree management (spec §4, §6, §17; I-12).
 *
 * The agent branch `agent/repo` is checked out in
 * `$BRAIN_HOME/repos/<repo_id>/worktrees/agent`. Humans never edit it; it is
 * disposable: a dirty agent worktree is always `reset --hard` + `clean`,
 * never stashed.
 */
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { AGENT_BRANCH, MAIN_BRANCH } from "../core/types";
import type { RepoPaths } from "../core/types";
import { git, gitOk, isClean, isRepoRoot, refExists, revParse, runGit } from "./git";

/** Identity used for every agent commit; humans and human-sync commit as themselves. */
export const AGENT_IDENTITY_ENV = {
  GIT_AUTHOR_NAME: "brain-agent",
  GIT_AUTHOR_EMAIL: "brain-agent@localhost",
  GIT_COMMITTER_NAME: "brain-agent",
  GIT_COMMITTER_EMAIL: "brain-agent@localhost",
} as const;

/** Env for `git commit` in the agent worktree. */
export function agentCommitEnv(): Record<string, string> {
  return { ...AGENT_IDENTITY_ENV };
}

/** Paths registered as worktrees of `repo` (as git reports them). */
export function registeredWorktrees(repo: string): string[] {
  const r = runGit(repo, ["worktree", "list", "--porcelain"]);
  if (r.code !== 0) return [];
  return r.stdout
    .split("\n")
    .filter((l) => l.startsWith("worktree "))
    .map((l) => l.slice("worktree ".length).trim());
}

function currentBranch(dir: string): string | null {
  const r = runGit(dir, ["symbolic-ref", "--short", "-q", "HEAD"]);
  return r.code === 0 ? r.stdout.trim() : null;
}

/**
 * Discard every local change in the agent worktree: tracked modifications,
 * staged changes and untracked files (I-12). Never stashes.
 */
export function resetAgentWorktree(paths: RepoPaths): void {
  git(paths.agentWorktree, "reset", "-q", "--hard", AGENT_BRANCH);
  git(paths.agentWorktree, "clean", "-fdq");
}

/**
 * Make sure `agent/repo` exists (created at `main` when missing) and is
 * checked out in `paths.agentWorktree`. Idempotent. A dirty worktree is
 * reset; a stale registration is pruned; a directory that is not a worktree
 * root is removed (it lives under BRAIN_HOME and is disposable).
 */
export function ensureAgentWorktree(paths: RepoPaths): void {
  const repo = paths.userWorktree;
  if (!refExists(repo, MAIN_BRANCH)) {
    throw new Error(`${repo}: branch ${MAIN_BRANCH} does not exist; run \`brain init\` first`);
  }
  if (!refExists(repo, AGENT_BRANCH)) {
    git(repo, "branch", AGENT_BRANCH, MAIN_BRANCH);
  }

  const wt = paths.agentWorktree;
  const healthy = existsSync(wt) && isRepoRoot(wt) && currentBranch(wt) === AGENT_BRANCH;

  if (!healthy) {
    if (existsSync(wt)) {
      if (isRepoRoot(wt)) {
        // A worktree of this repo on the wrong branch (or detached): switch it.
        git(wt, "checkout", "-q", AGENT_BRANCH);
      } else {
        rmSync(wt, { recursive: true, force: true });
      }
    }
    if (!existsSync(wt)) {
      // Drop any stale registration of a removed directory (idempotent).
      git(repo, "worktree", "prune");
      mkdirSync(dirname(wt), { recursive: true });
      git(repo, "worktree", "add", "-q", wt, AGENT_BRANCH);
    }
  }

  if (!isClean(wt)) resetAgentWorktree(paths);
}

export function agentHead(paths: RepoPaths): string {
  return revParse(paths.userWorktree, AGENT_BRANCH);
}

export function mainHead(paths: RepoPaths): string {
  return revParse(paths.userWorktree, MAIN_BRANCH);
}

/** True when `ancestor` is reachable from `descendant` (or equal). */
export function isAncestor(repo: string, ancestor: string, descendant: string): boolean {
  return gitOk(repo, "merge-base", "--is-ancestor", ancestor, descendant);
}

/**
 * When `agent/repo` has no un-integrated commits (it is an ancestor of
 * `main`) and `main` moved ahead, move the agent branch and worktree to
 * `main`. This is the zero-pending case of the rebuild (§13) and is always
 * safe. Returns the new agent head.
 */
export function fastForwardAgentToMain(paths: RepoPaths): string {
  const main = mainHead(paths);
  const agent = agentHead(paths);
  if (agent === main) return agent;
  if (!isAncestor(paths.userWorktree, agent, main)) return agent;
  if (!isClean(paths.agentWorktree)) resetAgentWorktree(paths);
  git(paths.agentWorktree, "reset", "-q", "--hard", main);
  return main;
}
