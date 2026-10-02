/**
 * Service layer, conversations (CR-2): what a caller of `runTurn` needs
 * besides the open repo. The index connection and conversation store
 * (`openSessionDeps`), creating or resuming a session (`openSession`), and
 * tracking knowledge updates still in flight so the caller can await them
 * before it closes the coordinator (`createKnowledgeTracker`).
 *
 * Turn I/O stays in the adapters: streaming the reply, spinners and the REPL
 * in the CLI, `reply.delta` events in RPC.
 */
import { openConversationStore, type ConversationStore } from "../conversation/store";
import type { EmbeddingProvider, ModelProvider, RepoCoordinator } from "../core/types";
import { openIndex } from "../index/schema";
import type { KnowledgeUpdate } from "../pipeline/knowledge";
import type { SessionDeps } from "../pipeline/session";
import { ensureEmbeddings } from "../retrieval/embeddings";
import { UnknownSessionError } from "./errors";

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
