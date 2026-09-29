/**
 * Index database schema (spec §49, I-23, I-24).
 *
 * `openIndex(dbPath)` opens (creating if necessary) the per-repo
 * `index.sqlite` in WAL mode and guarantees the §49 tables exist at
 * `SCHEMA_VERSION`. A version mismatch drops every table and recreates it; the
 * next `reconcileIndex` then sees `indexed_commit = NULL` and does a full
 * rebuild (§42). Nothing derived is ever written back to Markdown.
 *
 * `index_meta` holds exactly one row, maintained by code (INSERT on open when
 * absent, UPDATE afterwards) so `SELECT indexed_commit FROM index_meta` is
 * always single-valued.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";

/** Bump whenever a table shape or a stored derivation (hash formula, FTS body) changes. */
export const SCHEMA_VERSION = 1;

/** The open index handle. A plain bun:sqlite Database; callers may run SQL directly. */
export type IndexDb = Database;

/** Every table the index owns, in drop order (FTS last is fine; no FK constraints). */
export const INDEX_TABLES = ["links", "aliases", "embeddings", "notes_fts", "notes", "index_meta"] as const;

const CREATE_SQL = [
  `CREATE TABLE IF NOT EXISTS index_meta (
     repo_id TEXT,
     indexed_commit TEXT,
     schema_version INTEGER
   )`,
  `CREATE TABLE IF NOT EXISTS notes (
     note_id TEXT PRIMARY KEY,
     slug TEXT,
     slug_key TEXT UNIQUE,
     path TEXT UNIQUE,
     title TEXT,
     type TEXT,
     status TEXT,
     created_at TEXT,
     blob_hash TEXT,
     retrieval_content_hash TEXT
   )`,
  `CREATE TABLE IF NOT EXISTS aliases (
     alias TEXT,
     alias_key TEXT UNIQUE,
     note_id TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS aliases_note_id ON aliases(note_id)`,
  `CREATE TABLE IF NOT EXISTS links (
     source_note_id TEXT,
     target_key TEXT,
     target_note_id TEXT NULL,
     relationship TEXT,
     resolved INTEGER,
     section TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS links_source ON links(source_note_id)`,
  `CREATE INDEX IF NOT EXISTS links_target_key ON links(target_key)`,
  `CREATE INDEX IF NOT EXISTS links_target_note ON links(target_note_id)`,
  `CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(note_id UNINDEXED, title, body)`,
  `CREATE TABLE IF NOT EXISTS embeddings (
     note_id TEXT,
     model TEXT,
     retrieval_content_hash TEXT,
     dims INTEGER,
     vector BLOB,
     UNIQUE(note_id, model)
   )`,
];

function tableExists(db: Database, name: string): boolean {
  const row = db.query("SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name = ?").get(name);
  return row !== null;
}

function createAll(db: Database): void {
  for (const sql of CREATE_SQL) db.run(sql);
}

function dropAll(db: Database): void {
  for (const t of INDEX_TABLES) db.run(`DROP TABLE IF EXISTS ${t}`);
}

/** Ensure the single `index_meta` row exists; returns nothing. */
function ensureMetaRow(db: Database): void {
  const n = (db.query("SELECT COUNT(*) AS n FROM index_meta").get() as { n: number }).n;
  if (n === 0) {
    db.run("INSERT INTO index_meta (repo_id, indexed_commit, schema_version) VALUES (NULL, NULL, ?)", [SCHEMA_VERSION]);
  } else if (n > 1) {
    // Defensive: collapse to one row, keeping the first.
    db.run("DELETE FROM index_meta WHERE rowid <> (SELECT MIN(rowid) FROM index_meta)");
  }
}

/**
 * Open `dbPath` (creating parent directories), switch to WAL, and make the
 * §49 schema present at `SCHEMA_VERSION`. On a version mismatch every table is
 * dropped and recreated, which forces a full rebuild on the next reconcile.
 */
export function openIndex(dbPath: string): IndexDb {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath, { create: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA synchronous = NORMAL");

  let needsReset = false;
  if (tableExists(db, "index_meta")) {
    const row = db.query("SELECT schema_version FROM index_meta LIMIT 1").get() as { schema_version: number | null } | null;
    if (row !== null && row.schema_version !== SCHEMA_VERSION) needsReset = true;
  }
  if (needsReset) {
    db.transaction(() => {
      dropAll(db);
      createAll(db);
      ensureMetaRow(db);
    })();
  } else {
    db.transaction(() => {
      createAll(db);
      ensureMetaRow(db);
    })();
  }
  return db;
}

/** Currently indexed commit, or null when the index is empty / never reconciled. */
export function indexedCommitOf(db: IndexDb): string | null {
  const row = db.query("SELECT indexed_commit FROM index_meta LIMIT 1").get() as { indexed_commit: string | null } | null;
  return row?.indexed_commit ?? null;
}

/** Stored repo_id, or null when never set. */
export function repoIdOf(db: IndexDb): string | null {
  const row = db.query("SELECT repo_id FROM index_meta LIMIT 1").get() as { repo_id: string | null } | null;
  return row?.repo_id ?? null;
}

/** Set the single meta row (must be called inside the caller's transaction when atomicity matters). */
export function setIndexMeta(db: IndexDb, repoId: string, indexedCommit: string): void {
  ensureMetaRow(db);
  db.run("UPDATE index_meta SET repo_id = ?, indexed_commit = ?, schema_version = ?", [repoId, indexedCommit, SCHEMA_VERSION]);
}

/** Remove every projected row (all tables except `index_meta`, which is reset to NULL commit). */
export function clearIndex(db: IndexDb): void {
  db.run("DELETE FROM links");
  db.run("DELETE FROM aliases");
  db.run("DELETE FROM embeddings");
  db.run("DELETE FROM notes_fts");
  db.run("DELETE FROM notes");
  ensureMetaRow(db);
  db.run("UPDATE index_meta SET indexed_commit = NULL");
}
