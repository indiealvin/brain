/**
 * Phase 6 fixtures — index projection (spec §3.21, 3.22, §41–43, §49).
 * READ-ONLY for implementers.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { AGENT_BRANCH } from "../../src/core/types";
import { setupEnv, seedNote, writeNote, commitAsHuman, git, fileAt, aliasesOf, revParse, type Env } from "../harness";

let env: Env;
afterEach(async () => {
  if (env) await env.cleanup();
});

function linksTo(env: Env, targetKey: string): { resolved: number; target_note_id: string | null; source_note_id: string }[] {
  const db = new Database(env.coord.paths.indexDb, { readonly: true });
  const rows = db.query("SELECT source_note_id, target_note_id, resolved FROM links WHERE target_key = ?").all(targetKey) as any[];
  db.close();
  return rows;
}

function noteRow(env: Env, noteId: string): any {
  const db = new Database(env.coord.paths.indexDb, { readonly: true });
  const row = db.query("SELECT note_id, slug, path, title, type, status, blob_hash FROM notes WHERE note_id = ?").get(noteId);
  db.close();
  return row;
}

function indexedCommit(env: Env): string {
  const db = new Database(env.coord.paths.indexDb, { readonly: true });
  const row = db.query("SELECT indexed_commit FROM index_meta").get() as any;
  db.close();
  return row.indexed_commit;
}

describe("3.21 incremental index re-resolves links", () => {
  test("dangling link resolves when target appears, unresolves when it disappears, resolves via alias", async () => {
    env = await setupEnv();
    const repo = env.repo.path;
    const b = seedNote(env, "knowledge/b.md", { title: "B", sections: { Claim: "see [[a-note]] and [[Alpha Alias]]" } });
    env.clock.advance(60_000);
    await env.coord.integrate();
    const r0 = await env.coord.reconcileIndex();
    expect(r0.indexedCommit).toBe(revParse(repo, AGENT_BRANCH));
    expect(indexedCommit(env)).toBe(r0.indexedCommit);

    let rows = linksTo(env, "a-note");
    expect(rows.length).toBe(1);
    expect(rows[0]!.resolved).toBe(0);
    expect(rows[0]!.target_note_id).toBeNull();

    // target appears (human creates it)
    const a = writeNote(repo, "knowledge/a-note.md", { title: "A note" });
    commitAsHuman(repo, "user: add a-note");
    env.clock.advance(60_000);
    await env.coord.integrate();
    const r1 = await env.coord.reconcileIndex();
    expect(r1.fullRebuild).toBe(false);
    rows = linksTo(env, "a-note");
    expect(rows.length).toBe(1);
    expect(rows[0]!.resolved).toBe(1);
    expect(rows[0]!.target_note_id).toBe(a.id);
    expect(noteRow(env, a.id)?.slug).toBe("a-note");

    // alias appears on another note → the [[Alpha Alias]] link resolves
    const c = writeNote(repo, "knowledge/c.md", { title: "C", aliases: ["Alpha Alias"] });
    commitAsHuman(repo, "user: add c with alias");
    env.clock.advance(60_000);
    await env.coord.integrate();
    await env.coord.reconcileIndex();
    rows = linksTo(env, "alpha alias");
    expect(rows.length).toBe(1);
    expect(rows[0]!.resolved).toBe(1);
    expect(rows[0]!.target_note_id).toBe(c.id);

    // target disappears → unresolved again
    git(repo, "rm", "-q", "knowledge/a-note.md");
    commitAsHuman(repo, "user: delete a-note");
    env.clock.advance(60_000);
    await env.coord.integrate();
    await env.coord.reconcileIndex();
    rows = linksTo(env, "a-note");
    expect(rows.length).toBe(1);
    expect(rows[0]!.resolved).toBe(0);
    expect(noteRow(env, a.id)).toBeNull();
    expect(noteRow(env, b.id)).not.toBeNull();
  });

  test("full rebuild produces the same rows as incremental reconcile", async () => {
    env = await setupEnv();
    const repo = env.repo.path;
    seedNote(env, "knowledge/b.md", { title: "B", sections: { Claim: "see [[a-note]]", Connections: "- supports [[c]]" } });
    seedNote(env, "knowledge/a-note.md", { title: "A" });
    seedNote(env, "knowledge/c.md", { title: "C", aliases: ["See" ] });
    env.clock.advance(60_000);
    await env.coord.integrate();
    await env.coord.reconcileIndex();
    const dump = (): string => {
      const db = new Database(env.coord.paths.indexDb, { readonly: true });
      const notes = db.query("SELECT note_id, slug, path, title, blob_hash FROM notes ORDER BY note_id").all();
      const links = db.query("SELECT source_note_id, target_key, target_note_id, relationship, resolved, section FROM links ORDER BY source_note_id, target_key, relationship").all();
      const aliases = db.query("SELECT alias, note_id FROM aliases ORDER BY alias").all();
      db.close();
      return JSON.stringify({ notes, links, aliases });
    };
    const incremental = dump();
    const { rebuildIndex } = await import("../../src/index/reconcile");
    await rebuildIndex(env.coord.paths, revParse(repo, AGENT_BRANCH));
    expect(dump()).toBe(incremental);
  });
});

describe("3.22 human rename enqueues ADD_ALIAS of old slug", () => {
  test("same id at a new path is detected and the old slug becomes an alias", async () => {
    env = await setupEnv();
    const repo = env.repo.path;
    const x = seedNote(env, "knowledge/x.md", { title: "X" });
    env.clock.advance(60_000);
    await env.coord.integrate();
    await env.coord.reconcileIndex();

    git(repo, "mv", "knowledge/x.md", "knowledge/x-renamed.md");
    commitAsHuman(repo, "user: rename x");
    env.clock.advance(60_000);
    await env.coord.integrate();
    await env.coord.reconcileIndex();

    const rows = await env.coord.listMutations();
    const addAlias = rows.find((r) => r.type === "ADD_ALIAS" && r.targets.some((t) => t.kind === "present" && t.noteId === x.id));
    expect(addAlias).toBeDefined();
    if (addAlias!.state === "QUEUED") {
      const r = await env.coord.execute(addAlias!.mutationId);
      expect(r.state).toBe("COMMITTED");
    }
    const after = fileAt(repo, AGENT_BRANCH, "knowledge/x-renamed.md")!;
    expect(aliasesOf(after)).toContain("x");
    expect(noteRow(env, x.id)?.path).toBe("knowledge/x-renamed.md");
  });
});
