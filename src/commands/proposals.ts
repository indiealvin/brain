/**
 * Service layer, proposals (CR-2). Listing and getting refresh staleness in
 * core, under the worktree lock; getting with the review diff computes the
 * diff in that same locked section (CR-4). Decisions are core's
 * compare-and-set (CR-1):
 * this layer checks no status of its own, and core's typed errors
 * (`UnknownProposalError`, `ProposalNotPendingError`) pass through unchanged
 * for the adapters to map.
 */
import type { ProposalDetail } from "../core/coordinator";
import type { ExecutionResult, Proposal, ProposalStatus, RepoCoordinator } from "../core/types";
import { UnknownProposalError } from "../proposal/store";
import type { Coord } from "./repo";

/** Every `ProposalStatus`, in lifecycle order. */
export const PROPOSAL_STATUSES: readonly ProposalStatus[] = ["PENDING", "ACCEPTED", "REJECTED", "STALE"];

/** A proposal without its materialized `writes` (docs/mac-app/protocol.md §7): what a list shows. */
export type ProposalSummary = Omit<Proposal, "writes">;

export function proposalSummary(p: Proposal): ProposalSummary {
  const { writes: _writes, ...summary } = p;
  return summary;
}

/** Every proposal (or those in `status`), oldest first, after a staleness refresh. */
export async function proposalsList(coord: RepoCoordinator, opts: { status?: ProposalStatus } = {}): Promise<Proposal[]> {
  const all = await coord.listProposals();
  return opts.status === undefined ? all : all.filter((p) => p.status === opts.status);
}

/** One proposal, after a staleness refresh (`brain proposals show`). Throws `UnknownProposalError`. */
export async function proposalsGet(coord: RepoCoordinator, proposalId: string): Promise<Proposal> {
  const p = (await coord.listProposals()).find((x) => x.proposalId === proposalId);
  if (!p) throw new UnknownProposalError(proposalId);
  return p;
}

/**
 * One proposal and its review diff (`proposals.get`, CR-4): the staleness
 * refresh and the diff of every write against its snapshot blob, in one
 * locked section (`proposalDetail`). Throws `UnknownProposalError`.
 */
export function proposalsGetDetail(coord: Coord, proposalId: string): Promise<ProposalDetail> {
  return coord.proposalDetail(proposalId);
}

/** Accept (executes it). A proposal that is not PENDING returns `REPLAN` / `"STALE"`. Throws `UnknownProposalError`. */
export function proposalsAccept(coord: RepoCoordinator, proposalId: string): Promise<ExecutionResult> {
  return coord.acceptProposal(proposalId);
}

export interface ProposalRejectResult {
  proposalId: string;
  status: "REJECTED";
}

/** Reject. Throws `UnknownProposalError`, or `ProposalNotPendingError` when another decision won. */
export async function proposalsReject(coord: RepoCoordinator, proposalId: string, note?: string): Promise<ProposalRejectResult> {
  await coord.rejectProposal(proposalId, note);
  return { proposalId, status: "REJECTED" };
}
