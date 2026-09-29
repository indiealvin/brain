/**
 * Phase 4 fixtures — Human Sync, integration, lock (spec §3.11, 3.12).
 * READ-ONLY for implementers.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { AGENT_BRANCH } from "../../src/core/types";
import {
  setupEnv,
  seedNote,
  replaceMutation,
  fileAt,
  revParse,
  filesInCommit,
  dirtyPaths,
  readFile,
  mutationIdsOn,
  git,
  isClean,
  type Env,
} from "../harness";

let env: Env;
afterEach(async () => {
  if (env) await env.cleanup();
});

describe("3.11 human dirty state excluded from agent commit", () => {
  test("agent commit contains only its target; dirty human path is never swept, never overwritten", async () => {
    env = await setupEnv();
    const repo = env.repo.path;
    const x = seedNote(env, "knowledge/x.md", { title: "X", sections: { Claim: "x0" } });
    const y = seedNote(env, "knowledge/y.md", { title: "Y", sections: { Claim: "y0" } });

    // human edits X, does not commit
    const humanX = x.content.replace("x0", "x-human-dirty");
    await Bun.write(`${repo}/${x.path}`, humanX);

    // agent enriches Y
    const m1 = replaceMutation(repo, "main", y.path, y.content.replace("y0", "y1"));
    await env.coord.enqueue(m1);
    const r1 = await env.coord.execute(m1.mutationId);
    expect(r1.state).toBe("COMMITTED");
    expect(filesInCommit(repo, r1.commitSha!)).toEqual([y.path]);

    // integrate while X is dirty and NOT quiescent: Y integrates, X untouched
    const ir1 = await env.coord.integrate();
    expect(ir1.status).toBe("integrated");
    expect(mutationIdsOn(repo, "main")).toEqual([m1.mutationId]);
    expect(dirtyPaths(repo)).toEqual([x.path]);
    expect(readFile(repo, x.path)).toBe(humanX);
    expect(fileAt(repo, "main", x.path)).toBe(x.content);

    // agent now targets X (planned against main's X)
    const m2 = replaceMutation(repo, "main", x.path, x.content.replace("x0", "x-agent"));
    await env.coord.enqueue(m2);
    const r2 = await env.coord.execute(m2.mutationId);
    expect(r2.state).toBe("COMMITTED");

    const mainBefore = revParse(repo, "main");
    const ir2 = await env.coord.integrate();
    expect(ir2.status).toBe("refused-dirty");
    expect(revParse(repo, "main")).toBe(mainBefore);
    expect((await env.coord.getMutation(m2.mutationId))?.state).toBe("COMMITTED");
    expect(readFile(repo, x.path)).toBe(humanX);
    expect(dirtyPaths(repo)).toEqual([x.path]);

    // once quiescent, Human Sync commits X, rebuild invalidates M2
    env.clock.advance(60_000);
    const ir3 = await env.coord.integrate();
    expect(ir3.integratedMutationIds).toEqual([]);
    expect((await env.coord.getMutation(m2.mutationId))?.state).toBe("REPLAN");
    expect(fileAt(repo, "main", x.path)).toBe(humanX);
    expect(isClean(repo)).toBe(true);
    const headActor = git(repo, "log", "-1", "--format=%(trailers:key=Actor,valueonly)", "main").trim();
    expect(headActor).toBe("human-sync");
    expect(mutationIdsOn(repo, "main")).toEqual([m1.mutationId]);
    expect(revParse(repo, AGENT_BRANCH)).toBe(revParse(repo, "main"));
  });

  test("syncOnce commits nothing when not quiescent and commits once when quiescent", async () => {
    env = await setupEnv();
    const repo = env.repo.path;
    const x = seedNote(env, "knowledge/x.md", { title: "X", sections: { Claim: "x0" } });
    await Bun.write(`${repo}/${x.path}`, x.content.replace("x0", "x1"));

    const s1 = await env.coord.syncOnce(env.clock.now());
    expect(s1.committed).toBe(false);
    expect(dirtyPaths(repo)).toEqual([x.path]);

    const s2 = await env.coord.syncOnce(env.clock.now() + 60_000);
    expect(s2.committed).toBe(true);
    expect(isClean(repo)).toBe(true);
    expect(revParse(repo, "main")).toBe(s2.sha!);

    const s3 = await env.coord.syncOnce(env.clock.now() + 60_000);
    expect(s3.committed).toBe(false);
  });
});

describe("3.12 repo worktree lock", () => {
  test("second holder waits for the first and observes completed state", async () => {
    env = await setupEnv();
    const { withRepoWorktreeLock } = await import("../../src/sync/lock");
    const dir = env.coord.paths.runtimeDir;
    const order: string[] = [];
    const a = withRepoWorktreeLock(dir, async () => {
      order.push("a-start");
      await new Promise((r) => setTimeout(r, 150));
      order.push("a-end");
      return "a";
    });
    await new Promise((r) => setTimeout(r, 10));
    const b = withRepoWorktreeLock(dir, async () => {
      order.push("b-start");
      order.push("b-end");
      return "b";
    });
    expect(await Promise.all([a, b])).toEqual(["a", "b"]);
    expect(order).toEqual(["a-start", "a-end", "b-start", "b-end"]);
  });

  test("lock is released when the holder throws", async () => {
    env = await setupEnv();
    const { withRepoWorktreeLock } = await import("../../src/sync/lock");
    const dir = env.coord.paths.runtimeDir;
    await expect(
      withRepoWorktreeLock(dir, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const v = await withRepoWorktreeLock(dir, async () => 42);
    expect(v).toBe(42);
  });

  test("concurrent integrate and syncOnce leave a linear, clean history", async () => {
    env = await setupEnv();
    const repo = env.repo.path;
    const x = seedNote(env, "knowledge/x.md", { title: "X", sections: { Claim: "x0" } });
    const y = seedNote(env, "knowledge/y.md", { title: "Y", sections: { Claim: "y0" } });
    const m1 = replaceMutation(repo, "main", y.path, y.content.replace("y0", "y1"));
    await env.coord.enqueue(m1);
    await env.coord.execute(m1.mutationId);
    await Bun.write(`${repo}/${x.path}`, x.content.replace("x0", "x1"));

    const now = env.clock.now() + 60_000;
    env.clock.advance(60_000);
    const results = await Promise.all([env.coord.integrate(), env.coord.syncOnce(now)]);
    expect(results.length).toBe(2);
    expect(isClean(repo)).toBe(true);
    expect(git(repo, "log", "--merges", "--format=%H", "main")).toBe("");
    expect(revParse(repo, AGENT_BRANCH)).toBe(revParse(repo, "main"));
    expect(fileAt(repo, "main", x.path)).toContain("x1");
    expect(fileAt(repo, "main", y.path)).toContain("y1");
  });
});
