/**
 * The RPC server core (docs/mac-app/protocol.md §2, §3): framing, dispatch,
 * the per-request lifecycle, `cancel`, and the `shutdown` drain.
 *
 * Transport-agnostic: it takes one input line at a time (`handleLine`) and
 * hands one output line at a time to `send`, so the stdio adapter
 * (src/rpc/stdio.ts) and in-process tests drive the same code.
 *
 * ## Requests
 *
 * Each request runs its method handler concurrently with every other request.
 * The server keeps two things per request, separately (protocol §3 shutdown
 * step 3):
 * - its **message stream**: events (`ctx.emit`) and then exactly one terminal
 *   `result` or `error`. `cancel` ends the stream early with `CANCELLED`;
 *   later events and the handler's eventual outcome are dropped.
 * - its **underlying work**: the handler's promise. Cancel never aborts it,
 *   and `shutdown` waits for it.
 *
 * ## Framing errors
 *
 * - An empty line is ignored.
 * - A line that is not JSON, or a JSON value that is not an object with a
 *   string `id`, gets `error INVALID_PARAMS` with **`id: null`**: there is no
 *   request id to answer to. The message never quotes the line (it may hold a
 *   key the redactor has not seen yet).
 * - A request whose `id` equals that of a request still in flight gets
 *   `INVALID_PARAMS` with `id: null` and `data: {id}`, so the stream of the
 *   request already using that id is left intact.
 * - A missing or `null` `params` is `{}`; any other non-object is `INVALID_PARAMS`.
 *   Unknown fields of a request or its params are ignored.
 *
 * ## Dispatch order
 *
 * `SHUTTING_DOWN` (after `shutdown`, stdin EOF or SIGTERM) → `NOT_INITIALIZED`
 * (before `initialize` succeeds, for every method not marked
 * `preInitialize`, including unknown ones: protocol §3 says "anything else")
 * → `UNKNOWN_METHOD`.
 */
import pkg from "../../package.json" with { type: "json" };
import { createKnowledgeTracker, type KnowledgeTracker } from "../commands/conversation";
import { chatEmbeddingProvider, chatModelProvider } from "../commands/providers";
import type { Coord } from "../commands/repo";
import { applyUserConfigToEnv, loadUserConfig, type UserConfig } from "../config/userConfig";
import type { EmbeddingProvider, ModelProvider } from "../core/types";
import type { EngineInfo, ProviderEnv, WireError } from "./dto";
import { RpcError, toWireError, type RpcErrorCode } from "./errors";
import { isPlainObject, type Params } from "./params";
import { Redactor } from "./redact";

export const BRAIN_VERSION: string = pkg.version;

/** Lifecycle of the repo session (protocol §3). A failed `initialize` returns to "uninitialized", so the client can retry. */
export type Phase = "uninitialized" | "initializing" | "ready";

/** What `initialize` opened. Fixed for the life of the server. */
export interface RpcSession {
  repoId: string;
  userWorktree: string;
  stateDir: string;
  /** The coordinator from the service layer's open sequence (`openRepo`). Closed in shutdown step 5. */
  coord: Coord;
  /** The private env: `applyUserConfigToEnv(loadUserConfig(), {...process.env, ...initialize.env})`. Never written to process.env. */
  env: NodeJS.ProcessEnv;
  /** `initialize.env` as the client sent it (allowlisted keys only). */
  providerEnv: ProviderEnv;
  engine: EngineInfo;
}

/** What a method handler gets for one request. */
export interface RequestContext {
  readonly id: string;
  readonly method: string;
  readonly params: Params;
  readonly server: RpcServer;
  /** True once the client cancelled this request: its `CANCELLED` error is sent, and events and the outcome are dropped. The work goes on. */
  readonly cancelled: boolean;
  /** Send `{id, type, data}`. Dropped once the request has its terminal message. `result` and `error` are reserved. */
  emit(type: string, data: unknown): void;
}

export interface MethodDef {
  /** Accepted before `initialize` has succeeded (protocol §3: `initialize`, `repo.init`, `doctor.run`, `shutdown`, `cancel`). */
  preInitialize?: boolean;
  /** Resolves to the `result` data, or throws (mapped by `toWireError`). Its promise is the request's underlying work. */
  handler(ctx: RequestContext): unknown;
}

export interface RpcServerOptions {
  /** Write one protocol line (a JSON object, no trailing newline). */
  send(line: string): void;
  /** Write one human-readable log line (stderr). Lines are redacted before this is called. */
  log?(line: string): void;
  /** Base of every private env. Default `process.env`, which is copied and never written. */
  baseEnv?: NodeJS.ProcessEnv;
  /** Reads `$BRAIN_HOME/config.toml`. Default `loadUserConfig` (warnings go to the log). */
  loadUserConfig?: () => UserConfig | null;
  /** Shared with the transport so relayed stderr is redacted too. Default: a new one. */
  redactor?: Redactor;
}

interface RequestRecord {
  readonly id: string;
  readonly method: string;
  /** The terminal message was sent (normally, or as `CANCELLED`). */
  terminal: boolean;
  cancelled: boolean;
  /** This is the `shutdown` request: once its result is sent, the server is closed. */
  closesServer: boolean;
}

type Hook = () => Promise<void> | void;

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export class RpcServer {
  readonly redactor: Redactor;
  /**
   * Knowledge updates still in flight (shutdown step 4, pre-CR-5 form:
   * implementation-plan §2). Whoever starts one (`conversation.send`, T1.5)
   * passes its `TurnResult` to `knowledge.track`; the drain awaits them all.
   */
  readonly knowledge: KnowledgeTracker = createKnowledgeTracker();
  /** Resolves once the server is done: after a `shutdown` request, when its result has been sent; after EOF or SIGTERM, when the drain finished. */
  readonly closed: Promise<void>;

  private readonly opts: RpcServerOptions;
  private readonly baseEnv: NodeJS.ProcessEnv;
  private readonly readUserConfig: () => UserConfig | null;
  private readonly methods = new Map<string, MethodDef>();
  /** Requests without a terminal message yet, by id. */
  private readonly open = new Map<string, RequestRecord>();
  /** Underlying work of every request whose handler has not settled, cancelled or not. */
  private readonly work = new Map<RequestRecord, Promise<void>>();
  private readonly stopLoopHooks: Hook[] = [];
  private readonly closeHooks: Hook[] = [];
  private accepting = true;
  private draining: Promise<void> | null = null;
  private ended = false;
  private resolveClosed!: () => void;
  private phaseValue: Phase = "uninitialized";
  private sessionValue: RpcSession | null = null;
  private model: ModelProvider | null = null;
  private embeddings: EmbeddingProvider | null = null;

  constructor(opts: RpcServerOptions) {
    this.opts = opts;
    this.redactor = opts.redactor ?? new Redactor();
    this.baseEnv = opts.baseEnv ?? process.env;
    this.redactor.addFromEnv(this.baseEnv);
    this.readUserConfig = opts.loadUserConfig ?? (() => loadUserConfig({ warn: (m) => this.log(m) }));
    this.closed = new Promise((r) => {
      this.resolveClosed = r;
    });
  }

  // -------------------------------------------------------------------------
  // registration and output
  // -------------------------------------------------------------------------

  register(method: string, def: MethodDef): void {
    if (this.methods.has(method)) throw new Error(`rpc method ${method} is already registered`);
    this.methods.set(method, def);
  }

  /** One log line on stderr, redacted. */
  log(line: string): void {
    this.opts.log?.(this.redactor.redact(line));
  }

  /** Send a notification `{type, data}` (no id). Allowed while draining. */
  notify(type: string, data: unknown): void {
    this.sendObject({ type, data });
  }

  private sendObject(msg: object): void {
    if (this.ended) return;
    this.opts.send(JSON.stringify(msg));
  }

  private sendError(id: string | null, code: RpcErrorCode, message: string, data?: unknown): void {
    const error: WireError = { code, message: this.redactor.redact(message) };
    if (data !== undefined) error.data = data;
    this.sendObject({ id, type: "error", error });
  }

  // -------------------------------------------------------------------------
  // input
  // -------------------------------------------------------------------------

  /** Handle one input line. Never throws; a handler runs asynchronously. */
  handleLine(line: string): void {
    if (this.ended) return;
    const text = line.trim();
    if (text === "") return;
    let msg: unknown;
    try {
      msg = JSON.parse(text);
    } catch {
      this.sendError(null, "INVALID_PARAMS", `malformed JSON (a line of ${text.length} characters)`);
      return;
    }
    if (!isPlainObject(msg) || typeof msg["id"] !== "string") {
      this.sendError(null, "INVALID_PARAMS", "a request must be a JSON object with a string id");
      return;
    }
    const id = msg["id"];
    if (this.open.has(id)) {
      this.sendError(null, "INVALID_PARAMS", `request id ${JSON.stringify(id)} is already in flight`, { id });
      return;
    }
    const method = msg["method"];
    if (typeof method !== "string" || method === "") {
      this.sendError(id, "INVALID_PARAMS", "method must be a non-empty string");
      return;
    }
    const raw = msg["params"];
    if (raw !== undefined && raw !== null && !isPlainObject(raw)) {
      this.sendError(id, "INVALID_PARAMS", "params must be an object");
      return;
    }
    const params: Params = isPlainObject(raw) ? raw : {};
    if (!this.accepting) {
      this.sendError(id, "SHUTTING_DOWN", "the server is shutting down");
      return;
    }
    const def = this.methods.get(method);
    if (this.phaseValue !== "ready" && def?.preInitialize !== true) {
      this.sendError(id, "NOT_INITIALIZED", `${method} needs a successful initialize first`);
      return;
    }
    if (def === undefined) {
      this.sendError(id, "UNKNOWN_METHOD", `unknown method ${method}`);
      return;
    }
    this.start(id, method, params, def);
  }

  private start(id: string, method: string, params: Params, def: MethodDef): void {
    const req: RequestRecord = { id, method, terminal: false, cancelled: false, closesServer: false };
    this.open.set(id, req);
    const ctx: RequestContext = {
      id,
      method,
      params,
      server: this,
      get cancelled() {
        return req.cancelled;
      },
      emit: (type, data) => this.emitEvent(req, type, data),
    };
    let outcome: Promise<unknown>;
    try {
      outcome = Promise.resolve(def.handler(ctx));
    } catch (e) {
      outcome = Promise.reject(e);
    }
    const tracked = outcome.then(
      (value) => this.finish(req, true, value),
      (error) => this.finish(req, false, error),
    );
    this.work.set(req, tracked);
    void tracked.finally(() => this.work.delete(req));
  }

  private emitEvent(req: RequestRecord, type: string, data: unknown): void {
    if (type === "result" || type === "error") throw new Error(`event type ${type} is reserved for terminal messages`);
    if (req.terminal) return;
    this.sendObject({ id: req.id, type, data });
  }

  /** Send the terminal message for `req`, unless it already has one (cancelled). Never throws. */
  private finish(req: RequestRecord, ok: boolean, value: unknown): void {
    try {
      if (req.terminal) {
        if (!ok) this.log(`rpc: ${req.method} (id ${req.id}) failed after it was cancelled: ${errorText(value)}`);
        return;
      }
      req.terminal = true;
      this.open.delete(req.id);
      if (ok) {
        let line: string;
        try {
          line = JSON.stringify({ id: req.id, type: "result", data: value === undefined ? {} : value });
        } catch (e) {
          this.sendError(req.id, "INTERNAL", `${req.method}: result is not serializable: ${errorText(e)}`);
          return;
        }
        if (!this.ended) this.opts.send(line);
      } else {
        const error = toWireError(value, (t) => this.redactor.redact(t));
        if (error.code === "INTERNAL") this.log(`rpc: ${req.method} (id ${req.id}) failed: ${value instanceof Error ? (value.stack ?? value.message) : String(value)}`);
        this.sendObject({ id: req.id, type: "error", error });
      }
    } finally {
      if (req.closesServer) this.close();
    }
  }

  private close(): void {
    if (this.ended) return;
    this.ended = true;
    this.resolveClosed();
  }

  // -------------------------------------------------------------------------
  // cancel and shutdown
  // -------------------------------------------------------------------------

  /**
   * End request `target` with `error CANCELLED` (protocol §3). Its work is not
   * aborted, and `shutdown` still waits for it. False when `target` has no
   * request in flight (unknown, already finished or cancelled) or is the
   * cancelling request itself (`by`).
   */
  cancel(target: string, by?: string): boolean {
    const req = this.open.get(target);
    if (req === undefined || target === by) return false;
    req.terminal = true;
    req.cancelled = true;
    this.open.delete(target);
    this.sendError(target, "CANCELLED", `request ${target} (${req.method}) was cancelled; its work continues`);
    return true;
  }

  /**
   * Start the drain (protocol §3 `shutdown`; idempotent: later calls return
   * the same promise). `requestId` names the `shutdown` request that started
   * it: the drain does not wait for that request's own work, and the server
   * closes once its result is sent. Without one (stdin EOF, SIGTERM) the
   * server closes when the drain finishes.
   *
   * 1. Stop accepting requests: later ones get `SHUTTING_DOWN`.
   * 2. Stop scheduling loop ticks and polls and wait for the tick in flight
   *    (`onStopLoop` hooks; none before T1.7).
   * 3. Wait for the underlying work of every request, including cancelled ones.
   * 4. Wait for knowledge updates in flight (`knowledge`; pre-CR-5 form).
   * 5. Close resources (`onClose` hooks, last registered first: the
   *    coordinator opened by `initialize` closes last).
   * Events and notifications keep flowing throughout.
   */
  shutdown(reason: string, requestId?: string): Promise<void> {
    if (this.draining !== null) return this.draining;
    this.accepting = false;
    const self = requestId !== undefined ? this.open.get(requestId) : undefined;
    if (self !== undefined) self.closesServer = true;
    this.draining = this.drain(reason, self).then(() => {
      if (self === undefined) this.close();
    });
    return this.draining;
  }

  get shuttingDown(): boolean {
    return !this.accepting;
  }

  private async drain(reason: string, self: RequestRecord | undefined): Promise<void> {
    this.log(`rpc: shutdown (${reason}): draining`);
    await this.runHooks("stop loop", this.stopLoopHooks);
    for (;;) {
      const pending = [...this.work].filter(([req]) => req !== self).map(([, p]) => p);
      if (pending.length === 0) break;
      await Promise.all(pending);
    }
    try {
      await this.knowledge.drain();
    } catch (e) {
      this.log(`rpc: shutdown: knowledge drain failed: ${errorText(e)}`);
    }
    await this.runHooks("close", [...this.closeHooks].reverse());
    this.log("rpc: shutdown: drained");
  }

  private async runHooks(stage: string, hooks: Hook[]): Promise<void> {
    for (const hook of hooks) {
      try {
        await hook();
      } catch (e) {
        this.log(`rpc: shutdown: ${stage} hook failed: ${errorText(e)}`);
      }
    }
  }

  /** Shutdown step 2: stop the loop and its polls, resolving once the tick in flight has finished (T1.7). */
  onStopLoop(hook: Hook): void {
    this.stopLoopHooks.push(hook);
  }

  /** Shutdown step 5: close a resource. Hooks run last registered first. */
  onClose(hook: Hook): void {
    this.closeHooks.push(hook);
  }

  // -------------------------------------------------------------------------
  // session (initialize)
  // -------------------------------------------------------------------------

  get phase(): Phase {
    return this.phaseValue;
  }

  /** The initialized session. Throws `NOT_INITIALIZED` before `initialize` has succeeded. */
  get session(): RpcSession {
    if (this.sessionValue === null) throw new RpcError("NOT_INITIALIZED", "the server is not initialized");
    return this.sessionValue;
  }

  /** `initialize` claims the session; a second claim gets `ALREADY_INITIALIZED`, also while the first is still opening. */
  beginInitialize(): void {
    if (this.phaseValue === "ready") throw new RpcError("ALREADY_INITIALIZED", "the server is already initialized; restart it to change the repo or env");
    if (this.phaseValue === "initializing") throw new RpcError("ALREADY_INITIALIZED", "initialize is already in progress");
    this.phaseValue = "initializing";
  }

  /** The open sequence succeeded. Its coordinator is closed in shutdown step 5, after every later `onClose` hook. */
  completeInitialize(session: RpcSession): void {
    this.sessionValue = session;
    this.phaseValue = "ready";
    this.onClose(() => session.coord.close());
  }

  /** The open sequence failed: back to "uninitialized", so `initialize` can be retried. */
  abandonInitialize(): void {
    if (this.phaseValue === "initializing") this.phaseValue = "uninitialized";
  }

  /**
   * A private env (protocol §3, design §10):
   * `applyUserConfigToEnv(loadUserConfig(), {...base, ...overlay})`. Explicit
   * values win; `config.toml` fills only unset keys. A fresh copy every time:
   * nothing is ever written to `process.env`. Its credentials join the redactor.
   */
  buildPrivateEnv(overlay: ProviderEnv, base: NodeJS.ProcessEnv = this.baseEnv): NodeJS.ProcessEnv {
    const env = applyUserConfigToEnv(this.readUserConfig(), { ...base, ...overlay });
    this.redactor.addFromEnv(env);
    return env;
  }

  /**
   * The chat model for this session, built on first use from the private env
   * in isolated mode (CR-11): credentials come from that env only. Throws
   * `NoModelError` (`NO_MODEL`) when none can be built; a failure is not
   * cached, so a later call tries again.
   */
  modelProvider(): ModelProvider {
    const s = this.session;
    this.model ??= chatModelProvider({ env: s.env, isolatedEnv: true, log: (l) => this.log(l) });
    return this.model;
  }

  /** Embeddings for this session's conversations (offline hashing under a mock or script model), built on first use from the private env. */
  embeddingProvider(): EmbeddingProvider {
    const s = this.session;
    this.embeddings ??= chatEmbeddingProvider(s.env);
    return this.embeddings;
  }
}
