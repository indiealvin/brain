/**
 * One conversation turn end to end (design §3, §4, §17):
 *
 *   append user turn → reply (one model call) → append assistant turn →
 *   return; knowledge maintenance starts in the background.
 *
 * The returned `knowledge` promise never rejects (failures land in
 * `errors[]`), so callers may ignore it, subscribe with `onKnowledge`, or
 * await it (`awaitKnowledge`). Knowledge runs for the same session are
 * chained so a later turn plans against the state the earlier one produced;
 * runs for different sessions overlap freely and rely on the coordinator's
 * in-process serialization of `submit()`.
 */
import type { BrainConfig, ConversationTurn, EmbeddingProvider, ModelProvider, RepoCoordinator } from "../core/types";
import type { ConversationStore } from "../conversation/store";
import type { IndexDb } from "../index/schema";
import { replyToTurn, type ContextNote } from "./chat";
import { processTurnForKnowledge, type KnowledgeEvent, type KnowledgeUpdate } from "./knowledge";

export interface SessionDeps {
  coord: RepoCoordinator;
  db: IndexDb;
  model: ModelProvider;
  embeddings: EmbeddingProvider;
  config: BrainConfig;
  store: ConversationStore;
  /** YYYY-MM-DD; default: today (UTC). */
  today?: string;
  log?: (e: KnowledgeEvent) => void;
  /** Trailing turns sent to the reply model. Default 40. */
  replyWindow?: number;
}

export interface RunTurnOptions {
  onKnowledge?: (u: KnowledgeUpdate) => void;
  /** Resolve only after the knowledge update finished (CLI `--wait`, tests). */
  awaitKnowledge?: boolean;
  /** Trailing turns handed to the extractor. Default 8. */
  window?: number;
  /** Streams the reply's text deltas (see `ReplyOptions.onDelta`); the stored assistant turn is the full text regardless. */
  onDelta?: (text: string) => void;
}

export interface TurnResult {
  reply: string;
  /** The user turn that was appended. */
  turn: ConversationTurn;
  assistantTurn: ConversationTurn;
  contextNotes: ContextNote[];
  /** Never rejects. */
  knowledge: Promise<KnowledgeUpdate>;
}

export const DEFAULT_REPLY_WINDOW = 40;

export function todayIso(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** Per-session chain of knowledge runs (session ids are ULIDs, globally unique). */
const tails = new Map<string, Promise<unknown>>();

function chain<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  const prev = tails.get(sessionId) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  const settled = next.then(
    () => undefined,
    () => undefined,
  );
  tails.set(sessionId, settled);
  void settled.then(() => {
    if (tails.get(sessionId) === settled) tails.delete(sessionId);
  });
  return next;
}

function failedUpdate(e: unknown): KnowledgeUpdate {
  return {
    candidates: { accepted: 0, rejected: 0 },
    mutations: [],
    proposals: [],
    dropped: [],
    noop: true,
    errors: [`knowledge: ${e instanceof Error ? e.message : String(e)}`],
  };
}

export async function runTurn(deps: SessionDeps, sessionId: string, userText: string, opts: RunTurnOptions = {}): Promise<TurnResult> {
  const { store } = deps;
  if (!store.hasSession(sessionId)) throw new Error(`unknown session ${sessionId}`);

  const turn = store.appendTurn(sessionId, "user", userText);
  const all = store.getTurns(sessionId);
  const replyWindow = Math.max(1, deps.replyWindow ?? DEFAULT_REPLY_WINDOW);
  const { reply, contextNotes } = await replyToTurn(deps, all.slice(Math.max(0, all.length - replyWindow)), opts.onDelta ? { onDelta: opts.onDelta } : {});
  const assistantTurn = store.appendTurn(sessionId, "assistant", reply);

  const knowledgeDeps = { coord: deps.coord, db: deps.db, model: deps.model, embeddings: deps.embeddings, config: deps.config, today: deps.today ?? todayIso(), ...(deps.log ? { log: deps.log } : {}) };
  const knowledge: Promise<KnowledgeUpdate> = chain(sessionId, () =>
    processTurnForKnowledge(knowledgeDeps, store.getTurns(sessionId), { ...(opts.window !== undefined ? { window: opts.window } : {}) }),
  ).catch(failedUpdate);
  if (opts.onKnowledge) {
    const cb = opts.onKnowledge;
    void knowledge.then(cb);
  }

  const result: TurnResult = { reply, turn, assistantTurn, contextNotes, knowledge };
  if (opts.awaitKnowledge) await knowledge;
  return result;
}
