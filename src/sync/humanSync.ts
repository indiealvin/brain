/**
 * Human Sync (spec §16; I-2, I-13).
 *
 * `syncOnce(now)` commits the user's own edits in the user worktree once
 * they are quiescent: every dirty path's mtime must be at least
 * `config.sync.quiescenceMs` older than `now`. Nothing is staged before
 * that point, so a non-quiescent call leaves the user's `git status`
 * untouched. The commit is authored `Actor: human-sync`, never touches the
 * agent worktree, and `add` + `commit` are the only mutations of the user
 * worktree besides `merge --ff-only` (integration).
 *
 * Callers run it under the RepoWorktreeLock (the coordinator does); the
 * watcher below is a thin shell around the same primitive.
 */
import { statSync, watch, type FSWatcher } from "node:fs";
import { basename, join } from "node:path";
import type { BrainConfig, Clock, RepoPaths, SyncResult } from "../core/types";
import { MAIN_BRANCH } from "../core/types";
import { formatCommitMessage, gitWith, revParse, statusPorcelain, type StatusEntry } from "../git/git";
import { withRepoWorktreeLock } from "./lock";

/** Identity for human-sync commits (humans commit as themselves otherwise). */
export const HUMAN_SYNC_IDENTITY_ENV = {
  GIT_AUTHOR_NAME: "brain-human-sync",
  GIT_AUTHOR_EMAIL: "brain-human-sync@localhost",
  GIT_COMMITTER_NAME: "brain-human-sync",
  GIT_COMMITTER_EMAIL: "brain-human-sync@localhost",
} as const;

const SUMMARY_MAX_NAMES = 3;

/** `x.md, y.md, z.md (+2)` from the dirty paths. */
export function summarize(paths: string[]): string {
  const names = paths.map((p) => basename(p));
  const head = names.slice(0, SUMMARY_MAX_NAMES).join(", ");
  const rest = names.length - SUMMARY_MAX_NAMES;
  return rest > 0 ? `${head} (+${rest})` : head;
}

/** Latest mtime (ms) over the dirty paths; deleted paths count as quiescent. */
export function lastChangeMs(userWorktree: string, entries: StatusEntry[]): number {
  let max = -Infinity;
  for (const e of entries) {
    try {
      const st = statSync(join(userWorktree, e.path));
      if (st.mtimeMs > max) max = st.mtimeMs;
    } catch {
      // deleted (or unreadable): nothing left to settle
    }
  }
  return max;
}

/**
 * Commit quiescent human edits on `main` in the user worktree.
 * Must be called under the RepoWorktreeLock.
 */
export async function syncOnce(paths: RepoPaths, config: BrainConfig, now: number): Promise<SyncResult> {
  const wt = paths.userWorktree;
  const dirty = statusPorcelain(wt);
  if (dirty.length === 0) return { committed: false, reason: "clean" };
  const last = lastChangeMs(wt, dirty);
  if (now - last < config.sync.quiescenceMs) return { committed: false, reason: "not-quiescent" };
  gitWith(wt, ["add", "-A"]);

  const message = formatCommitMessage(`user: ${summarize(dirty.map((e) => e.path))}`, { actor: "human-sync" });
  gitWith(wt, ["commit", "-q", "--no-verify", "-F", "-"], { stdin: message, env: { ...HUMAN_SYNC_IDENTITY_ENV } });
  const sha = revParse(wt, MAIN_BRANCH);
  return { committed: true, sha, reason: "committed" };
}

export interface HumanSyncWatcher {
  stop(): void;
}

/**
 * Thin filesystem watcher: any change bumps an internal "dirty" flag, and a
 * timer calls `sync` (default: `syncOnce` under the RepoWorktreeLock) every
 * `intervalMs`. Not under test; the coordinator's `syncOnce` is the seam.
 */
export function startHumanSyncWatcher(
  paths: RepoPaths,
  config: BrainConfig,
  clock: Clock,
  intervalMs: number,
  sync: (now: number) => Promise<SyncResult> = (now) => withRepoWorktreeLock(paths.runtimeDir, () => syncOnce(paths, config, now)),
): HumanSyncWatcher {
  let pending = true;
  let running = false;
  let watcher: FSWatcher | null = null;
  try {
    watcher = watch(paths.userWorktree, { recursive: true }, () => {
      pending = true;
    });
  } catch {
    watcher = null; // fall back to polling only
  }
  const timer = setInterval(async () => {
    if (running || (!pending && watcher)) return;
    running = true;
    try {
      const r = await sync(clock.now());
      if (r.committed || r.reason === "clean") pending = false;
    } catch {
      // keep trying on the next tick
    } finally {
      running = false;
    }
  }, intervalMs);
  return {
    stop() {
      clearInterval(timer);
      watcher?.close();
    },
  };
}
