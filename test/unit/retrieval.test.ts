/**
 * Phase 7 unit tests — hybrid retrieval (spec §44–48, §49; I-23, I-24).
 *
 * Drives src/retrieval/** against a temp git repo indexed with
 * src/index/reconcile; no coordinator. Only pure harness helpers are used.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoPaths } from "../../src/core/brainHome";
import type { RepoPaths } from "../../src/core/types";
import { reconcileIndex, retrievalText } from "../../src/index/reconcile";
import { openIndex, type IndexDb } from "../../src/index/schema";
import { parseNote } from "../../src/markdown/parse";
import { lexicalSearch, ftsQuery } from "../../src/retrieval/lexical";
import {
  HashingEmbeddingProvider,
  ensureEmbeddings,
  cosine,
  hashingEmbed,
  retrievalTextFromIndex,
  decodeVector,
} from "../../src/retrieval/embeddings";
import { semanticSearch } from "../../src/retrieval/semantic";
import { graphExpand } from "../../src/retrieval/graph";
import { hybridSearch, retrieveForPlanner } from "../../src/retrieval/hybrid";
import { commitAsHuman, makeTempKnowledgeRepo, revParse, withBrainHome, writeNote, type TempRepo } from "../harness";

let repo: TempRepo;
let home: { home: string; cleanup: () => void };
let paths: RepoPaths;
let db: IndexDb | null;
let logs: string[];
const provider = new HashingEmbeddingProvider();

/** note key → id, filled by seed(). */
let ids: Record<string, string>;

beforeEach(() => {
  home = withBrainHome();
  repo = makeTempKnowledgeRepo();
  paths = repoPaths(repo.path, repo.repoId);
  db = null;
  logs = [];
  ids = {};
});

afterEach(() => {
  db?.close();
  repo.cleanup();
  home.cleanup();
});

async function reindex(): Promise<IndexDb> {
  db?.close();
  await reconcileIndex(paths, repo.repoId, revParse(repo.path, "HEAD"), { repo: repo.path, log: (m) => logs.push(m) });
  db = openIndex(paths.indexDb);
  return db;
}

/** Eight notes. Vocabulary is chosen so each test has a clean negative control. */
function seed(): void {
  const n = (key: string, rel: string, spec: Parameters<typeof writeNote>[2]) => {
    ids[key] = writeNote(repo.path, rel, spec).id;
  };
  n("safe", "knowledge/safe-agent-changes.md", {
    title: "Safe agent changes",
    sections: {
      Claim: "Agents can make aggressive changes safely when every write is a reviewable commit.",
      Connections: "- supports [[reversibility-enables-agent-autonomy]]",
    },
  });
  n("rev", "knowledge/reversibility-enables-agent-autonomy.md", {
    title: "Reversibility enables agent autonomy",
    sections: {
      Claim: "Reversible state transitions let an autonomous system operate with less pre-approval.",
      Evidence: "Undo is cheap; review after the fact is enough for low-risk work.",
    },
  });
  n("zebra", "knowledge/zebra-stripes.md", {
    title: "Zebra stripes",
    sections: { Claim: "Zebra stripes confuse biting flies.", Evolution: "### 2026-01-01 — tentative\nStripes may also regulate temperature." },
  });
  n("coffee", "knowledge/coffee-brewing.md", {
    title: "Coffee brewing",
    sections: { Claim: "Coarse grounds and a slow pour give a sweeter cup.", Connections: "- related [[tea-steeping]]" },
  });
  n("tea", "knowledge/tea-steeping.md", {
    title: "Tea steeping",
    sections: { Claim: "Green tea steeped too hot turns bitter." },
  });
  n("fence", "knowledge/fenced-example.md", {
    title: "Fenced example",
    sections: {
      Claim: "Code fences keep headings literal.\n\n```md\n## not a heading\n# also not a title\n```",
      Evidence: "The parser ignores fenced lines.",
      Evolution: "### 2026-02-02 — confirmed\nStill true after refactor.",
      Notes: "This section is not part of the retrieval text.",
    },
  });
  n("garden", "knowledge/garden-compost.md", {
    title: "Garden compost",
    sections: { Claim: "Compost needs carbon and nitrogen in balance.", Connections: "- extends [[zebra-stripes]]" },
  });
  n("orphan", "knowledge/orphan-thought.md", {
    title: "Orphan thought",
    sections: { Claim: "Unlinked idea about lighthouse maintenance schedules." },
  });
  commitAsHuman(repo.path, "seed notes");
}

const noteIdsOf = (hits: { noteId: string }[]) => hits.map((h) => h.noteId);

describe("HashingEmbeddingProvider", () => {
  test("is deterministic, 256-dim, unit-length, and dependency-free", async () => {
    expect(provider.model).toBe("hashing-v1");
    expect(provider.dims).toBe(256);
    const [a, b] = await provider.embed(["Agents make changes", "Agents make changes"]);
    expect(a).toEqual(b);
    expect(a!.length).toBe(256);
    let norm = 0;
    for (const x of a!) norm += x * x;
    expect(Math.abs(norm - 1)).toBeLessThan(1e-5);
    expect(cosine(a!, b!)).toBeCloseTo(1, 6);
    // Zero vector (no tokens) never yields NaN.
    const [z] = await provider.embed(["   "]);
    expect(cosine(z!, a!)).toBe(0);
    expect(hashingEmbed("x y", 8).length).toBe(8);
  });

  test("shared vocabulary scores higher than unrelated text", () => {
    const q = hashingEmbed("reversible state transitions autonomy", 256);
    const near = hashingEmbed("Reversible state transitions let an autonomous system run", 256);
    const far = hashingEmbed("Zebra stripes confuse biting flies", 256);
    expect(cosine(q, near)).toBeGreaterThan(cosine(q, far));
  });

  test("decodeVector rejects wrong sizes and copies unaligned views", () => {
    const v = new Float32Array([1, 2, 3]);
    const raw = new Uint8Array(v.buffer);
    const padded = new Uint8Array(raw.length + 1);
    padded.set(raw, 1);
    const unaligned = new Uint8Array(padded.buffer, 1, raw.length);
    expect(decodeVector(unaligned)).toEqual(v);
    expect(decodeVector(raw, 4)).toBeNull();
    expect(decodeVector(raw.subarray(0, 5))).toBeNull();
  });
});

describe("lexicalSearch", () => {
  test("sanitizes FTS operators and finds exact-term notes", async () => {
    seed();
    const d = await reindex();
    expect(ftsQuery("")).toBeNull();
    expect(ftsQuery('   " * ^ : ')).toBeNull();
    expect(ftsQuery('zebra AND "flies" OR NOT stripes*')).toBe('"zebra" OR "and" OR "flies" OR "or" OR "not" OR "stripes"');
    expect(lexicalSearch(d, "", 10)).toEqual([]);
    expect(lexicalSearch(d, "()\"*", 10)).toEqual([]);

    // A term that occurs in exactly one note.
    expect(noteIdsOf(lexicalSearch(d, "lighthouse", 10))).toEqual([ids.orphan!]);
    expect(noteIdsOf(lexicalSearch(d, "Zebra", 10))).toContain(ids.zebra!);
    // Operator-laden query still works, and partial matches still rank (OR-join).
    const hits = lexicalSearch(d, 'lighthouse (compost) ^ "*', 10);
    expect(noteIdsOf(hits).sort()).toEqual([ids.orphan!, ids.garden!].sort());
    // Bare operator words are plain tokens, never syntax: no throw ("and" is a real word in two notes).
    expect(() => lexicalSearch(d, "NEAR AND OR NOT", 10)).not.toThrow();
    expect(noteIdsOf(lexicalSearch(d, "NEAR AND OR NOT", 10)).sort()).toEqual([ids.garden!, ids.coffee!, ids.fence!].sort());
    for (const h of hits) expect(Number.isFinite(h.score)).toBe(true);
    expect(lexicalSearch(d, "lighthouse compost", 1).length).toBe(1);
  });
});

describe("ensureEmbeddings", () => {
  test("embeds retrievalText exactly, is idempotent, and re-embeds only on retrieval content change", async () => {
    seed();
    let d = await reindex();
    expect(await ensureEmbeddings(d, provider)).toBe(8);
    expect(await ensureEmbeddings(d, provider)).toBe(0);

    // Stored rows: one per note for the model, dims, hash copied from notes.
    const rows = d
      .query(
        `SELECT e.note_id AS noteId, e.model AS model, e.dims AS dims, length(e.vector) AS bytes,
                (e.retrieval_content_hash = n.retrieval_content_hash) AS sameHash
         FROM embeddings e JOIN notes n ON n.note_id = e.note_id ORDER BY e.note_id`,
      )
      .all() as { noteId: string; model: string; dims: number; bytes: number; sameHash: number }[];
    expect(rows.length).toBe(8);
    for (const r of rows) expect(r).toMatchObject({ model: "hashing-v1", dims: 256, bytes: 1024, sameHash: 1 });

    // The text recovered from the index equals retrievalText of the original file (fences, Evolution, extra section).
    const raw = readFileSync(join(repo.path, "knowledge/fenced-example.md"), "utf8");
    const expected = retrievalText(parseNote("knowledge/fenced-example.md", raw));
    expect(expected).toContain("## not a heading");
    expect(expected).not.toContain("not part of the retrieval text");
    expect(retrievalTextFromIndex(d, ids.fence!)).toBe(expected);
    expect(retrievalTextFromIndex(d, "nope")).toBeNull();

    // Stored vector == embedding of that exact text.
    const stored = d.query("SELECT vector FROM embeddings WHERE note_id = ? AND model = ?").get(ids.fence!, provider.model) as { vector: Uint8Array };
    expect(decodeVector(stored.vector, 256)).toEqual(hashingEmbed(expected, 256));

    // Editing a non-retrieval section changes blob_hash but not the retrieval hash → 0 updates.
    writeNote(repo.path, "knowledge/safe-agent-changes.md", {
      id: ids.safe!,
      title: "Safe agent changes",
      sections: {
        Claim: "Agents can make aggressive changes safely when every write is a reviewable commit.",
        Connections: "- supports [[reversibility-enables-agent-autonomy]]\n- related [[tea-steeping]]",
      },
    });
    commitAsHuman(repo.path, "edit connections");
    d = await reindex();
    expect(await ensureEmbeddings(d, provider)).toBe(0);

    // Editing the Claim changes the retrieval hash → exactly that note is re-embedded.
    writeNote(repo.path, "knowledge/tea-steeping.md", { id: ids.tea!, title: "Tea steeping", sections: { Claim: "Oolong rewards a second steep." } });
    commitAsHuman(repo.path, "edit tea claim");
    d = await reindex();
    expect(await ensureEmbeddings(d, provider)).toBe(1);
    expect(await ensureEmbeddings(d, provider)).toBe(0);
    expect(noteIdsOf(await semanticSearch(d, provider, "oolong second steep", 1))).toEqual([ids.tea!]);

    // noteIds filter: only the listed notes are considered.
    d.run("DELETE FROM embeddings WHERE note_id IN (?, ?)", [ids.zebra!, ids.coffee!]);
    expect(await ensureEmbeddings(d, provider, [ids.zebra!])).toBe(1);
    expect(await ensureEmbeddings(d, provider, [])).toBe(0);
    expect(await ensureEmbeddings(d, provider)).toBe(1);

    // A second model keeps its own rows; nothing is ever written to Markdown.
    const other = new HashingEmbeddingProvider(64);
    (other as { model: string }).model = "hashing-test-64";
    expect(await ensureEmbeddings(d, other)).toBe(8);
    expect((d.query("SELECT COUNT(*) AS n FROM embeddings").get() as { n: number }).n).toBe(16);
    expect(readFileSync(join(repo.path, "knowledge/tea-steeping.md"), "utf8")).not.toMatch(/embedding|vector/i);
  });
});

describe("semanticSearch", () => {
  test("ranks a note sharing vocabulary above unrelated ones", async () => {
    seed();
    const d = await reindex();
    await ensureEmbeddings(d, provider);
    const hits = await semanticSearch(d, provider, "reversible state transitions with less pre-approval", 8);
    expect(hits.length).toBe(8);
    expect(hits[0]!.noteId).toBe(ids.rev!);
    const at = (id: string) => hits.findIndex((h) => h.noteId === id);
    expect(at(ids.rev!)).toBeLessThan(at(ids.zebra!));
    expect(at(ids.rev!)).toBeLessThan(at(ids.coffee!));
    expect(await semanticSearch(d, provider, "", 5)).toEqual([]);
    expect(await semanticSearch(d, provider, "*** — ...", 5)).toEqual([]);
    expect((await semanticSearch(d, provider, "zebra", 2)).length).toBe(2);
  });
});

describe("graphExpand", () => {
  test("returns minimum distances over resolved links in both directions", async () => {
    seed();
    const d = await reindex();
    const one = graphExpand(d, [ids.safe!], 1);
    expect([...one.entries()]).toEqual([
      [ids.safe!, 0],
      [ids.rev!, 1],
    ]);
    // zebra ← garden (backlink) at 1 hop; coffee → tea; two seeds merge with min distance.
    const two = graphExpand(d, [ids.zebra!, ids.tea!], 2);
    expect(two.get(ids.zebra!)).toBe(0);
    expect(two.get(ids.tea!)).toBe(0);
    expect(two.get(ids.garden!)).toBe(1);
    expect(two.get(ids.coffee!)).toBe(1);
    expect(two.has(ids.orphan!)).toBe(false);
    expect(graphExpand(d, [ids.orphan!], 3).size).toBe(1);
    expect(graphExpand(d, [], 2).size).toBe(0);
  });
});

describe("hybridSearch", () => {
  test("lexical mismatch (spec §57): a note reachable only through a link surfaces with a graph signal", async () => {
    seed();
    const d = await reindex();
    await ensureEmbeddings(d, provider);
    const query = "agents make aggressive changes safely";

    // Negative control: neither the lexical nor the semantic top-3 contains the target.
    expect(noteIdsOf(lexicalSearch(d, query, 10))).not.toContain(ids.rev!);
    expect(noteIdsOf(lexicalSearch(d, query, 10))[0]).toBe(ids.safe!);
    expect(noteIdsOf(await semanticSearch(d, provider, query, 3))).not.toContain(ids.rev!);

    const hits = await hybridSearch(d, provider, query, { limit: 5 });
    expect(hits.length).toBeLessThanOrEqual(5);
    expect(hits[0]!.noteId).toBe(ids.safe!);
    expect(hits[0]!.signals.lexical).toBe(1);
    expect(hits[0]!.signals.graph).toBeUndefined();
    const rev = hits.find((h) => h.noteId === ids.rev!);
    expect(rev).toBeDefined();
    expect(rev!.signals.graph).toBe(0.5);
    expect(rev!.signals.lexical).toBeUndefined();
    // With the hashing provider, unrelated notes carry small collision-noise semantic
    // scores; the linked note still lands in the top 3 of 8 on the graph signal alone.
    expect(noteIdsOf(hits).indexOf(ids.rev!)).toBeLessThan(3);
    // Scores are descending and bounded by the weight sum.
    for (let i = 1; i < hits.length; i++) expect(hits[i - 1]!.score).toBeGreaterThanOrEqual(hits[i]!.score);
    for (const h of hits) expect(h.score).toBeLessThanOrEqual(1 + 1e-9);

    // Weights and hops are honoured: zero graph weight removes the graph signal.
    const noGraph = await hybridSearch(d, provider, query, { limit: 8, weights: { graph: 0 } });
    expect(noGraph.find((h) => h.noteId === ids.rev!)?.signals.graph).toBeUndefined();
    expect(await hybridSearch(d, provider, "", { limit: 5 })).toEqual([]);
    expect(await hybridSearch(d, provider, "*** — ...", { limit: 5 })).toEqual([]);
  });

  test("retrieveForPlanner merges per-text results by max score", async () => {
    seed();
    const d = await reindex();
    await ensureEmbeddings(d, provider);
    const a = await hybridSearch(d, provider, "lighthouse maintenance", { limit: 3 });
    const b = await hybridSearch(d, provider, "zebra stripes flies", { limit: 3 });
    const merged = await retrieveForPlanner(d, provider, ["lighthouse maintenance", "zebra stripes flies"], 6);
    expect(noteIdsOf(merged)).toContain(ids.orphan!);
    expect(noteIdsOf(merged)).toContain(ids.zebra!);
    const scoreOf = (hits: { noteId: string; score: number }[], id: string) => hits.find((h) => h.noteId === id)?.score ?? -1;
    expect(scoreOf(merged, ids.orphan!)).toBe(Math.max(scoreOf(a, ids.orphan!), scoreOf(b, ids.orphan!)));
    expect(scoreOf(merged, ids.zebra!)).toBe(Math.max(scoreOf(a, ids.zebra!), scoreOf(b, ids.zebra!)));
    for (let i = 1; i < merged.length; i++) expect(merged[i - 1]!.score).toBeGreaterThanOrEqual(merged[i]!.score);
    expect(merged.length).toBeLessThanOrEqual(6);
    expect(await retrieveForPlanner(d, provider, [], 5)).toEqual([]);
  });
});
