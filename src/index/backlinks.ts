/**
 * Graph reads derived from `links` (spec §25, I-24). Backlinks are never
 * stored in Markdown; they are always computed from the index.
 */
import type { IndexDb } from "./schema";

export interface Backlink {
  sourceNoteId: string;
  relationship: string;
  section: string;
}

export interface Outlink {
  targetKey: string;
  /** Null when the link is dangling (§24). */
  targetNoteId: string | null;
  relationship: string;
  section: string;
  resolved: boolean;
}

/** Notes linking *to* `noteId` (resolved links only). */
export function backlinks(db: IndexDb, noteId: string): Backlink[] {
  return db
    .query(
      `SELECT source_note_id AS sourceNoteId, relationship, section
       FROM links WHERE resolved = 1 AND target_note_id = ?
       ORDER BY source_note_id, relationship, section`,
    )
    .all(noteId) as Backlink[];
}

/** Links written *by* `noteId`, including dangling ones. */
export function outlinks(db: IndexDb, noteId: string): Outlink[] {
  const rows = db
    .query(
      `SELECT target_key AS targetKey, target_note_id AS targetNoteId, relationship, section, resolved
       FROM links WHERE source_note_id = ?
       ORDER BY target_key, relationship, section`,
    )
    .all(noteId) as (Omit<Outlink, "resolved"> & { resolved: number })[];
  return rows.map((r) => ({ ...r, resolved: r.resolved === 1 }));
}

/**
 * Note ids within `hops` link-steps of `noteId`, following resolved links in
 * both directions. Excludes `noteId` itself; BFS order (nearest first, ties by
 * id).
 */
export function neighbors(db: IndexDb, noteId: string, hops = 1): string[] {
  const seen = new Set<string>([noteId]);
  const out: string[] = [];
  let frontier = [noteId];
  const stmt = db.query(
    `SELECT target_note_id AS id FROM links WHERE resolved = 1 AND source_note_id = ?
     UNION
     SELECT source_note_id AS id FROM links WHERE resolved = 1 AND target_note_id = ?`,
  );
  for (let h = 0; h < hops && frontier.length > 0; h++) {
    const next = new Set<string>();
    for (const id of frontier) {
      for (const r of stmt.all(id, id) as { id: string | null }[]) {
        if (r.id === null || seen.has(r.id)) continue;
        next.add(r.id);
      }
    }
    frontier = [...next].sort();
    for (const id of frontier) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}
