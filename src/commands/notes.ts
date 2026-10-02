/**
 * Service layer, knowledge (CR-2): hybrid search over the index, and the
 * index refresh behind `brain index`. Returns data; adapters format it.
 */
import type { EmbeddingProvider, ReconcileResult, RepoCoordinator } from "../core/types";
import { rebuildIndex } from "../index/reconcile";
import { noteById } from "../index/queries";
import { openIndex } from "../index/schema";
import { ensureEmbeddings } from "../retrieval/embeddings";
import { hybridSearch, type HybridSignals } from "../retrieval/hybrid";

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
