/**
 * Lifecycle methods (docs/mac-app/protocol.md §3): `initialize`, `shutdown`,
 * `cancel`.
 */
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { openRepo } from "../../commands/repo";
import { CONFIG_FILE } from "../../markdown/repo";
import { DEFAULT_ENGINE_INTERVAL_MS, PROTOCOL_VERSION, type InitializeResult } from "../dto";
import { RpcEngine } from "../engine";
import { invalidParams, RpcError } from "../errors";
import { optionalObject, optionalPositiveInt, providerEnvParam, requireString, type Params } from "../params";
import { BRAIN_VERSION, type RequestContext, type RpcServer } from "../server";

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
 * nothing is pending, reconcile the index), then open the engine
 * (src/rpc/engine.ts): take the `repo.changed` baseline and try-lock the
 * loop-owner lock (CR-10). The result's `engine` says who runs the loop. The
 * engine starts (the loop, polls, later try-locks) once the result is sent,
 * so no notification precedes it.
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
    let engine: RpcEngine;
    try {
      engine = await RpcEngine.open({ server, coord, intervalMs: p.intervalMs });
    } catch (e) {
      await coord.close();
      throw e;
    }
    // Registered before the coordinator's own close hook, so (hooks run last registered first) the engine
    // closes after the coordinator and the loop-owner lock is released last (protocol §3, shutdown step 5).
    server.onClose(() => engine.close());
    server.completeInitialize({
      repoId: coord.config.repoId,
      userWorktree: coord.paths.userWorktree,
      stateDir: coord.paths.stateDir,
      coord,
      env,
      providerEnv: p.env,
      engine,
    });
    server.onStopLoop(() => engine.stopLoop());
    // Once this result is sent: the result goes out in promise reactions, which all run before a timer.
    setTimeout(() => engine.start(), 0);
    const s = server.session;
    return { protocolVersion: PROTOCOL_VERSION, brainVersion: BRAIN_VERSION, repoId: s.repoId, userWorktree: s.userWorktree, stateDir: s.stateDir, engine: engine.info() };
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
