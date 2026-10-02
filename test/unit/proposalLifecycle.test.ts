import { describe, test, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { AGENT_BRANCH } from "../../src/core/types";
import type { Proposal } from "../../src/core/types";
import { PROPOSAL_NOT_PENDING, ProposalNotPendingError, UNKNOWN_PROPOSAL, UnknownProposalError } from "../../src/proposal/store";
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
    const unknown = await env.coord.rejectProposal("prop_missing").catch((e: unknown) => e);
    expect(unknown).toBeInstanceOf(UnknownProposalError);
    expect(unknown).toMatchObject({ code: UNKNOWN_PROPOSAL, proposalId: "prop_missing" });
    expect(await env.coord.acceptProposal("prop_missing").catch((e: unknown) => e)).toBeInstanceOf(UnknownProposalError);
  });

  /** Reject `id` and return the error it must fail with. */
  async function rejectFails(id: string, note: string): Promise<ProposalNotPendingError> {
    const err = await env.coord.rejectProposal(id, note).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ProposalNotPendingError);
    return err as ProposalNotPendingError;
  }

  test("reject of a proposal that is no longer PENDING fails with PROPOSAL_NOT_PENDING and changes nothing (CR-1)", async () => {
    env = await setupEnv();
    const repo = env.repo.path;
    const notes = ["a", "r", "s"].map((k) => seedNote(env, `knowledge/${k}.md`, { title: k.toUpperCase(), sections: { Claim: `${k} claim` } }));
    env.clock.advance(60_000);
    await env.coord.integrate();
    const [accepted, rejected, stale] = notes.map((x) =>
      mkProposal({
        operation: "ARCHIVE",
        targets: [{ noteId: x.id, path: x.path, blobHash: blobAt(repo, "main", x.path)! }],
        writes: [{ path: x.path, content: x.content.replace("status: active", "status: archived") }],
      }),
    ) as [Proposal, Proposal, Proposal];
    for (const p of [accepted, rejected, stale]) await env.coord.submitProposal(p);

    expect((await env.coord.acceptProposal(accepted.proposalId)).state).toBe("INTEGRATED");
    await env.coord.rejectProposal(rejected.proposalId, "first");
    const s = notes[2]!;
    await Bun.write(`${repo}/${s.path}`, s.content.replace("s claim", "human claim"));
    commitAsHuman(repo, "user: edit s");
    env.clock.advance(60_000);
    await env.coord.integrate(); // the next refresh marks `stale` STALE
    const before = await env.coord.listProposals();
    expect(Object.fromEntries(before.map((p) => [p.proposalId, p.status]))).toEqual({
      [accepted.proposalId]: "ACCEPTED",
      [rejected.proposalId]: "REJECTED",
      [stale.proposalId]: "STALE",
    });
    const main = revParse(repo, "main");

    for (const [p, status] of [
      [accepted, "ACCEPTED"],
      [rejected, "REJECTED"],
      [stale, "STALE"],
    ] as const) {
      const err = await rejectFails(p.proposalId, "too late");
      expect(err.code).toBe(PROPOSAL_NOT_PENDING);
      expect(err.proposalId).toBe(p.proposalId);
      expect(err.status).toBe(status);
    }
    // Nothing was written: not the status, not the note, not resolvedAt.
    expect(await env.coord.listProposals()).toEqual(before);
    expect(before.find((p) => p.proposalId === rejected.proposalId)!.decisionNote).toBe("first");
    expect(revParse(repo, "main")).toBe(main);
  });

  test("reject refreshes staleness first: a proposal whose target changed ends STALE, never REJECTED (I-19)", async () => {
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

    // The target changes on main and reaches agent/repo; nothing has refreshed staleness since.
    await Bun.write(`${repo}/${x.path}`, x.content.replace("old", "human"));
    commitAsHuman(repo, "user: edit x");
    env.clock.advance(60_000);
    await env.coord.integrate();
    expect(blobAt(repo, AGENT_BRANCH, x.path)).not.toBe(p.targets[0]!.blobHash);
    const storedRow = () => {
      const db = new Database(env.coord.paths.proposalsDb, { readonly: true });
      try {
        return db.query("SELECT status, decision_note FROM proposals WHERE proposal_id = ?").get(p.proposalId);
      } finally {
        db.close();
      }
    };
    expect(storedRow()).toEqual({ status: "PENDING", decision_note: null }); // stale, but not yet marked

    const err = await rejectFails(p.proposalId, "no");
    expect(err).toMatchObject({ code: PROPOSAL_NOT_PENDING, proposalId: p.proposalId, status: "STALE" });
    expect(storedRow()).toEqual({ status: "STALE", decision_note: null });
    expect(await env.coord.negativeEvidenceFor([x.id])).toEqual([]);
  });

  test("accept of a rejected proposal returns REPLAN / STALE and executes nothing", async () => {
    env = await setupEnv();
    const repo = env.repo.path;
    const x = seedNote(env, "knowledge/x.md", { title: "X" });
    env.clock.advance(60_000);
    await env.coord.integrate();
    const p = mkProposal({
      operation: "ARCHIVE",
      targets: [{ noteId: x.id, path: x.path, blobHash: blobAt(repo, "main", x.path)! }],
      writes: [{ path: x.path, content: x.content.replace("status: active", "status: archived") }],
    });
    await env.coord.submitProposal(p);
    await env.coord.rejectProposal(p.proposalId, "no");
    const agent = revParse(repo, AGENT_BRANCH);

    const r = await env.coord.acceptProposal(p.proposalId);
    expect(r).toEqual({ mutationId: p.mutationId, state: "REPLAN", error: "STALE" });
    expect(await env.coord.getMutation(p.mutationId)).toBeUndefined();
    expect(commitsWithMutationId(repo, AGENT_BRANCH, p.mutationId)).toEqual([]);
    expect(revParse(repo, AGENT_BRANCH)).toBe(agent);
    const stored = (await env.coord.listProposals()).find((q) => q.proposalId === p.proposalId)!;
    expect(stored).toMatchObject({ status: "REJECTED", decisionNote: "no" });
  });
});
