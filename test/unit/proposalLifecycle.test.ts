import { describe, test, expect, afterEach } from "bun:test";
import { AGENT_BRANCH } from "../../src/core/types";
import type { Proposal } from "../../src/core/types";
import {
  setupEnv,
  seedNote,
  blobAt,
  fileAt,
  commitAsHuman,
  mutationIdsOn,
  commitsWithMutationId,
  filesInCommit,
  trailer,
  newMutationId,
  isClean,
  revParse,
  type Env,
} from "../harness";

let env: Env;
afterEach(async () => {
  if (env) await env.cleanup();
});

let n = 0;
function mkProposal(p: Partial<Proposal> & Pick<Proposal, "operation" | "targets" | "writes">): Proposal {
  n += 1;
  return {
    proposalId: p.proposalId ?? `prop_unit_${n}`,
    mutationId: p.mutationId ?? newMutationId(),
    operation: p.operation,
    targets: p.targets,
    writes: p.writes,
    evidence: p.evidence ?? ["conversation://unit/1"],
    reasoning: p.reasoning ?? "unit",
    createdAt: p.createdAt ?? new Date().toISOString(),
    status: p.status ?? "PENDING",
  };
}

describe("proposal lifecycle through the coordinator", () => {
  test("accepted MERGE rewrites A and deletes B in one integrated commit", async () => {
    env = await setupEnv();
    const repo = env.repo.path;
    const a = seedNote(env, "knowledge/a.md", { title: "A", sections: { Claim: "a0" } });
    const b = seedNote(env, "knowledge/b.md", { title: "B", sections: { Claim: "b0" } });
    env.clock.advance(60_000);
    await env.coord.integrate();

    const merged = a.content + "\n## Evidence\nmerged from b\n";
    const p = mkProposal({
      operation: "MERGE",
      targets: [
        { noteId: a.id, path: a.path, blobHash: blobAt(repo, "main", a.path)! },
        { noteId: b.id, path: b.path, blobHash: blobAt(repo, "main", b.path)! },
      ],
      writes: [
        { path: a.path, content: merged },
        { path: b.path, content: null },
      ],
    });
    await env.coord.submitProposal(p);
    const r = await env.coord.acceptProposal(p.proposalId);
    expect(r.state).toBe("INTEGRATED");
    expect(r.mutationId).toBe(p.mutationId);

    expect(fileAt(repo, "main", a.path)).toBe(merged);
    expect(fileAt(repo, "main", b.path)).toBeNull();
    expect(mutationIdsOn(repo, "main")).toEqual([p.mutationId]);
    const sha = commitsWithMutationId(repo, "main", p.mutationId)[0]!;
    expect(filesInCommit(repo, sha).sort()).toEqual([a.path, b.path].sort());
    expect(trailer(repo, sha, "Mutation-Type")).toBe("MERGE");
    expect(trailer(repo, sha, "Actor")).toBe("agent");
    expect(revParse(repo, AGENT_BRANCH)).toBe(revParse(repo, "main"));
    expect(isClean(repo)).toBe(true);

    const row = (await env.coord.getMutation(p.mutationId))!;
    expect(row.state).toBe("INTEGRATED");
    expect(row.type).toBe("MERGE");
    expect(row.targets).toEqual([
      { kind: "present", noteId: a.id, path: a.path, blobHash: p.targets[0]!.blobHash },
      { kind: "present", noteId: b.id, path: b.path, blobHash: p.targets[1]!.blobHash },
    ]);
    const stored = (await env.coord.listProposals()).find((q) => q.proposalId === p.proposalId)!;
    expect(stored.status).toBe("ACCEPTED");
    expect(stored.resolvedAt).toBeDefined();
  });

  test("RECONCILE_EVOLUTION via proposal may change status and type of a superseded note", async () => {
    env = await setupEnv();
    const repo = env.repo.path;
    const x = seedNote(env, "knowledge/x.md", { title: "X", status: "superseded", type: "idea" });
    env.clock.advance(60_000);
    await env.coord.integrate();

    const next = x.content.replace("status: superseded", "status: archived").replace("type: idea", "type: decision");
    const p = mkProposal({
      operation: "RECONCILE_EVOLUTION",
      targets: [{ noteId: x.id, path: x.path, blobHash: blobAt(repo, "main", x.path)! }],
      writes: [{ path: x.path, content: next }],
    });
    await env.coord.submitProposal(p);
    const r = await env.coord.acceptProposal(p.proposalId);
    expect(r.state).toBe("INTEGRATED");
    expect(r.proposalRequired).toBeUndefined();
    expect(fileAt(repo, "main", x.path)).toBe(next);
  });

  test("accept sees a human commit on main that has not been integrated yet; nothing executes", async () => {
    env = await setupEnv();
    const repo = env.repo.path;
    const x = seedNote(env, "knowledge/x.md", { title: "X", sections: { Claim: "old" } });
    env.clock.advance(60_000);
    await env.coord.integrate();

    const p = mkProposal({
      operation: "ARCHIVE",
      targets: [{ noteId: x.id, path: x.path, blobHash: blobAt(repo, "main", x.path)! }],
      writes: [{ path: x.path, content: x.content.replace("status: active", "status: archived") }],
    });
    await env.coord.submitProposal(p);

    const humanX = x.content.replace("old", "human");
    await Bun.write(`${repo}/${x.path}`, humanX);
    commitAsHuman(repo, "user: edit x");
    // No integrate(): the agent branch still points at the pre-edit main.

    const r = await env.coord.acceptProposal(p.proposalId);
    expect(r.state).toBe("REPLAN");
    expect(r.error).toBe("STALE");
    expect(r.mutationId).toBe(p.mutationId);
    expect(await env.coord.getMutation(p.mutationId)).toBeUndefined();
    expect(mutationIdsOn(repo, "main")).toEqual([]);
    expect(fileAt(repo, "main", x.path)).toBe(humanX);
    const stored = (await env.coord.listProposals()).find((q) => q.proposalId === p.proposalId)!;
    expect(stored.status).toBe("STALE");

    // A second accept of a resolved proposal is refused the same way.
    const again = await env.coord.acceptProposal(p.proposalId);
    expect(again.state).toBe("REPLAN");
    expect(again.error).toBe("STALE");
  });

  test("rejecting keeps the proposal, never executes, and unknown ids throw", async () => {
    env = await setupEnv();
    const repo = env.repo.path;
    const x = seedNote(env, "knowledge/x.md", { title: "X" });
    env.clock.advance(60_000);
    await env.coord.integrate();
    const p = mkProposal({
      operation: "DELETE",
      targets: [{ noteId: x.id, path: x.path, blobHash: blobAt(repo, "main", x.path)! }],
      writes: [{ path: x.path, content: null }],
    });
    await env.coord.submitProposal(p);
    await env.coord.rejectProposal(p.proposalId, "keep it");
    const ev = await env.coord.negativeEvidenceFor([x.id]);
    expect(ev.map((q) => q.proposalId)).toEqual([p.proposalId]);
    expect(ev[0]!.decisionNote).toBe("keep it");
    expect(ev[0]!.resolvedAt).toBe(new Date(env.clock.now()).toISOString());
    expect(fileAt(repo, "main", x.path)).toBe(x.content);
    expect(await env.coord.listMutations()).toEqual([]);
    await expect(env.coord.acceptProposal("prop_missing")).rejects.toThrow(/unknown proposal/);
    await expect(env.coord.rejectProposal("prop_missing")).rejects.toThrow(/unknown proposal/);
  });
});
