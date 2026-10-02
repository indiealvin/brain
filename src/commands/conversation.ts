/**
 * Service layer, conversations (CR-2): what a caller of `runTurn` needs
 * besides the open repo. The index connection and conversation store
 * (`openSessionDeps`), creating or resuming a session (`openSession`), and
 * tracking knowledge updates still in flight so the caller can await them
 * before it closes the coordinator (`createKnowledgeTracker`). And the reads
 * behind `conversation.list` / `create` / `get`: listing sessions, creating
 * one, and paging a session's turns with their timestamps (CR-8).
 *
 * Turn I/O stays in the adapters: streaming the reply, spinners and the REPL
 * in the CLI, `reply.delta` events in RPC.
 */
import { openConversationStore, type ConversationStore, type SessionSummary, type StoredTurn } from "../conversation/store";
import type { EmbeddingProvider, ModelProvider, RepoCoordinator } from "../core/types";
import { openIndex } from "../index/schema";
import type { KnowledgeUpdate } from "../pipeline/knowledge";
import type { SessionDeps } from "../pipeline/session";
import { ensureEmbeddings } from "../retrieval/embeddings";
import { UnknownSessionError, UnknownTurnError } from "./errors";

export interface OpenedSessionDeps {
  /** For `runTurn`. */
  deps: SessionDeps;
  /** Closes the index connection. Call it after every knowledge update has finished. */
  close(): void;
}

/**
 * Open the index (embeddings brought up to date for `embeddings`) and the
 * conversation store for `runTurn`. On failure nothing is left open.
 */
export async function openSessionDeps(coord: RepoCoordinator, providers: { model: ModelProvider; embeddings: EmbeddingProvider }): Promise<OpenedSessionDeps> {
  const db = openIndex(coord.paths.indexDb);
  try {
    await ensureEmbeddings(db, providers.embeddings);
    const store = openConversationStore(coord.paths.conversationsDir);
    return { deps: { coord, db, model: providers.model, embeddings: providers.embeddings, config: coord.config, store }, close: () => db.close() };
  } catch (e) {
    db.close();
    throw e;
  }
}

export interface OpenedSession {
  sessionId: string;
  /** True when an existing session was requested. */
  resumed: boolean;
  /** Turns already in the session. */
  turnCount: number;
}

// ---------------------------------------------------------------------------
// reads (docs/mac-app/protocol.md §4): no turn lock, no worktree lock
// ---------------------------------------------------------------------------

/** The conversation store of `coord`'s repo. Cheap: the store keeps no state beyond its directory. */
export function conversationStore(coord: RepoCoordinator): ConversationStore {
  return openConversationStore(coord.paths.conversationsDir);
}

/** Every session, oldest first (session ids are ULIDs). */
export function listConversations(store: ConversationStore): SessionSummary[] {
  return store.listSessions();
}

/** A new, empty session. Creating takes no turn lock: no other writer can know the new id yet. */
export function createConversation(store: ConversationStore): { sessionId: string } {
  return { sessionId: store.createSession() };
}

export const DEFAULT_TURN_PAGE = 100;

/** `conversation.get` (protocol.md §4). */
export interface TurnPage {
  /** In session order. */
  turns: StoredTurn[];
  /** Older turns exist before the first one returned. */
  hasMore: boolean;
}

/**
 * The newest `limit` turns before `beforeTurnId` (or before the end of the
 * session), in session order. Pages walk backwards: the next older page is
 * `beforeTurnId = turns[0].turnId`, until `hasMore` is false. `limit` > 0.
 * Throws `UnknownSessionError`, or `UnknownTurnError` when `beforeTurnId`
 * is not a turn of the session.
 */
export function conversationTurns(store: ConversationStore, sessionId: string, opts: { limit?: number; beforeTurnId?: string } = {}): TurnPage {
  if (!store.hasSession(sessionId)) throw new UnknownSessionError(sessionId, `unknown session ${sessionId}`);
  return pageTurns(store.getStoredTurns(sessionId), sessionId, opts);
}

/** The paging of `conversationTurns` over turns already read, in session order. */
export function pageTurns(all: StoredTurn[], sessionId: string, opts: { limit?: number; beforeTurnId?: string } = {}): TurnPage {
  const limit = opts.limit ?? DEFAULT_TURN_PAGE;
  let end = all.length;
  if (opts.beforeTurnId !== undefined) {
    end = all.findIndex((t) => t.turnId === opts.beforeTurnId);
    if (end < 0) throw new UnknownTurnError(sessionId, opts.beforeTurnId);
  }
  const start = Math.max(0, end - limit);
  return { turns: all.slice(start, end), hasMore: start > 0 };
}

/** Resume `requested`, or create a new session when it is undefined. Throws `UnknownSessionError`. */
export function openSession(store: ConversationStore, requested?: string): OpenedSession {
  if (requested !== undefined && !store.hasSession(requested)) throw new UnknownSessionError(requested, `unknown session ${requested} (conversations live in ${store.dir})`);
  const sessionId = requested ?? store.createSession();
  return { sessionId, resumed: requested !== undefined, turnCount: requested !== undefined ? store.getTurns(sessionId).length : 0 };
}

/**
 * Knowledge updates still in flight (`TurnResult.knowledge`, which never
 * rejects). A process must not close the coordinator under one: `close()`
 * closes the queue under any in-flight `submit()`. `drain()` waits until none
 * is left, including updates tracked while it waits.
 */
export interface KnowledgeTracker {
  track<T extends { knowledge: Promise<KnowledgeUpdate> }>(r: T): T;
  drain(): Promise<void>;
}

export function createKnowledgeTracker(): KnowledgeTracker {
  const inFlight = new Set<Promise<KnowledgeUpdate>>();
  return {
    track: (r) => {
      inFlight.add(r.knowledge);
      void r.knowledge.finally(() => inFlight.delete(r.knowledge));
      return r;
    },
    drain: async () => {
      while (inFlight.size > 0) await Promise.all([...inFlight]);
    },
  };
}
