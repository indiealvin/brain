/**
 * RPC-only shapes (docs/mac-app/protocol.md §2, §3, §7). Every other DTO the
 * protocol sends is a type from src/core/types.ts or the service layer, sent
 * unchanged. Field names here are the wire names.
 */
import type { RpcErrorCode } from "./errors";

/** The one protocol version this server speaks (protocol §8). */
export const PROTOCOL_VERSION = 1;

// ---------------------------------------------------------------------------
// framing (protocol §2)
// ---------------------------------------------------------------------------

/** client → server. `params` may be omitted (read as `{}`); unknown fields are ignored. */
export interface RequestMessage {
  id: string;
  method: string;
  params?: Record<string, unknown>;
}

/** server → client: an event of request `id`, before its terminal message. */
export interface EventMessage {
  id: string;
  type: string;
  data: unknown;
}

/** server → client: the terminal success message of request `id`. */
export interface ResultMessage {
  id: string;
  type: "result";
  data: unknown;
}

export interface WireError {
  code: RpcErrorCode;
  /** English, for logs; never contains a secret (protocol §6). */
  message: string;
  data?: unknown;
}

/**
 * server → client: the terminal failure message of request `id`. `id` is
 * `null` when the error belongs to no request: a line that is not JSON, a
 * message without a string `id`, or a request that reuses the id of a
 * request still in flight (the original request's stream is left intact).
 */
export interface ErrorMessage {
  id: string | null;
  type: "error";
  error: WireError;
}

/** server → client: a notification (no id). */
export interface NotificationMessage {
  type: string;
  data: unknown;
}

// ---------------------------------------------------------------------------
// initialize (protocol §3)
// ---------------------------------------------------------------------------

/** The variables the providers read (protocol §3); the only keys `initialize.env` and `doctor.run.env` accept. */
export const PROVIDER_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "OPENROUTER_API_KEY",
  "OPENROUTER_BASE_URL",
  "BRAIN_MODEL_PROVIDER",
  "BRAIN_MODEL",
  "BRAIN_EFFORT",
  "BRAIN_EMBEDDINGS",
  "BRAIN_EMBEDDING_MODEL",
  "BRAIN_EMBEDDING_DIMS",
] as const;
export type ProviderEnvKey = (typeof PROVIDER_ENV_KEYS)[number];
export type ProviderEnv = Partial<Record<ProviderEnvKey, string>>;

/** Credentials among the provider variables: their values are redacted from every log line and error message. */
export const SECRET_ENV_KEYS: readonly ProviderEnvKey[] = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENROUTER_API_KEY"];

/** Default `engine.intervalMs`, the same as `brain watch --interval`. */
export const DEFAULT_ENGINE_INTERVAL_MS = 1000;

export interface InitializeParams {
  protocolVersion: number;
  client: { name: string; version: string };
  /** The user worktree (knowledge repo root). Must hold brain.toml itself; no walk-up. */
  repoPath: string;
  env?: ProviderEnv;
  engine?: { intervalMs?: number };
}

/** Who runs the repo's loop (docs/mac-app/design.md §5.3 item 2). */
export interface EngineInfo {
  loopOwner: "self" | "other";
  /** Informational, from the loop-owner lock's side file; set when "other" and known. */
  owner?: { kind: "watch" | "rpc"; pid: number };
  intervalMs: number;
}

export interface InitializeResult {
  protocolVersion: number;
  /** package.json "version". */
  brainVersion: string;
  repoId: string;
  userWorktree: string;
  /** RepoPaths.stateDir. */
  stateDir: string;
  engine: EngineInfo;
}
