/**
 * Proposal and mutation reads (docs/mac-app/protocol.md §4): `proposals.list`
 * and `mutations.list`.
 *
 * `proposals.list` refreshes staleness first, which writes STALE marks, so it
 * takes the worktree lock (CR-1) and can wait behind an execute or integrate
 * in any process. `mutations.list` only reads `queue.sqlite` and never waits.
 */
import { mutationsList, DEFAULT_MUTATIONS_PAGE } from "../../commands/mutations";
import { PROPOSAL_STATUSES, proposalsList, proposalSummary, type ProposalSummary } from "../../commands/proposals";
import { QUEUE_STATES } from "../../commands/repo";
import type { QueueRow } from "../../core/types";
import { optionalEnum, optionalEnumArray, optionalPositiveInt } from "../params";
import type { RequestContext, RpcServer } from "../server";

/** `proposals.list {status?}` → `ProposalSummary[]`, oldest first, after a staleness refresh. */
async function list(ctx: RequestContext): Promise<ProposalSummary[]> {
  const status = optionalEnum(ctx.params, "status", PROPOSAL_STATUSES);
  return (await proposalsList(ctx.server.session.coord, { status })).map(proposalSummary);
}

/** `mutations.list {states?, limit?=100}` → `QueueRow[]`, newest first. */
function mutations(ctx: RequestContext): Promise<QueueRow[]> {
  const states = optionalEnumArray(ctx.params, "states", QUEUE_STATES);
  const limit = optionalPositiveInt(ctx.params, "limit") ?? DEFAULT_MUTATIONS_PAGE;
  return mutationsList(ctx.server.session.coord, { states, limit });
}

export function registerProposalMethods(server: RpcServer): void {
  server.register("proposals.list", { handler: list });
  server.register("mutations.list", { handler: mutations });
}
