/**
 * First-run methods (docs/mac-app/protocol.md §3), accepted before and after
 * `initialize`: `repo.init` and `doctor.run`. Neither needs a coordinator.
 */
import { resolve } from "node:path";
import { initRepo, type RepoInitResult } from "../../commands/repo";
import { runDoctor, type DoctorReport } from "../../config/doctor";
import { optionalBoolean, optionalString, providerEnvParam, requireString } from "../params";
import type { RequestContext, RpcServer } from "../server";

/** `repo.init {path}`: create or repair the knowledge repo at `path` (the service layer's `initRepo`, same data as `brain init --json`). */
function repoInit(ctx: RequestContext): RepoInitResult {
  return initRepo(resolve(requireString(ctx.params, "path")));
}

/**
 * `doctor.run {repoPath?, offline?, env?}`: the `brain doctor` checks
 * (`runDoctor`, which opens no coordinator).
 *
 * The env is a private one, merged as in `initialize`:
 * `applyUserConfigToEnv(loadUserConfig(), {...base, ...params.env})`, where
 * `base` is `process.env` before `initialize` and the session's private env
 * after it. So after `initialize`, `doctor.run {}` checks what the server
 * uses, and `doctor.run {env}` checks a change layered on top of it (a new
 * key from Settings, say) before the client restarts the server with it.
 *
 * The live Anthropic check runs in isolated mode (CR-11): credentials come
 * from that env only, never from `process.env` or the SDK's default
 * credential chain.
 *
 * `repoPath` is the repo root as given (no walk-up); after `initialize` it
 * defaults to the initialized repo. A path that is not a knowledge repo is
 * reported by the doctor's `repo` check, not as an error.
 */
async function doctorRun(ctx: RequestContext): Promise<DoctorReport> {
  const server = ctx.server;
  const repoPath = optionalString(ctx.params, "repoPath");
  const offline = optionalBoolean(ctx.params, "offline") ?? false;
  const overlay = providerEnvParam(ctx.params);
  const ready = server.phase === "ready";
  const env = ready ? server.buildPrivateEnv(overlay, server.session.env) : server.buildPrivateEnv(overlay);
  const repoRoot = repoPath !== undefined ? resolve(repoPath) : ready ? server.session.userWorktree : null;
  return runDoctor({ env, repoRoot, offline, isolatedEnv: true });
}

export function registerFirstRunMethods(server: RpcServer): void {
  server.register("repo.init", { preInitialize: true, handler: repoInit });
  server.register("doctor.run", { preInitialize: true, handler: doctorRun });
}
