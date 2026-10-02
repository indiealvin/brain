/**
 * RPC-only shapes (docs/mac-app/protocol.md §2, §3, §7). Every other DTO the
 * protocol sends is a type from src/core/types.ts or the service layer, sent
 * unchanged. Field names here are the wire names.
 */
import type { WatchTickResult } from "../cli/watch";
import type { TurnRole } from "../core/types";
import type { ContextNote } from "../pipeline/chat";
import type { KnowledgeEvent } from "../pipeline/knowledge";
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

// ---------------------------------------------------------------------------
// read methods (protocol §4, §7)
// ---------------------------------------------------------------------------

/**
 * The service layer's result types, sent unchanged: `RepoStatus` (cmdStatus
 * data), `SearchHit`, `NoteDetail`, `ProposalSummary` (a `Proposal` without
 * `writes`), and CR-4's: the pending-integration paths, `ProposalDetail`
 * (`proposals.get`), `FileDiff` and `HistoryEntry`.
 */
export type { RepoStatus, PendingIntegration } from "../commands/repo";
export type { SearchHit, NoteDetail } from "../commands/notes";
export type { ProposalSummary } from "../commands/proposals";
export type { ProposalDetail } from "../core/coordinator";
export type { FileDiff } from "../git/diff";
export type { HistoryEntry } from "../commands/history";

/**
 * One turn: `ConversationTurn` (src/core/types.ts) plus the timestamp the
 * store wrote (CR-8, `StoredTurn`). `knowledge?: KnowledgeTurnState` joins it
 * with the knowledge backlog (T2.5); until then it is omitted.
 */
export interface TurnDTO {
  sessionId: string;
  turnId: string;
  role: TurnRole;
  text: string;
  at: string;
}

/** `conversation.get`: the newest `limit` turns before `beforeTurnId`, in session order. */
export interface TurnPageDTO {
  turns: TurnDTO[];
  /** Older turns exist before `turns[0]`. */
  hasMore: boolean;
}

// ---------------------------------------------------------------------------
// conversation.send and knowledge notifications (protocol §4, §5; design §6)
// ---------------------------------------------------------------------------

/** `conversation.send`'s event `reply.delta`: the next piece of the reply, in order. */
export interface ReplyDelta {
  text: string;
}

/**
 * `conversation.send`'s result, sent once the assistant turn is stored
 * (`runTurn`, src/pipeline/session.ts). `turn` is the user turn the request
 * appended; its knowledge run follows as `knowledge.event` notifications.
 */
export interface SendResult {
  turn: TurnDTO;
  assistantTurn: TurnDTO;
  contextNotes: ContextNote[];
}

/**
 * `knowledge.event` notification data: one `KnowledgeEvent` of a knowledge
 * run this server executes, keyed by the session and the **user** turn whose
 * run it is. `summary` (`formatKnowledgeSummary`) is set only on `done`,
 * which ends the run. The `deferred` and `interrupted` variants (CR-5) are
 * not emitted before T2.3.
 */
export interface KnowledgeEventData {
  sessionId: string;
  turnId: string;
  event: KnowledgeEvent;
  summary?: string;
}

/** `watchTick`'s result (src/cli/watch.ts). */
export type EngineTick = WatchTickResult;

/** `engine.status`. `lastTick` is set once this server has run a tick (its loop's, or one asked for with `engine.tick`). */
export type EngineStatus = EngineInfo & { lastTick?: EngineTick };

// ---------------------------------------------------------------------------
// engine and change notifications (protocol §5)
// ---------------------------------------------------------------------------

/** A `repo.changed` domain. `knowledge` (CR-5) is added with the knowledge backlog (T2.5). */
export type RepoDomain = "git" | "index" | "queue" | "proposals" | "conversations" | "knowledge";

/** `repo.changed`: the domains whose fingerprint component moved since the previous check, and the current values. */
export interface RepoChanged {
  /** Non-empty. */
  domains: RepoDomain[];
  mainHead: string;
  agentHead: string;
  indexedCommit: string | null;
  /** Advisory: counted on the poll connection, without a staleness refresh. */
  pendingProposals: number;
}

/** `engine.humanSync`: the loop's Human Sync watcher committed quiescent edits on `main`. */
export interface EngineHumanSync {
  sha: string;
}

/** `engine.error`: the loop caught an error (redacted). Informational only. */
export interface EngineError {
  message: string;
}
