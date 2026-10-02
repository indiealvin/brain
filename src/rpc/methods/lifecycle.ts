/**
 * Lifecycle methods (docs/mac-app/protocol.md §3): `initialize`, `shutdown`,
 * `cancel`.
 */
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { openRepo } from "../../commands/repo";
import { CONFIG_FILE } from "../../markdown/repo";
import { DEFAULT_ENGINE_INTERVAL_MS, PROTOCOL_VERSION, type EngineInfo, type InitializeResult } from "../dto";
import { invalidParams, RpcError } from "../errors";
import { optionalObject, optionalPositiveInt, providerEnvParam, requireString, type Params } from "../params";
import { BRAIN_VERSION, type RequestContext, type RpcServer } from "../server";

/**
 * Before T1.7 the server takes no loop-owner lock and runs no loop, so it
 * reports the loop as someone else's, with no owner (implementation-plan §2):
 * a `brain watch` beside it is never blocked.
 */
function stagingEngineInfo(intervalMs: number): EngineInfo {
  return { loopOwner: "other", intervalMs };
}

interface ParsedInitialize {
  client: { name: string; version: string };
  repoPath: string;
  env: ReturnType<typeof providerEnvParam>;
  intervalMs: number;
}

/** `PROTOCOL_MISMATCH` is checked first: a client of another version learns that before anything else. */
function parseInitialize(p: Params): ParsedInitialize {
  const version = p["protocolVersion"];
  if (typeof version !== "number" || !Number.isInteger(version)) throw invalidParams("protocolVersion is required and must be an integer");
  if (version !== PROTOCOL_VERSION) throw new RpcError("PROTOCOL_MISMATCH", `this server speaks protocol version ${PROTOCOL_VERSION}, not ${version}`, { protocolVersion: PROTOCOL_VERSION });
  const client = optionalObject(p, "client");
  if (client === undefined || typeof client["name"] !== "string" || typeof client["version"] !== "string") throw invalidParams("client is required: {name: string, version: string}");
  const engine = optionalObject(p, "engine") ?? {};
  return {
    client: { name: client["name"], version: client["version"] },
    repoPath: requireString(p, "repoPath"),
    env: providerEnvParam(p),
    intervalMs: optionalPositiveInt(engine, "intervalMs", "engine.intervalMs") ?? DEFAULT_ENGINE_INTERVAL_MS,
  };
}

/**
 * `initialize` (protocol §3): build the private env, run the service layer's
 * open sequence (`openRepo`: recover, fast-forward the agent branch when
 * nothing is pending, reconcile the index), and report the session.
 *
 * `repoPath` must be the knowledge repo root itself (brain.toml there), as
 * `--repo` is for the CLI; there is no walk-up. A failure returns the server
 * to "uninitialized", so the client can pick another folder and retry.
 *
 * Cancelling `initialize` does not abort the open sequence (as for every
 * request); if it then succeeds the server is initialized, and a new
 * `initialize` gets `ALREADY_INITIALIZED`. A client that cancels
 * `initialize` should restart the server.
 */
async function initialize(ctx: RequestContext): Promise<InitializeResult> {
  const server = ctx.server;
  const p = parseInitialize(ctx.params);
  server.beginInitialize();
  try {
    const env = server.buildPrivateEnv(p.env);
    const repoDir = resolve(p.repoPath);
    if (!existsSync(join(repoDir, CONFIG_FILE))) throw new RpcError("NOT_A_REPO", `${repoDir} is not a knowledge repo (no ${CONFIG_FILE}); create it with repo.init`);
    server.log(`rpc: initialize: ${p.client.name} ${p.client.version}, repo ${repoDir}, env keys [${Object.keys(p.env).join(", ")}]`);
    const { coord } = await openRepo(repoDir);
    const engine = stagingEngineInfo(p.intervalMs);
    server.completeInitialize({
      repoId: coord.config.repoId,
      userWorktree: coord.paths.userWorktree,
      stateDir: coord.paths.stateDir,
      coord,
      env,
      providerEnv: p.env,
      engine,
    });
    const s = server.session;
    return { protocolVersion: PROTOCOL_VERSION, brainVersion: BRAIN_VERSION, repoId: s.repoId, userWorktree: s.userWorktree, stateDir: s.stateDir, engine: { ...s.engine } };
  } catch (e) {
    server.abandonInitialize();
    throw e;
  }
}

/** `shutdown` (protocol §3): the five drain steps, then `{}`. The process exits once this result is sent. */
async function shutdown(ctx: RequestContext): Promise<Record<string, never>> {
  await ctx.server.shutdown("shutdown request", ctx.id);
  return {};
}

/** `cancel {target}` (protocol §3). */
function cancel(ctx: RequestContext): { cancelled: boolean } {
  const target = requireString(ctx.params, "target");
  return { cancelled: ctx.server.cancel(target, ctx.id) };
}

export function registerLifecycleMethods(server: RpcServer): void {
  server.register("initialize", { preInitialize: true, handler: initialize });
  server.register("shutdown", { preInitialize: true, handler: shutdown });
  server.register("cancel", { preInitialize: true, handler: cancel });
}
