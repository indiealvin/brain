/**
 * Phase 5 fixtures — agent branch rebuild (spec §3.1–3.6, 3.10, 3.20).
 * READ-ONLY for implementers.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { AGENT_BRANCH } from "../../src/core/types";
import {
  setupEnv,
  seedNote,
  writeNote,
  createMutation,
  replaceMutation,
  fileAt,
  revParse,
  revList,
  mutationIdsOn,
  commitsWithMutationId,
  commitAsHuman,
  git,
  trailer,
  type Env,
} from "../harness";

let env: Env;
afterEach(async () => {
  if (env) await env.cleanup();
});

async function exec(env: Env, m: ReturnType<typeof createMutation>) {
  await env.coord.enqueue(m);
  const r = await env.coord.execute(m.mutationId);
  expect(r.state).toBe("COMMITTED");
  return r;
}

describe("3.1 human commit, clean replay, ff-only integration", () => {
  test("pending mutations replay onto H1 and integrate; IDs stable, SHAs change", async () => {
    env = await setupEnv();
    seedNote(env, "knowledge/x.md", { title: "X" });
    const repo = env.repo.path;

    const m1 = createMutation("knowledge/m1.md", { title: "M1 note" });
    const r1 = await exec(env, m1);
    const m1Content = fileAt(repo, AGENT_BRANCH, "knowledge/m1.md")!;
    const m2Content = m1Content + "\n## Evidence\nmore\n";
    const m2 = replaceMutation(repo, AGENT_BRANCH, "knowledge/m1.md", m2Content);
    const r2 = await exec(env, m2);

    writeNote(repo, "knowledge/y.md", { title: "Y" });
    const h1 = commitAsHuman(repo, "user: add y");
    env.clock.advance(60_000);

    const ir = await env.coord.integrate();
    expect(ir.status).toBe("rebuilt-and-integrated");
    expect(ir.integratedMutationIds.sort()).toEqual([m1.mutationId, m2.mutationId].sort());

    const main = revParse(repo, "main");
    expect(revParse(repo, AGENT_BRANCH)).toBe(main);
    expect(revList(repo, "main")).toContain(h1);
    expect(mutationIdsOn(repo, "main")).toEqual([m1.mutationId, m2.mutationId]);
    expect(commitsWithMutationId(repo, "main", m1.mutationId)[0]).not.toBe(r1.commitSha);
    expect(commitsWithMutationId(repo, "main", m2.mutationId)[0]).not.toBe(r2.commitSha);
    expect(fileAt(repo, "main", "knowledge/m1.md")).toBe(m2Content);
    expect(fileAt(repo, "main", "knowledge/y.md")).not.toBeNull();
    expect((await env.coord.getMutation(m1.mutationId))?.state).toBe("INTEGRATED");
    expect((await env.coord.getMutation(m2.mutationId))?.state).toBe("INTEGRATED");
  });
});

describe("3.2 blob-level invalidation without textual conflict", () => {
  test("human edit to a different section still invalidates the mutation", async () => {
    env = await setupEnv();
    const repo = env.repo.path;
    const x = seedNote(env, "knowledge/x.md", {
      title: "X",
      sections: { Claim: "Original claim.", Connections: "- related [[y]]" },
    });
    const agentVersion = x.content.replace("- related [[y]]", "- related [[y]]\n- supports [[z]]");
    const m1 = replaceMutation(repo, "main", x.path, agentVersion);
    await exec(env, m1);

    const humanVersion = x.content.replace("Original claim.", "Human-edited claim.");
    await Bun.write(`${repo}/${x.path}`, humanVersion);
    commitAsHuman(repo, "user: edit claim");
    env.clock.advance(60_000);

    const ir = await env.coord.integrate();
    expect(ir.integratedMutationIds).toEqual([]);
    expect((await env.coord.getMutation(m1.mutationId))?.state).toBe("REPLAN");
    expect(fileAt(repo, "main", x.path)).toBe(humanVersion);
    expect(mutationIdsOn(repo, "main")).toEqual([]);
    expect(revParse(repo, AGENT_BRANCH)).toBe(revParse(repo, "main"));
  });
});

describe("3.3 sequential validation across pending mutations", () => {
  test("M1 planned against M0's output validates against the rebuild tree, not main", async () => {
    env = await setupEnv();
    const repo = env.repo.path;
    const x = seedNote(env, "knowledge/x.md", { title: "X", sections: { Claim: "A" } });

    const b = x.content.replace("A", "B");
    const m0 = replaceMutation(repo, "main", x.path, b);
    await exec(env, m0);
    const c = b.replace("B", "C");
    const m1 = replaceMutation(repo, AGENT_BRANCH, x.path, c);
    await exec(env, m1);

    writeNote(repo, "knowledge/z.md", { title: "Z" });
    commitAsHuman(repo, "user: add z");
    env.clock.advance(60_000);

    const ir = await env.coord.integrate();
    expect(ir.integratedMutationIds.sort()).toEqual([m0.mutationId, m1.mutationId].sort());
    expect(fileAt(repo, "main", x.path)).toBe(c);
    expect((await env.coord.getMutation(m0.mutationId))?.state).toBe("INTEGRATED");
    expect((await env.coord.getMutation(m1.mutationId))?.state).toBe("INTEGRATED");
  });
});

describe("3.4 shared-note implicit dependency", () => {
  test("M3 on the same note as invalid M1 is replanned; unrelated M2 survives", async () => {
    env = await setupEnv();
    const repo = env.repo.path;
    const y = seedNote(env, "knowledge/y.md", { title: "Y", sections: { Claim: "y0" } });
    const z = seedNote(env, "knowledge/z.md", { title: "Z", sections: { Claim: "z0" } });

    const m1 = replaceMutation(repo, "main", y.path, y.content.replace("y0", "y1"));
    await exec(env, m1);
    const z1 = z.content.replace("z0", "z1");
    const m2 = replaceMutation(repo, "main", z.path, z1);
    await exec(env, m2);
    const y1 = fileAt(repo, AGENT_BRANCH, y.path)!;
    const m3 = replaceMutation(repo, AGENT_BRANCH, y.path, y1.replace("y1", "y2"));
    await exec(env, m3);

    const humanY = y.content.replace("y0", "y-human");
    await Bun.write(`${repo}/${y.path}`, humanY);
    commitAsHuman(repo, "user: edit y");
    env.clock.advance(60_000);

    const ir = await env.coord.integrate();
    expect(ir.integratedMutationIds).toEqual([m2.mutationId]);
    expect((await env.coord.getMutation(m1.mutationId))?.state).toBe("REPLAN");
    expect((await env.coord.getMutation(m3.mutationId))?.state).toBe("REPLAN");
    expect((await env.coord.getMutation(m2.mutationId))?.state).toBe("INTEGRATED");
    expect(fileAt(repo, "main", y.path)).toBe(humanY);
    expect(fileAt(repo, "main", z.path)).toBe(z1);
    expect(mutationIdsOn(repo, "main")).toEqual([m2.mutationId]);
  });
});

describe("3.5 CREATE absent assertion", () => {
  test("human creating the slug first invalidates the CREATE; no duplicate", async () => {
    env = await setupEnv();
    const repo = env.repo.path;
    seedNote(env, "knowledge/x.md", { title: "X" });

    const m1 = createMutation("knowledge/agent-autonomy.md", { title: "Agent autonomy (agent)" });
    await exec(env, m1);

    const human = writeNote(repo, "knowledge/agent-autonomy.md", { title: "Agent autonomy (human)" });
    commitAsHuman(repo, "user: add agent-autonomy");
    env.clock.advance(60_000);

    const ir = await env.coord.integrate();
    expect(ir.integratedMutationIds).toEqual([]);
    expect((await env.coord.getMutation(m1.mutationId))?.state).toBe("REPLAN");
    expect(fileAt(repo, "main", "knowledge/agent-autonomy.md")).toBe(human.content);
    const tree = git(repo, "ls-tree", "-r", "--name-only", "main");
    const matches = tree.split("\n").filter((p) => /(^|\/)agent-autonomy\.md$/i.test(p));
    expect(matches.length).toBe(1);
  });
});

describe("3.6 ENRICH target deleted", () => {
  test("human deleting the target invalidates the ENRICH", async () => {
    env = await setupEnv();
    const repo = env.repo.path;
    const x = seedNote(env, "knowledge/x.md", { title: "X" });
    const m1 = replaceMutation(repo, "main", x.path, x.content + "\n## Evidence\nmore\n");
    await exec(env, m1);

    git(repo, "rm", "-q", x.path);
    commitAsHuman(repo, "user: delete x");
    env.clock.advance(60_000);

    const ir = await env.coord.integrate();
    expect(ir.integratedMutationIds).toEqual([]);
    expect((await env.coord.getMutation(m1.mutationId))?.state).toBe("REPLAN");
    expect(fileAt(repo, "main", x.path)).toBeNull();
    expect(revParse(repo, AGENT_BRANCH)).toBe(revParse(repo, "main"));
  });
});

describe("3.10 REPLAN is never replayed", () => {
  test("after restart a REPLAN row stays terminal; a new mutation carries replans", async () => {
    env = await setupEnv();
    const repo = env.repo.path;
    const x = seedNote(env, "knowledge/x.md", { title: "X", sections: { Claim: "x0" } });
    const m1 = replaceMutation(repo, "main", x.path, x.content.replace("x0", "x-agent"));
    await exec(env, m1);

    const humanX = x.content.replace("x0", "x-human");
    await Bun.write(`${repo}/${x.path}`, humanX);
    commitAsHuman(repo, "user: edit x");
    env.clock.advance(60_000);
    await env.coord.integrate();
    expect((await env.coord.getMutation(m1.mutationId))?.state).toBe("REPLAN");

    const { reopen } = await import("../harness");
    const coord = await reopen(env);
    await coord.recover();
    expect((await coord.getMutation(m1.mutationId))?.state).toBe("REPLAN");
    expect(commitsWithMutationId(repo, AGENT_BRANCH, m1.mutationId)).toEqual([]);
    expect(revParse(repo, AGENT_BRANCH)).toBe(revParse(repo, "main"));

    const m1b = replaceMutation(repo, "main", x.path, humanX + "\n## Evidence\nreplanned\n", { replans: m1.mutationId });
    const r = await coord.submit(m1b);
    expect(r.state).toBe("INTEGRATED");
    expect((await coord.getMutation(m1b.mutationId))?.replans).toBe(m1.mutationId);
    expect(mutationIdsOn(repo, "main")).toEqual([m1b.mutationId]);
    const sha = commitsWithMutationId(repo, "main", m1b.mutationId)[0]!;
    expect(trailer(repo, sha, "Replans")).toBe(m1.mutationId);
  });
});

describe("3.20 link-target implicit dependency", () => {
  test("a LINK to a slug created by an invalid CREATE is replanned too", async () => {
    env = await setupEnv();
    const repo = env.repo.path;
    const b = seedNote(env, "knowledge/b.md", { title: "B", sections: { Claim: "b claim" } });

    const m1 = createMutation("knowledge/a-note.md", { title: "A note" });
    await exec(env, m1);
    const bLinked = b.content.replace("b claim", "b claim, see [[a-note]]");
    const m2 = replaceMutation(repo, "main", b.path, bLinked, { type: "LINK" });
    expect(m2.dependsOn).toEqual([]);
    await exec(env, m2);

    writeNote(repo, "knowledge/a-note.md", { title: "A note (human)" });
    commitAsHuman(repo, "user: add a-note");
    env.clock.advance(60_000);

    const ir = await env.coord.integrate();
    expect(ir.integratedMutationIds).toEqual([]);
    expect((await env.coord.getMutation(m1.mutationId))?.state).toBe("REPLAN");
    expect((await env.coord.getMutation(m2.mutationId))?.state).toBe("REPLAN");
    expect(fileAt(repo, "main", b.path)).toBe(b.content);
  });
});
