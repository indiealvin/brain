import { describe, test, expect, afterEach } from "bun:test";
import { utimesSync } from "node:fs";
import { join } from "node:path";
import { setupEnv, seedNote, writeNote, git, isClean, dirtyPaths, revParse, fileAt, type Env } from "../harness";
import { syncOnce, summarize } from "../../src/sync/humanSync";

let env: Env;
afterEach(async () => {
  if (env) await env.cleanup();
});

describe("Human Sync quiescence (spec §16)", () => {
  test("clean worktree → clean; fresh edit → not-quiescent; settled edit → committed with human-sync trailer", async () => {
    env = await setupEnv({ quiescenceMs: 1500 });
    const repo = env.repo.path;
    const x = seedNote(env, "knowledge/x.md", { title: "X", sections: { Claim: "x0" } });
    const agentBefore = revParse(repo, "agent/repo");
    expect(await syncOnce(env.coord.paths, env.coord.config, Date.now())).toEqual({ committed: false, reason: "clean" });

    await Bun.write(join(repo, x.path), x.content.replace("x0", "x1"));
    const now = Date.now();
    const s1 = await syncOnce(env.coord.paths, env.coord.config, now + 1000);
    expect(s1).toEqual({ committed: false, reason: "not-quiescent" });
    expect(isClean(repo)).toBe(false);
    expect(fileAt(repo, "main", x.path)).toBe(x.content);

    const s2 = await syncOnce(env.coord.paths, env.coord.config, now + 5000);
    expect(s2.committed).toBe(true);
    expect(s2.reason).toBe("committed");
    expect(s2.sha).toBe(revParse(repo, "main"));
    expect(isClean(repo)).toBe(true);
    expect(fileAt(repo, "main", x.path)).toContain("x1");
    expect(git(repo, "log", "-1", "--format=%s", "main")).toBe("user: x.md");
    expect(git(repo, "log", "-1", "--format=%(trailers:key=Actor,valueonly)", "main").trim()).toBe("human-sync");
    expect(git(repo, "log", "-1", "--format=%an", "main")).toBe("brain-human-sync");
    // the agent branch is never touched by human sync
    expect(revParse(repo, "agent/repo")).toBe(agentBefore);
  });

  test("the newest dirty path decides; deleted paths count as quiescent; .gitignore respected", async () => {
    env = await setupEnv({ quiescenceMs: 1500 });
    const repo = env.repo.path;
    const x = seedNote(env, "knowledge/x.md", { title: "X" });
    const y = seedNote(env, "knowledge/y.md", { title: "Y" });
    const now = Date.now();
    // distinct content so git does not pair it with the deleted x.md as a rename
    writeNote(repo, "knowledge/z.md", { title: "Z", sections: { Claim: "entirely different z content. ".repeat(20) } });
    utimesSync(join(repo, "knowledge/z.md"), new Date(now - 10_000), new Date(now - 10_000));
    await Bun.write(join(repo, y.path), y.content + "\n## Evidence\ne\n"); // fresh
    git(repo, "rm", "-q", x.path);
    await Bun.write(join(repo, ".brain", "scratch"), "ignored");

    expect((await syncOnce(env.coord.paths, env.coord.config, now + 100)).reason).toBe("not-quiescent");
    const paths = dirtyPaths(repo);
    expect(paths).toContain("knowledge/z.md");
    expect(paths).not.toContain(".brain/scratch");

    const s = await syncOnce(env.coord.paths, env.coord.config, now + 10_000);
    expect(s.committed).toBe(true);
    expect(isClean(repo)).toBe(true);
    expect(fileAt(repo, "main", x.path)).toBeNull();
    expect(fileAt(repo, "main", "knowledge/z.md")).not.toBeNull();
    expect(fileAt(repo, "main", ".brain/scratch")).toBeNull();
    expect(git(repo, "log", "-1", "--format=%s", "main")).toBe("user: x.md, y.md, z.md");
  });

  test("only deletions pending → quiescent immediately", async () => {
    env = await setupEnv({ quiescenceMs: 1500 });
    const repo = env.repo.path;
    const x = seedNote(env, "knowledge/x.md", { title: "X" });
    git(repo, "rm", "-q", x.path);
    const s = await syncOnce(env.coord.paths, env.coord.config, Date.now());
    expect(s.committed).toBe(true);
    expect(fileAt(repo, "main", x.path)).toBeNull();
  });

  test("summary lists up to three basenames plus a count", () => {
    expect(summarize(["a/b.md"])).toBe("b.md");
    expect(summarize(["a.md", "b.md", "c.md"])).toBe("a.md, b.md, c.md");
    expect(summarize(["a.md", "b.md", "c.md", "d.md", "e.md"])).toBe("a.md, b.md, c.md (+2)");
  });
});
