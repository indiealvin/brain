/**
 * Semantic retrieval: brute-force cosine over the stored embeddings of one
 * provider (spec §44–48). v0 scale (≤100K notes × 256 dims) fits a linear
 * scan; there is no separate vector store (design.md §19).
 */
import type { EmbeddingProvider } from "../core/types";
import type { IndexDb } from "../index/schema";
import { cosine, decodeVector } from "./embeddings";

export interface SemanticHit {
  noteId: string;
  /** Cosine similarity in [-1, 1]; higher is better. */
  score: number;
}

/**
 * Top `limit` notes by cosine between the embedded `query` and every
 * `embeddings` row for `provider.model`. Rows whose vector does not decode to
 * `provider.dims` floats are skipped. Empty or token-free query → `[]`.
 */
export async function semanticSearch(db: IndexDb, provider: EmbeddingProvider, query: string, limit = 10): Promise<SemanticHit[]> {
  if (limit <= 0 || query.trim() === "") return [];
  const [q] = await provider.embed([query]);
  if (q === undefined || q.length !== provider.dims) return [];
  // A query with no embeddable content (punctuation only) is a zero vector:
  // cosine would be 0 for every note, i.e. no signal. Treat it like an empty query.
  let norm = 0;
  for (let i = 0; i < q.length; i++) norm += q[i]! * q[i]!;
  if (norm === 0) return [];
  const rows = db
    .query("SELECT note_id AS noteId, vector FROM embeddings WHERE model = ? ORDER BY note_id")
    .all(provider.model) as { noteId: string; vector: Uint8Array }[];
  const hits: SemanticHit[] = [];
  for (const r of rows) {
    const v = decodeVector(r.vector, provider.dims);
    if (v === null) continue;
    hits.push({ noteId: r.noteId, score: cosine(q, v) });
  }
  hits.sort((a, b) => b.score - a.score || (a.noteId < b.noteId ? -1 : a.noteId > b.noteId ? 1 : 0));
  return hits.slice(0, limit);
}
