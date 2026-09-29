/**
 * Phase 10 fixtures — proposal lifecycle (spec §3.14, 3.19, 3.23, §33–34).
 * READ-ONLY for implementers.
 */
import { describe, test, expect, afterEach } from "bun:test";
import type { Proposal } from "../../src/core/types";
import { setupEnv, seedNote, blobAt, fileAt, commitAsHuman, mutationIdsOn, newMutationId, type Env } from "../harness";

let env: Env;
afterEach(async () => {
  if (env) await env.cleanup();
});

let pCounter = 0;
function mkProposal(p: Partial<Proposal> & Pick<Proposal, "operation" | "targets" | "writes">): Proposal {
  pCounter += 1;
  return {
    proposalId: p.proposalId ?? `prop_${String(pCounter).padStart(6, "0")}`,
    mutationId: p.mutationId ?? newMutationId(),
    operation: p.operation,
    targets: p.targets,
    writes: p.writes,
    evidence: p.evidence ?? ["conversation://fixture/9"],
    reasoning: p.reasoning ?? "fixture",
    createdAt: p.createdAt ?? new Date().toISOString(),
    status: p.status ?? "PENDING",
  };
}

describe("3.14 proposal multi-target staleness", () => {
  test("any target blob change marks the proposal STALE", async () => {
    env = await setupEnv();
    const repo = env.repo.path;
    const a = seedNote(env, "knowledge/a.md", { title: "A", sections: { Claim: "a0" } });
    const b = seedNote(env, "knowledge/b.md", { title: "B", sections: { Claim: "b0" } });
    env.clock.advance(60_000);
    await env.coord.integrate();

    const p = mkProposal({
      operation: "MERGE",
      targets: [
        { noteId: a.id, path: a.path, blobHash: blobAt(repo, "main", a.path)! },
        { noteId: b.id, path: b.path, blobHash: blobAt(repo, "main", b.path)! },
      ],
      writes: [
        { path: a.path, content: a.content + "\n## Evidence\nmerged from b\n" },
        { path: b.path, content: null },
      ],
    });
    await env.coord.submitProposal(p);
    expect((await env.coord.listProposals()).find((x) => x.proposalId === p.proposalId)?.status).toBe("PENDING");

    await Bun.write(`${repo}/${b.path}`, b.content.replace("b0", "b1"));
    commitAsHuman(repo, "user: edit b");
    env.clock.advance(60_000);
    await env.coord.integrate();

    const after = (await env.coord.listProposals()).find((x) => x.proposalId === p.proposalId);
    expect(after?.status).toBe("STALE");
  });
});

describe("3.19 rejected proposal remains planner-visible", () => {
  test("rejection persists and is returned as negative evidence for its targets", async () => {
    env = await setupEnv();
    const repo = env.repo.path;
    const a = seedNote(env, "knowledge/a.md", { title: "A" });
    const b = seedNote(env, "knowledge/b.md", { title: "B" });
    env.clock.advance(60_000);
    await env.coord.integrate();

    const p = mkProposal({
      operation: "MERGE",
      targets: [
        { noteId: a.id, path: a.path, blobHash: blobAt(repo, "main", a.path)! },
        { noteId: b.id, path: b.path, blobHash: blobAt(repo, "main", b.path)! },
      ],
      writes: [{ path: b.path, content: null }],
    });
    await env.coord.submitProposal(p);
    await env.coord.rejectProposal(p.proposalId, "these are distinct ideas");

    const { reopen } = await import("../harness");
    const coord = await reopen(env);
    const ev = await coord.negativeEvidenceFor([a.id]);
    expect(ev.map((x) => x.proposalId)).toEqual([p.proposalId]);
    expect(ev[0]!.status).toBe("REJECTED");
    expect(ev[0]!.decisionNote).toBe("these are distinct ideas");
    expect(await coord.negativeEvidenceFor(["nope"])).toEqual([]);
    expect(fileAt(repo, "main", b.path)).toBe(b.content);
  });
});

describe("3.23 accepted proposal re-enters as a mutation", () => {
  test("accept executes with snapshot preconditions and integrates", async () => {
    env = await setupEnv();
    const repo = env.repo.path;
    const x = seedNote(env, "knowledge/x.md", { title: "X", sections: { Claim: "old claim" } });
    env.clock.advance(60_000);
    await env.coord.integrate();

    const newContent = x.content.replace("old claim", "reconciled claim").replace("status: active", "status: active");
    const p = mkProposal({
      operation: "RECONCILE_EVOLUTION",
      targets: [{ noteId: x.id, path: x.path, blobHash: blobAt(repo, "main", x.path)! }],
      writes: [{ path: x.path, content: newContent }],
    });
    await env.coord.submitProposal(p);
    const r = await env.coord.acceptProposal(p.proposalId);
    expect(r.state).toBe("INTEGRATED");
    expect(fileAt(repo, "main", x.path)).toBe(newContent);
    expect(mutationIdsOn(repo, "main")).toEqual([p.mutationId]);
    expect((await env.coord.listProposals()).find((q) => q.proposalId === p.proposalId)?.status).toBe("ACCEPTED");
  });

  test("accept of a proposal whose target changed is STALE and executes nothing", async () => {
    env = await setupEnv();
    const repo = env.repo.path;
    const x = seedNote(env, "knowledge/x.md", { title: "X", sections: { Claim: "old claim" } });
    env.clock.advance(60_000);
    await env.coord.integrate();

    const p = mkProposal({
      operation: "RECONCILE_EVOLUTION",
      targets: [{ noteId: x.id, path: x.path, blobHash: blobAt(repo, "main", x.path)! }],
      writes: [{ path: x.path, content: x.content.replace("old claim", "reconciled claim") }],
    });
    await env.coord.submitProposal(p);

    const humanX = x.content.replace("old claim", "human claim");
    await Bun.write(`${repo}/${x.path}`, humanX);
    commitAsHuman(repo, "user: edit x");
    env.clock.advance(60_000);
    await env.coord.integrate();

    const r = await env.coord.acceptProposal(p.proposalId);
    expect(r.state).not.toBe("COMMITTED");
    expect(r.state).not.toBe("INTEGRATED");
    expect((await env.coord.listProposals()).find((q) => q.proposalId === p.proposalId)?.status).toBe("STALE");
    expect(fileAt(repo, "main", x.path)).toBe(humanX);
    expect(mutationIdsOn(repo, "main")).toEqual([]);
  });
});
