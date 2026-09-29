/**
 * Application state layout (spec §6, I-25).
 *
 * Every path to app state is derived here. Nothing else in the codebase
 * reads `~/.brain` directly.
 */
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { RepoPaths } from "./types";

/** `$BRAIN_HOME`, or `~/.brain` when the variable is unset or blank. */
export function resolveBrainHome(): string {
  const env = process.env.BRAIN_HOME;
  if (env !== undefined && env.trim() !== "") return resolve(env.trim());
  return join(homedir(), ".brain");
}

/** Per-repo state directory: `$BRAIN_HOME/repos/<repo_id>`. */
export function repoStateDir(repoId: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(repoId) || repoId === "." || repoId === "..") {
    throw new Error(`invalid repo_id for state directory: ${JSON.stringify(repoId)}`);
  }
  return join(resolveBrainHome(), "repos", repoId);
}

/** All state paths for a knowledge repo (spec §6). */
export function repoPaths(userWorktree: string, repoId: string): RepoPaths {
  const stateDir = repoStateDir(repoId);
  return {
    userWorktree: resolve(userWorktree),
    stateDir,
    agentWorktree: join(stateDir, "worktrees", "agent"),
    indexDb: join(stateDir, "index.sqlite"),
    usageDb: join(stateDir, "usage.sqlite"),
    proposalsDb: join(stateDir, "proposals.sqlite"),
    queueDb: join(stateDir, "queue.sqlite"),
    conversationsDir: join(stateDir, "conversations"),
    runtimeDir: join(stateDir, "runtime"),
  };
}
