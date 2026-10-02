/**
 * Service layer, knowledge (CR-2): hybrid search over the index, the note
 * list and one note's detail for the Knowledge Browser, and the index
 * refresh behind `brain index`. Returns data; adapters format it.
 *
 * Reads take no worktree lock (docs/mac-app/protocol.md §5): the index is
 * read on its own connection, and a note's content comes from Git at agent
 * HEAD (I-23, docs/mac-app/design.md §8), never from the user worktree.
 */
import type { EmbeddingProvider, ReconcileResult, RepoCoordinator } from "../core/types";
import { showFile } from "../git/git";
import { pendingIntegration } from "../git/worktree";
import { backlinks, outlinks, type Backlink, type Outlink } from "../index/backlinks";
import { rebuildIndex } from "../index/reconcile";
import { aliasesOfNote, noteById, noteCount, notesPage, type NoteRow } from "../index/queries";
import { openIndex, type IndexDb } from "../index/schema";
import { ensureEmbeddings } from "../retrieval/embeddings";
import { hybridSearch, type HybridSignals } from "../retrieval/hybrid";
import { UnknownNoteError } from "./errors";

/** One search result (protocol.md §7 `SearchHit`). */
export interface SearchHit {
  noteId: string;
  score: number;
  title: string;
  path: string;
  signals: HybridSignals;
}

export interface SearchResult {
  query: string;
  hits: SearchHit[];
}

/** Bring embeddings up to date for `embeddings`, then run hybrid search at agent HEAD's index. */
export async function search(coord: RepoCoordinator, query: string, opts: { limit: number; embeddings: EmbeddingProvider }): Promise<SearchResult> {
  const db = openIndex(coord.paths.indexDb);
  try {
    await ensureEmbeddings(db, opts.embeddings);
    const hits = await hybridSearch(db, opts.embeddings, query, { limit: opts.limit });
    const rows = hits.map((h) => {
      const note = noteById(db, h.noteId);
      return { noteId: h.noteId, score: h.score, title: note?.title ?? "(unknown)", path: note?.path ?? "", signals: h.signals };
    });
    return { query, hits: rows };
  } finally {
    db.close();
  }
}

/** Run `fn` on a fresh index connection, inside one read transaction so every query sees the same snapshot. */
function readIndex<T>(coord: RepoCoordinator, fn: (db: IndexDb) => T): T {
  const db = openIndex(coord.paths.indexDb);
  try {
    return db.transaction(() => fn(db))();
  } finally {
    db.close();
  }
}

export const DEFAULT_NOTES_PAGE = 200;

/** `notes.list` (protocol.md §4). */
export interface NotesPage {
  /** In path order, after skipping `offset`. */
  notes: NoteRow[];
  /** Every indexed note, whatever the page. */
  total: number;
}

/** One page of the indexed notes, ordered by path. `offset` ≥ 0, `limit` > 0. */
export function notesList(coord: RepoCoordinator, opts: { offset?: number; limit?: number } = {}): NotesPage {
  const offset = opts.offset ?? 0;
  const limit = opts.limit ?? DEFAULT_NOTES_PAGE;
  return readIndex(coord, (db) => ({ notes: notesPage(db, offset, limit), total: noteCount(db) }));
}

/** `notes.get` (protocol.md §7 `NoteDetail`). */
export interface NoteDetail {
  note: NoteRow;
  /** `aliasesOfNote`, in declaration order. */
  aliases: string[];
  /** The note file at `atCommit`. */
  raw: string;
  /** The agent HEAD sha that `raw` was read at. */
  atCommit: string;
  backlinks: Backlink[];
  outlinks: Outlink[];
  /** The note's path differs between `main` and agent HEAD (CR-4). */
  pendingIntegration: boolean;
}

/**
 * One note as the Knowledge Browser shows it: the index row, aliases and
 * links (one index snapshot), and the file at agent HEAD with whether its
 * path is pending integration. Agent HEAD is read once, so `raw`,
 * `atCommit` and `pendingIntegration` agree.
 *
 * Throws `UnknownNoteError` when the index has no such note, and also when
 * its indexed path is not at agent HEAD: the index can trail agent HEAD
 * briefly (an integrate moves the head before the reconcile that follows
 * it), and the note is then not at agent HEAD under that path. The client
 * refetches on the next `repo.changed`.
 */
export function noteDetail(coord: RepoCoordinator, noteId: string): NoteDetail {
  const indexed = readIndex(coord, (db) => {
    const note = noteById(db, noteId);
    return note === null ? null : { note, aliases: aliasesOfNote(db, noteId), backlinks: backlinks(db, noteId), outlinks: outlinks(db, noteId) };
  });
  if (indexed === null) throw new UnknownNoteError(noteId);
  const pending = pendingIntegration(coord.paths);
  const raw = showFile(coord.paths.agentWorktree, pending.agentHead, indexed.note.path);
  if (raw === null) throw new UnknownNoteError(noteId, `note ${noteId} (${indexed.note.path}) is not at agent HEAD ${pending.agentHead}; the index has not caught up yet`);
  return {
    note: indexed.note,
    aliases: indexed.aliases,
    raw,
    atCommit: pending.agentHead,
    backlinks: indexed.backlinks,
    outlinks: indexed.outlinks,
    pendingIntegration: pending.paths.includes(indexed.note.path),
  };
}

export type IndexRefreshResult = ReconcileResult & { notes: number; embedded: number; rebuild: boolean };

/**
 * `brain index`: report the open sequence's reconcile (`reconciled`), or
 * fully rebuild the index when `rebuild`, then embed every stale note.
 * `embeddings` is called only after the (re)index, so a provider that cannot
 * be built fails once the index is already current.
 */
export async function refreshIndex(
  coord: RepoCoordinator,
  reconciled: ReconcileResult,
  opts: { rebuild: boolean; embeddings: () => EmbeddingProvider },
): Promise<IndexRefreshResult> {
  const rebuild = opts.rebuild;
  // The open sequence already reconciled to agent HEAD (§17 step 5); report that result rather than reconciling twice.
  const r = rebuild ? await rebuildIndex(coord.paths, await coord.agentHead(), { repoId: coord.config.repoId }) : reconciled;
  const db = openIndex(coord.paths.indexDb);
  let embedded: number;
  let notes: number;
  try {
    embedded = await ensureEmbeddings(db, opts.embeddings());
    notes = (db.query("SELECT COUNT(*) AS n FROM notes").get() as { n: number }).n;
  } finally {
    db.close();
  }
  return { ...r, notes, embedded, rebuild };
}
