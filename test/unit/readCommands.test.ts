/**
 * Service-layer reads behind T1.4's RPC methods (src/commands; protocol.md §4):
 *
 * - `pendingIntegration` (CR-4): the paths that differ between `main` and
 *   agent HEAD, whichever side moved, with both heads of the same snapshot.
 * - `pageTurns`: `conversation.get`'s paging (newest `limit` turns before
 *   `beforeTurnId`, in session order) and its edge cases.
 * - `noteDetail`: content and `atCommit` at agent HEAD, never the user worktree.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { renameSync } from "node:fs";
import { join } from "node:path";
import { pageTurns } from "../../src/commands/conversation";
import { UnknownNoteError, UnknownTurnError } from "../../src/commands/errors";
import { noteDetail } from "../../src/commands/notes";
import { repoPendingIntegration } from "../../src/commands/repo";
import type { StoredTurn } from "../../src/conversation/store";
import { pendingIntegration } from "../../src/git/worktree";
import { commitAsHuman, createMutation, fileAt, noteMd, replaceMutation, revParse, seedNote, setupEnv, type Env } from "../harness";

let envs: Env[] = [];
afterEach(async () => {
  for (const e of envs) await e.cleanup();
  envs = [];
});

async function env(): Promise<Env> {
  const e = await setupEnv();
  envs.push(e);
  return e;
}

describe("pendingIntegration (CR-4)", () => {
  test("equal heads: no paths", async () => {
    const e = await env();
    seedNote(e, "knowledge/a.md", { title: "A", sections: { Claim: "a" } });
    await e.coord.integrate(); // catch the agent branch up with main
    const p = pendingIntegration(e.coord.paths);
    expect(p.mainHead).toBe(p.agentHead);
    expect(p.paths).toEqual([]);
    expect(repoPendingIntegration(e.coord)).toEqual(p);
  });

  test("agent ahead: the paths of commits waiting for integration", async () => {
    const e = await env();
    const m = createMutation("knowledge/new-idea.md", { title: "New idea", sections: { Claim: "c" } });
    await e.coord.enqueue(m);
    expect((await e.coord.execute(m.mutationId)).state).toBe("COMMITTED"); // executed, not integrated
    const p = pendingIntegration(e.coord.paths);
    expect(p.mainHead).toBe(revParse(e.repo.path, "main"));
    expect(p.agentHead).toBe(revParse(e.repo.path, "agent/repo"));
    expect(p.mainHead).not.toBe(p.agentHead);
    expect(p.paths).toEqual(["knowledge/new-idea.md"]);
  });

  test("main ahead: a human commit the agent branch has not caught up with", async () => {
    const e = await env();
    seedNote(e, "knowledge/a.md", { title: "A", sections: { Claim: "a" } });
    seedNote(e, "knowledge/b.md", { title: "B", sections: { Claim: "b" } });
    expect(pendingIntegration(e.coord.paths).paths).toEqual(["knowledge/a.md", "knowledge/b.md"]);
  });

  test("a rename lists both its old and its new path", async () => {
    const e = await env();
    seedNote(e, "knowledge/old-name.md", { title: "Old name", sections: { Claim: "same content" } });
    await e.coord.integrate();
    renameSync(join(e.repo.path, "knowledge/old-name.md"), join(e.repo.path, "knowledge/new-name.md"));
    commitAsHuman(e.repo.path, "user: rename");
    expect(pendingIntegration(e.coord.paths).paths).toEqual(["knowledge/new-name.md", "knowledge/old-name.md"]);
  });
});

describe("noteDetail", () => {
  test("raw and atCommit are agent HEAD's, not the user worktree's; an unknown id is UnknownNoteError", async () => {
    const e = await env();
    const a = seedNote(e, "knowledge/a.md", { title: "A", sections: { Claim: "a" } });
    await e.coord.integrate();
    await e.coord.reconcileIndex();
    const m = replaceMutation(e.repo.path, "main", "knowledge/a.md", noteMd({ id: a.id, title: "A", sections: { Claim: "a", Evidence: "- e" } }));
    await e.coord.enqueue(m);
    expect((await e.coord.execute(m.mutationId)).state).toBe("COMMITTED");
    await Bun.write(join(e.repo.path, "knowledge/a.md"), "unsaved user edit\n");

    const d = noteDetail(e.coord, a.id);
    const agent = revParse(e.repo.path, "agent/repo");
    expect(d.atCommit).toBe(agent);
    expect(d.raw).toBe(fileAt(e.repo.path, agent, "knowledge/a.md")!);
    expect(d.raw).toContain("## Evidence");
    expect(d.pendingIntegration).toBe(true);
    expect(d.note).toMatchObject({ noteId: a.id, path: "knowledge/a.md" });
    expect(() => noteDetail(e.coord, "01JA00000000000000000000ZZ")).toThrow(UnknownNoteError);
  });
});

describe("pageTurns (conversation.get)", () => {
  const turns: StoredTurn[] = ["000001", "000002", "000003", "000004", "000005"].map((turnId, i) => ({
    sessionId: "S",
    turnId,
    role: i % 2 === 0 ? "user" : "assistant",
    text: `t${i + 1}`,
    at: `2026-10-02T00:00:0${i}.000Z`,
  }));
  const ids = (p: { turns: StoredTurn[] }) => p.turns.map((t) => t.turnId);

  test("newest limit turns before the end, in session order; walking back with beforeTurnId = turns[0]", () => {
    const p1 = pageTurns(turns, "S", { limit: 2 });
    expect([ids(p1), p1.hasMore]).toEqual([["000004", "000005"], true]);
    const p2 = pageTurns(turns, "S", { limit: 2, beforeTurnId: p1.turns[0]!.turnId });
    expect([ids(p2), p2.hasMore]).toEqual([["000002", "000003"], true]);
    const p3 = pageTurns(turns, "S", { limit: 2, beforeTurnId: p2.turns[0]!.turnId });
    expect([ids(p3), p3.hasMore]).toEqual([["000001"], false]);
  });

  test("edges: limit larger than the session, a page ending exactly at the first turn, beforeTurnId = the first turn, an empty session", () => {
    expect(pageTurns(turns, "S")).toEqual({ turns, hasMore: false }); // default limit 100
    expect(pageTurns(turns, "S", { limit: 5 })).toEqual({ turns, hasMore: false });
    const exact = pageTurns(turns, "S", { limit: 3, beforeTurnId: "000004" });
    expect([ids(exact), exact.hasMore]).toEqual([["000001", "000002", "000003"], false]);
    expect(pageTurns(turns, "S", { beforeTurnId: "000001" })).toEqual({ turns: [], hasMore: false });
    expect(pageTurns([], "S", { limit: 3 })).toEqual({ turns: [], hasMore: false });
  });

  test("an unknown beforeTurnId is UnknownTurnError (INVALID_PARAMS)", () => {
    expect(() => pageTurns(turns, "S", { beforeTurnId: "000099" })).toThrow(UnknownTurnError);
    expect(() => pageTurns([], "S", { beforeTurnId: "000001" })).toThrow(UnknownTurnError);
  });
});
