/**
 * Per-session turn lock (CR-9; docs/mac-app/design.md §5.4, §5.2).
 *
 * One turn per session at a time, across processes. A writer holds the
 * session's turn lock from appending the user turn to appending the
 * assistant turn (`runTurn`), so two writers can never interleave
 * `user₁ user₂ assistant₂ assistant₁`, and turn ids, which `appendTurn`
 * allocates from the session file, are unique.
 *
 * The lock is the kernel-released CR-1 primitive (`src/sync/lock.ts`), one
 * file per session: `<runtimeDir>/locks/turn-<sessionId>.sqlite`. It has no
 * staleness rule: the kernel releases a crashed holder's lock.
 *
 * A writer makes a **bounded wait** of `TURN_LOCK_WAIT_MS` (a server constant
 * of about 1 s, not a protocol guarantee). Within the bound it proceeds after
 * the earlier turn; otherwise it fails with `SessionBusyError`
 * (`SESSION_BUSY`). Sweeps (CR-5) will use try-lock instead.
 *
 * Lock order: loop owner → knowledge → **turn** → worktree. A turn writer
 * holds only this lock: the reply never calls the coordinator.
 */
import { acquireLock, type LockHandle } from "../sync/lock";

/** The bounded wait of a turn-lock writer, in ms (design §5.4: about 1 s). */
export const TURN_LOCK_WAIT_MS = 1000;

/** The protocol error code for a session whose turn lock is held past the bound (protocol §2). */
export const SESSION_BUSY = "SESSION_BUSY";

/** Lock name of a session's turn lock: `turn-<sessionId>` (design §5.2 layout table). */
export function turnLockName(sessionId: string): string {
  return `turn-${sessionId}`;
}

/** A writer did not get the session's turn lock within the bound. */
export class SessionBusyError extends Error {
  readonly code = SESSION_BUSY;
  readonly sessionId: string;
  constructor(sessionId: string) {
    super(`session ${sessionId} is busy: another turn is in progress (${SESSION_BUSY}); try again when it finishes`);
    this.name = "SessionBusyError";
    this.sessionId = sessionId;
  }
}

/**
 * Acquire the session's turn lock with a bounded wait. Resolves to a held
 * handle (release it in a `finally`); rejects with `SessionBusyError` when
 * the bound passes. Not re-entrant.
 */
export async function acquireTurnLock(runtimeDir: string, sessionId: string, timeoutMs: number = TURN_LOCK_WAIT_MS): Promise<LockHandle> {
  const handle = await acquireLock(runtimeDir, turnLockName(sessionId), { mode: "bounded", timeoutMs });
  if (handle === null) throw new SessionBusyError(sessionId);
  return handle;
}

/** Run `fn` while holding the session's turn lock (bounded wait); always releases. */
export async function withTurnLock<T>(runtimeDir: string, sessionId: string, fn: () => Promise<T>, timeoutMs: number = TURN_LOCK_WAIT_MS): Promise<T> {
  const handle = await acquireTurnLock(runtimeDir, sessionId, timeoutMs);
  try {
    return await fn();
  } finally {
    handle.release();
  }
}
