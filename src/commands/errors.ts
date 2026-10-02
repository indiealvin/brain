/**
 * Typed errors raised by the service layer (src/commands). Each carries the
 * stable error code of `docs/mac-app/protocol.md` §6, so the RPC adapter maps
 * `code` and the CLI adapter prints `message` (exit code 1).
 *
 * Errors raised by core pass through the service layer unchanged; the
 * adapters map those themselves (`UnknownProposalError`,
 * `ProposalNotPendingError`, `SessionBusyError`).
 */
export type ServiceErrorCode = "NO_MODEL" | "UNKNOWN_SESSION" | "UNKNOWN_NOTE" | "INVALID_PARAMS" | "INTERNAL";

export class ServiceError extends Error {
  readonly code: ServiceErrorCode;
  constructor(code: ServiceErrorCode, message: string) {
    super(message);
    this.name = "ServiceError";
    this.code = code;
  }
}

/** No usable chat model: no credentials, a provider that cannot be built, or an unreadable model script. */
export class NoModelError extends ServiceError {
  constructor(message: string) {
    super("NO_MODEL", message);
    this.name = "NoModelError";
  }
}

/** A conversation session id that the store does not know. */
export class UnknownSessionError extends ServiceError {
  readonly sessionId: string;
  constructor(sessionId: string, message: string) {
    super("UNKNOWN_SESSION", message);
    this.name = "UnknownSessionError";
    this.sessionId = sessionId;
  }
}

/** A note id the index (the projection of agent HEAD) does not hold, or whose file is not at agent HEAD. */
export class UnknownNoteError extends ServiceError {
  readonly noteId: string;
  constructor(noteId: string, message = `unknown note ${noteId}`) {
    super("UNKNOWN_NOTE", message);
    this.name = "UnknownNoteError";
    this.noteId = noteId;
  }
}

/**
 * A turn id that is not in its session: `conversation.get`'s `beforeTurnId`.
 * Turns are never removed, so a client paging with the ids it was given never
 * sees this. It is a bad parameter (`INVALID_PARAMS`), not a missing record.
 */
export class UnknownTurnError extends ServiceError {
  readonly sessionId: string;
  readonly turnId: string;
  constructor(sessionId: string, turnId: string) {
    super("INVALID_PARAMS", `turn ${turnId} is not in session ${sessionId}`);
    this.name = "UnknownTurnError";
    this.sessionId = sessionId;
    this.turnId = turnId;
  }
}
