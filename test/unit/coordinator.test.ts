import { describe, test, expect, afterEach } from "bun:test";
import { AGENT_BRANCH } from "../../src/core/types";
import {
  setupEnv,
  seedNote,
  writeNote,
  createMutation,
  replaceMutation,
  commitAsHuman,
  fileAt,
  revParse,
  mutationIdsOn,
  git,
  isClean,
  type Env,
} from "../harness";

let env: Env;
afterEach(async () => {
  if (env) await env.cleanup();
});

describe("coordinator locking and wiring", () => {
  test("two concurrent submit() calls both integrate; history stays linear", async () => {
    env = await setupEnv();
    const repo = env.repo.path;
    const x = seedNote(env, "knowledge/x.md", { title: "X", sections: { Claim: "x0" } });
    const y = seedNote(env, "knowledge/y.md", { title: "Y", sections: { Claim: "y0" } });
    const m1 = replaceMutation(repo, "main", x.path, x.content.replace("x0", "x1"));
    const m2 = replaceMutation(repo, "main", y.path, y.content.replace("y0", "y1"));
    const [r1, r2] = await Promise.all([env.coord.submit(m1), env.coord.submit(m2)]);
    expect(r1.state).toBe("INTEGRATED");
    expect(r2.state).toBe("INTEGRATED");
    expect(mutationIdsOn(repo, "main")).toEqual([m1.mutationId, m2.mutationId]);
    expect(git(repo, "log", "--merges", "--format=%H", "main")).toBe("");
    expect(revParse(repo, AGENT_BRANCH)).toBe(revParse(repo, "main"));
    expect(fileAt(repo, "main", x.path)).toContain("x1");
    expect(fileAt(repo, "main", y.path)).toContain("y1");
    expect(isClean(repo)).toBe(true);
  });

  test("execute() never integrates; integrate() then does; rebuild() alone moves the agent branch", async () => {
    env = await setupEnv();
    const repo = env.repo.path;
    const x = seedNote(env, "knowledge/x.md", { title: "X" });
    const m = createMutation("knowledge/n.md", { title: "N" });
    await env.coord.enqueue(m);
    expect((await env.coord.execute(m.mutationId)).state).toBe("COMMITTED");
    expect(mutationIdsOn(repo, "main")).toEqual([]);
    expect((await env.coord.getMutation(m.mutationId))?.state).toBe("COMMITTED");

    writeNote(repo, "knowledge/h.md", { title: "H" });
    commitAsHuman(repo, "user: add h");
    const rb = await env.coord.rebuild();
    expect(rb.replayed).toEqual([m.mutationId]);
    expect(rb.replanned).toEqual([]);
    expect(rb.failed).toEqual([]);
    expect(rb.newAgentHead).toBe(revParse(repo, AGENT_BRANCH));
    expect(git(repo, "merge-base", "--is-ancestor", "main", AGENT_BRANCH)).toBe("");
    expect(mutationIdsOn(repo, "main")).toEqual([]);
    expect(fileAt(repo, AGENT_BRANCH, x.path)).not.toBeNull();

    const ir = await env.coord.integrate();
    expect(ir.status).toBe("integrated");
    expect(ir.integratedMutationIds).toEqual([m.mutationId]);
    expect((await env.coord.getMutation(m.mutationId))?.state).toBe("INTEGRATED");
    expect((await env.coord.integrate()).status).toBe("nothing-to-integrate");
  });

  test("execute() after main moved with pending commits replays them first (sequential validation)", async () => {
    env = await setupEnv();
    const repo = env.repo.path;
    const x = seedNote(env, "knowledge/x.md", { title: "X", sections: { Claim: "x0" } });
    const m1 = replaceMutation(repo, "main", x.path, x.content.replace("x0", "x1"));
    await env.coord.enqueue(m1);
    expect((await env.coord.execute(m1.mutationId)).state).toBe("COMMITTED");
    const x1 = fileAt(repo, AGENT_BRANCH, x.path)!;
    const m2 = replaceMutation(repo, AGENT_BRANCH, x.path, x1.replace("x1", "x2"));

    writeNote(repo, "knowledge/h.md", { title: "H" });
    commitAsHuman(repo, "user: add h");

    await env.coord.enqueue(m2);
    expect((await env.coord.execute(m2.mutationId)).state).toBe("COMMITTED");
    expect(mutationIdsOn(repo, AGENT_BRANCH)).toEqual([m1.mutationId, m2.mutationId]);
    expect(fileAt(repo, AGENT_BRANCH, "knowledge/h.md")).not.toBeNull();
    expect(fileAt(repo, AGENT_BRANCH, x.path)).toContain("x2");
  });

  test("a COMMITTED row already on main is marked INTEGRATED by the rebuild instead of being replayed", async () => {
    env = await setupEnv();
    const repo = env.repo.path;
    const m = createMutation("knowledge/n.md", { title: "N" });
    await env.coord.enqueue(m);
    await env.coord.execute(m.mutationId);
    // simulate a crash between the ff merge and the queue update
    git(repo, "merge", "--ff-only", "-q", AGENT_BRANCH);
    expect((await env.coord.getMutation(m.mutationId))?.state).toBe("COMMITTED");
    writeNote(repo, "knowledge/h.md", { title: "H" });
    commitAsHuman(repo, "user: add h");
    const rb = await env.coord.rebuild();
    expect(rb.replayed).toEqual([]);
    expect((await env.coord.getMutation(m.mutationId))?.state).toBe("INTEGRATED");
    expect(mutationIdsOn(repo, AGENT_BRANCH)).toEqual([m.mutationId]);
    expect(revParse(repo, AGENT_BRANCH)).toBe(revParse(repo, "main"));
  });
});
