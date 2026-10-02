/**
 * In-process proposal change reports (`onProposalsChanged`, the concrete
 * coordinator; T1.6): what the RPC server sends as `proposals.changed`
 * (docs/mac-app/protocol.md §5).
 *
 * - Once per created proposal; a duplicate insert reports nothing.
 * - Once per locked section that decided or marked STALE any proposal, after
 *   that section, with every id it changed; also when the section throws
 *   (a reject whose own refresh marked its proposal STALE).
 * - Nothing for a section that changed nothing: a list with nothing to mark,
 *   a lost accept (`REPLAN` / `"STALE"`), a lost reject, an unknown id.
 * - A get with its review diff (`proposalDetail`, T1.8) reports like a list:
 *   its refresh is one locked section, the diff computed in that section.
 * - Never for another coordinator's writes (another process, in production).
 * - A listener that throws fails nothing.
 *
 * The transcripts (test/rpc/transcripts/proposals-*.jsonl) cover the same
 * reports end to end over RPC.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { openCoordinator } from "../../src/core/coordinator";
import type { Coord } from "../../src/commands/repo";
import type { Proposal } from "../../src/core/types";
import { ProposalNotPendingError, UnknownProposalError } from "../../src/proposal/store";
import { blobAt, commitAsHuman, newMutationId, seedNote, setupEnv, type Env } from "../harness";

let env: Env | null = null;
afterEach(async () => {
  if (env) await env.cleanup();
  env = null;
});

/** Every report, in order. */
function watch(coord: Coord): string[][] {
  const reports: string[][] = [];
  coord.onProposalsChanged((ids) => reports.push(ids));
  return reports;
}

function mkProposal(p: Pick<Proposal, "operation" | "targets" | "writes">): Proposal {
  const id = newMutationId().replace(/^mut_/, "prop_");
  return { proposalId: id, mutationId: newMutationId(), evidence: ["conversation://unit/1"], reasoning: "unit", createdAt: new Date().toISOString(), status: "PENDING", ...p };
}

/** A note on main and agent/repo, and an (unsubmitted) ARCHIVE proposal for it. */
async function archiveOf(e: Env, slug: string): Promise<{ p: Proposal; path: string; content: string }> {
  const x = seedNote(e, `knowledge/${slug}.md`, { title: slug.toUpperCase(), sections: { Claim: `${slug} claim` } });
  await e.coord.integrate();
  const p = mkProposal({
    operation: "ARCHIVE",
    targets: [{ noteId: x.id, path: x.path, blobHash: blobAt(e.repo.path, "main", x.path)! }],
    writes: [{ path: x.path, content: x.content.replace("status: active", "status: archived") }],
  });
  return { p, path: x.path, content: x.content };
}

/** A human edit of `path`, committed on main and caught up on agent/repo: the proposal's snapshot no longer matches. */
async function editTarget(e: Env, path: string): Promise<void> {
  const abs = join(e.repo.path, path);
  await Bun.write(abs, (await Bun.file(abs).text()) + "\nedited by a human\n");
  commitAsHuman(e.repo.path, `user: edit ${path}`);
  e.clock.advance(60_000);
  await e.coord.integrate();
}

describe("onProposalsChanged (T1.6)", () => {
  test("a created proposal is reported once; a duplicate insert is not", async () => {
    env = await setupEnv();
    const coord = env.coord as Coord;
    const reports = watch(coord);
    const { p } = await archiveOf(env, "created");
    expect(reports).toEqual([]);
    await coord.submitProposal(p);
    expect(reports).toEqual([[p.proposalId]]);
    await coord.submitProposal(p);
    expect(reports).toEqual([[p.proposalId]]);
  });

  test("a list reports the proposals its refresh marked STALE, and nothing when it marks none", async () => {
    env = await setupEnv();
    const coord = env.coord as Coord;
    const { p, path } = await archiveOf(env, "listed");
    await coord.submitProposal(p);
    const reports = watch(coord);
    await coord.listProposals();
    expect(reports).toEqual([]);
    await editTarget(env, path);
    expect(reports).toEqual([]); // integrate refreshes no proposal
    expect((await coord.listProposals()).find((x) => x.proposalId === p.proposalId)!.status).toBe("STALE");
    expect(reports).toEqual([[p.proposalId]]);
    await coord.listProposals();
    expect(reports).toEqual([[p.proposalId]]);
  });

  test("an accept reports once, with every proposal its section changed; a lost or unknown accept reports nothing", async () => {
    env = await setupEnv();
    const coord = env.coord as Coord;
    const a = await archiveOf(env, "accepted");
    const b = await archiveOf(env, "outdated");
    await coord.submitProposal(a.p);
    await coord.submitProposal(b.p);
    await editTarget(env, b.path);
    const reports = watch(coord);
    // One section: b is marked STALE by the refresh, a is accepted, executed and integrated.
    expect((await coord.acceptProposal(a.p.proposalId)).state).toBe("INTEGRATED");
    expect(reports.map((ids) => [...ids].sort())).toEqual([[a.p.proposalId, b.p.proposalId].sort()]);
    expect(await coord.acceptProposal(a.p.proposalId)).toEqual({ mutationId: a.p.mutationId, state: "REPLAN", error: "STALE" });
    expect(await coord.acceptProposal(b.p.proposalId)).toEqual({ mutationId: b.p.mutationId, state: "REPLAN", error: "STALE" });
    await expect(coord.acceptProposal("prop_nope")).rejects.toBeInstanceOf(UnknownProposalError);
    expect(reports).toHaveLength(1);
  });

  test("a reject reports once; a lost reject reports nothing, unless its own refresh marked the proposal STALE", async () => {
    env = await setupEnv();
    const coord = env.coord as Coord;
    const a = await archiveOf(env, "rejected");
    const b = await archiveOf(env, "stale-on-reject");
    await coord.submitProposal(a.p);
    await coord.submitProposal(b.p);
    const reports = watch(coord);
    await coord.rejectProposal(a.p.proposalId, "no");
    expect(reports).toEqual([[a.p.proposalId]]);
    await expect(coord.rejectProposal(a.p.proposalId)).rejects.toMatchObject({ status: "REJECTED" });
    expect(reports).toHaveLength(1);

    await editTarget(env, b.path);
    const err = await coord.rejectProposal(b.p.proposalId).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProposalNotPendingError);
    expect((err as ProposalNotPendingError).status).toBe("STALE");
    expect(reports).toEqual([[a.p.proposalId], [b.p.proposalId]]); // reported although the section threw
  });

  test("a drain that marks an accepted proposal STALE (its mutation reached REPLAN) reports it", async () => {
    env = await setupEnv();
    const coord = env.coord as Coord;
    const { p, path, content } = await archiveOf(env, "replanned");
    await coord.submitProposal(p);
    await Bun.write(join(env.repo.path, path), content.replace("replanned claim", "the human's edit")); // not quiescent yet
    const reports = watch(coord);
    expect((await coord.acceptProposal(p.proposalId)).state).toBe("COMMITTED"); // integration refused: dirty target
    expect(reports).toEqual([[p.proposalId]]);
    env.clock.advance(60_000);
    await coord.integrate(); // Human Sync commits the edit; the rebuild sends the mutation to REPLAN and marks nothing
    expect(reports).toHaveLength(1);
    expect(await coord.drainQueued()).toEqual([]);
    expect(reports).toEqual([[p.proposalId], [p.proposalId]]);
    expect((await coord.listProposals()).find((x) => x.proposalId === p.proposalId)!.status).toBe("STALE");
    expect(reports).toHaveLength(2);
  });

  test("another coordinator's writes are not reported; a throwing listener fails nothing", async () => {
    env = await setupEnv();
    const coord = env.coord as Coord;
    const other = (await openCoordinator(env.repo.path, { clock: env.clock })) as Coord;
    try {
      const reports = watch(coord);
      coord.onProposalsChanged(() => {
        throw new Error("listener failure");
      });
      const a = await archiveOf(env, "elsewhere");
      await other.submitProposal(a.p);
      await other.rejectProposal(a.p.proposalId);
      expect(reports).toEqual([]);

      const b = await archiveOf(env, "here");
      await coord.submitProposal(b.p);
      await coord.rejectProposal(b.p.proposalId);
      expect(reports).toEqual([[b.p.proposalId], [b.p.proposalId]]);
    } finally {
      await other.close();
    }
  });

  test("a get (proposalDetail) reports the proposals its refresh marked STALE, once, and nothing when it marks none or the id is unknown", async () => {
    env = await setupEnv();
    const coord = env.coord as Coord;
    const a = await archiveOf(env, "detailed");
    const b = await archiveOf(env, "also-outdated");
    await coord.submitProposal(a.p);
    await coord.submitProposal(b.p);
    const reports = watch(coord);
    const fresh = await coord.proposalDetail(a.p.proposalId);
    expect(fresh.proposal).toEqual(a.p); // the whole Proposal, writes included
    expect(fresh.diff).toEqual([{ path: a.path, change: "modified", unified: expect.stringContaining("\n-status: active\n+status: archived\n"), additions: 1, deletions: 1 }]);
    expect(reports).toEqual([]);

    await editTarget(env, a.path);
    await editTarget(env, b.path);
    expect(reports).toEqual([]);
    // One section: the refresh marks both, then a's diff is computed against its snapshot, still in history.
    const stale = await coord.proposalDetail(a.p.proposalId);
    expect(stale.proposal.status).toBe("STALE");
    expect(stale.diff).toEqual(fresh.diff);
    expect(reports.map((ids) => [...ids].sort())).toEqual([[a.p.proposalId, b.p.proposalId].sort()]);
    await coord.proposalDetail(b.p.proposalId);
    await expect(coord.proposalDetail("prop_nope")).rejects.toBeInstanceOf(UnknownProposalError);
    expect(reports).toHaveLength(1);
  });

  test("a get runs the REPLAN → STALE check of accepted proposals too", async () => {
    env = await setupEnv();
    const coord = env.coord as Coord;
    const { p, path, content } = await archiveOf(env, "accepted-then-replanned");
    await coord.submitProposal(p);
    await Bun.write(join(env.repo.path, path), content.replace("accepted-then-replanned claim", "the human's edit")); // not quiescent yet
    expect((await coord.acceptProposal(p.proposalId)).state).toBe("COMMITTED"); // integration refused: dirty target
    env.clock.advance(60_000);
    await coord.integrate(); // Human Sync commits the edit; the rebuild sends the mutation to REPLAN
    const reports = watch(coord);
    const detail = await coord.proposalDetail(p.proposalId);
    expect(detail.proposal.status).toBe("STALE");
    expect(detail.diff.map((d) => [d.path, d.change])).toEqual([[path, "modified"]]);
    expect(reports).toEqual([[p.proposalId]]);
  });

  test("unsubscribing stops the reports", async () => {
    env = await setupEnv();
    const coord = env.coord as Coord;
    const reports: string[][] = [];
    const stop = coord.onProposalsChanged((ids) => reports.push(ids));
    const { p } = await archiveOf(env, "unsubscribed");
    stop();
    await coord.submitProposal(p);
    expect(reports).toEqual([]);
  });
});
