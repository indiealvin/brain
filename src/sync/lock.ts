/**
 * RepoWorktreeLock (spec §15–16, §21.1; I-11).
 *
 * One file-based, cross-process lock per knowledge repo, stored at
 * `<runtimeDir>/worktree.lock`. Human Sync, integration and the agent-branch
 * rebuild all run under it, so the second holder always observes the first
 * holder's completed state.
 *
 * Acquisition is `open(O_CREAT|O_EXCL)`; the file holds `<pid> <timestamp>`.
 * A lock whose owner is dead (or that is older than STALE_MS) is stale and is
 * moved aside with `rename` before re-trying, so at most one process ever
 * creates the file. Not re-entrant: callers must never nest it.
 */
import { closeSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export const LOCK_FILE = "worktree.lock";
export const STALE_MS = 60_000;
const MIN_BACKOFF_MS = 5;
const MAX_BACKOFF_MS = 50;

export function lockPath(runtimeDir: string): string {
  return join(runtimeDir, LOCK_FILE);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    // EPERM: the process exists but belongs to another user.
    return code === "EPERM";
  }
}

/** True when the lock at `file` is held by a dead process or is too old. */
function isStale(file: string, now: number): boolean {
  let raw: string;
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(file);
    raw = readFileSync(file, "utf8");
  } catch {
    return false; // vanished: the owner released it; just retry
  }
  const m = raw.trim().match(/^(\d+)\s+(\d+)/);
  if (m) {
    const pid = Number(m[1]);
    const ts = Number(m[2]);
    if (pid !== process.pid && !pidAlive(pid)) return true;
    if (Number.isFinite(ts) && now - ts > STALE_MS) return true;
    return false;
  }
  return now - st.mtimeMs > STALE_MS;
}

/** Move a stale lock aside; only one contender's rename succeeds. */
function evictStale(file: string): void {
  const aside = `${file}.stale.${process.pid}.${Date.now()}.${Math.floor(Math.random() * 1e6)}`;
  try {
    renameSync(file, aside);
  } catch {
    return; // someone else evicted (or the owner released) it
  }
  try {
    unlinkSync(aside);
  } catch {}
}

function tryAcquire(file: string): boolean {
  let fd: number;
  try {
    fd = openSync(file, "wx");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw e;
  }
  try {
    writeSync(fd, `${process.pid} ${Date.now()}\n`);
  } finally {
    closeSync(fd);
  }
  return true;
}

/**
 * Run `fn` while holding the repo worktree lock. Waits (polling with a small
 * backoff) until the lock is free; always releases it, also when `fn` throws.
 */
export async function withRepoWorktreeLock<T>(runtimeDir: string, fn: () => Promise<T>): Promise<T> {
  mkdirSync(runtimeDir, { recursive: true });
  const file = lockPath(runtimeDir);
  let backoff = MIN_BACKOFF_MS;
  while (!tryAcquire(file)) {
    if (isStale(file, Date.now())) {
      evictStale(file);
      continue;
    }
    await sleep(backoff);
    backoff = Math.min(MAX_BACKOFF_MS, backoff * 2);
  }
  try {
    return await fn();
  } finally {
    try {
      unlinkSync(file);
    } catch {}
  }
}
