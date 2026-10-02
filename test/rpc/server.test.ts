/**
 * The RPC server core in process (src/rpc/server.ts; protocol §2, §3, §6):
 * framing, dispatch order, events, cancel, the shutdown drain, initialize and
 * its private env, the provider accessors, error mapping and redaction. Test
 * methods are registered next to the real ones to hold work open.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";
import { NoModelError, ServiceError, UnknownSessionError } from "../../src/commands/errors";
import { SessionBusyError } from "../../src/conversation/turnLock";
import { ConfigError } from "../../src/markdown/repo";
import { ClaudeModelProvider, ModelProviderError } from "../../src/model/claude";
import { ProposalNotPendingError, UnknownProposalError } from "../../src/proposal/store";
import { createRpcServer, RpcError, toWireError, type RpcServer } from "../../src/rpc";
import { RPC_ERROR_CODES } from "../../src/rpc/errors";
import { REDACTED, Redactor } from "../../src/rpc/redact";
import type { UserConfig } from "../../src/config/userConfig";
import type { KnowledgeUpdate } from "../../src/pipeline/knowledge";
import { HashingEmbeddingProvider } from "../../src/retrieval/embeddings";
import { makeTempKnowledgeRepo, withBrainHome } from "../harness";

type Msg = Record<string, any>;

interface Deferred<T = unknown> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}
function deferred<T = unknown>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface Harness {
  server: RpcServer;
  out: Msg[];
  logs: string[];
  send(msg: unknown): void;
  terminal(id: string | null): Msg | undefined;
  waitTerminal(id: string, timeoutMs?: number): Promise<Msg>;
  /** test.hold requests by id: resolve to let the handler finish. */
  holds: Map<string, Deferred>;
  /** Side effects of test.hold handlers that ran to completion. */
  finished: string[];
}

function makeServer(opts: { baseEnv?: NodeJS.ProcessEnv; config?: UserConfig | null } = {}): Harness {
  const out: Msg[] = [];
  const logs: string[] = [];
  const server = createRpcServer({ send: (l) => out.push(JSON.parse(l)), log: (l) => logs.push(l), baseEnv: opts.baseEnv ?? {}, loadUserConfig: () => opts.config ?? null });
  const holds = new Map<string, Deferred>();
  const finished: string[] = [];
  // Emits `progress {step: 1}`, waits until released, emits `progress {step: 2}`, returns `{value}`.
  server.register("test.hold", {
    preInitialize: true,
    handler: async (ctx) => {
      ctx.emit("progress", { step: 1 });
      const d = deferred();
      holds.set(ctx.id, d);
      const value = await d.promise;
      ctx.emit("progress", { step: 2 });
      finished.push(ctx.id);
      return { value };
    },
  });
  server.register("test.throw", {
    preInitialize: true,
    handler: (ctx) => {
      const what = ctx.params["what"];
      if (what === "type") throw new TypeError("x is not a function");
      if (what === "rpc") throw new RpcError("UNKNOWN_NOTE", "no such note", { noteId: "n1" });
      if (what === "secret") throw new Error(`provider said: bad key ${String(ctx.params["key"])}`);
      if (what === "reserved") ctx.emit("result", {});
      return undefined;
    },
  });
  server.register("test.afterInit", { handler: () => ({ ok: true }) });
  const terminal = (id: string | null) => out.find((m) => m.id === id && (m.type === "result" || m.type === "error"));
  return {
    server,
    out,
    logs,
    holds,
    finished,
    send: (msg) => server.handleLine(typeof msg === "string" ? msg : JSON.stringify(msg)),
    terminal,
    waitTerminal: async (id, timeoutMs = 10_000) => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const t = terminal(id);
        if (t) return t;
        if (Date.now() > deadline) throw new Error(`no terminal message for ${id}; got ${JSON.stringify(out)}`);
        await sleep(2);
      }
    },
  };
}

async function waitFor(cond: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await sleep(2);
  }
}

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

/** A temp BRAIN_HOME (restored afterwards) and a knowledge repo. */
function repoFixture(): { repo: string; home: string } {
  const prev = process.env.BRAIN_HOME;
  const bh = withBrainHome();
  const repo = makeTempKnowledgeRepo();
  cleanups.push(() => {
    repo.cleanup();
    bh.cleanup();
    if (prev === undefined) delete process.env.BRAIN_HOME;
    else process.env.BRAIN_HOME = prev;
  });
  return { repo: repo.path, home: bh.home };
}

const initParams = (repoPath: string, extra: Msg = {}) => ({ protocolVersion: 1, client: { name: "test", version: "0" }, repoPath, ...extra });

/** Initialize `h` against `repo`; registers a shutdown in teardown so the coordinator is closed. */
async function initialize(h: Harness, repo: string, extra: Msg = {}): Promise<Msg> {
  h.send({ id: "init", method: "initialize", params: initParams(repo, extra) });
  const r = await h.waitTerminal("init");
  if (r.type === "result") cleanups.push(() => h.server.shutdown("test teardown"));
  return r;
}

describe("framing", () => {
  test("a line that is not JSON, or not an object with a string id, gets INVALID_PARAMS with id null; the line is never quoted", () => {
    const h = makeServer();
    h.send('{"id":"1","params":{"key":"sk-ant-never-seen-1234"}');
    h.send("[1,2]");
    h.send('{"method":"shutdown"}');
    h.send('{"id":7,"method":"shutdown"}');
    expect(h.out).toHaveLength(4);
    for (const m of h.out) {
      expect(m.id).toBeNull();
      expect(m.type).toBe("error");
      expect(m.error.code).toBe("INVALID_PARAMS");
      expect(JSON.stringify(m)).not.toContain("sk-ant");
    }
  });

  test("blank lines are ignored; a bad method or params is INVALID_PARAMS for that id; null params is {}", async () => {
    const h = makeServer();
    h.send("");
    h.send("   ");
    h.send({ id: "1", params: {} });
    h.send({ id: "2", method: "repo.init", params: ["x"] });
    h.send({ id: "3", method: "cancel", params: null });
    expect(h.terminal("1")!.error.code).toBe("INVALID_PARAMS");
    expect(h.terminal("2")!.error).toEqual({ code: "INVALID_PARAMS", message: "params must be an object" });
    // cancel with params null: params read as {}, so `target` is missing
    expect((await h.waitTerminal("3")).error.code).toBe("INVALID_PARAMS");
    expect(h.out).toHaveLength(3);
  });

  test("a request reusing the id of one in flight gets INVALID_PARAMS with id null; the original stream is intact", async () => {
    const h = makeServer();
    h.send({ id: "a", method: "test.hold" });
    h.send({ id: "a", method: "test.hold" });
    const dup = h.out.find((m) => m.id === null)!;
    expect(dup.error.code).toBe("INVALID_PARAMS");
    expect(dup.error.data).toEqual({ id: "a" });
    h.holds.get("a")!.resolve(1);
    expect(await h.waitTerminal("a")).toEqual({ id: "a", type: "result", data: { value: 1 } });
    expect(h.out.filter((m) => m.id === "a").map((m) => m.type)).toEqual(["progress", "progress", "result"]);
    // once it finished, the id is free again
    h.send({ id: "a", method: "cancel", params: { target: "zzz" } });
    expect(await h.waitTerminal("a")).toBeDefined();
  });
});

describe("dispatch", () => {
  test("before initialize, every method not marked preInitialize gets NOT_INITIALIZED, unknown ones included", () => {
    const h = makeServer();
    h.send({ id: "1", method: "test.afterInit" });
    h.send({ id: "2", method: "no.such.method" });
    h.send({ id: "3", method: "repo.status" });
    expect([h.terminal("1"), h.terminal("2"), h.terminal("3")].map((m) => m!.error.code)).toEqual(["NOT_INITIALIZED", "NOT_INITIALIZED", "NOT_INITIALIZED"]);
  });

  test("after initialize, an unknown method gets UNKNOWN_METHOD and a registered one runs", async () => {
    const { repo } = repoFixture();
    const h = makeServer();
    expect((await initialize(h, repo)).type).toBe("result");
    h.send({ id: "1", method: "no.such.method" });
    h.send({ id: "2", method: "test.afterInit" });
    expect(h.terminal("1")!.error.code).toBe("UNKNOWN_METHOD");
    expect(await h.waitTerminal("2")).toEqual({ id: "2", type: "result", data: { ok: true } });
  });

  test("events precede their request's result; requests run concurrently and finish in any order", async () => {
    const h = makeServer();
    h.send({ id: "a", method: "test.hold" });
    h.send({ id: "b", method: "test.hold" });
    h.holds.get("b")!.resolve("B");
    await h.waitTerminal("b");
    h.holds.get("a")!.resolve("A");
    await h.waitTerminal("a");
    const order = h.out.map((m) => `${m.id}:${m.type}${m.data?.step ?? ""}`);
    expect(order).toEqual(["a:progress1", "b:progress1", "b:progress2", "b:result", "a:progress2", "a:result"]);
  });

  test("errors: programmer errors are INTERNAL (logged with stack), RpcError keeps code and data, undefined result is {}, reserved event types are refused", async () => {
    const h = makeServer();
    h.send({ id: "1", method: "test.throw", params: { what: "type" } });
    h.send({ id: "2", method: "test.throw", params: { what: "rpc" } });
    h.send({ id: "3", method: "test.throw", params: {} });
    h.send({ id: "4", method: "test.throw", params: { what: "reserved" } });
    expect((await h.waitTerminal("1")).error).toEqual({ code: "INTERNAL", message: "TypeError: x is not a function" });
    expect(h.logs.some((l) => l.includes("test.throw (id 1) failed") && l.includes("TypeError"))).toBe(true);
    expect((await h.waitTerminal("2")).error).toEqual({ code: "UNKNOWN_NOTE", message: "no such note", data: { noteId: "n1" } });
    expect(await h.waitTerminal("3")).toEqual({ id: "3", type: "result", data: {} });
    expect((await h.waitTerminal("4")).error.code).toBe("INTERNAL");
  });
});

describe("cancel", () => {
  test("the target ends with CANCELLED at once and gets no more messages; its work still runs to completion", async () => {
    const h = makeServer();
    h.send({ id: "a", method: "test.hold" });
    h.send({ id: "c", method: "cancel", params: { target: "a" } });
    expect(h.terminal("a")!.error.code).toBe("CANCELLED");
    expect(await h.waitTerminal("c")).toEqual({ id: "c", type: "result", data: { cancelled: true } });
    const before = h.out.length;
    h.holds.get("a")!.resolve("late");
    await waitFor(() => h.finished.includes("a"));
    await sleep(5);
    expect(h.out.length).toBe(before); // neither the step-2 event nor the result is sent
    expect(h.out.filter((m) => m.id === "a").map((m) => m.type)).toEqual(["progress", "error"]);
  });

  test("cancel of an unknown, finished or already cancelled request, or of itself, is {cancelled: false}", async () => {
    const h = makeServer();
    h.send({ id: "a", method: "test.hold" });
    h.send({ id: "c1", method: "cancel", params: { target: "a" } });
    h.send({ id: "c2", method: "cancel", params: { target: "a" } });
    h.send({ id: "c3", method: "cancel", params: { target: "nope" } });
    h.send({ id: "c4", method: "cancel", params: { target: "c4" } });
    for (const [id, want] of [
      ["c1", true],
      ["c2", false],
      ["c3", false],
      ["c4", false],
    ] as const)
      expect((await h.waitTerminal(id)).data).toEqual({ cancelled: want });
    h.holds.get("a")!.resolve(0);
  });

  test("a failure of cancelled work is logged, not sent", async () => {
    const h = makeServer();
    h.send({ id: "a", method: "test.hold" });
    h.send({ id: "c", method: "cancel", params: { target: "a" } });
    h.holds.get("a")!.reject(new Error("model went away"));
    await waitFor(() => h.logs.some((l) => l.includes("failed after it was cancelled: model went away")));
    expect(h.out.filter((m) => m.id === "a")).toHaveLength(2);
  });
});

describe("shutdown", () => {
  test("drains in protocol order: stop loop → request work (cancelled too) → knowledge → close (LIFO) → result → closed", async () => {
    const h = makeServer();
    const order: string[] = [];
    h.server.onStopLoop(async () => {
      await sleep(10);
      order.push("loop");
    });
    h.server.onClose(() => void order.push("close-first-registered"));
    h.server.onClose(async () => {
      await sleep(5);
      order.push("close-last-registered");
    });
    const knowledge = deferred<KnowledgeUpdate>();
    void knowledge.promise.then(() => order.push("knowledge"));
    h.server.knowledge.track({ knowledge: knowledge.promise });
    h.send({ id: "a", method: "test.hold" });
    h.send({ id: "b", method: "test.hold" });
    h.send({ id: "c", method: "cancel", params: { target: "b" } });
    h.send({ id: "s", method: "shutdown" });
    let closed = false;
    void h.server.closed.then(() => {
      closed = true;
      // the shutdown result is sent before the server reports itself closed
      order.push(h.terminal("s") === undefined ? "closed before result" : "closed after result");
    });

    // step 1: no new requests, including shutdown and cancel
    h.send({ id: "x1", method: "repo.init", params: { path: "/nowhere" } });
    h.send({ id: "x2", method: "shutdown" });
    h.send({ id: "x3", method: "cancel", params: { target: "a" } });
    for (const id of ["x1", "x2", "x3"]) expect(h.terminal(id)!.error.code).toBe("SHUTTING_DOWN");

    await sleep(30);
    expect(order).toEqual(["loop"]);
    h.holds.get("a")!.resolve("A");
    await h.waitTerminal("a"); // results and events keep flowing while draining
    h.server.notify("test.note", { during: "drain" });
    await sleep(10);
    expect(h.terminal("s")).toBeUndefined(); // b (cancelled) is still running
    h.holds.get("b")!.resolve("B");
    await waitFor(() => h.finished.includes("b"));
    await sleep(10);
    expect(h.terminal("s")).toBeUndefined(); // knowledge still in flight
    order.push("work done");
    knowledge.resolve({} as KnowledgeUpdate);
    expect(await h.waitTerminal("s")).toEqual({ id: "s", type: "result", data: {} });
    await h.server.closed;
    expect(closed).toBe(true);
    expect(order).toEqual(["loop", "work done", "knowledge", "close-last-registered", "close-first-registered", "closed after result"]);
    expect(h.out.some((m) => m.type === "test.note")).toBe(true);
    // closed: nothing more is sent
    const n = h.out.length;
    h.send({ id: "late", method: "repo.init", params: { path: "/nowhere" } });
    h.server.notify("test.note", {});
    expect(h.out.length).toBe(n);
  });

  test("EOF / SIGTERM drain: no result is sent, and the server is closed when the drain ends", async () => {
    const h = makeServer();
    h.send({ id: "a", method: "test.hold" });
    const drained = h.server.shutdown("stdin closed");
    expect(h.server.shutdown("SIGTERM")).toBe(drained); // idempotent
    h.send({ id: "x", method: "shutdown" });
    expect(h.terminal("x")!.error.code).toBe("SHUTTING_DOWN");
    h.holds.get("a")!.resolve(1);
    await h.server.closed;
    expect(h.terminal("a")!.type).toBe("result");
    expect(h.out.filter((m) => m.type === "result").map((m) => m.id)).toEqual(["a"]);
  });
});

describe("initialize", () => {
  test("builds a private env (explicit env wins, config.toml fills unset keys) and never writes process.env", async () => {
    const { repo } = repoFixture();
    const before = JSON.stringify(process.env);
    const h = makeServer({
      baseEnv: { PATH: "/usr/bin", BRAIN_MODEL: "base-model", BRAIN_EFFORT: "low" },
      config: { model: { model: "config-model", effort: "max" }, keys: { anthropic: "sk-ant-config-0000", openrouter: "sk-or-config-1111" } },
    });
    const r = await initialize(h, repo, { env: { ANTHROPIC_API_KEY: "sk-ant-param-2222", BRAIN_EFFORT: "medium" } });
    expect(r.type).toBe("result");
    expect(JSON.stringify(process.env)).toBe(before);
    const env = h.server.session.env;
    expect(env["ANTHROPIC_API_KEY"]).toBe("sk-ant-param-2222"); // params.env over config.toml
    expect(env["OPENROUTER_API_KEY"]).toBe("sk-or-config-1111"); // config.toml fills an unset key
    expect(env["BRAIN_MODEL"]).toBe("base-model"); // the base env (process.env) wins over config.toml
    expect(env["BRAIN_EFFORT"]).toBe("medium"); // params.env wins over the base env
    expect(env["PATH"]).toBe("/usr/bin");
    expect(h.server.session.providerEnv).toEqual({ ANTHROPIC_API_KEY: "sk-ant-param-2222", BRAIN_EFFORT: "medium" });
    // no key value reaches a log line
    expect(h.logs.join("\n")).not.toMatch(/sk-(ant|or)-(param|config)/);
  });

  test("result: repo id, user worktree, state dir, and the staging engine value (loopOwner other, no owner)", async () => {
    const { repo, home } = repoFixture();
    const h = makeServer();
    const r = await initialize(h, repo, { engine: { intervalMs: 250 } });
    const s = h.server.session;
    expect(r.data).toEqual({ protocolVersion: 1, brainVersion: expect.any(String), repoId: s.repoId, userWorktree: repo, stateDir: `${home}/repos/${s.repoId}`, engine: { loopOwner: "other", intervalMs: 250 } });
    expect(r.data.engine.owner).toBeUndefined();
  });

  test("a second initialize, also while the first is still opening, gets ALREADY_INITIALIZED", async () => {
    const { repo } = repoFixture();
    const h = makeServer();
    h.send({ id: "i1", method: "initialize", params: initParams(repo) });
    h.send({ id: "i2", method: "initialize", params: initParams(repo) });
    // i2 was dispatched while i1's open sequence was still running
    expect((await h.waitTerminal("i2")).error).toEqual({ code: "ALREADY_INITIALIZED", message: "initialize is already in progress" });
    expect((await h.waitTerminal("i1")).type).toBe("result");
    cleanups.push(() => h.server.shutdown("test teardown"));
    h.send({ id: "i3", method: "initialize", params: initParams(repo) });
    expect((await h.waitTerminal("i3")).error.code).toBe("ALREADY_INITIALIZED");
  });

  test("PROTOCOL_MISMATCH, NOT_A_REPO and INVALID_PARAMS leave the server uninitialized, so a retry succeeds", async () => {
    const { repo } = repoFixture();
    const h = makeServer();
    h.send({ id: "1", method: "initialize", params: { ...initParams(repo), protocolVersion: 2 } });
    h.send({ id: "2", method: "initialize", params: initParams(`${repo}/knowledge`) });
    h.send({ id: "3", method: "initialize", params: initParams(repo, { env: { GIT_DIR: "/x" } }) });
    h.send({ id: "4", method: "initialize", params: initParams(repo, { engine: { intervalMs: 0 } }) });
    h.send({ id: "5", method: "initialize", params: initParams(repo, { env: { ANTHROPIC_API_KEY: 42 } }) });
    expect((await h.waitTerminal("1")).error).toEqual({ code: "PROTOCOL_MISMATCH", message: "this server speaks protocol version 1, not 2", data: { protocolVersion: 1 } });
    expect((await h.waitTerminal("2")).error.code).toBe("NOT_A_REPO");
    expect((await h.waitTerminal("3")).error).toEqual({ code: "INVALID_PARAMS", message: expect.stringContaining("got GIT_DIR") });
    expect((await h.waitTerminal("4")).error.code).toBe("INVALID_PARAMS");
    expect((await h.waitTerminal("5")).error).toEqual({ code: "INVALID_PARAMS", message: "env.ANTHROPIC_API_KEY must be a string" });
    expect(h.server.phase).toBe("uninitialized");
    expect((await initialize(h, repo)).type).toBe("result");
    expect(h.server.phase).toBe("ready");
  });

  test("shutdown closes the coordinator opened by initialize, after later close hooks", async () => {
    const { repo } = repoFixture();
    const h = makeServer();
    await initialize(h, repo);
    const coord = h.server.session.coord;
    const order: string[] = [];
    const close = coord.close.bind(coord);
    coord.close = async () => {
      order.push("coordinator");
      await close();
    };
    h.server.onClose(() => void order.push("session deps"));
    h.send({ id: "s", method: "shutdown" });
    await h.server.closed;
    expect(order).toEqual(["session deps", "coordinator"]);
  });
});

describe("providers (CR-11 isolated mode)", () => {
  /** Runs `fn` with `vars` on process.env, then restores them. */
  async function withProcessEnv(vars: Record<string, string | undefined>, fn: () => Promise<void> | void): Promise<void> {
    const saved = new Map(Object.keys(vars).map((k) => [k, process.env[k]] as const));
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try {
      await fn();
    } finally {
      for (const [k, v] of saved) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }

  test("the chat model is built lazily from the private env, and never takes credentials from process.env", async () => {
    const { repo } = repoFixture();
    await withProcessEnv({ ANTHROPIC_API_KEY: "env-key", ANTHROPIC_AUTH_TOKEN: "env-token", ANTHROPIC_BASE_URL: "http://env.invalid", BRAIN_MODEL_SCRIPT: undefined, BRAIN_MODEL_MOCK: undefined }, async () => {
      const h = makeServer({ baseEnv: {} });
      await initialize(h, repo, { env: { ANTHROPIC_API_KEY: "private-key", BRAIN_MODEL_PROVIDER: "anthropic" } });
      const model = h.server.modelProvider();
      expect(model).toBeInstanceOf(ClaudeModelProvider);
      expect(h.server.modelProvider()).toBe(model); // built once
      const client = (model as unknown as { client: Anthropic }).client;
      expect(client.apiKey).toBe("private-key");
      expect(client.authToken).toBeNull();
      expect(client.baseURL).toBe("https://api.anthropic.com");
      expect(h.server.embeddingProvider()).toBeInstanceOf(HashingEmbeddingProvider);
    });
  });

  test("no credentials in the private env is NO_MODEL, whatever process.env holds; the failure is not cached", async () => {
    const { repo } = repoFixture();
    await withProcessEnv({ ANTHROPIC_API_KEY: "env-key", BRAIN_MODEL_SCRIPT: undefined, BRAIN_MODEL_MOCK: undefined }, async () => {
      const h = makeServer({ baseEnv: {} });
      await initialize(h, repo);
      expect(() => h.server.modelProvider()).toThrow(NoModelError);
      expect(toWireError(new NoModelError("no model configured")).code).toBe("NO_MODEL");
      expect(() => h.server.modelProvider()).toThrow(NoModelError);
    });
  });

  test("before initialize there is no session, so no provider", () => {
    const h = makeServer();
    expect(() => h.server.modelProvider()).toThrow(RpcError);
    expect(() => h.server.session).toThrow("not initialized");
  });
});

describe("errors (protocol §6)", () => {
  test("service and core errors map to their codes and data; anything else is INTERNAL", () => {
    const cases: [unknown, object][] = [
      [new NoModelError("m"), { code: "NO_MODEL", message: "m" }],
      [new ServiceError("INTERNAL", "m"), { code: "INTERNAL", message: "m" }],
      [new UnknownSessionError("s1", "m"), { code: "UNKNOWN_SESSION", message: "m", data: { sessionId: "s1" } }],
      [new UnknownProposalError("p1"), { code: "UNKNOWN_PROPOSAL", message: "unknown proposal p1", data: { proposalId: "p1" } }],
      [new ProposalNotPendingError("p1", "ACCEPTED"), { code: "PROPOSAL_NOT_PENDING", message: expect.any(String), data: { proposalId: "p1", status: "ACCEPTED" } }],
      [new SessionBusyError("s1"), { code: "SESSION_BUSY", message: expect.any(String), data: { sessionId: "s1" } }],
      [new ConfigError("repo_id is required"), { code: "NOT_A_REPO", message: "repo_id is required" }],
      [new ModelProviderError("rate limited", { retryable: true }), { code: "MODEL_ERROR", message: "rate limited" }],
      [new RangeError("bad"), { code: "INTERNAL", message: "RangeError: bad" }],
      [new Error("plain"), { code: "INTERNAL", message: "plain" }],
      ["a string", { code: "INTERNAL", message: "a string" }],
    ];
    for (const [e, want] of cases) {
      const wire = toWireError(e);
      expect(wire).toEqual(want as never);
      expect(RPC_ERROR_CODES).toContain(wire.code);
    }
  });

  test("messages are redacted: a secret in a thrown error never reaches the client", async () => {
    const h = makeServer({ baseEnv: { OPENROUTER_API_KEY: "sk-or-base-secret-9999" } });
    h.send({ id: "1", method: "test.throw", params: { what: "secret", key: "sk-or-base-secret-9999" } });
    const e = (await h.waitTerminal("1")).error;
    expect(e.message).toBe(`provider said: bad key ${REDACTED}`);
    expect(h.logs.join("\n")).not.toContain("sk-or-base-secret-9999");
  });
});

describe("Redactor", () => {
  test("replaces every known secret, longest first; ignores values too short to be secrets", () => {
    const r = new Redactor();
    r.addFromEnv({ ANTHROPIC_API_KEY: " sk-ant-abc ", OPENROUTER_API_KEY: "sk-ant-abc-longer", BRAIN_MODEL: "claude", ANTHROPIC_AUTH_TOKEN: "ab" });
    expect(r.redact("a sk-ant-abc-longer b sk-ant-abc c claude ab")).toBe(`a ${REDACTED} b ${REDACTED} c claude ab`);
    r.add(undefined);
    expect(r.redact("nothing")).toBe("nothing");
  });
});
