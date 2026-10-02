/**
 * Conversation methods (docs/mac-app/protocol.md §4, §5; design §6).
 *
 * Reads: `conversation.list`, `conversation.create` and `conversation.get`.
 * None takes a turn lock or the worktree lock: the store reads each session
 * file whole, and appends are single lines, so a read sees whole turns.
 *
 * `conversation.send` runs one turn (`runTurn`): `reply.delta` events while
 * the reply streams, then the result once the assistant turn is stored. The
 * turn's knowledge run follows in the background (the in-memory per-session
 * chain until T2.3, implementation-plan §2) and is reported as
 * `knowledge.event` notifications keyed by the user turn. Shutdown waits for
 * it (`server.knowledge`, step 4).
 */
import { conversationStore, conversationTurns, createConversation, DEFAULT_TURN_PAGE, listConversations, requireSession, storedTurns } from "../../commands/conversation";
import type { SessionSummary } from "../../conversation/store";
import { formatKnowledgeSummary, type KnowledgeEvent, type KnowledgeUpdate } from "../../pipeline/knowledge";
import { runTurn } from "../../pipeline/session";
import type { KnowledgeEventData, SendResult, TurnPageDTO } from "../dto";
import { invalidParams } from "../errors";
import { optionalPositiveInt, optionalString, requireString } from "../params";
import type { RequestContext, RpcServer } from "../server";

/** `conversation.list {}`: every session, oldest first. */
function list(ctx: RequestContext): SessionSummary[] {
  return listConversations(conversationStore(ctx.server.session.coord));
}

/** `conversation.create {}` → `{sessionId}`: a new, empty session. */
function create(ctx: RequestContext): { sessionId: string } {
  return createConversation(conversationStore(ctx.server.session.coord));
}

/**
 * `conversation.get {sessionId, limit?=100, beforeTurnId?}` → `{turns, hasMore}`:
 * the newest `limit` turns before `beforeTurnId` (or the end), in session
 * order. `UNKNOWN_SESSION`; `INVALID_PARAMS` for a `limit` that is not a
 * positive integer or a `beforeTurnId` that is not a turn of the session.
 */
function get(ctx: RequestContext): TurnPageDTO {
  const sessionId = requireString(ctx.params, "sessionId");
  const limit = optionalPositiveInt(ctx.params, "limit") ?? DEFAULT_TURN_PAGE;
  const beforeTurnId = optionalString(ctx.params, "beforeTurnId");
  return conversationTurns(conversationStore(ctx.server.session.coord), sessionId, { limit, beforeTurnId });
}

/** The knowledge events of one turn's run, as `knowledge.event` notifications. */
export interface TurnKnowledgeEvents {
  /** The run's `KnowledgeDeps.log`, for this turn only. */
  log(event: KnowledgeEvent): void;
  /** The user turn is known: send the events logged so far, then each as it comes. `knowledge` is the run's promise. */
  bind(turnId: string, knowledge: Promise<KnowledgeUpdate>): void;
}

/**
 * `knowledge.event {sessionId, turnId, event, summary?}` for one turn's run
 * (protocol §5), keyed by the user turn.
 *
 * - Each send gets its own `log` (`{...deps, log}`), so runs that overlap, in
 *   different sessions, never cross keys.
 * - The user turn's id is known only once `runTurn` returns. Events logged
 *   before `bind` are kept and sent, in order, by `bind`.
 * - `summary` (`formatKnowledgeSummary`) goes on `done` only.
 * - Every run ends with `done`. A run that failed with a programmer error
 *   logs none; `runTurn` resolves its promise to an update with the failure
 *   in `errors[]` (which `brain chat` prints as its summary), and that update
 *   is sent as the `done`.
 * - Strings are redacted: an `error` event can carry a provider's message.
 */
export function turnKnowledgeEvents(server: RpcServer, sessionId: string): TurnKnowledgeEvents {
  let turnId: string | null = null;
  const early: KnowledgeEvent[] = [];
  let ended = false;
  const send = (id: string, event: KnowledgeEvent) => {
    const data: KnowledgeEventData = { sessionId, turnId: id, event };
    if (event.type === "done") {
      ended = true;
      data.summary = formatKnowledgeSummary(event.update);
    }
    server.notify("knowledge.event", server.redactor.redactDeep(data));
  };
  return {
    log: (event) => {
      if (turnId === null) early.push(event);
      else send(turnId, event);
    },
    bind: (id, knowledge) => {
      turnId = id;
      for (const event of early.splice(0)) send(id, event);
      void knowledge.then((update) => {
        if (!ended) send(id, { type: "done", update });
      });
    },
  };
}

/**
 * `conversation.send {sessionId, text}` → `SendResult`, with `reply.delta
 * {text}` events while the reply streams.
 *
 * Errors, before anything is appended: `INVALID_PARAMS`, `UNKNOWN_SESSION`,
 * `NO_MODEL` (no model in the private env; a script or mock model needs no
 * credentials), `SESSION_BUSY` (another writer, in this process or another,
 * held the session's turn lock past the bound). `MODEL_ERROR` when the reply
 * fails: the user turn stays stored without a reply, as in `brain chat`, and
 * no knowledge run starts.
 *
 * Cancel ends the stream only: the reply is still stored, and the knowledge
 * run still happens, is tracked for shutdown and is reported.
 */
async function send(ctx: RequestContext): Promise<SendResult> {
  const sessionId = requireString(ctx.params, "sessionId");
  const text = requireString(ctx.params, "text");
  if (text.trim() === "") throw invalidParams("text must not be blank");
  const server = ctx.server;
  requireSession(conversationStore(server.session.coord), sessionId);
  const deps = await server.conversationDeps();
  const knowledge = turnKnowledgeEvents(server, sessionId);
  const r = await runTurn({ ...deps, log: knowledge.log }, sessionId, text, { onDelta: (delta) => ctx.emit("reply.delta", { text: delta }) });
  server.knowledge.track(r);
  knowledge.bind(r.turn.turnId, r.knowledge);
  const [turn, assistantTurn] = storedTurns(deps.store, sessionId, [r.turn, r.assistantTurn]);
  return { turn: turn!, assistantTurn: assistantTurn!, contextNotes: r.contextNotes };
}

export function registerConversationMethods(server: RpcServer): void {
  server.register("conversation.list", { handler: list });
  server.register("conversation.create", { handler: create });
  server.register("conversation.get", { handler: get });
  server.register("conversation.send", { handler: send });
}
