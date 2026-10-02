/**
 * Small read helpers over the index (spec §22, §49).
 *
 * `namespace(db)` is the shared slug/alias namespace projected from the
 * index; the executor can use it instead of parsing every note.
 */
import type { IndexDb } from "./schema";
import { slugKey } from "../core/slug";

/** One `notes` row, camel-cased. */
export interface NoteRow {
  noteId: string;
  slug: string;
  slugKey: string;
  path: string;
  title: string;
  type: string;
  status: string;
  createdAt: string;
  blobHash: string;
  retrievalContentHash: string;
}

const NOTE_COLUMNS = `note_id AS noteId, slug, slug_key AS slugKey, path, title, type, status,
  created_at AS createdAt, blob_hash AS blobHash, retrieval_content_hash AS retrievalContentHash`;

/**
 * Resolve a slug-or-alias `key` (raw text; normalized here with `slugKey`) to
 * the owning note id: exact slug first, then exact alias (§22). Null when the
 * key is unknown (a dangling target).
 */
export function resolveKey(db: IndexDb, key: string): string | null {
  const k = slugKey(key);
  if (k === "") return null;
  const bySlug = db.query("SELECT note_id FROM notes WHERE slug_key = ?").get(k) as { note_id: string } | null;
  if (bySlug) return bySlug.note_id;
  const byAlias = db.query("SELECT note_id FROM aliases WHERE alias_key = ?").get(k) as { note_id: string } | null;
  return byAlias ? byAlias.note_id : null;
}

/** Note owning `key` (slug or alias, case-insensitive), or null. */
export function noteByKey(db: IndexDb, key: string): NoteRow | null {
  const id = resolveKey(db, key);
  return id === null ? null : noteById(db, id);
}

export function noteById(db: IndexDb, noteId: string): NoteRow | null {
  return (db.query(`SELECT ${NOTE_COLUMNS} FROM notes WHERE note_id = ?`).get(noteId) as NoteRow | null) ?? null;
}

export function noteByPath(db: IndexDb, path: string): NoteRow | null {
  return (db.query(`SELECT ${NOTE_COLUMNS} FROM notes WHERE path = ?`).get(path) as NoteRow | null) ?? null;
}

/** Every indexed note, ordered by path. */
export function allNotes(db: IndexDb): NoteRow[] {
  return db.query(`SELECT ${NOTE_COLUMNS} FROM notes ORDER BY path`).all() as NoteRow[];
}

/** At most `limit` notes in `allNotes` order (by path), skipping the first `offset`. */
export function notesPage(db: IndexDb, offset: number, limit: number): NoteRow[] {
  return db.query(`SELECT ${NOTE_COLUMNS} FROM notes ORDER BY path LIMIT ? OFFSET ?`).all(limit, offset) as NoteRow[];
}

/** Number of indexed notes. */
export function noteCount(db: IndexDb): number {
  return (db.query("SELECT COUNT(*) AS n FROM notes").get() as { n: number }).n;
}

/** Aliases (raw text) declared by `noteId`, in insertion order. */
export function aliasesOfNote(db: IndexDb, noteId: string): string[] {
  const rows = db.query("SELECT alias FROM aliases WHERE note_id = ? ORDER BY rowid").all(noteId) as { alias: string }[];
  return rows.map((r) => r.alias);
}

/**
 * The shared namespace: normalized key → owning note id. Slugs are entered
 * first so a slug always wins over an alias with the same key (§22). Same
 * shape as `buildNamespace` in src/markdown/validate.ts, so it can be handed
 * straight to `checkAliasCollision`.
 */
export function namespace(db: IndexDb): Map<string, string> {
  const ns = new Map<string, string>();
  for (const r of db.query("SELECT slug_key, note_id FROM notes ORDER BY path").all() as { slug_key: string; note_id: string }[]) {
    if (!ns.has(r.slug_key)) ns.set(r.slug_key, r.note_id);
  }
  for (const r of db.query("SELECT alias_key, note_id FROM aliases ORDER BY rowid").all() as { alias_key: string; note_id: string }[]) {
    if (!ns.has(r.alias_key)) ns.set(r.alias_key, r.note_id);
  }
  return ns;
}
