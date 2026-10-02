/**
 * Repo and engine methods (docs/mac-app/protocol.md §4): `repo.status`,
 * `engine.status` and `engine.tick`. The two reads never take the worktree
 * lock, so the status view never waits behind an execute or integrate in any
 * process (protocol §5).
 */
import { repoStatus, type RepoStatus } from "../../commands/repo";
import type { EngineStatus, EngineTick } from "../dto";
import type { RequestContext, RpcServer } from "../server";

/** `repo.status {}`: heads, queue counts per state, the advisory pending-proposal count, the indexed commit (`brain status` data). */
function status(ctx: RequestContext): Promise<RepoStatus> {
  return repoStatus(ctx.server.session.coord);
}

/**
 * `engine.status {}`: who runs the loop (`EngineInfo`; `owner` from the
 * loop-owner lock's side file while another process holds it), and
 * `lastTick` once this server has run a tick. From memory and one side-file
 * read: never waits.
 */
function engineStatus(ctx: RequestContext): EngineStatus {
  return ctx.server.session.engine.status();
}

/**
 * `engine.tick {}` → `EngineTick`: one forced `watchTick` (drain, integrate,
 * reconcile when the agent branch moved, embed what is stale), whoever owns
 * the loop: every write in it takes the worktree lock (CR-1). It runs after
 * this server's tick in flight, never alongside it.
 */
function engineTick(ctx: RequestContext): Promise<EngineTick> {
  return ctx.server.session.engine.tick();
}

export function registerRepoMethods(server: RpcServer): void {
  server.register("repo.status", { handler: status });
  server.register("engine.status", { handler: engineStatus });
  server.register("engine.tick", { handler: engineTick });
}
