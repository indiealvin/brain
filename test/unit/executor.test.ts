import { describe, test, expect, afterEach } from "bun:test";
import { AGENT_BRANCH } from "../../src/core/types";
import {
  setupEnv,
  seedNote,
  replaceMutation,
  createMutation,
  mkMutation,
  present,
  absent,
  noteMd,
  fileAt,
  blobAt,
  revParse,
  isClean,
  commitsWithMutationId,
  filesInCommit,
  trailer,
  type Env,
} from "../harness";

let env: Env;
afterEach(async () => {
  if (env) await env.cleanup();
});

describe("executor rules beyond the contract fixtures", () => {
  test("active → tentative is the only automatic status transition; type never changes", async () => {
    env = await setupEnv();
    const x = seedNote(env, "knowledge/x.md", { title: "X" });
    const y = seedNote(env, "knowledge/y.md", { title: "Y" });
    const ok = replaceMutation(env.repo.path, "main", x.path, x.content.replace("status: active", "status: tentative"));
    await env.coord.enqueue(ok);
    expect((await env.coord.execute(ok.mutationId)).state).toBe("COMMITTED");

    const bad = replaceMutation(env.repo.path, "main", y.path, y.content.replace("status: active", "status: archived"));
    await env.coord.enqueue(bad);
    const r = await env.coord.execute(bad.mutationId);
    expect(r.state).toBe("FAILED");
    expect(r.error).toStartWith("STATUS_TRANSITION_FORBIDDEN");
    expect(isClean(env.coord.paths.agentWorktree)).toBe(true);

    const typeChange = replaceMutation(env.repo.path, "main", y.path, y.content.replace("type: idea", "type: decision"));
    await env.coord.enqueue(typeChange);
    const r2 = await env.coord.execute(typeChange.mutationId);
    expect(r2.state).toBe("FAILED");
    expect(r2.error).toStartWith("TYPE_CHANGE_FORBIDDEN");
    expect((await env.coord.getMutation(typeChange.mutationId))?.lastError).toStartWith("TYPE_CHANGE_FORBIDDEN");
  });

  test("proposal-derived types skip the automatic status/type protections", async () => {
    env = await setupEnv();
    const x = seedNote(env, "knowledge/x.md", { title: "X", status: "superseded" });
    const m = replaceMutation(env.repo.path, "main", x.path, x.content.replace("status: superseded", "status: archived"), {
      type: "RECONCILE_EVOLUTION",
    });
    await env.coord.enqueue(m);
    const r = await env.coord.execute(m.mutationId);
    expect(r.state).toBe("COMMITTED");
    expect(r.proposalRequired).toBeUndefined();
    const sha = commitsWithMutationId(env.repo.path, AGENT_BRANCH, m.mutationId)[0]!;
    expect(trailer(env.repo.path, sha, "Mutation-Type")).toBe("RECONCILE_EVOLUTION");
    expect(trailer(env.repo.path, sha, "Actor")).toBe("agent");
  });

  test("a declared target whose write is byte-identical is tolerated (partial NOOP, spec §12 step 9)", async () => {
    env = await setupEnv();
    const x = seedNote(env, "knowledge/x.md", { title: "X" });
    const y = seedNote(env, "knowledge/y.md", { title: "Y" });
    const mainSha = revParse(env.repo.path, "main");
    const m = mkMutation({
      type: "ENRICH",
      targets: [
        present(x.id, x.path, blobAt(env.repo.path, "main", x.path)!),
        present(y.id, y.path, blobAt(env.repo.path, "main", y.path)!),
      ],
      writes: [
        { path: x.path, content: x.content + "\n## Evidence\nmore\n" },
        { path: y.path, content: y.content },
      ],
    });
    await env.coord.enqueue(m);
    const r = await env.coord.execute(m.mutationId);
    expect(r.state).toBe("COMMITTED");
    expect(revParse(env.repo.path, AGENT_BRANCH)).not.toBe(mainSha);
    expect(isClean(env.coord.paths.agentWorktree)).toBe(true);
    const sha = commitsWithMutationId(env.repo.path, AGENT_BRANCH, m.mutationId)[0]!;
    expect(filesInCommit(env.repo.path, sha)).toEqual([x.path]);
    expect(fileAt(env.repo.path, AGENT_BRANCH, y.path)).toBe(y.content);
  });

  test("CREATE with a write whose basename is not the absent slug is invalid; a colliding slug fails validation", async () => {
    env = await setupEnv();
    seedNote(env, "knowledge/x-note.md", { title: "X" });
    const mainSha = revParse(env.repo.path, "main");
    const wrongPath = mkMutation({
      type: "CREATE",
      targets: [absent("new-note")],
      writes: [{ path: "knowledge/other.md", content: noteMd({ title: "N" }) }],
    });
    await env.coord.enqueue(wrongPath);
    expect((await env.coord.execute(wrongPath.mutationId)).state).toBe("FAILED_INVALID_EXECUTION");
    expect(fileAt(env.repo.path, AGENT_BRANCH, "knowledge/other.md")).toBeNull();

    // absent(slug) passes case-insensitively only when no such slug exists; here it exists → REPLAN
    const dup = createMutation("knowledge/X-Note.md", { title: "dup" });
    await env.coord.enqueue(dup);
    const r = await env.coord.execute(dup.mutationId);
    expect(r.state).toBe("REPLAN");
    expect(r.error).toStartWith("PRECONDITION_FAILED");
    expect(revParse(env.repo.path, AGENT_BRANCH)).toBe(mainSha);
  });

  test("CREATE colliding with an existing alias fails validation without commit", async () => {
    env = await setupEnv();
    // slugKey keeps hyphens, so only "Agent-Autonomy" (not "Agent Autonomy") shares the key of slug agent-autonomy
    seedNote(env, "knowledge/z.md", { title: "Z", aliases: ["Agent-Autonomy"] });
    const mainSha = revParse(env.repo.path, "main");
    const m = createMutation("knowledge/agent-autonomy.md", { title: "Agent autonomy" });
    await env.coord.enqueue(m);
    const r = await env.coord.execute(m.mutationId);
    expect(r.state).toBe("FAILED");
    expect(r.error).toStartWith("SLUG_COLLISION");
    expect(revParse(env.repo.path, AGENT_BRANCH)).toBe(mainSha);
    expect(isClean(env.coord.paths.agentWorktree)).toBe(true);
  });

  test("title normalization keeps unknown frontmatter keys and existing aliases", async () => {
    env = await setupEnv();
    const x = seedNote(env, "knowledge/x.md", { title: "Old title", aliases: ["Kept"] });
    // human-written extra key, committed on main
    const withExtra = x.content.replace("status: active\n", "status: active\ncustom: hello world\n");
    await Bun.write(`${env.repo.path}/${x.path}`, withExtra);
    const { commitAsHuman } = await import("../harness");
    commitAsHuman(env.repo.path, "user: add custom key");
    const m = replaceMutation(env.repo.path, "main", x.path, withExtra.replace("# Old title", "# New title"));
    await env.coord.enqueue(m);
    expect((await env.coord.execute(m.mutationId)).state).toBe("COMMITTED");
    const after = fileAt(env.repo.path, AGENT_BRANCH, x.path)!;
    expect(after).toContain("custom: hello world");
    expect(after).toContain("# New title");
    const { aliasesOf } = await import("../harness");
    expect(aliasesOf(after)).toEqual(["Kept", "Old title"]);
  });

  test("terminal rows are never re-executed; idempotent by Mutation-ID", async () => {
    env = await setupEnv();
    const x = seedNote(env, "knowledge/x.md", { title: "X" });
    const m = replaceMutation(env.repo.path, "main", x.path, x.content + "\n## Evidence\nmore\n");
    await env.coord.enqueue(m);
    const r1 = await env.coord.execute(m.mutationId);
    expect(r1.state).toBe("COMMITTED");
    const r2 = await env.coord.execute(m.mutationId);
    expect(r2.state).toBe("COMMITTED");
    expect(r2.commitSha).toBe(r1.commitSha);
    expect(commitsWithMutationId(env.repo.path, AGENT_BRANCH, m.mutationId).length).toBe(1);
    expect((await env.coord.getMutation(m.mutationId))?.attemptCount).toBe(2);

    const { forceQueueState } = await import("../harness");
    forceQueueState(env, m.mutationId, "REPLAN");
    const r3 = await env.coord.execute(m.mutationId);
    expect(r3.state).toBe("REPLAN");
    expect((await env.coord.getMutation(m.mutationId))?.attemptCount).toBe(2);
  });

  test("submit integrates a committed mutation by fast-forward and reports INTEGRATED", async () => {
    env = await setupEnv();
    const x = seedNote(env, "knowledge/x.md", { title: "X" });
    const m = replaceMutation(env.repo.path, "main", x.path, x.content + "\n## Evidence\nmore\n");
    const r = await env.coord.submit(m);
    expect(r.state).toBe("INTEGRATED");
    expect(revParse(env.repo.path, "main")).toBe(r.commitSha!);
    expect(revParse(env.repo.path, AGENT_BRANCH)).toBe(revParse(env.repo.path, "main"));
    expect(isClean(env.repo.path)).toBe(true);
  });
});
