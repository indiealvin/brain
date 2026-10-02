/**
 * Repo and engine reads (docs/mac-app/protocol.md §4): `repo.status` and
 * `engine.status`. Neither takes the worktree lock, so the status view never
 * waits behind an execute or integrate in any process (protocol §5).
 */
import { repoStatus, type RepoStatus } from "../../commands/repo";
import type { EngineStatus } from "../dto";
import type { RequestContext, RpcServer } from "../server";

/** `repo.status {}`: heads, queue counts per state, the advisory pending-proposal count, the indexed commit (`brain status` data). */
function status(ctx: RequestContext): Promise<RepoStatus> {
  return repoStatus(ctx.server.session.coord);
}

/**
 * `engine.status {}`: who runs the loop. Before T1.7 this is the staging
 * value from `initialize` (`loopOwner: "other"`, implementation-plan §2)
 * and there is no `lastTick`.
 */
function engineStatus(ctx: RequestContext): EngineStatus {
  return { ...ctx.server.session.engine };
}

export function registerRepoMethods(server: RpcServer): void {
  server.register("repo.status", { handler: status });
  server.register("engine.status", { handler: engineStatus });
}
