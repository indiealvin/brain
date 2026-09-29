/**
 * Graph proximity for retrieval (spec §25, §44–48; I-24). Built on
 * `neighbors()` from src/index/backlinks, which follows resolved links in
 * both directions.
 */
import { neighbors } from "../index/backlinks";
import type { IndexDb } from "../index/schema";

/**
 * Every note within `hops` link-steps of any seed, mapped to its minimum
 * distance from the seed set. Seeds themselves are included at distance 0.
 * Iteration order is by distance, then note id.
 */
export function graphExpand(db: IndexDb, seedNoteIds: Iterable<string>, hops = 1): Map<string, number> {
  const dist = new Map<string, number>();
  const seeds = [...new Set(seedNoteIds)].sort();
  for (const s of seeds) dist.set(s, 0);
  if (hops <= 0) return dist;
  for (const seed of seeds) {
    // neighbors() returns ids only; distance = the smallest hop count at which an id first appears.
    let prev = new Set<string>();
    for (let h = 1; h <= hops; h++) {
      const ids = neighbors(db, seed, h);
      for (const id of ids) {
        if (prev.has(id)) continue;
        const cur = dist.get(id);
        if (cur === undefined || h < cur) dist.set(id, h);
      }
      if (ids.length === prev.size) break; // frontier exhausted: deeper hops add nothing
      prev = new Set(ids);
    }
  }
  const ordered = [...dist.entries()].sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return new Map(ordered);
}
