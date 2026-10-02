/**
 * Kernel-released cross-process locks (spec §15–16, §21.1; I-11;
 * docs/mac-app/design.md §5.2, CR-1).
 *
 * A lock is a SQLite write transaction (`BEGIN IMMEDIATE`) on a dedicated,
 * otherwise empty database file, one file per lock:
 * `<runtimeDir>/locks/<name>.sqlite`. SQLite's POSIX record locks are dropped
 * by the kernel when the holder dies, so there is no pid file, no staleness
 * rule and nothing to reclaim. SQLite's unix VFS also excludes two
 * connections inside one process, so in-process contenders exclude each
 * other too (fixture 3.12).
 *
 * - **Every wait is asynchronous.** Lock connections run with
 *   `busy_timeout = 0`; a waiter retries on `SQLITE_BUSY` with an async
 *   backoff. `bun:sqlite` is synchronous, so a non-zero `busy_timeout` would
 *   block the whole event loop. Three wait modes: `blocking` (no deadline),
 *   `bounded` (a deadline on the async retries) and `try` (one attempt).
 * - **Not re-entrant**, even within one process: a nested acquisition of the
 *   same lock is a second connection, gets `SQLITE_BUSY`, and in blocking
 *   mode waits forever. Callers must never nest a lock.
 * - **Held handles stay strongly reachable.** An unreferenced `Database` is
 *   garbage-collected, which closes it and drops the lock while the holder is
 *   alive. Every held lock is kept in a module-level set until `release()`.
 * - **Each lock file is initialized once** with a committed
 *   `PRAGMA user_version = 1`, so an acquisition writes nothing and leaves no
 *   journal behind (on a 0-byte file every `BEGIN IMMEDIATE` would write
 *   page 1). Lock connections never create the file (`create: false`); a
 *   missing file is initialized as a temp file and `link()`ed into place,
 *   which fails with `EEXIST` when another contender won. The lock file is
 *   never renamed or replaced: a new inode would no longer exclude the
 *   holder of the old one. It is also never opened with a raw fd: closing
 *   any fd on the file drops this process's POSIX locks on it.
 * - **Side file.** The holder's kind, pid, process start time and
 *   acquisition time go to `<name>.holder.json` for `brain doctor`. It is
 *   informational only and never read to make a locking decision. It is
 *   removed on release, so one that names a dead pid was left by a holder
 *   that died; the next holder overwrites it.
 */
import { Database } from "bun:sqlite";
import { existsSync, linkSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

/** Lock files live under `<runtimeDir>/locks/`. */
export const LOCKS_DIR = "locks";
/** The repo worktree lock (CR-1; I-11). */
export const WORKTREE_LOCK = "worktree";

const MIN_BACKOFF_MS = 5;
const MAX_BACKOFF_MS = 50;

/**
 * How to wait for a lock. Every mode is asynchronous.
 * - `blocking`: until acquired; no deadline (worktree lock; `brain watch` on the loop-owner lock).
 * - `bounded`: give up after `timeoutMs` (turn-lock writers).
 * - `try`: a single attempt (sweeps, queries, the knowledge lock, the RPC server on the loop-owner lock).
 */
export type LockWait = { mode: "blocking" } | { mode: "bounded"; timeoutMs: number } | { mode: "try" };

export interface AcquireOptions {
  /** Recorded in the side file; default: the process-wide kind (`setLockHolderKind`). */
  holderKind?: string;
  /** Write the informational side file while held (default true). */
  recordHolder?: boolean;
}

/** A held lock. `release()` is idempotent. */
export interface LockHandle {
  readonly name: string;
  readonly held: boolean;
  release(): void;
}

/** Contents of `<name>.holder.json`. Informational only. */
export interface LockHolderInfo {
  lock: string;
  kind: string;
  pid: number;
  /** Holder process start time, ms since epoch. */
  processStartedAtMs: number;
  /** When the lock was acquired, ms since epoch. */
  acquiredAtMs: number;
}

/** Thrown by `withLock` when a `try` or `bounded` wait does not acquire. */
export class LockBusyError extends Error {
  readonly lock: string;
  constructor(lock: string) {
    super(`lock ${JSON.stringify(lock)} is held by another holder`);
    this.name = "LockBusyError";
    this.lock = lock;
  }
}

let processHolderKind = "brain";
const PROCESS_STARTED_AT_MS = Math.round(Date.now() - process.uptime() * 1000);

/** Set the holder kind this process records in side files (e.g. "watch", "rpc"). */
export function setLockHolderKind(kind: string): void {
  processHolderKind = kind;
}

function validateName(name: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) throw new Error(`invalid lock name: ${JSON.stringify(name)}`);
}

export function locksDir(runtimeDir: string): string {
  return join(runtimeDir, LOCKS_DIR);
}

/** `<runtimeDir>/locks/<name>.sqlite` */
export function lockFilePath(runtimeDir: string, name: string): string {
  validateName(name);
  return join(locksDir(runtimeDir), `${name}.sqlite`);
}

/** `<runtimeDir>/locks/<name>.holder.json` */
export function lockHolderPath(runtimeDir: string, name: string): string {
  validateName(name);
  return join(locksDir(runtimeDir), `${name}.holder.json`);
}

/**
 * Create and initialize `file` unless it exists. A temp file in the same
 * directory gets a committed `user_version = 1` and is `link()`ed into place;
 * `EEXIST` means another contender won, and its file is used as is. Never
 * renames over `file`. Exported for tests.
 */
export function createLockFile(file: string): void {
  const tmp = `${file}.init-${process.pid}-${randomUUID()}`;
  try {
    const db = new Database(tmp, { create: true, readwrite: true });
    try {
      db.exec("PRAGMA user_version = 1");
    } finally {
      db.close();
    }
    try {
      linkSync(tmp, file);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
  } finally {
    try {
      unlinkSync(tmp);
    } catch {}
  }
}

function ensureLockFile(file: string, dir: string): void {
  // Route on existence, never on the open error: SQLITE_CANTOPEN also covers
  // missing directories and permission errors.
  if (existsSync(file)) return;
  mkdirSync(dir, { recursive: true });
  createLockFile(file);
}

function openLockConnection(file: string): Database {
  const db = new Database(file, { create: false, readwrite: true });
  try {
    db.exec("PRAGMA busy_timeout = 0");
  } catch (e) {
    db.close();
    throw e;
  }
  return db;
}

function isBusy(e: unknown): boolean {
  return String((e as { code?: unknown })?.code ?? "").startsWith("SQLITE_BUSY");
}

/** One `BEGIN IMMEDIATE`: true when acquired, false on SQLITE_BUSY; anything else throws. */
function tryBegin(db: Database): boolean {
  try {
    db.exec("BEGIN IMMEDIATE");
    return true;
  } catch (e) {
    if (isBusy(e)) return false;
    throw e;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function writeHolder(sideFile: string, info: LockHolderInfo): void {
  const tmp = `${sideFile}.${process.pid}-${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(info) + "\n");
    renameSync(tmp, sideFile); // the side file, never the lock file
  } catch {
    try {
      unlinkSync(tmp);
    } catch {}
  }
}

/** Every held lock, so a handle the caller dropped is never garbage-collected (and released) while held. */
const HELD = new Set<HeldLock>();

class HeldLock implements LockHandle {
  readonly name: string;
  private db: Database | null;
  private readonly sideFile: string | null;

  constructor(name: string, db: Database, sideFile: string | null) {
    this.name = name;
    this.db = db;
    this.sideFile = sideFile;
    HELD.add(this);
  }

  get held(): boolean {
    return this.db !== null;
  }

  release(): void {
    const db = this.db;
    if (db === null) return;
    this.db = null;
    HELD.delete(this);
    // Remove the side file while still holding, so it can never delete the next holder's.
    if (this.sideFile) {
      try {
        unlinkSync(this.sideFile);
      } catch {}
    }
    try {
      db.exec("ROLLBACK");
    } catch {
      // closing the connection below ends the transaction anyway
    } finally {
      db.close();
    }
  }
}

/**
 * Acquire lock `name` under `<runtimeDir>/locks/`. Resolves to a held handle,
 * or `null` when a `try` / `bounded` wait does not acquire. Never re-entrant.
 */
export function acquireLock(runtimeDir: string, name: string, wait: { mode: "blocking" }, opts?: AcquireOptions): Promise<LockHandle>;
export function acquireLock(runtimeDir: string, name: string, wait: LockWait, opts?: AcquireOptions): Promise<LockHandle | null>;
export async function acquireLock(runtimeDir: string, name: string, wait: LockWait, opts: AcquireOptions = {}): Promise<LockHandle | null> {
  const file = lockFilePath(runtimeDir, name);
  const deadline = wait.mode === "bounded" ? Date.now() + Math.max(0, wait.timeoutMs) : null;
  ensureLockFile(file, locksDir(runtimeDir));
  const db = openLockConnection(file);
  let acquired = false;
  try {
    let backoff = MIN_BACKOFF_MS;
    for (;;) {
      if (tryBegin(db)) {
        acquired = true;
        break;
      }
      if (wait.mode === "try") return null;
      let delay = backoff;
      if (deadline !== null) {
        const left = deadline - Date.now();
        if (left <= 0) return null;
        delay = Math.min(delay, left);
      }
      await sleep(delay);
      backoff = Math.min(MAX_BACKOFF_MS, backoff * 2);
    }
  } finally {
    if (!acquired) db.close();
  }
  let sideFile: string | null = null;
  if (opts.recordHolder !== false) {
    sideFile = lockHolderPath(runtimeDir, name);
    writeHolder(sideFile, {
      lock: name,
      kind: opts.holderKind ?? processHolderKind,
      pid: process.pid,
      processStartedAtMs: PROCESS_STARTED_AT_MS,
      acquiredAtMs: Date.now(),
    });
  }
  return new HeldLock(name, db, sideFile);
}

/**
 * Run `fn` while holding lock `name`; always releases, also when `fn` throws.
 * A `try` or `bounded` wait that does not acquire throws `LockBusyError`.
 */
export async function withLock<T>(runtimeDir: string, name: string, wait: LockWait, fn: () => Promise<T>, opts?: AcquireOptions): Promise<T> {
  const handle = await acquireLock(runtimeDir, name, wait, opts);
  if (handle === null) throw new LockBusyError(name);
  try {
    return await fn();
  } finally {
    handle.release();
  }
}

/**
 * Run `fn` while holding the repo worktree lock (I-11): a blocking wait with
 * no deadline. Not re-entrant: callers must never nest it.
 */
export function withRepoWorktreeLock<T>(runtimeDir: string, fn: () => Promise<T>): Promise<T> {
  return withLock(runtimeDir, WORKTREE_LOCK, { mode: "blocking" }, fn);
}

/**
 * True when some connection, in this or another process, holds lock `name`.
 * A momentary try-lock that writes nothing (no side file); false when the
 * lock file does not exist yet.
 */
export function isLockHeld(runtimeDir: string, name: string): boolean {
  const file = lockFilePath(runtimeDir, name);
  if (!existsSync(file)) return false;
  const db = openLockConnection(file);
  try {
    if (!tryBegin(db)) return true;
    db.exec("ROLLBACK");
    return false;
  } finally {
    db.close();
  }
}

/** The side file of lock `name`, or null when absent or unreadable. Informational only. */
export function readLockHolder(runtimeDir: string, name: string): LockHolderInfo | null {
  let raw: string;
  try {
    raw = readFileSync(lockHolderPath(runtimeDir, name), "utf8");
  } catch {
    return null;
  }
  try {
    const v = JSON.parse(raw) as Partial<LockHolderInfo>;
    if (
      typeof v.kind !== "string" ||
      !Number.isInteger(v.pid) ||
      typeof v.processStartedAtMs !== "number" ||
      typeof v.acquiredAtMs !== "number"
    ) {
      return null;
    }
    return { lock: typeof v.lock === "string" ? v.lock : name, kind: v.kind, pid: v.pid!, processStartedAtMs: v.processStartedAtMs, acquiredAtMs: v.acquiredAtMs };
  } catch {
    return null;
  }
}
