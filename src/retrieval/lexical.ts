/**
 * Lexical retrieval over `notes_fts` (spec §44–48, §49; design.md §15).
 *
 * FTS5 `bm25()` ranks matches; lower is better in SQLite, so the returned
 * `score` is the negated value (higher = better). The user's query text is
 * never handed to FTS5 verbatim: it is reduced to plain word tokens, each
 * quoted, OR-joined, so operators (`AND`, `NOT`, `*`, `"`, `^`, `:`) cannot
 * change the query semantics or raise a syntax error, and a note that matches
 * only some of the tokens still ranks.
 */
import type { IndexDb } from "../index/schema";

export interface LexicalHit {
  noteId: string;
  /** `-bm25(notes_fts)`; higher is better. Strictly comparable only within one call. */
  score: number;
}

const TOKEN_RE = /[\p{L}\p{N}_]+/gu;

/** Lowercased, de-duplicated word tokens of `text` (letters, digits, underscore), in first-seen order. */
export function queryTokens(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of text.toLowerCase().matchAll(TOKEN_RE)) {
    const t = m[0];
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

/** The sanitized FTS5 MATCH expression for `text`, or null when it has no tokens. */
export function ftsQuery(text: string): string | null {
  const tokens = queryTokens(text);
  if (tokens.length === 0) return null;
  return tokens.map((t) => `"${t.replace(/"/g, "")}"`).join(" OR ");
}

/** Top `limit` notes by BM25 over title + body. Empty / operator-only queries → `[]`. */
export function lexicalSearch(db: IndexDb, query: string, limit = 10): LexicalHit[] {
  const match = ftsQuery(query);
  if (match === null || limit <= 0) return [];
  const rows = db
    .query(
      `SELECT note_id AS noteId, bm25(notes_fts) AS rank
       FROM notes_fts WHERE notes_fts MATCH ?
       ORDER BY rank, note_id LIMIT ?`,
    )
    .all(match, limit) as { noteId: string; rank: number }[];
  return rows.map((r) => ({ noteId: r.noteId, score: -r.rank }));
}
