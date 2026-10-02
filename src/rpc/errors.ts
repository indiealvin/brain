/**
 * Protocol error codes (docs/mac-app/protocol.md §6) and the mapping from
 * whatever a method throws to the wire `error {code, message, data?}`.
 *
 * - `RpcError`: thrown by the adapter itself (params, lifecycle).
 * - `ServiceError` (src/commands/errors.ts): its `code` is already a protocol
 *   code. The ones that name a record also carry it in `data`:
 *   `UNKNOWN_SESSION {sessionId}`, `UNKNOWN_NOTE {noteId}`, an unknown
 *   turn as `INVALID_PARAMS {sessionId, beforeTurnId}`, and an unknown
 *   commit as `INVALID_PARAMS {sha}` (`history.diff`) or `{before}`
 *   (`history.list`).
 * - Typed core errors: `UnknownProposalError`, `ProposalNotPendingError`,
 *   `SessionBusyError`, plus `ConfigError` (an unreadable brain.toml) and the
 *   model adapters' `ModelProviderError` / `ModelRefusalError`.
 * - Anything else is a programmer error or an unexpected failure: `INTERNAL`.
 *
 * Every message passes through the caller's redactor, so a secret that
 * reached an error message (a provider echoing a key, say) never leaves the
 * process.
 */
import { ServiceError, UnknownCommitError, UnknownNoteError, UnknownSessionError, UnknownTurnError } from "../commands/errors";
import { SessionBusyError } from "../conversation/turnLock";
import { ConfigError } from "../markdown/repo";
import { ModelProviderError, ModelRefusalError } from "../model/claude";
import { ProposalNotPendingError, UnknownProposalError } from "../proposal/store";
import type { WireError } from "./dto";

export const RPC_ERROR_CODES = [
  "PROTOCOL_MISMATCH",
  "NOT_INITIALIZED",
  "ALREADY_INITIALIZED",
  "NOT_A_REPO",
  "INVALID_PARAMS",
  "UNKNOWN_METHOD",
  "UNKNOWN_SESSION",
  "UNKNOWN_NOTE",
  "UNKNOWN_PROPOSAL",
  "PROPOSAL_NOT_PENDING",
  "SESSION_BUSY",
  "NO_MODEL",
  "MODEL_ERROR",
  "CANCELLED",
  "SHUTTING_DOWN",
  "INTERNAL",
] as const;
export type RpcErrorCode = (typeof RPC_ERROR_CODES)[number];

/** An error the adapter raises with an explicit protocol code. */
export class RpcError extends Error {
  readonly code: RpcErrorCode;
  readonly data: unknown;
  constructor(code: RpcErrorCode, message: string, data?: unknown) {
    super(message);
    this.name = "RpcError";
    this.code = code;
    this.data = data;
  }
}

export function invalidParams(message: string): RpcError {
  return new RpcError("INVALID_PARAMS", message);
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Map anything thrown by a method to the wire error. `redact` scrubs secrets from the message. */
export function toWireError(e: unknown, redact: (text: string) => string = (t) => t): WireError {
  const wire = (code: RpcErrorCode, message: string, data?: unknown): WireError => (data === undefined ? { code, message: redact(message) } : { code, message: redact(message), data });
  if (e instanceof RpcError) return wire(e.code, e.message, e.data);
  if (e instanceof UnknownSessionError) return wire("UNKNOWN_SESSION", e.message, { sessionId: e.sessionId });
  if (e instanceof UnknownNoteError) return wire("UNKNOWN_NOTE", e.message, { noteId: e.noteId });
  if (e instanceof UnknownTurnError) return wire("INVALID_PARAMS", e.message, { sessionId: e.sessionId, beforeTurnId: e.turnId });
  if (e instanceof UnknownCommitError) return wire("INVALID_PARAMS", e.message, { [e.field]: e.sha });
  if (e instanceof ServiceError) return wire(e.code, e.message);
  if (e instanceof UnknownProposalError) return wire("UNKNOWN_PROPOSAL", e.message, { proposalId: e.proposalId });
  if (e instanceof ProposalNotPendingError) return wire("PROPOSAL_NOT_PENDING", e.message, { proposalId: e.proposalId, status: e.status });
  if (e instanceof SessionBusyError) return wire("SESSION_BUSY", e.message, { sessionId: e.sessionId });
  if (e instanceof ConfigError) return wire("NOT_A_REPO", e.message);
  if (e instanceof ModelProviderError || e instanceof ModelRefusalError) return wire("MODEL_ERROR", e.message);
  // Programmer errors (TypeError, …) and unexpected failures (a git subprocess, the file system).
  const name = e instanceof Error && e.name !== "Error" ? `${e.name}: ` : "";
  return wire("INTERNAL", `${name}${errorText(e)}`);
}
