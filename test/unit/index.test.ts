/**
 * Phase 6 unit tests — index projection (spec §21, §41–43, §49; I-21..I-23).
 *
 * Drives src/index/** directly against a temp git repo; no coordinator. Only
 * pure harness helpers are imported.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { repoPaths } from "../../src/core/brainHome";
import type { RepoPaths, ReconcileResult } from "../../src/core/types";
import { reconcileIndex, rebuildIndex, retrievalContentHash, bodyForFts } from "../../src/index/reconcile";
import { openIndex, SCHEMA_VERSION, indexedCommitOf } from "../../src/index/schema";
import { namespace, noteByKey, noteById, allNotes, resolveKey } from "../../src/index/queries";
import { backlinks, outlinks, neighbors } from "../../src/index/backlinks";
import { parseNote } from "../../src/markdown/parse";
import {
  git,
  revParse,
  blobAt,
  commitAsHuman,
  makeTempKnowledgeRepo,
  withBrainHome,
  writeNote,
  noteMd,
  type TempRepo,
} from "../harness";

let repo: TempRepo;
let home: { home: string; cleanup: () => void };
let paths: RepoPaths;
let logs: string[];

beforeEach(() => {
  home = withBrainHome();
  repo = makeTempKnowledgeRepo();
  paths = repoPaths(repo.path, repo.repoId);
  logs = [];
});

afterEach(() => {
  repo.cleanup();
  home.cleanup();
});

const opts = () => ({ repo: repo.path, log: (m: string) => logs.push(m) });

async function rec(ref = "HEAD"): Promise<ReconcileResult> {
  return reconcileIndex(paths, repo.repoId, revParse(repo.path, ref), opts());
}

function q<T = any>(sql: string, ...params: any[]): T[] {
  const db = new Database(paths.indexDb, { readonly: true });
  const rows = db.query(sql).all(...params) as T[];
  db.close();
  return rows;
}

function linksTo(targetKey: string) {
  return q<{ source_note_id: string; target_note_id: string | null; resolved: number; relationship: string; section: string }>(
    "SELECT source_note_id, target_note_id, resolved, relationship, section FROM links WHERE target_key = ? ORDER BY source_note_id",
    targetKey,
  );
}

function noteRow(noteId: string) {
  return q("SELECT * FROM notes WHERE note_id = ?", noteId)[0] ?? null;
}

function meta() {
  return q<{ repo_id: string | null; indexed_commit: string | null; schema_version: number }>("SELECT * FROM index_meta");
}

/** Same dump the Phase 6 fixture uses. */
function dump(): string {
  const db = new Database(paths.indexDb, { readonly: true });
  const notes = db.query("SELECT note_id, slug, path, title, blob_hash FROM notes ORDER BY note_id").all();
  const links = db
    .query("SELECT source_note_id, target_key, target_note_id, relationship, resolved, section FROM links ORDER BY source_note_id, target_key, relationship")
    .all();
  const aliases = db.query("SELECT alias, note_id FROM aliases ORDER BY alias").all();
  db.close();
  return JSON.stringify({ notes, links, aliases });
}

/** Full-content dump (every projected table except embeddings, which the indexer never writes). */
function fullDump(): string {
  const db = new Database(paths.indexDb, { readonly: true });
  const notes = db.query("SELECT * FROM notes ORDER BY note_id").all();
  const links = db
    .query("SELECT source_note_id, target_key, target_note_id, relationship, resolved, section FROM links ORDER BY source_note_id, target_key, relationship, section")
    .all();
  const aliases = db.query("SELECT alias, alias_key, note_id FROM aliases ORDER BY alias_key").all();
  const fts = db.query("SELECT note_id, title, body FROM notes_fts ORDER BY note_id").all();
  db.close();
  return JSON.stringify({ notes, links, aliases, fts });
}

describe("schema", () => {
  test("openIndex creates the §49 tables, WAL, one meta row; version mismatch drops everything", () => {
    const db = openIndex(paths.indexDb);
    const tables = (db.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[]).map((t) => t.name);
    for (const t of ["index_meta", "notes", "aliases", "links", "notes_fts", "embeddings"]) expect(tables).toContain(t);
    expect((db.query("PRAGMA journal_mode").get() as any).journal_mode).toBe("wal");
    expect(db.query("SELECT COUNT(*) AS n FROM index_meta").get()).toEqual({ n: 1 });
    expect(indexedCommitOf(db)).toBeNull();
    db.run("INSERT INTO notes (note_id, slug, slug_key, path) VALUES ('id1','s','s','knowledge/s.md')");
    db.run("UPDATE index_meta SET schema_version = ?, indexed_commit = 'abc'", [SCHEMA_VERSION + 1]);
    db.close();

    const db2 = openIndex(paths.indexDb);
    expect(db2.query("SELECT COUNT(*) AS n FROM notes").get()).toEqual({ n: 0 });
    expect(indexedCommitOf(db2)).toBeNull();
    expect((db2.query("SELECT schema_version FROM index_meta").get() as any).schema_version).toBe(SCHEMA_VERSION);
    db2.close();
  });
});

describe("reconcileIndex: A / M / D", () => {
  test("first reconcile is a full rebuild; then adds, modifies, deletes are incremental", async () => {
    const a = writeNote(repo.path, "knowledge/a.md", { title: "A", aliases: ["Alpha"], sections: { Claim: "zebra fact a", Connections: "- supports [[b]]" } });
    const b = writeNote(repo.path, "knowledge/b.md", { title: "B", sections: { Claim: "see [[a]] and [[missing]]" } });
    commitAsHuman(repo.path, "add a b");
    const head0 = revParse(repo.path, "HEAD");

    const r0 = await rec();
    expect(r0.fullRebuild).toBe(true);
    expect(r0.indexedCommit).toBe(head0);
    expect(r0.changedPaths).toEqual(["knowledge/a.md", "knowledge/b.md"]);
    expect(r0.renames).toEqual([]);
    expect(meta()).toEqual([{ repo_id: repo.repoId, indexed_commit: head0, schema_version: SCHEMA_VERSION }]);

    const rowA = noteRow(a.id);
    expect(rowA).toMatchObject({
      note_id: a.id,
      slug: "a",
      slug_key: "a",
      path: "knowledge/a.md",
      title: "A",
      type: "idea",
      status: "active",
      created_at: "2026-09-28",
      blob_hash: blobAt(repo.path, head0, "knowledge/a.md"),
    });
    expect(rowA.retrieval_content_hash).toBe(retrievalContentHash(parseNote("knowledge/a.md", a.content)));
    expect(q("SELECT alias, alias_key, note_id FROM aliases")).toEqual([{ alias: "Alpha", alias_key: "alpha", note_id: a.id }]);
    expect(q("SELECT note_id, title, body FROM notes_fts WHERE note_id = ?", a.id)).toEqual([
      { note_id: a.id, title: "A", body: bodyForFts(parseNote("knowledge/a.md", a.content)) },
    ]);
    expect(q("SELECT body FROM notes_fts WHERE note_id = ?", a.id)[0].body).not.toContain("id:");
    expect(q("SELECT note_id FROM notes_fts WHERE notes_fts MATCH 'zebra'").map((r: any) => r.note_id)).toEqual([a.id]);

    expect(linksTo("b")).toEqual([{ source_note_id: a.id, target_note_id: b.id, resolved: 1, relationship: "supports", section: "connections" }]);
    expect(linksTo("a")).toEqual([{ source_note_id: b.id, target_note_id: a.id, resolved: 1, relationship: "related", section: "body" }]);
    expect(linksTo("missing")).toEqual([{ source_note_id: b.id, target_note_id: null, resolved: 0, relationship: "related", section: "body" }]);

    // no movement → no-op
    const rSame = await rec();
    expect(rSame).toEqual({ indexedCommit: head0, changedPaths: [], renames: [], fullRebuild: false });

    // M: title + alias change on a; A: new note c
    writeNote(repo.path, "knowledge/a.md", { id: a.id, title: "A2", aliases: ["Alpha Two"], sections: { Claim: "claim a v2" } });
    writeNote(repo.path, "knowledge/c.md", { title: "C" });
    commitAsHuman(repo.path, "modify a, add c");
    const head1 = revParse(repo.path, "HEAD");
    const r1 = await rec();
    expect(r1.fullRebuild).toBe(false);
    expect(r1.indexedCommit).toBe(head1);
    expect(r1.changedPaths).toEqual(["knowledge/a.md", "knowledge/c.md"]);
    expect(r1.renames).toEqual([]);
    expect(noteRow(a.id)).toMatchObject({ title: "A2", blob_hash: blobAt(repo.path, head1, "knowledge/a.md") });
    expect(noteRow(a.id).retrieval_content_hash).not.toBe(rowA.retrieval_content_hash);
    expect(q("SELECT alias FROM aliases WHERE note_id = ?", a.id)).toEqual([{ alias: "Alpha Two" }]);
    expect(q("SELECT * FROM links WHERE source_note_id = ?", a.id)).toEqual([]); // Connections section removed
    expect(q("SELECT title FROM notes_fts WHERE note_id = ?", a.id)).toEqual([{ title: "A2" }]);
    expect(allNotes(openIndex(paths.indexDb)).map((n) => n.slug)).toEqual(["a", "b", "c"]);

    // D: delete b
    git(repo.path, "rm", "-q", "knowledge/b.md");
    commitAsHuman(repo.path, "delete b");
    const r2 = await rec();
    expect(r2.changedPaths).toEqual(["knowledge/b.md"]);
    expect(noteRow(b.id)).toBeNull();
    expect(q("SELECT * FROM links WHERE source_note_id = ?", b.id)).toEqual([]);
    expect(q("SELECT * FROM notes_fts WHERE note_id = ?", b.id)).toEqual([]);
    expect(noteRow(a.id)).not.toBeNull();
    expect(logs).toEqual([]);
  });

  test("changes to non-note files are ignored", async () => {
    writeNote(repo.path, "knowledge/a.md", { title: "A" });
    commitAsHuman(repo.path, "add a");
    await rec();
    writeFileSync(join(repo.path, "AGENTS.md"), "# Agents\n\nmore\n");
    writeFileSync(join(repo.path, "notes.txt"), "not a note\n");
    commitAsHuman(repo.path, "edit non-notes");
    const r = await rec();
    expect(r.changedPaths).toEqual([]); // AGENTS.md has no frontmatter: not a note, not logged
    expect(logs).toEqual([]);
    writeFileSync(join(repo.path, "knowledge/half.md"), "---\nid: 01HALF\n---\n# half a note\n");
    commitAsHuman(repo.path, "add half note");
    const r2 = await rec();
    expect(r2.changedPaths).toEqual([]);
    expect(logs.length).toBe(1);
    expect(logs[0]).toContain("knowledge/half.md");
    expect(allNotes(openIndex(paths.indexDb)).map((n) => n.path)).toEqual(["knowledge/a.md"]);
  });

  test("unparsable note is skipped and logged; fixing it later indexes it; breaking it removes it", async () => {
    const a = writeNote(repo.path, "knowledge/a.md", { title: "A" });
    mkdirSync(dirname(join(repo.path, "knowledge/bad.md")), { recursive: true });
    writeFileSync(join(repo.path, "knowledge/bad.md"), "---\ncreated: 2026-01-01\n---\n# No id\n");
    commitAsHuman(repo.path, "add a + bad");
    const r0 = await rec();
    expect(r0.fullRebuild).toBe(true);
    expect(r0.changedPaths).toEqual(["knowledge/a.md"]);
    expect(logs.length).toBe(1);
    expect(logs[0]).toContain("knowledge/bad.md");
    expect(allNotes(openIndex(paths.indexDb)).map((n) => n.path)).toEqual(["knowledge/a.md"]);

    const bad = writeNote(repo.path, "knowledge/bad.md", { title: "Fixed" });
    commitAsHuman(repo.path, "fix bad");
    await rec();
    expect(noteRow(bad.id)).toMatchObject({ title: "Fixed", path: "knowledge/bad.md" });

    writeFileSync(join(repo.path, "knowledge/bad.md"), "---\nid: " + bad.id + "\n---\n# broken again\n");
    commitAsHuman(repo.path, "break bad");
    const r2 = await rec();
    expect(r2.fullRebuild).toBe(false);
    expect(noteRow(bad.id)).toBeNull();
    expect(noteRow(a.id)).not.toBeNull();
  });
});

describe("reconcileIndex: human renames (§21)", () => {
  test("git mv is reported as a rename and the row is updated in place", async () => {
    const x = writeNote(repo.path, "knowledge/x.md", { title: "X", aliases: ["Ex"], sections: { Claim: "links [[y]]" } });
    const y = writeNote(repo.path, "knowledge/y.md", { title: "Y", sections: { Claim: "links [[x]] and [[x-renamed]]" } });
    commitAsHuman(repo.path, "add x y");
    await rec();
    expect(linksTo("x")[0]).toMatchObject({ resolved: 1, target_note_id: x.id });
    expect(linksTo("x-renamed")[0]).toMatchObject({ resolved: 0, target_note_id: null });

    git(repo.path, "mv", "knowledge/x.md", "knowledge/x-renamed.md");
    commitAsHuman(repo.path, "rename x");
    const r = await rec();
    expect(r.fullRebuild).toBe(false);
    expect(r.renames).toEqual([{ noteId: x.id, oldPath: "knowledge/x.md", newPath: "knowledge/x-renamed.md", oldSlug: "x" }]);
    expect(r.changedPaths).toEqual(["knowledge/x-renamed.md", "knowledge/x.md"]);
    expect(noteRow(x.id)).toMatchObject({ path: "knowledge/x-renamed.md", slug: "x-renamed", slug_key: "x-renamed" });
    expect(q("SELECT COUNT(*) AS n FROM notes")).toEqual([{ n: 2 }]);
    // alias and outgoing links survive; inbound links follow the namespace
    expect(q("SELECT alias FROM aliases WHERE note_id = ?", x.id)).toEqual([{ alias: "Ex" }]);
    expect(linksTo("y")).toEqual([{ source_note_id: x.id, target_note_id: y.id, resolved: 1, relationship: "related", section: "body" }]);
    expect(linksTo("x")[0]).toMatchObject({ resolved: 0, target_note_id: null });
    expect(linksTo("x-renamed")[0]).toMatchObject({ resolved: 1, target_note_id: x.id });

    // a plain modification afterwards is not a rename
    writeNote(repo.path, "knowledge/x-renamed.md", { id: x.id, title: "X!", aliases: ["Ex"] });
    commitAsHuman(repo.path, "edit x");
    expect((await rec()).renames).toEqual([]);
  });

  test("delete + add with the same id (content changed, no git R) is still a rename", async () => {
    const x = writeNote(repo.path, "knowledge/x.md", { title: "X", sections: { Claim: "alpha beta gamma delta ".repeat(40) } });
    commitAsHuman(repo.path, "add x");
    await rec();

    git(repo.path, "rm", "-q", "knowledge/x.md");
    writeNote(repo.path, "sub/x-moved.md", { id: x.id, title: "X moved", sections: { Evidence: "one two three four five six ".repeat(40) } });
    commitAsHuman(repo.path, "move x with rewrite");
    expect(git(repo.path, "diff", "--name-status", "-M", "HEAD~1", "HEAD")).toMatch(/^D\tknowledge\/x\.md/m);

    const r = await rec();
    expect(r.renames).toEqual([{ noteId: x.id, oldPath: "knowledge/x.md", newPath: "sub/x-moved.md", oldSlug: "x" }]);
    expect(noteRow(x.id)).toMatchObject({ path: "sub/x-moved.md", slug: "x-moved", title: "X moved" });
    expect(q("SELECT COUNT(*) AS n FROM notes")).toEqual([{ n: 1 }]);
  });

  test("swapping two paths in one commit reports two renames without UNIQUE violations", async () => {
    const p = writeNote(repo.path, "knowledge/p.md", { title: "P" });
    const s = writeNote(repo.path, "knowledge/s.md", { title: "S" });
    commitAsHuman(repo.path, "add p s");
    await rec();
    writeNote(repo.path, "knowledge/p.md", { id: s.id, title: "S" });
    writeNote(repo.path, "knowledge/s.md", { id: p.id, title: "P" });
    commitAsHuman(repo.path, "swap");
    const r = await rec();
    expect(r.renames.sort((a, b) => a.noteId.localeCompare(b.noteId))).toEqual([
      { noteId: p.id, oldPath: "knowledge/p.md", newPath: "knowledge/s.md", oldSlug: "p" },
      { noteId: s.id, oldPath: "knowledge/s.md", newPath: "knowledge/p.md", oldSlug: "s" },
    ]);
    expect(noteRow(p.id)).toMatchObject({ path: "knowledge/s.md", slug: "s" });
    expect(noteRow(s.id)).toMatchObject({ path: "knowledge/p.md", slug: "p" });
  });

  test("a rename on the full-rebuild path (unreachable commit) is still reported", async () => {
    const x = writeNote(repo.path, "knowledge/x.md", { title: "X" });
    commitAsHuman(repo.path, "add x");
    await rec();
    git(repo.path, "mv", "knowledge/x.md", "knowledge/z.md");
    commitAsHuman(repo.path, "rename");
    const db = new Database(paths.indexDb);
    db.run("UPDATE index_meta SET indexed_commit = ?", ["0".repeat(40)]);
    db.close();
    const r = await rec();
    expect(r.fullRebuild).toBe(true);
    expect(r.renames).toEqual([{ noteId: x.id, oldPath: "knowledge/x.md", newPath: "knowledge/z.md", oldSlug: "x" }]);
  });
});

describe("reconcileIndex: link re-resolution (§43, I-23)", () => {
  test("dangling → resolved → dangling, and alias-based resolution", async () => {
    const b = writeNote(repo.path, "knowledge/b.md", { title: "B", sections: { Claim: "see [[a-note]] and [[Alpha Alias]]" } });
    commitAsHuman(repo.path, "add b");
    await rec();
    expect(linksTo("a-note")).toEqual([{ source_note_id: b.id, target_note_id: null, resolved: 0, relationship: "related", section: "body" }]);
    expect(linksTo("alpha alias")[0]).toMatchObject({ resolved: 0 });

    const a = writeNote(repo.path, "knowledge/a-note.md", { title: "A note" });
    commitAsHuman(repo.path, "add a-note");
    const r1 = await rec();
    expect(r1.fullRebuild).toBe(false);
    expect(linksTo("a-note")).toEqual([{ source_note_id: b.id, target_note_id: a.id, resolved: 1, relationship: "related", section: "body" }]);

    const c = writeNote(repo.path, "knowledge/c.md", { title: "C", aliases: ["Alpha Alias"] });
    commitAsHuman(repo.path, "add c with alias");
    await rec();
    expect(linksTo("alpha alias")).toEqual([{ source_note_id: b.id, target_note_id: c.id, resolved: 1, relationship: "related", section: "body" }]);

    // slug wins over alias: a note whose slug is "Alpha Alias" takes the key
    const d = writeNote(repo.path, "knowledge/Alpha Alias.md", { title: "D" });
    commitAsHuman(repo.path, "add slug that shadows alias");
    await rec();
    expect(linksTo("alpha alias")[0]).toMatchObject({ resolved: 1, target_note_id: d.id });
    git(repo.path, "rm", "-q", "knowledge/Alpha Alias.md");
    commitAsHuman(repo.path, "remove shadowing slug");
    await rec();
    expect(linksTo("alpha alias")[0]).toMatchObject({ resolved: 1, target_note_id: c.id });

    // alias removed from c → dangling again
    writeNote(repo.path, "knowledge/c.md", { id: c.id, title: "C" });
    commitAsHuman(repo.path, "drop alias");
    await rec();
    expect(linksTo("alpha alias")[0]).toMatchObject({ resolved: 0, target_note_id: null });

    git(repo.path, "rm", "-q", "knowledge/a-note.md");
    commitAsHuman(repo.path, "delete a-note");
    await rec();
    expect(linksTo("a-note")).toEqual([{ source_note_id: b.id, target_note_id: null, resolved: 0, relationship: "related", section: "body" }]);
    expect(noteRow(a.id)).toBeNull();
    expect(noteRow(b.id)).not.toBeNull();
    expect(logs).toEqual([]);
  });

  test("delete + add at the same path with a different id re-points inbound links", async () => {
    const a1 = writeNote(repo.path, "knowledge/a.md", { title: "A1" });
    const b = writeNote(repo.path, "knowledge/b.md", { title: "B", sections: { Claim: "[[a]]" } });
    commitAsHuman(repo.path, "add");
    await rec();
    expect(linksTo("a")[0]).toMatchObject({ target_note_id: a1.id, resolved: 1 });
    const a2 = writeNote(repo.path, "knowledge/a.md", { title: "A2 replaced" });
    commitAsHuman(repo.path, "replace a with a new note");
    const r = await rec();
    expect(r.renames).toEqual([]);
    expect(noteRow(a1.id)).toBeNull();
    expect(noteRow(a2.id)).toMatchObject({ path: "knowledge/a.md" });
    expect(linksTo("a")).toEqual([{ source_note_id: b.id, target_note_id: a2.id, resolved: 1, relationship: "related", section: "body" }]);
  });

  test("case-insensitive namespace: [[Café]] resolves to cafe.md", async () => {
    const cafe = writeNote(repo.path, "knowledge/cafe.md", { title: "Cafe" });
    const s = writeNote(repo.path, "knowledge/s.md", { title: "S", sections: { Claim: "[[Café|the café]]" } });
    commitAsHuman(repo.path, "add");
    await rec();
    expect(linksTo("cafe")).toEqual([{ source_note_id: s.id, target_note_id: cafe.id, resolved: 1, relationship: "related", section: "body" }]);
  });
});

describe("reconcileIndex: full rebuild", () => {
  test("incremental history and rebuildIndex produce identical rows", async () => {
    const b = writeNote(repo.path, "knowledge/b.md", { title: "B", sections: { Claim: "see [[a-note]] [[See]]", Connections: "- supports [[c]]\n- extends [[nowhere]]" } });
    commitAsHuman(repo.path, "1");
    await rec();
    writeNote(repo.path, "knowledge/a-note.md", { title: "A" });
    commitAsHuman(repo.path, "2");
    await rec();
    writeNote(repo.path, "knowledge/c.md", { title: "C", aliases: ["See"], sections: { Claim: "back to [[b]]" } });
    commitAsHuman(repo.path, "3");
    await rec();
    git(repo.path, "mv", "knowledge/b.md", "knowledge/b2.md");
    writeNote(repo.path, "knowledge/b2.md", { id: b.id, title: "B2", aliases: ["b"], sections: { Claim: "see [[a-note]] [[See]]", Connections: "- supports [[c]]" } });
    commitAsHuman(repo.path, "4");
    const r = await rec();
    expect(r.fullRebuild).toBe(false);
    expect(r.renames.length).toBe(1);
    const head = revParse(repo.path, "HEAD");
    const incremental = fullDump();
    expect(q("SELECT COUNT(*) AS n FROM links WHERE resolved = 1")[0].n).toBe(4);

    const rb = await rebuildIndex(paths, head, opts());
    expect(rb.fullRebuild).toBe(true);
    expect(rb.renames).toEqual([]);
    expect(fullDump()).toBe(incremental);
    expect(dump()).toBe(dump());
    expect(meta()).toEqual([{ repo_id: repo.repoId, indexed_commit: head, schema_version: SCHEMA_VERSION }]);

    // and a fresh index at the same commit is byte-identical as well
    const db = new Database(paths.indexDb);
    db.run("DELETE FROM notes; DELETE FROM aliases; DELETE FROM links; DELETE FROM notes_fts; UPDATE index_meta SET indexed_commit = NULL");
    db.close();
    const r2 = await rec();
    expect(r2.fullRebuild).toBe(true);
    expect(fullDump()).toBe(incremental);
    expect(logs).toEqual([]);
  });

  test("unreachable indexed_commit triggers a full rebuild; a later reconcile is incremental again", async () => {
    const a = writeNote(repo.path, "knowledge/a.md", { title: "A" });
    commitAsHuman(repo.path, "add a");
    await rec();
    writeNote(repo.path, "knowledge/b.md", { title: "B", sections: { Claim: "[[a]]" } });
    commitAsHuman(repo.path, "add b");
    const db = new Database(paths.indexDb);
    db.run("UPDATE index_meta SET indexed_commit = ?", ["0".repeat(40)]);
    db.close();
    const r = await rec();
    expect(r.fullRebuild).toBe(true);
    expect(r.changedPaths).toEqual(["knowledge/a.md", "knowledge/b.md"]);
    expect(linksTo("a")[0]).toMatchObject({ target_note_id: a.id, resolved: 1 });
    expect(logs.some((l) => l.includes("unreachable"))).toBe(true);
    writeNote(repo.path, "knowledge/c.md", { title: "C" });
    commitAsHuman(repo.path, "add c");
    const r2 = await rec();
    expect(r2.fullRebuild).toBe(false);
    expect(r2.changedPaths).toEqual(["knowledge/c.md"]);
  });

  test("targetCommit may be a ref and is stored as the full sha; unknown ref throws", async () => {
    writeNote(repo.path, "knowledge/a.md", { title: "A" });
    commitAsHuman(repo.path, "add a");
    const r = await reconcileIndex(paths, repo.repoId, "main", opts());
    expect(r.indexedCommit).toBe(revParse(repo.path, "main"));
    await expect(reconcileIndex(paths, repo.repoId, "no-such-ref", opts())).rejects.toThrow();
  });
});

describe("queries and backlinks", () => {
  test("namespace, noteByKey, resolveKey, backlinks, outlinks, neighbors", async () => {
    const a = writeNote(repo.path, "knowledge/a.md", { title: "A", aliases: ["Alpha", "B"], sections: { Claim: "[[b]] [[c]] [[nope]]" } });
    const b = writeNote(repo.path, "knowledge/b.md", { title: "B", sections: { Connections: "- supports [[c]]" } });
    const c = writeNote(repo.path, "knowledge/c.md", { title: "C", sections: { Claim: "[[d]]" } });
    const d = writeNote(repo.path, "knowledge/d.md", { title: "D" });
    commitAsHuman(repo.path, "add");
    await rec();
    const db = openIndex(paths.indexDb);
    try {
      // slug wins over alias "B"
      const ns = namespace(db);
      expect(ns.get("b")).toBe(b.id);
      expect(ns.get("alpha")).toBe(a.id);
      expect(ns.size).toBe(5);
      expect(resolveKey(db, "ALPHA")).toBe(a.id);
      expect(resolveKey(db, "b")).toBe(b.id);
      expect(resolveKey(db, "zzz")).toBeNull();
      expect(noteByKey(db, "Alpha")?.noteId).toBe(a.id);
      expect(noteById(db, d.id)).toMatchObject({ slug: "d", path: "knowledge/d.md", title: "D", createdAt: "2026-09-28" });

      expect(backlinks(db, c.id)).toEqual([
        { sourceNoteId: a.id, relationship: "related", section: "body" },
        { sourceNoteId: b.id, relationship: "supports", section: "connections" },
      ]);
      expect(outlinks(db, a.id)).toEqual([
        { targetKey: "b", targetNoteId: b.id, relationship: "related", section: "body", resolved: true },
        { targetKey: "c", targetNoteId: c.id, relationship: "related", section: "body", resolved: true },
        { targetKey: "nope", targetNoteId: null, relationship: "related", section: "body", resolved: false },
      ]);
      expect(neighbors(db, a.id)).toEqual([b.id, c.id].sort());
      expect(neighbors(db, d.id, 1)).toEqual([c.id]);
      expect(neighbors(db, d.id, 2)).toEqual([c.id, ...[a.id, b.id].sort()]);
      expect(neighbors(db, d.id, 0)).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("retrievalContentHash depends on title + Claim/Evidence/Evolution only", () => {
    const base = parseNote("knowledge/n.md", noteMd({ id: "01N", title: "T", sections: { Claim: "c", Evidence: "e", Evolution: "v", Other: "o" } }));
    const other = parseNote("knowledge/n.md", noteMd({ id: "01N", title: "T", sections: { Claim: "c", Evidence: "e", Evolution: "v", Other: "changed" } }));
    const claim = parseNote("knowledge/n.md", noteMd({ id: "01N", title: "T", sections: { Claim: "c2", Evidence: "e", Evolution: "v" } }));
    expect(retrievalContentHash(base)).toBe(retrievalContentHash(other));
    expect(retrievalContentHash(base)).not.toBe(retrievalContentHash(claim));
    expect(retrievalContentHash(base)).toMatch(/^[0-9a-f]{40}$/);
    expect(bodyForFts(base).startsWith("# T")).toBe(true);
  });
});
