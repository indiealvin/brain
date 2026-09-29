/**
 * Embeddings for semantic retrieval (spec §44–48, §49; I-24).
 *
 * - `HashingEmbeddingProvider`: deterministic, dependency-free feature-hashing
 *   provider (model `hashing-v1`, 256 dims) used by tests and as the fallback
 *   when no real provider is configured. Word unigrams + bigrams are hashed
 *   into a fixed-size vector with sign hashing, then L2-normalized.
 * - `ensureEmbeddings`: brings the `embeddings` table up to date for one
 *   provider. A note is (re)embedded when it has no row for `provider.model`
 *   or the row's `retrieval_content_hash` differs from `notes`. The embedded
 *   text is exactly `retrievalText()` of the note as the reconciler parsed it,
 *   recovered from the index (`notes_fts.body` is the Markdown body minus
 *   frontmatter, so `parseNote` re-derives title + sections).
 * - `cosine`: cosine similarity, NaN-free (zero vectors → 0).
 *
 * Vectors live only in SQLite as Float32Array BLOBs; nothing here writes
 * Markdown.
 */
import type { EmbeddingProvider } from "../core/types";
import { retrievalText } from "../index/reconcile";
import type { IndexDb } from "../index/schema";
import { parseNote } from "../markdown/parse";

// ---------------------------------------------------------------------------
// Hashing provider
// ---------------------------------------------------------------------------

const WORD_RE = /[\p{L}\p{N}_]+/gu;

/** FNV-1a 32-bit over a UTF-16 code-unit string, with a seed. */
function fnv1a(text: string, seed: number): number {
  let h = (0x811c9dc5 ^ seed) >>> 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Lowercased word tokens of `text` (letters, digits, underscore), in order, repeats kept. */
export function wordTokens(text: string): string[] {
  const out: string[] = [];
  for (const m of text.toLowerCase().matchAll(WORD_RE)) out.push(m[0]);
  return out;
}

export function l2Normalize(v: Float32Array): Float32Array {
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i]! * v[i]!;
  if (sum === 0) return v;
  const inv = 1 / Math.sqrt(sum);
  for (let i = 0; i < v.length; i++) v[i] = v[i]! * inv;
  return v;
}

/** Deterministic feature-hashing embedding: unigrams + bigrams, signed, L2-normalized. */
export function hashingEmbed(text: string, dims: number): Float32Array {
  const v = new Float32Array(dims);
  const tokens = wordTokens(text);
  const add = (feature: string) => {
    const h = fnv1a(feature, 0);
    const sign = fnv1a(feature, 0x9e3779b9) & 1 ? 1 : -1;
    v[h % dims] = v[h % dims]! + sign;
  };
  for (let i = 0; i < tokens.length; i++) {
    add(`u:${tokens[i]}`);
    if (i + 1 < tokens.length) add(`b:${tokens[i]} ${tokens[i + 1]}`);
  }
  return l2Normalize(v);
}

export class HashingEmbeddingProvider implements EmbeddingProvider {
  readonly model = "hashing-v1";
  readonly dims: number;

  constructor(dims = 256) {
    if (!Number.isInteger(dims) || dims <= 0) throw new Error(`HashingEmbeddingProvider: invalid dims ${dims}`);
    this.dims = dims;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map((t) => hashingEmbed(t, this.dims));
  }
}

// ---------------------------------------------------------------------------
// Vector math + BLOB codec
// ---------------------------------------------------------------------------

/** Cosine similarity; 0 when either vector has zero norm or the lengths differ. */
export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / Math.sqrt(na * nb);
}

/** Float32Array → BLOB bytes (little-endian, native). */
export function encodeVector(v: Float32Array): Uint8Array {
  return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
}

/**
 * BLOB bytes → Float32Array. Copies into a fresh, 4-aligned buffer because
 * bun:sqlite may hand back a view at an unaligned byte offset. Returns null
 * when the byte length is not a whole number of floats or does not match
 * `expectedDims` (when given).
 */
export function decodeVector(blob: Uint8Array | ArrayBuffer, expectedDims?: number): Float32Array | null {
  const u8 = blob instanceof Uint8Array ? blob : new Uint8Array(blob);
  if (u8.byteLength % 4 !== 0) return null;
  const n = u8.byteLength / 4;
  if (expectedDims !== undefined && n !== expectedDims) return null;
  const copy = new Uint8Array(n * 4);
  copy.set(u8);
  return new Float32Array(copy.buffer);
}

// ---------------------------------------------------------------------------
// Retrieval text from the index
// ---------------------------------------------------------------------------

/** Placeholder frontmatter so `parseNote` accepts an FTS body (values are never used). */
const SYNTHETIC_FRONTMATTER = "---\nid: 00000000000000000000000000\ncreated: 1970-01-01\ntype: idea\nstatus: active\n---\n";

/**
 * Rebuild the embedding input for a note from its index rows. `body` is the
 * `notes_fts.body` text (frontmatter already stripped), so re-parsing it with
 * a synthetic frontmatter block yields the same title and sections the
 * reconciler saw, and therefore the same `retrievalText` it hashed.
 */
export function retrievalTextFromFtsBody(path: string, body: string): string {
  return retrievalText(parseNote(path, SYNTHETIC_FRONTMATTER + body));
}

/** `retrievalText` for an indexed note, or null when the note is not in the index. */
export function retrievalTextFromIndex(db: IndexDb, noteId: string): string | null {
  const row = db
    .query("SELECT n.path AS path, f.body AS body FROM notes n LEFT JOIN notes_fts f ON f.note_id = n.note_id WHERE n.note_id = ?")
    .get(noteId) as { path: string; body: string | null } | null;
  if (row === null) return null;
  return retrievalTextFromFtsBody(row.path, row.body ?? "");
}

// ---------------------------------------------------------------------------
// ensureEmbeddings
// ---------------------------------------------------------------------------

interface StaleRow {
  noteId: string;
  path: string;
  hash: string;
  body: string | null;
}

/**
 * Embed every note (or only `noteIds`) whose `embeddings` row for
 * `provider.model` is missing or whose stored `retrieval_content_hash` differs
 * from the `notes` row. Rows for notes that left the index are already removed
 * by the reconciler. Returns the number of rows written; a second call with
 * an unchanged index returns 0.
 *
 * The stored hash is copied from `notes.retrieval_content_hash`, never
 * recomputed, so it always describes the text that was embedded.
 */
export async function ensureEmbeddings(db: IndexDb, provider: EmbeddingProvider, noteIds?: string[]): Promise<number> {
  if (noteIds !== undefined && noteIds.length === 0) return 0;
  const filter = noteIds === undefined ? "" : ` AND n.note_id IN (${noteIds.map(() => "?").join(",")})`;
  const stale = db
    .query(
      `SELECT n.note_id AS noteId, n.path AS path, n.retrieval_content_hash AS hash, f.body AS body
       FROM notes n
       LEFT JOIN notes_fts f ON f.note_id = n.note_id
       LEFT JOIN embeddings e ON e.note_id = n.note_id AND e.model = ?
       WHERE (e.retrieval_content_hash IS NULL OR e.retrieval_content_hash <> n.retrieval_content_hash
              OR e.dims <> ?)${filter}
       ORDER BY n.path`,
    )
    .all(provider.model, provider.dims, ...(noteIds ?? [])) as StaleRow[];
  if (stale.length === 0) return 0;

  const texts = stale.map((r) => retrievalTextFromFtsBody(r.path, r.body ?? ""));
  const vectors = await provider.embed(texts);
  if (vectors.length !== stale.length) {
    throw new Error(`ensureEmbeddings: provider returned ${vectors.length} vectors for ${stale.length} texts`);
  }
  const upsert = db.query(
    `INSERT INTO embeddings (note_id, model, retrieval_content_hash, dims, vector) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(note_id, model) DO UPDATE SET
       retrieval_content_hash = excluded.retrieval_content_hash,
       dims = excluded.dims,
       vector = excluded.vector`,
  );
  return db.transaction((): number => {
    let n = 0;
    for (let i = 0; i < stale.length; i++) {
      const row = stale[i]!;
      const vec = vectors[i]!;
      if (vec.length !== provider.dims) {
        throw new Error(`ensureEmbeddings: provider ${provider.model} returned ${vec.length} dims, expected ${provider.dims}`);
      }
      upsert.run(row.noteId, provider.model, row.hash, provider.dims, encodeVector(vec));
      n += 1;
    }
    return n;
  })();
}
