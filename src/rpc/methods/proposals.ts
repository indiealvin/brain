/**
 * Proposal and mutation methods (docs/mac-app/protocol.md §4, §5):
 * `proposals.list`, `proposals.get`, `proposals.accept`, `proposals.reject`
 * and `mutations.list`, plus the `proposals.changed` notification.
 *
 * `proposals.list` and `proposals.get` refresh staleness first, which writes
 * STALE marks, so they take the worktree lock (CR-1) and can wait behind an
 * execute or integrate in any process. `proposals.get` computes its review
 * diff (CR-4, `FileDiff[]`) in core, in the same locked section as the
 * refresh. `mutations.list` only reads `queue.sqlite` and never waits.
 *
 * Decisions are the service layer's (`proposalsAccept`, `proposalsReject`),
 * shared with the CLI: core's compare-and-set under the worktree lock, so of
 * two decisions on one proposal, in any two processes, exactly one takes
 * effect. This adapter checks no status of its own. `accept` returns core's
 * `ExecutionResult` unchanged: a proposal that cannot apply is a normal
 * `REPLAN` result (`"STALE"`, or the executor's `"PRECONDITION_FAILED: …"`),
 * never an error. `toWireError` maps `UnknownProposalError` to
 * `UNKNOWN_PROPOSAL {proposalId}` and `ProposalNotPendingError` (a lost
 * reject) to `PROPOSAL_NOT_PENDING {proposalId, status}`.
 *
 * `proposals.changed {}` is sent whenever this server's coordinator reports
 * a proposal change (`watchProposalChanges`): a proposal its knowledge run
 * created, and every locked section that decided or marked STALE a proposal
 * (an accept, a reject, the staleness refresh of `proposals.list` or
 * `proposals.get`). It is sent before that request's result. Another
 * process's changes are never reported here; the `repo.changed` poll sees
 * them.
 */
import { mutationsList, DEFAULT_MUTATIONS_PAGE } from "../../commands/mutations";
import {
  PROPOSAL_STATUSES,
  proposalsAccept,
  proposalsGetDetail,
  proposalsList,
  proposalsReject,
  proposalSummary,
  type ProposalRejectResult,
  type ProposalSummary,
} from "../../commands/proposals";
import type { ProposalDetail } from "../../core/coordinator";
import { QUEUE_STATES, type Coord } from "../../commands/repo";
import type { ExecutionResult, QueueRow } from "../../core/types";
import { optionalEnum, optionalEnumArray, optionalPositiveInt, optionalString, requireString } from "../params";
import type { RequestContext, RpcServer } from "../server";

export const PROPOSALS_CHANGED = "proposals.changed";

/**
 * Send `proposals.changed {}` for every proposal change `coord` reports
 * (protocol §5). Subscribed once, when `initialize` opens the coordinator.
 */
export function watchProposalChanges(server: RpcServer, coord: Coord): () => void {
  return coord.onProposalsChanged(() => server.notify(PROPOSALS_CHANGED, {}));
}

/** `proposals.list {status?}` → `ProposalSummary[]`, oldest first, after a staleness refresh. */
async function list(ctx: RequestContext): Promise<ProposalSummary[]> {
  const status = optionalEnum(ctx.params, "status", PROPOSAL_STATUSES);
  return (await proposalsList(ctx.server.session.coord, { status })).map(proposalSummary);
}

/**
 * `proposals.get {proposalId}` → `{proposal, diff}`: the whole `Proposal`
 * (with `writes`) after a staleness refresh, and one `FileDiff` per write.
 * `UNKNOWN_PROPOSAL`.
 */
function get(ctx: RequestContext): Promise<ProposalDetail> {
  const proposalId = requireString(ctx.params, "proposalId");
  return proposalsGetDetail(ctx.server.session.coord, proposalId);
}

/** `proposals.accept {proposalId}` → `ExecutionResult`. `UNKNOWN_PROPOSAL`. */
function accept(ctx: RequestContext): Promise<ExecutionResult> {
  const proposalId = requireString(ctx.params, "proposalId");
  return proposalsAccept(ctx.server.session.coord, proposalId);
}

/** `proposals.reject {proposalId, note?}` → `{proposalId, status: "REJECTED"}`. `UNKNOWN_PROPOSAL`, `PROPOSAL_NOT_PENDING`. */
function reject(ctx: RequestContext): Promise<ProposalRejectResult> {
  const proposalId = requireString(ctx.params, "proposalId");
  const note = optionalString(ctx.params, "note");
  return proposalsReject(ctx.server.session.coord, proposalId, note);
}

/** `mutations.list {states?, limit?=100}` → `QueueRow[]`, newest first. */
function mutations(ctx: RequestContext): Promise<QueueRow[]> {
  const states = optionalEnumArray(ctx.params, "states", QUEUE_STATES);
  const limit = optionalPositiveInt(ctx.params, "limit") ?? DEFAULT_MUTATIONS_PAGE;
  return mutationsList(ctx.server.session.coord, { states, limit });
}

export function registerProposalMethods(server: RpcServer): void {
  server.register("proposals.list", { handler: list });
  server.register("proposals.get", { handler: get });
  server.register("proposals.accept", { handler: accept });
  server.register("proposals.reject", { handler: reject });
  server.register("mutations.list", { handler: mutations });
}
