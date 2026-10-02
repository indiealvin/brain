/**
 * Typed errors raised by the service layer (src/commands). Each carries the
 * stable error code of `docs/mac-app/protocol.md` §6, so the RPC adapter maps
 * `code` and the CLI adapter prints `message` (exit code 1).
 *
 * Errors raised by core pass through the service layer unchanged; the
 * adapters map those themselves (`UnknownProposalError`,
 * `ProposalNotPendingError`, `SessionBusyError`).
 */
export type ServiceErrorCode = "NO_MODEL" | "UNKNOWN_SESSION" | "INTERNAL";

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
