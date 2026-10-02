/**
 * History reads (CR-4; src/commands/history.ts, docs/mac-app/protocol.md §4
 * History, §7 `HistoryEntry`):
 *
 * - `historyList`: commits on `main`, newest first, first parents only;
 *   trailers parsed (`Actor` missing → `"human"`); `paths` against the first
 *   parent (the empty tree for the root), all of them even when filtered by
 *   `path`; paging with `limit` and `before` (exclusive; must be on `main`).
 * - `historyDiff`: a commit against its first parent, limited to a path.
 * - Bad parameters: an unknown, non-commit or non-hex sha is
 *   `UnknownCommitError` (`INVALID_PARAMS`, naming the parameter); a path
 *   outside the repository is `INVALID_PARAMS`.
 * - Read only: listing and diffing write no ref, object or index.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { ServiceError, UnknownCommitError } from "../../src/commands/errors";
import { historyDiff, historyList } from "../../src/commands/history";
import { AGENT_BRANCH } from "../../src/core/types";
import { blobAt, commitAsHuman, createMutation, git, quiescentNow, revParse, seedNote, setupEnv, writeNote, type Env } from "../harness";

let env: Env | null = null;
afterEach(async () => {
  if (env) await env.cleanup();
  env = null;
});

/** init → human seed → agent CREATE (integrated) → human-sync edit → a plain `git revert` (no trailers). */
async function scenario(): Promise<{ e: Env; init: string; seed: string; agent: string; sync: string; revert: string; mutationId: string }> {
  env = await setupEnv();
  const e = env;
  const init = revParse(e.repo.path, "main");
  const seed = seedNote(e, "knowledge/a.md", { id: "01JA0000000000000000000001", title: "A", sections: { Claim: "a" } }).sha;
  const m = createMutation("knowledge/b.md", { id: "01JA0000000000000000000002", title: "B", sections: { Claim: "b" } });
  expect((await e.coord.submit(m)).state).toBe("INTEGRATED");
  const agent = revParse(e.repo.path, "main");
  writeNote(e.repo.path, "knowledge/a.md", { id: "01JA0000000000000000000001", title: "A", sections: { Claim: "a, edited" } });
  expect((await e.coord.syncOnce(quiescentNow(e))).committed).toBe(true);
  const sync = revParse(e.repo.path, "main");
  git(e.repo.path, "revert", "--no-edit", "HEAD");
  const revert = revParse(e.repo.path, "main");
  return { e, init, seed, agent, sync, revert, mutationId: m.mutationId };
}

/** Everything a read could change: refs, the index files, loose and packed objects. */
function repoState(e: Env): string {
  return [git(e.repo.path, "for-each-ref"), git(e.repo.path, "count-objects", "-v"), git(e.repo.path, "status", "--porcelain")].join("\n");
}

describe("historyList", () => {
  test("every commit on main, newest first, with trailers, actor, committedAt and paths", async () => {
    const s = await scenario();
    const entries = historyList(s.e.coord);
    expect(entries.map((h) => h.sha)).toEqual([s.revert, s.sync, s.agent, s.seed, s.init]);
    expect(entries[0]).toEqual({ sha: s.revert, committedAt: entries[0]!.committedAt, subject: 'Revert "user: a.md"', actor: "human", paths: ["knowledge/a.md"] });
    expect(entries[1]).toMatchObject({ subject: "user: a.md", actor: "human-sync", paths: ["knowledge/a.md"] });
    expect(entries[1]!.mutationId).toBeUndefined();
    expect(entries[2]).toEqual({
      sha: s.agent,
      committedAt: entries[2]!.committedAt,
      subject: "knowledge: create fixture",
      actor: "agent",
      mutationId: s.mutationId,
      mutationType: "CREATE",
      paths: ["knowledge/b.md"],
    });
    expect(entries[3]).toMatchObject({ subject: "user: add knowledge/a.md", actor: "human", paths: ["knowledge/a.md"] });
    // The root commit against the empty tree; a commit without an Actor trailer is "human".
    expect(entries[4]).toMatchObject({ subject: "init", actor: "human", paths: [".gitignore", "AGENTS.md", "brain.toml", "knowledge/.keep"] });
    for (const h of entries) {
      expect(h.committedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/);
      expect(h.committedAt).toBe(new Date(Number(git(s.e.repo.path, "log", "-1", "--format=%ct", h.sha)) * 1000).toISOString());
    }
  });

  test("paging: limit bounds a page, before continues after the last sha (exclusive), the root ends it", async () => {
    const s = await scenario();
    expect(historyList(s.e.coord, { limit: 2 }).map((h) => h.sha)).toEqual([s.revert, s.sync]);
    expect(historyList(s.e.coord, { limit: 2, before: s.sync }).map((h) => h.sha)).toEqual([s.agent, s.seed]);
    expect(historyList(s.e.coord, { limit: 2, before: s.seed }).map((h) => h.sha)).toEqual([s.init]);
    expect(historyList(s.e.coord, { before: s.init })).toEqual([]);
    // An abbreviated sha names the same commit.
    expect(historyList(s.e.coord, { limit: 1, before: s.sync.slice(0, 12) }).map((h) => h.sha)).toEqual([s.agent]);
  });

  test("path: commits that changed that file (or a file under that directory); paths still lists every file", async () => {
    const s = await scenario();
    writeNote(s.e.repo.path, "knowledge/a.md", { id: "01JA0000000000000000000001", title: "A", sections: { Claim: "a, twice" } });
    writeNote(s.e.repo.path, "knowledge/c.md", { title: "C" });
    const both = commitAsHuman(s.e.repo.path, "user: a and c");
    const a = historyList(s.e.coord, { path: "knowledge/a.md" });
    expect(a.map((h) => h.sha)).toEqual([both, s.revert, s.sync, s.seed]);
    expect(a[0]!.paths).toEqual(["knowledge/a.md", "knowledge/c.md"]);
    expect(historyList(s.e.coord, { path: "knowledge/b.md" }).map((h) => h.sha)).toEqual([s.agent]);
    expect(historyList(s.e.coord, { path: "knowledge" }).length).toBe(6);
    expect(historyList(s.e.coord, { path: "knowledge/a.md", limit: 1, before: s.revert }).map((h) => h.sha)).toEqual([s.sync]);
    expect(historyList(s.e.coord, { path: "knowledge/none.md" })).toEqual([]);
  });

  test("main only: pending agent commits are not listed, and a before that is not on main is rejected", async () => {
    env = await setupEnv();
    const e = env;
    seedNote(e, "knowledge/a.md", { title: "A" });
    await e.coord.integrate();
    const pending = createMutation("knowledge/other.md", { title: "Other" });
    await e.coord.enqueue(pending);
    expect((await e.coord.execute(pending.mutationId)).state).toBe("COMMITTED"); // executed, not integrated
    const agentOnly = revParse(e.repo.path, AGENT_BRANCH);
    expect(agentOnly).not.toBe(revParse(e.repo.path, "main"));
    expect(historyList(e.coord).map((h) => h.sha)).not.toContain(agentOnly);
    let err: unknown;
    try {
      historyList(e.coord, { before: agentOnly });
    } catch (x) {
      err = x;
    }
    expect(err).toBeInstanceOf(UnknownCommitError);
    expect(err).toMatchObject({ code: "INVALID_PARAMS", field: "before", sha: agentOnly });
  });

  test("a merge made by hand is one entry compared with its first parent; the side branch is not walked", async () => {
    env = await setupEnv();
    const e = env;
    git(e.repo.path, "checkout", "-q", "-b", "side");
    writeNote(e.repo.path, "knowledge/side.md", { title: "Side" });
    const side = commitAsHuman(e.repo.path, "user: side");
    git(e.repo.path, "checkout", "-q", "main");
    const mainSide = seedNote(e, "knowledge/main.md", { title: "Main" }).sha;
    git(e.repo.path, "merge", "-q", "--no-ff", "-m", "merge side", "side");
    const merge = revParse(e.repo.path, "main");
    const entries = historyList(e.coord);
    expect(entries.map((h) => h.sha).slice(0, 2)).toEqual([merge, mainSide]);
    expect(entries.map((h) => h.sha)).not.toContain(side);
    expect(entries[0]).toMatchObject({ subject: "merge side", actor: "human", paths: ["knowledge/side.md"] });
    expect(historyList(e.coord, { path: "knowledge/side.md" }).map((h) => h.sha)).toEqual([merge]);
  });

  test("bad parameters: unknown, non-commit and non-hex shas, paths outside the repository, a non-positive limit", async () => {
    const s = await scenario();
    const fails = (f: () => unknown): unknown => {
      try {
        f();
      } catch (x) {
        return x;
      }
      throw new Error("expected an error");
    };
    const blob = blobAt(s.e.repo.path, "main", "knowledge/a.md")!;
    for (const before of ["0".repeat(40), blob, "main", "HEAD~1", "--output=/tmp/x"]) {
      expect(fails(() => historyList(s.e.coord, { before }))).toMatchObject({ name: "UnknownCommitError", code: "INVALID_PARAMS", field: "before", sha: before });
    }
    for (const path of ["../outside", "/etc/passwd", "knowledge/../../x", ""]) {
      const err = fails(() => historyList(s.e.coord, { path }));
      expect(err).toBeInstanceOf(ServiceError);
      expect(err).toMatchObject({ code: "INVALID_PARAMS" });
    }
    expect(fails(() => historyList(s.e.coord, { limit: 0 }))).toMatchObject({ code: "INVALID_PARAMS" });
  });
});

describe("historyDiff", () => {
  test("a commit against its first parent, the root against the empty tree, limited to a path", async () => {
    const s = await scenario();
    expect(historyDiff(s.e.coord, { sha: s.agent }).map((d) => [d.path, d.change])).toEqual([["knowledge/b.md", "added"]]);
    const sync = historyDiff(s.e.coord, { sha: s.sync });
    expect(sync.map((d) => [d.path, d.change, d.additions, d.deletions])).toEqual([["knowledge/a.md", "modified", 1, 1]]);
    expect(sync[0]!.unified).toContain("\n-a\n+a, edited\n");
    expect(historyDiff(s.e.coord, { sha: s.init }).map((d) => d.change)).toEqual(["added", "added", "added", "added"]);
    expect(historyDiff(s.e.coord, { sha: s.init, path: "AGENTS.md" }).map((d) => d.path)).toEqual(["AGENTS.md"]);
    expect(historyDiff(s.e.coord, { sha: s.agent, path: "knowledge/a.md" })).toEqual([]);
    unlinkSync(join(s.e.repo.path, "knowledge/b.md"));
    const removed = commitAsHuman(s.e.repo.path, "user: drop b");
    expect(historyDiff(s.e.coord, { sha: removed.slice(0, 10) }).map((d) => [d.path, d.change])).toEqual([["knowledge/b.md", "deleted"]]);
  });

  test("any commit of the repository: a pending agent commit on agent/repo", async () => {
    env = await setupEnv();
    const e = env;
    const m = createMutation("knowledge/pending.md", { title: "Pending" });
    await e.coord.enqueue(m);
    expect((await e.coord.execute(m.mutationId)).state).toBe("COMMITTED");
    const sha = revParse(e.repo.path, AGENT_BRANCH);
    expect(historyDiff(e.coord, { sha }).map((d) => [d.path, d.change])).toEqual([["knowledge/pending.md", "added"]]);
  });

  test("an unknown, non-commit or non-hex sha is UnknownCommitError naming sha; a bad path is INVALID_PARAMS", async () => {
    const s = await scenario();
    const blob = blobAt(s.e.repo.path, "main", "knowledge/a.md")!;
    for (const sha of ["f".repeat(40), blob, "main", "-p"]) {
      let err: unknown;
      try {
        historyDiff(s.e.coord, { sha });
      } catch (x) {
        err = x;
      }
      expect(err).toBeInstanceOf(UnknownCommitError);
      expect(err).toMatchObject({ code: "INVALID_PARAMS", field: "sha", sha });
    }
    expect(() => historyDiff(s.e.coord, { sha: s.agent, path: "../x" })).toThrow(ServiceError);
  });

  test("reads write nothing: refs, objects and the index are unchanged", async () => {
    const s = await scenario();
    const before = repoState(s.e);
    historyList(s.e.coord);
    historyList(s.e.coord, { path: "knowledge/a.md", before: s.sync });
    for (const sha of [s.init, s.seed, s.agent, s.sync, s.revert]) historyDiff(s.e.coord, { sha });
    expect(repoState(s.e)).toBe(before);
  });
});
