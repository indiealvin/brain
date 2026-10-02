/**
 * Knowledge reads (docs/mac-app/protocol.md §4): `notes.search`,
 * `notes.list` and `notes.get`. They read the index (the projection of agent
 * HEAD) and Git at agent HEAD, never the user worktree (I-23,
 * docs/mac-app/design.md §8), and take no worktree lock.
 */
import { DEFAULT_NOTES_PAGE, noteDetail, notesList, search, type NoteDetail, type NotesPage, type SearchHit } from "../../commands/notes";
import { invalidParams } from "../errors";
import { optionalNonNegativeInt, optionalPositiveInt, requireString } from "../params";
import type { RequestContext, RpcServer } from "../server";

export const DEFAULT_SEARCH_LIMIT = 10;

/**
 * `notes.search {query, limit?=10}` → `{hits}`: hybrid search, as
 * `brain search`. Embeddings come from the session's private env (offline
 * hashing under a mock or scripted model); stale notes are embedded first.
 */
async function notesSearch(ctx: RequestContext): Promise<{ hits: SearchHit[] }> {
  const query = requireString(ctx.params, "query").trim();
  if (query === "") throw invalidParams("query must not be blank");
  const limit = optionalPositiveInt(ctx.params, "limit") ?? DEFAULT_SEARCH_LIMIT;
  const { hits } = await search(ctx.server.session.coord, query, { limit, embeddings: ctx.server.embeddingProvider() });
  return { hits };
}

/** `notes.list {offset?=0, limit?=200}` → `{notes, total}`, by path. */
function list(ctx: RequestContext): NotesPage {
  const offset = optionalNonNegativeInt(ctx.params, "offset") ?? 0;
  const limit = optionalPositiveInt(ctx.params, "limit") ?? DEFAULT_NOTES_PAGE;
  return notesList(ctx.server.session.coord, { offset, limit });
}

/** `notes.get {noteId}` → `NoteDetail` at agent HEAD. `UNKNOWN_NOTE`. */
function get(ctx: RequestContext): NoteDetail {
  return noteDetail(ctx.server.session.coord, requireString(ctx.params, "noteId"));
}

export function registerNotesMethods(server: RpcServer): void {
  server.register("notes.search", { handler: notesSearch });
  server.register("notes.list", { handler: list });
  server.register("notes.get", { handler: get });
}
