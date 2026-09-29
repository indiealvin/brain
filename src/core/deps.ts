/**
 * Dependency rules (spec §10; I-5).
 *
 * B depends on A when the planner declares it (rule 1), when A precedes B
 * and they share a target note (rule 2), or when B's content links to a
 * slug that A (an earlier CREATE) introduces (rule 3). The graph maps each
 * mutation id to its direct dependencies; `closure` walks the reverse edges
 * so an invalid mutation parks everything that transitively depends on it.
 */
import type { Mutation, QueueRow, TargetPrecondition } from "./types";
import { isNotePath, slugFromPath, slugKey } from "./slug";
import { targetNoteKey } from "./preconditions";
import { NoteParseError, parseNote } from "../markdown/parse";

/** The tree the pending mutations were planned against (the agent branch base). */
export interface SlugTree {
  hasSlug(slugKey: string): boolean;
}

const WIKILINK_RE = /\[\[([^\]|\n]+?)(?:\|[^\]\n]*)?\]\]/g;

/**
 * Note keys a mutation touches: note ids for present targets, `slug:<key>`
 * for absent targets, and additionally `slug:<key>` of every present target's
 * path so a later edit of a file created by an earlier CREATE is shared.
 */
export function sharedTargetKeys(targets: TargetPrecondition[]): Set<string> {
  const keys = new Set<string>();
  for (const t of targets) {
    keys.add(targetNoteKey(t));
    if (t.kind === "present" && isNotePath(t.path)) keys.add(`slug:${slugKey(slugFromPath(t.path))}`);
  }
  return keys;
}

/** Slugs (keys) declared absent by a mutation, i.e. the slugs a CREATE introduces. */
export function createdSlugKeys(targets: TargetPrecondition[]): Set<string> {
  const keys = new Set<string>();
  for (const t of targets) if (t.kind === "absent") keys.add(slugKey(t.slug));
  return keys;
}

/** Wikilink target keys in a note's content (parser first, regex fallback). */
export function linkTargetKeys(path: string, content: string): Set<string> {
  const keys = new Set<string>();
  if (isNotePath(path)) {
    try {
      for (const l of parseNote(path, content).links) keys.add(l.targetKey);
      return keys;
    } catch (e) {
      if (!(e instanceof NoteParseError)) throw e;
    }
  }
  WIKILINK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = WIKILINK_RE.exec(content)) !== null) {
    const target = m[1]!.trim();
    if (target !== "") keys.add(slugKey(target));
  }
  return keys;
}

function intersects<T>(a: Set<T>, b: Set<T>): boolean {
  for (const x of a) if (b.has(x)) return true;
  return false;
}

/**
 * Direct dependencies of every row: id → set of ids it depends on. `rows`
 * are ordered by seq; `mutations` supplies the materialized writes (rule 3);
 * `mainTree` answers whether a slug already exists on the base the pending
 * mutations were planned against (a link to an existing note is not a
 * dependency).
 */
export function dependencyGraph(rows: QueueRow[], mutations: Map<string, Mutation>, mainTree: SlugTree): Map<string, Set<string>> {
  const ordered = [...rows].sort((a, b) => a.seq - b.seq);
  const ids = new Set(ordered.map((r) => r.mutationId));
  const graph = new Map<string, Set<string>>();
  const shared = new Map<string, Set<string>>();
  const created = new Map<string, Set<string>>();
  for (const r of ordered) {
    shared.set(r.mutationId, sharedTargetKeys(r.targets));
    created.set(r.mutationId, createdSlugKeys(r.targets));
  }

  for (let i = 0; i < ordered.length; i++) {
    const b = ordered[i]!;
    const deps = new Set<string>();
    // Rule 1: explicit.
    for (const d of b.dependsOn) if (d !== b.mutationId && ids.has(d)) deps.add(d);

    // Rule 3 input: every wikilink target key in B's written content.
    const links = new Set<string>();
    const mb = mutations.get(b.mutationId);
    if (mb) {
      for (const w of mb.writes) {
        if (w.content === null) continue;
        for (const k of linkTargetKeys(w.path, w.content)) links.add(k);
      }
    }

    for (let j = 0; j < i; j++) {
      const a = ordered[j]!;
      // Rule 2: shared target with an earlier mutation.
      if (intersects(shared.get(a.mutationId)!, shared.get(b.mutationId)!)) {
        deps.add(a.mutationId);
        continue;
      }
      // Rule 3: B links to a slug that the earlier CREATE A introduces.
      if (a.type === "CREATE" && links.size > 0) {
        for (const s of created.get(a.mutationId)!) {
          if (links.has(s) && !mainTree.hasSlug(s)) {
            deps.add(a.mutationId);
            break;
          }
        }
      }
    }
    graph.set(b.mutationId, deps);
  }
  return graph;
}

/** `seeds` plus every mutation that transitively depends on one of them. */
export function closure(graph: Map<string, Set<string>>, seeds: Set<string>): Set<string> {
  const dependents = new Map<string, Set<string>>();
  for (const [id, deps] of graph) {
    for (const d of deps) {
      let s = dependents.get(d);
      if (!s) dependents.set(d, (s = new Set()));
      s.add(id);
    }
  }
  const out = new Set<string>(seeds);
  const stack = [...seeds];
  while (stack.length) {
    const id = stack.pop()!;
    for (const dep of dependents.get(id) ?? []) {
      if (!out.has(dep)) {
        out.add(dep);
        stack.push(dep);
      }
    }
  }
  return out;
}
