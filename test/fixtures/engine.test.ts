/**
 * Phase 3 fixtures — Git mutation engine (spec §3.7, 3.8, 3.9, 3.13, 3.15b, 3.16, 3.24).
 * READ-ONLY for implementers.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { AGENT_BRANCH } from "../../src/core/types";
import {
  setupEnv,
  seedNote,
  writeNote,
  replaceMutation,
  mkMutation,
  present,
  noteMd,
  fileAt,
  blobAt,
  revParse,
  commitsWithMutationId,
  isClean,
  aliasesOf,
  idOf,
  forceQueueState,
  reopen,
  commitAsHuman,
  git,
  type Env,
} from "../harness";

let env: Env;
afterEach(async () => {
  if (env) await env.cleanup();
});

describe("3.7 executor undeclared write", () => {
  test("touching an undeclared path fails before commit and never extends targets", async () => {
    env = await setupEnv();
    const x = seedNote(env, "knowledge/x.md", { title: "X" });
    const mainSha = revParse(env.repo.path, "main");
    const m = mkMutation({
      type: "ENRICH",
      targets: [present(x.id, x.path, blobAt(env.repo.path, "main", x.path)!)],
      writes: [
        { path: x.path, content: x.content + "\n## Evidence\nmore\n" },
        { path: "knowledge/b.md", content: noteMd({ title: "B" }) },
      ],
    });
    await env.coord.enqueue(m);
    const r = await env.coord.execute(m.mutationId);
    expect(r.state).toBe("FAILED_INVALID_EXECUTION");
    expect(revParse(env.repo.path, AGENT_BRANCH)).toBe(mainSha);
    expect(isClean(env.coord.paths.agentWorktree)).toBe(true);
    expect(fileAt(env.repo.path, AGENT_BRANCH, "knowledge/b.md")).toBeNull();
    const row = await env.coord.getMutation(m.mutationId);
    expect(row?.state).toBe("FAILED_INVALID_EXECUTION");
    expect(row?.targets.length).toBe(1);
  });
});

describe("3.8 executor NOOP", () => {
  test("identical content produces NOOP and no commit", async () => {
    env = await setupEnv();
    const x = seedNote(env, "knowledge/x.md", { title: "X" });
    const mainSha = revParse(env.repo.path, "main");
    const m = replaceMutation(env.repo.path, "main", x.path, x.content);
    await env.coord.enqueue(m);
    const r = await env.coord.execute(m.mutationId);
    expect(r.state).toBe("NOOP");
    expect(revParse(env.repo.path, AGENT_BRANCH)).toBe(mainSha);
    expect(commitsWithMutationId(env.repo.path, AGENT_BRANCH, m.mutationId)).toEqual([]);
    expect((await env.coord.getMutation(m.mutationId))?.state).toBe("NOOP");
  });
});

describe("3.9 crash recovery", () => {
  test("RUNNING row whose commit exists is reconciled to COMMITTED, not re-executed", async () => {
    env = await setupEnv();
    const x = seedNote(env, "knowledge/x.md", { title: "X" });
    const m = replaceMutation(env.repo.path, "main", x.path, x.content + "\n## Evidence\nmore\n");
    await env.coord.enqueue(m);
    const r = await env.coord.execute(m.mutationId);
    expect(r.state).toBe("COMMITTED");
    const sha = revParse(env.repo.path, AGENT_BRANCH);

    forceQueueState(env, m.mutationId, "RUNNING");
    const coord = await reopen(env);
    await coord.recover();

    expect((await coord.getMutation(m.mutationId))?.state).toBe("COMMITTED");
    expect(commitsWithMutationId(env.repo.path, AGENT_BRANCH, m.mutationId).length).toBe(1);
    expect(revParse(env.repo.path, AGENT_BRANCH)).toBe(sha);
  });

  test("RUNNING row without a commit is re-executed exactly once", async () => {
    env = await setupEnv();
    const x = seedNote(env, "knowledge/x.md", { title: "X" });
    const m = replaceMutation(env.repo.path, "main", x.path, x.content + "\n## Evidence\nmore\n");
    await env.coord.enqueue(m);
    forceQueueState(env, m.mutationId, "RUNNING");
    // simulate half-applied worktree state
    writeNote(env.coord.paths.agentWorktree, "knowledge/garbage.md", { title: "garbage" });

    const coord = await reopen(env);
    await coord.recover();

    expect(isClean(env.coord.paths.agentWorktree)).toBe(true);
    expect(fileAt(env.repo.path, AGENT_BRANCH, "knowledge/garbage.md")).toBeNull();
    expect((await coord.getMutation(m.mutationId))?.state).toBe("COMMITTED");
    expect(commitsWithMutationId(env.repo.path, AGENT_BRANCH, m.mutationId).length).toBe(1);
  });
});

describe("3.13 superseded / archived protection", () => {
  for (const status of ["superseded", "archived"] as const) {
    test(`automatic ENRICH on ${status} note requires a proposal`, async () => {
      env = await setupEnv();
      const x = seedNote(env, "knowledge/x.md", { title: "X", status });
      const mainSha = revParse(env.repo.path, "main");
      const m = replaceMutation(env.repo.path, "main", x.path, x.content + "\n## Evidence\nmore\n");
      await env.coord.enqueue(m);
      const r = await env.coord.execute(m.mutationId);
      expect(r.proposalRequired).toBe(true);
      expect(r.state).not.toBe("COMMITTED");
      expect(revParse(env.repo.path, AGENT_BRANCH)).toBe(mainSha);
      expect(commitsWithMutationId(env.repo.path, AGENT_BRANCH, m.mutationId)).toEqual([]);
    });
  }
});

describe("3.15b alias collision through the executor", () => {
  test("ADD_ALIAS colliding case-insensitively with another slug fails without commit", async () => {
    env = await setupEnv();
    seedNote(env, "knowledge/x-note.md", { title: "X" });
    const y = seedNote(env, "knowledge/y.md", { title: "Y" });
    const mainSha = revParse(env.repo.path, "main");
    const withAlias = y.content.replace("status: active\n", "status: active\naliases:\n  - X-Note\n");
    const m = replaceMutation(env.repo.path, "main", y.path, withAlias, { type: "ADD_ALIAS" });
    await env.coord.enqueue(m);
    const r = await env.coord.execute(m.mutationId);
    expect(r.state).toBe("FAILED");
    expect(revParse(env.repo.path, AGENT_BRANCH)).toBe(mainSha);
    expect(isClean(env.coord.paths.agentWorktree)).toBe(true);
  });
});

describe("3.16 title change preserves old title", () => {
  test("old title is appended to aliases automatically", async () => {
    env = await setupEnv();
    const x = seedNote(env, "knowledge/git-agent-trust.md", { title: "Git as a trust layer" });
    const renamed = x.content.replace("# Git as a trust layer", "# Reversibility enables agent autonomy");
    const m = replaceMutation(env.repo.path, "main", x.path, renamed);
    await env.coord.enqueue(m);
    const r = await env.coord.execute(m.mutationId);
    expect(r.state).toBe("COMMITTED");
    const after = fileAt(env.repo.path, AGENT_BRANCH, x.path)!;
    expect(after).toContain("# Reversibility enables agent autonomy");
    expect(aliasesOf(after)).toContain("Git as a trust layer");
    expect(idOf(after)).toBe(x.id);
  });

  test("title change fails when the old title would collide as an alias", async () => {
    env = await setupEnv();
    seedNote(env, "knowledge/z.md", { title: "Z", aliases: ["Git as a trust layer"] });
    const x = seedNote(env, "knowledge/git-agent-trust.md", { title: "Git as a trust layer" });
    const mainSha = revParse(env.repo.path, "main");
    const renamed = x.content.replace("# Git as a trust layer", "# Reversibility enables agent autonomy");
    const m = replaceMutation(env.repo.path, "main", x.path, renamed);
    await env.coord.enqueue(m);
    const r = await env.coord.execute(m.mutationId);
    expect(r.state).toBe("FAILED");
    expect(revParse(env.repo.path, AGENT_BRANCH)).toBe(mainSha);
  });
});

describe("3.24 precondition path mismatch", () => {
  test("a note moved by the human invalidates a mutation planned against the old path", async () => {
    env = await setupEnv();
    const x = seedNote(env, "knowledge/x.md", { title: "X" });
    const m = replaceMutation(env.repo.path, "main", x.path, x.content + "\n## Evidence\nmore\n");
    git(env.repo.path, "mv", "knowledge/x.md", "knowledge/x2.md");
    commitAsHuman(env.repo.path, "user: move x");
    env.clock.advance(60_000);

    const r = await env.coord.submit(m);
    expect(r.state).toBe("REPLAN");
    expect((await env.coord.getMutation(m.mutationId))?.state).toBe("REPLAN");
    expect(fileAt(env.repo.path, "main", "knowledge/x2.md")).toBe(x.content);
    expect(fileAt(env.repo.path, "main", "knowledge/x.md")).toBeNull();
    expect(commitsWithMutationId(env.repo.path, "main", m.mutationId)).toEqual([]);
  });
});
