/**
 * The RPC adapter (docs/mac-app/protocol.md; CR-3): a thin layer over the
 * service layer in src/commands, like src/cli.ts. `createRpcServer` builds the
 * transport-agnostic server with every method of this version registered;
 * src/rpc/stdio.ts serves it as `brain rpc --stdio`.
 *
 * Adding a method (later tasks): write a handler `(ctx: RequestContext) =>
 * result` in src/rpc/methods/<area>.ts, register it in a
 * `register<Area>Methods(server)` function, and call that below. Handlers use
 * `ctx.server.session` (the coordinator and private env), `ctx.emit` for
 * events, `ctx.server.notify` for notifications, `ctx.server.modelProvider()`
 * / `embeddingProvider()` for the providers, `ctx.server.knowledge.track` for
 * knowledge updates that shutdown must wait for, and `onClose` / `onStopLoop`
 * for resources the drain must release.
 */
import { registerConversationMethods } from "./methods/conversation";
import { registerFirstRunMethods } from "./methods/firstRun";
import { registerLifecycleMethods } from "./methods/lifecycle";
import { registerNotesMethods } from "./methods/notes";
import { registerProposalMethods } from "./methods/proposals";
import { registerRepoMethods } from "./methods/repo";
import { RpcServer, type RpcServerOptions } from "./server";

export { RpcServer, type MethodDef, type RequestContext, type RpcServerOptions, type RpcSession } from "./server";
export { RpcError, toWireError, type RpcErrorCode } from "./errors";

export function createRpcServer(opts: RpcServerOptions): RpcServer {
  const server = new RpcServer(opts);
  registerLifecycleMethods(server);
  registerFirstRunMethods(server);
  registerRepoMethods(server);
  registerConversationMethods(server);
  registerNotesMethods(server);
  registerProposalMethods(server);
  return server;
}
