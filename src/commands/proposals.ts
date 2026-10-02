/**
 * Service layer, proposals (CR-2). Listing and getting refresh staleness in
 * core, under the worktree lock. Decisions are core's compare-and-set (CR-1):
 * this layer checks no status of its own, and core's typed errors
 * (`UnknownProposalError`, `ProposalNotPendingError`) pass through unchanged
 * for the adapters to map.
 */
import type { ExecutionResult, Proposal, ProposalStatus, RepoCoordinator } from "../core/types";
import { UnknownProposalError } from "../proposal/store";

/** Every proposal (or those in `status`), oldest first, after a staleness refresh. */
export async function proposalsList(coord: RepoCoordinator, opts: { status?: ProposalStatus } = {}): Promise<Proposal[]> {
  const all = await coord.listProposals();
  return opts.status === undefined ? all : all.filter((p) => p.status === opts.status);
}

/** One proposal, after a staleness refresh. Throws `UnknownProposalError`. */
export async function proposalsGet(coord: RepoCoordinator, proposalId: string): Promise<Proposal> {
  const p = (await coord.listProposals()).find((x) => x.proposalId === proposalId);
  if (!p) throw new UnknownProposalError(proposalId);
  return p;
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
