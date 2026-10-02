/**
 * Conversation reads (docs/mac-app/protocol.md §4): `conversation.list`,
 * `conversation.create` and `conversation.get`. None takes a turn lock or
 * the worktree lock: the store reads each session file whole, and appends
 * are single lines, so a read sees whole turns.
 */
import { conversationStore, conversationTurns, createConversation, DEFAULT_TURN_PAGE, listConversations } from "../../commands/conversation";
import type { SessionSummary } from "../../conversation/store";
import type { TurnPageDTO } from "../dto";
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

export function registerConversationMethods(server: RpcServer): void {
  server.register("conversation.list", { handler: list });
  server.register("conversation.create", { handler: create });
  server.register("conversation.get", { handler: get });
}
