/**
 * Hybrid retrieval (spec §44–48; design.md §15): lexical (FTS5 BM25) +
 * semantic (cosine over stored embeddings) + graph proximity, unioned and
 * reranked by a weighted sum with simple v0 weights.
 *
 * Signals are normalized to [0, 1] per query:
 *   - lexical:  by rank (`1 - rank/n`); BM25 magnitudes are not comparable
 *               across queries and degenerate on small corpora;
 *   - semantic: min-max over the semantic candidates;
 *   - graph:    `1 / (1 + distance)` from the top-3 seeds; seeds themselves get
 *               no graph credit (they already carry lexical/semantic signal).
 *
 * Deterministic: every sort tie-breaks on note id.
 */
import type { EmbeddingProvider } from "../core/types";
import type { IndexDb } from "../index/schema";
import { graphExpand } from "./graph";
import { lexicalSearch } from "./lexical";
import { semanticSearch } from "./semantic";

export interface HybridWeights {
  lexical: number;
  semantic: number;
  graph: number;
}

export interface HybridOptions {
  /** Results returned. Default 10. */
  limit?: number;
  /** Signal weights; missing keys fall back to the defaults. */
  weights?: Partial<HybridWeights>;
  /** Graph expansion depth from the seeds. Default 1. */
  hops?: number;
  /** Number of top union candidates used as graph seeds. Default 3. */
  seeds?: number;
}

export interface HybridSignals {
  lexical?: number;
  semantic?: number;
  graph?: number;
}

export interface HybridHit {
  noteId: string;
  /** Weighted sum of the normalized signals. */
  score: number;
  /**
   * Normalized per-signal contributions. A key is absent when the note was not
   * a candidate for that signal; present-but-0 means it was the weakest
   * candidate (min-max floor) and contributed nothing to `score`.
   */
  signals: HybridSignals;
}

export const DEFAULT_WEIGHTS: HybridWeights = { lexical: 0.4, semantic: 0.4, graph: 0.2 };

function byScoreThenId<T extends { noteId: string; score: number }>(a: T, b: T): number {
  return b.score - a.score || (a.noteId < b.noteId ? -1 : a.noteId > b.noteId ? 1 : 0);
}

/** Rank normalization: first → 1, last → 1/n (never 0, so a hit is distinguishable from no signal). */
function rankScores(ids: string[]): Map<string, number> {
  const m = new Map<string, number>();
  const n = ids.length;
  ids.forEach((id, i) => m.set(id, (n - i) / n));
  return m;
}

/** Min-max normalization over `hits`; a single hit or a flat set scores 1. */
function minMaxScores(hits: { noteId: string; score: number }[]): Map<string, number> {
  const m = new Map<string, number>();
  if (hits.length === 0) return m;
  let lo = Infinity;
  let hi = -Infinity;
  for (const h of hits) {
    if (h.score < lo) lo = h.score;
    if (h.score > hi) hi = h.score;
  }
  const span = hi - lo;
  for (const h of hits) m.set(h.noteId, span > 0 ? (h.score - lo) / span : 1);
  return m;
}

export async function hybridSearch(db: IndexDb, provider: EmbeddingProvider, query: string, opts: HybridOptions = {}): Promise<HybridHit[]> {
  const limit = opts.limit ?? 10;
  if (limit <= 0) return [];
  const weights: HybridWeights = { ...DEFAULT_WEIGHTS, ...opts.weights };
  const hops = opts.hops ?? 1;
  const seedCount = opts.seeds ?? 3;
  const pool = 2 * limit;

  const lexicalHits = lexicalSearch(db, query, pool);
  const semanticHits = await semanticSearch(db, provider, query, pool);
  const lex = rankScores(lexicalHits.map((h) => h.noteId));
  const sem = minMaxScores(semanticHits);

  // Union of candidates scored by lexical + semantic only, to choose seeds.
  const candidates = new Map<string, HybridHit>();
  const touch = (id: string): HybridHit => {
    let c = candidates.get(id);
    if (!c) {
      c = { noteId: id, score: 0, signals: {} };
      candidates.set(id, c);
    }
    return c;
  };
  for (const [id, s] of lex) {
    const c = touch(id);
    c.signals.lexical = s;
    c.score += weights.lexical * s;
  }
  for (const [id, s] of sem) {
    const c = touch(id);
    c.signals.semantic = s;
    c.score += weights.semantic * s;
  }
  const seeds = [...candidates.values()]
    .sort(byScoreThenId)
    .slice(0, seedCount)
    .map((c) => c.noteId);

  if (seeds.length > 0 && hops > 0 && weights.graph !== 0) {
    const seedSet = new Set(seeds);
    for (const [id, d] of graphExpand(db, seeds, hops)) {
      if (seedSet.has(id) || d === 0) continue;
      const s = 1 / (1 + d);
      const c = touch(id);
      c.signals.graph = s;
      c.score += weights.graph * s;
    }
  }

  return [...candidates.values()].sort(byScoreThenId).slice(0, limit);
}

/**
 * Retrieval for the planner (Phase 9): run `hybridSearch` for each text and
 * merge by note, keeping the maximum score and the maximum of each signal.
 * Returns the top `limit` merged hits.
 */
export async function retrieveForPlanner(
  db: IndexDb,
  provider: EmbeddingProvider,
  texts: string[],
  limit = 10,
  opts: Omit<HybridOptions, "limit"> = {},
): Promise<HybridHit[]> {
  const merged = new Map<string, HybridHit>();
  for (const text of texts) {
    for (const hit of await hybridSearch(db, provider, text, { ...opts, limit })) {
      const cur = merged.get(hit.noteId);
      if (!cur) {
        merged.set(hit.noteId, { noteId: hit.noteId, score: hit.score, signals: { ...hit.signals } });
        continue;
      }
      cur.score = Math.max(cur.score, hit.score);
      for (const k of ["lexical", "semantic", "graph"] as const) {
        const v = hit.signals[k];
        if (v === undefined) continue;
        const prev = cur.signals[k];
        cur.signals[k] = prev === undefined ? v : Math.max(prev, v);
      }
    }
  }
  return [...merged.values()].sort(byScoreThenId).slice(0, limit);
}
