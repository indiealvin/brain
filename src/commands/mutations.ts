/**
 * Service layer, the mutation queue (CR-2): `mutations.list`
 * (docs/mac-app/protocol.md §4). A read of `queue.sqlite`; takes no lock.
 */
import type { MutationState, QueueRow, RepoCoordinator } from "../core/types";

export const DEFAULT_MUTATIONS_PAGE = 100;

/**
 * Queue rows, newest first: `listMutations` (`seq` ascending) filtered to
 * `states` when given (an empty list matches nothing), reversed, then cut to
 * the first `limit` (> 0).
 */
export async function mutationsList(coord: RepoCoordinator, opts: { states?: readonly MutationState[]; limit?: number } = {}): Promise<QueueRow[]> {
  const limit = opts.limit ?? DEFAULT_MUTATIONS_PAGE;
  const states = opts.states === undefined ? null : new Set(opts.states);
  const rows = await coord.listMutations();
  return rows
    .filter((r) => states === null || states.has(r.state))
    .reverse()
    .slice(0, limit);
}
