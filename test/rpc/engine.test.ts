/**
 * The engine in process (T1.7): the `repo.changed` poller
 * (src/rpc/poller.ts), the loop shared with `brain watch`
 * (`createWatchLoop`, src/cli/watch.ts), and the server's engine
 * notifications and lock lifecycle (src/rpc/engine.ts). The transcripts
 * (handshake*.jsonl, loop-takeover.jsonl, repo-changed-*.jsonl) cover the
 * protocol end to end; these cover what they cannot reach deterministically.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWatchLoop, type WatchLoopCoord, type WatchTickResult } from "../../src/cli/watch";
import { loopOwnerCheck } from "../../src/config/doctor";
import { openConversationStore } from "../../src/conversation/store";
import type { ExecutionResult, IntegrationResult, Mutation, SyncResult } from "../../src/core/types";
import { openIndex } from "../../src/index/schema";
import { ProposalStore } from "../../src/proposal/store";
import { Queue } from "../../src/core/queue";
import { createRpcServer, type RpcServer } from "../../src/rpc";
import { RepoChangePoller } from "../../src/rpc/poller";
import { REDACTED } from "../../src/rpc/redact";
import { acquireLock, isLockHeld, LOOP_OWNER_LOCK, readLockHolder } from "../../src/sync/lock";
import { blobAt } from "../../src/git/git";
import { AGENT_BRANCH } from "../../src/core/types";
import { commitAsHuman, makeTempKnowledgeRepo, noteMd, setupEnv, withBrainHome, writeNote, type Env } from "../harness";

type Msg = Record<string, any>;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function waitFor(what: string, cond: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

/** `setupEnv` (a temp BRAIN_HOME, a knowledge repo, a coordinator), restoring BRAIN_HOME afterwards, with the index created. */
async function env(): Promise<Env> {
  const prev = process.env.BRAIN_HOME;
  const e = await setupEnv();
  cleanups.push(async () => {
    await e.cleanup();
    if (prev === undefined) delete process.env.BRAIN_HOME;
    else process.env.BRAIN_HOME = prev;
  });
  await e.coord.reconcileIndex();
  return e;
}

describe("RepoChangePoller", () => {
  test("the baseline reports nothing; each domain is reported when its component moves, including writes from this process", async () => {
    const e = await env();
    const paths = e.coord.paths;
    const poller = new RepoChangePoller(paths);
    cleanups.push(() => poller.close());
    poller.baseline();
    expect(poller.poll()).toBeNull();

    // queue: a commit on another connection in this process
    const queue = new Queue(paths.queueDb);
    cleanups.push(() => queue.close());
    queue.enqueue({ mutationId: "mut_01JA00000000000000000000Q1", type: "CREATE", summary: "s", targets: [{ kind: "absent", slug: "q" }], writes: [{ path: "knowledge/q.md", content: "x" }], dependsOn: [], evidence: ["e"] } as Mutation);
    const q = poller.poll();
    expect(q?.domains).toEqual(["queue"]);
    expect(poller.poll()).toBeNull(); // reported once

    // proposals: pendingProposals is counted on the poll connection
    const store = new ProposalStore(paths.proposalsDb);
    cleanups.push(() => store.close());
    store.create({ proposalId: "prop_01JA00000000000000000000P1", mutationId: "mut_01JA00000000000000000000P1", operation: "ARCHIVE", targets: [], writes: [], evidence: ["e"], reasoning: "r", createdAt: "2026-10-02T00:00:00.000Z", status: "PENDING" });
    const p = poller.poll();
    expect(p?.domains).toEqual(["proposals"]);
    expect(p?.pendingProposals).toBe(1);

    // index: a write at an unchanged indexed commit (as an external `brain index` embedding) still counts
    const db = openIndex(paths.indexDb);
    db.run("UPDATE index_meta SET repo_id = 'another'");
    db.close();
    const i = poller.poll();
    expect(i?.domains).toEqual(["index"]);
    expect(i?.indexedCommit).toBe(await e.coord.agentHead()); // read on the index poll connection

    // conversations: a new session, then an appended turn
    const conv = openConversationStore(paths.conversationsDir);
    const sessionId = conv.createSession();
    expect(poller.poll()?.domains).toEqual(["conversations"]);
    conv.appendTurn(sessionId, "user", "hello");
    expect(poller.poll()?.domains).toEqual(["conversations"]);

    // git: a human commit on main moves mainHead only
    writeNote(e.repo.path, "knowledge/g.md", { title: "G", sections: { Claim: "A git change." } });
    const sha = commitAsHuman(e.repo.path, "user: g");
    const g = poller.poll();
    expect(g?.domains).toEqual(["git"]);
    expect(g?.mainHead).toBe(sha);
    expect(g?.agentHead).not.toBe(sha);

    // several domains in one check
    queue.enqueue({ mutationId: "mut_01JA00000000000000000000Q2", type: "CREATE", summary: "s", targets: [{ kind: "absent", slug: "q2" }], writes: [{ path: "knowledge/q2.md", content: "x" }], dependsOn: [], evidence: ["e"] } as Mutation);
    store.decide("prop_01JA00000000000000000000P1", "PENDING", "REJECTED");
    const both = poller.poll();
    expect(both?.domains).toEqual(["queue", "proposals"]);
    expect(both?.pendingProposals).toBe(0);

    poller.close();
    queue.enqueue({ mutationId: "mut_01JA00000000000000000000Q3", type: "CREATE", summary: "s", targets: [{ kind: "absent", slug: "q3" }], writes: [{ path: "knowledge/q3.md", content: "x" }], dependsOn: [], evidence: ["e"] } as Mutation);
    expect(poller.poll()).toBeNull(); // closed: reports nothing
  });

  test("a database that appears after the baseline is reported; the poll connection never writes", async () => {
    const e = await env();
    const paths = e.coord.paths;
    const dir = mkdtempSync(join(tmpdir(), "brain-poll-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const late = { ...paths, queueDb: join(dir, "queue.sqlite") };
    const poller = new RepoChangePoller(late);
    cleanups.push(() => poller.close());
    poller.baseline();
    expect(poller.poll()).toBeNull();
    const queue = new Queue(late.queueDb);
    cleanups.push(() => queue.close());
    expect(poller.poll()?.domains).toEqual(["queue"]);
    expect(poller.poll()).toBeNull();

    // read-only: a poll connection cannot write (it would hide its own commits from data_version)
    const ro = new Database(late.queueDb, { readonly: true });
    try {
      expect(() => ro.run("DELETE FROM mutations")).toThrow();
    } finally {
      ro.close();
    }
  });
});

/** A coordinator stub whose calls are recorded and can be held open. */
function stubCoord(dir: string) {
  const calls: string[] = [];
  let active = 0;
  let maxActive = 0;
  let hold: Promise<void> | null = null;
  let fail: Error | null = null;
  const syncResults: SyncResult[] = [];
  const integration: IntegrationResult = { status: "nothing-to-integrate", integratedMutationIds: [], mainSha: "a".repeat(40) };
  const coord: WatchLoopCoord = {
    paths: { userWorktree: dir } as WatchLoopCoord["paths"],
    config: { sync: { quiescenceMs: 0 } } as WatchLoopCoord["config"],
    async drainQueued(): Promise<ExecutionResult[]> {
      calls.push("drain");
      active++;
      maxActive = Math.max(maxActive, active);
      try {
        if (hold) await hold;
        if (fail) throw fail;
        return [];
      } finally {
        active--;
      }
    },
    async integrate() {
      return integration;
    },
    async reconcileIndex() {},
    async syncOnce() {
      calls.push("sync");
      return syncResults.shift() ?? { committed: false, reason: "clean" };
    },
  };
  return {
    coord,
    calls,
    get maxActive() {
      return maxActive;
    },
    hold(p: Promise<void> | null) {
      hold = p;
    },
    fail(e: Error | null) {
      fail = e;
    },
    syncResults,
  };
}

describe("createWatchLoop (the loop brain watch and the RPC server share)", () => {
  function tempDir(): string {
    const d = mkdtempSync(join(tmpdir(), "brain-loop-"));
    cleanups.push(() => rmSync(d, { recursive: true, force: true }));
    return d;
  }

  test("start runs a forced tick at once, then one tick per interval; ticks never overlap; stop waits for the tick in flight", async () => {
    const s = stubCoord(tempDir());
    const ticks: WatchTickResult[] = [];
    let embeds = 0;
    const loop = createWatchLoop({ coord: s.coord, embedder: { run: async () => (embeds++, 0) }, intervalMs: 10, log: () => {}, onTick: (r) => ticks.push(r) });
    let release!: () => void;
    s.hold(new Promise<void>((r) => (release = r)));
    const started = loop.start();
    await sleep(60); // several intervals while the forced tick is held
    expect(s.calls.filter((c) => c === "drain")).toHaveLength(1);
    expect(ticks).toHaveLength(0);
    release();
    s.hold(null);
    await started;
    expect(ticks).toHaveLength(1);
    expect(embeds).toBe(1); // forced: embeds although nothing changed
    await waitFor("scheduled ticks", () => ticks.length >= 3);
    expect(embeds).toBe(1); // scheduled ticks embed only after a change
    expect(s.maxActive).toBe(1);

    // a requested tick waits for the one in flight, and is forced
    let release2!: () => void;
    s.hold(new Promise<void>((r) => (release2 = r)));
    await waitFor("a held scheduled tick", () => s.calls.filter((c) => c === "drain").length > ticks.length);
    const requested = loop.tick();
    await sleep(30);
    expect(s.maxActive).toBe(1);
    s.hold(null);
    release2();
    const r = await requested;
    expect(r.changed).toBe(false);
    expect(embeds).toBe(2);

    // stop: no more ticks once the one in flight is done
    let release3!: () => void;
    s.hold(new Promise<void>((r) => (release3 = r)));
    await waitFor("another held tick", () => s.calls.filter((c) => c === "drain").length > ticks.length);
    let stopped = false;
    const stopping = loop.stop().then(() => (stopped = true));
    await sleep(30);
    expect(stopped).toBe(false); // waiting for the tick in flight
    s.hold(null);
    release3();
    await stopping;
    const n = s.calls.filter((c) => c === "drain").length;
    await sleep(50);
    expect(s.calls.filter((c) => c === "drain").length).toBe(n);
    expect(s.maxActive).toBe(1);
    // a requested tick still runs after stop (an engine.tick request already in flight)
    expect((await loop.tick()).changed).toBe(false);
  });

  test("a scheduled tick that throws goes to onError and the loop goes on; a requested one rejects instead", async () => {
    const s = stubCoord(tempDir());
    const errors: string[] = [];
    const loop = createWatchLoop({ coord: s.coord, embedder: null, intervalMs: 10, log: () => {}, onError: (e) => errors.push(String((e as Error).message)) });
    cleanups.push(() => loop.stop());
    s.fail(new Error("boom"));
    // not started: only the requested tick runs, and its caller gets the error
    await expect(loop.tick()).rejects.toThrow("boom");
    expect(errors).toEqual([]);
    // started: the forced tick and the scheduled ones report to onError, and the loop keeps ticking
    await loop.start();
    await waitFor("errors", () => errors.length >= 3);
    expect(new Set(errors)).toEqual(new Set(["boom"]));
    s.fail(null);
    expect((await loop.tick()).changed).toBe(false);
  });

  test("Human Sync goes through coord.syncOnce, and a commit is reported to onHumanSync", async () => {
    const s = stubCoord(tempDir());
    const synced: SyncResult[] = [];
    s.syncResults.push({ committed: false, reason: "not-quiescent" }, { committed: true, sha: "b".repeat(40), reason: "committed" });
    const loop = createWatchLoop({ coord: s.coord, embedder: null, intervalMs: 10, log: () => {}, onHumanSync: (r) => synced.push(r) });
    cleanups.push(() => loop.stop());
    await loop.start();
    await waitFor("a Human Sync commit", () => synced.length === 1);
    expect(synced[0]).toEqual({ committed: true, sha: "b".repeat(40), reason: "committed" });
    expect(s.calls.filter((c) => c === "sync").length).toBeGreaterThanOrEqual(2);
  });
});

describe("the server's engine (in process)", () => {
  interface Harness {
    server: RpcServer;
    out: Msg[];
    logs: string[];
    request(id: string, method: string, params?: Msg): Promise<Msg>;
    notifications(type: string): Msg[];
  }

  function makeServer(): Harness {
    const out: Msg[] = [];
    const logs: string[] = [];
    const server = createRpcServer({ send: (l) => out.push(JSON.parse(l)), log: (l) => logs.push(l), baseEnv: {}, loadUserConfig: () => null });
    return {
      server,
      out,
      logs,
      notifications: (type) => out.filter((m) => !("id" in m) && m.type === type),
      request: async (id, method, params = {}) => {
        server.handleLine(JSON.stringify({ id, method, params }));
        const deadline = Date.now() + 20_000;
        for (;;) {
          const t = out.find((m) => m.id === id && (m.type === "result" || m.type === "error"));
          if (t) return t;
          if (Date.now() > deadline) throw new Error(`no terminal message for ${id}`);
          await sleep(5);
        }
      },
    };
  }

  /** A temp BRAIN_HOME and repo (restored / removed afterwards). */
  function repoFixture(): { repo: string; home: string } {
    const prev = process.env.BRAIN_HOME;
    const bh = withBrainHome();
    const repo = makeTempKnowledgeRepo({ quiescenceMs: 100 });
    cleanups.push(() => {
      repo.cleanup();
      bh.cleanup();
      if (prev === undefined) delete process.env.BRAIN_HOME;
      else process.env.BRAIN_HOME = prev;
    });
    return { repo: repo.path, home: bh.home };
  }

  async function initialized(env: Msg = {}): Promise<{ h: Harness; repo: string }> {
    const { repo } = repoFixture();
    const h = makeServer();
    const r = await h.request("init", "initialize", { protocolVersion: 1, client: { name: "test", version: "0" }, repoPath: repo, env: { BRAIN_EMBEDDINGS: "hashing", ...env }, engine: { intervalMs: 20 } });
    expect(r.type).toBe("result");
    cleanups.push(() => h.server.shutdown("test teardown"));
    return { h, repo };
  }

  test("holds the loop-owner lock as rpc while running and releases it in shutdown, after the loop stopped", async () => {
    const { h } = await initialized();
    const runtimeDir = h.server.session.coord.paths.runtimeDir;
    expect(h.server.session.engine.loopOwner).toBe("self");
    expect(readLockHolder(runtimeDir, LOOP_OWNER_LOCK)).toMatchObject({ kind: "rpc", pid: process.pid });
    Bun.gc(true); // the handle stays reachable from the engine
    await sleep(50);
    expect(isLockHeld(runtimeDir, LOOP_OWNER_LOCK)).toBe(true);
    expect(loopOwnerCheck(runtimeDir, "svc").detail).toBe(`running (rpc, pid ${process.pid}); svc`);
    await waitFor("the forced tick", () => h.server.session.engine.status().lastTick !== undefined);
    h.server.handleLine(JSON.stringify({ id: "bye", method: "shutdown" }));
    await h.server.closed;
    expect(isLockHeld(runtimeDir, LOOP_OWNER_LOCK)).toBe(false);
    expect(readLockHolder(runtimeDir, LOOP_OWNER_LOCK)).toBeNull();
  });

  test("another holder: loopOwner other with its owner from the side file, no loop; takes over when the holder lets go", async () => {
    const { repo } = repoFixture();
    // the loop-owner lock lives under the repo's runtime dir, which exists once the repo is opened
    const { openRepo } = await import("../../src/commands/repo");
    const opened = await openRepo(repo);
    const runtimeDir = opened.coord.paths.runtimeDir;
    await opened.coord.close();
    mkdirSync(runtimeDir, { recursive: true });
    const other = await acquireLock(runtimeDir, LOOP_OWNER_LOCK, { mode: "try" }, { holderKind: "watch" });
    expect(other).not.toBeNull();
    const h = makeServer();
    const r = await h.request("init", "initialize", { protocolVersion: 1, client: { name: "test", version: "0" }, repoPath: repo, env: { BRAIN_EMBEDDINGS: "hashing" }, engine: { intervalMs: 20 } });
    cleanups.push(() => h.server.shutdown("test teardown"));
    expect(r.data.engine).toEqual({ loopOwner: "other", owner: { kind: "watch", pid: process.pid }, intervalMs: 20 });
    await sleep(100);
    expect(h.server.session.engine.status().lastTick).toBeUndefined(); // no loop ran
    expect(h.notifications("engine.loopOwner")).toEqual([]);
    other!.release();
    await waitFor("engine.loopOwner", () => h.notifications("engine.loopOwner").length === 1);
    expect(h.notifications("engine.loopOwner")[0]!.data).toEqual({ loopOwner: "self", intervalMs: 20 });
    await waitFor("the forced tick", () => h.server.session.engine.status().lastTick !== undefined);
    expect((await h.request("s", "engine.status")).data).toMatchObject({ loopOwner: "self", intervalMs: 20 });
  });

  test("engine.tick notifications: after a drained result other than INTEGRATED, never after an idle tick", async () => {
    const { h, repo } = await initialized();
    const coord = h.server.session.coord;
    writeNote(repo, "knowledge/n.md", { id: "01JA0000000000000000000001", title: "N", sections: { Claim: "A claim." } });
    commitAsHuman(repo, "user: n");
    await waitFor("the human commit to be integrated", () => h.notifications("engine.tick").some((m) => m.data.changed === true));
    await sleep(100); // idle ticks
    const before = h.notifications("engine.tick").length;
    await sleep(100);
    expect(h.notifications("engine.tick").length).toBe(before); // idle ticks send nothing

    // an identical write ends in NOOP when the loop drains it: no change, but a non-INTEGRATED result
    const blob = blobAt(coord.paths.agentWorktree, AGENT_BRANCH, "knowledge/n.md")!;
    await coord.enqueue({
      mutationId: "mut_01JA00000000000000000000E1",
      type: "ENRICH",
      summary: "enrich n",
      targets: [{ kind: "present", noteId: "01JA0000000000000000000001", path: "knowledge/n.md", blobHash: blob }],
      writes: [{ path: "knowledge/n.md", content: noteMd({ id: "01JA0000000000000000000001", title: "N", sections: { Claim: "A claim." } }) }],
      dependsOn: [],
      evidence: ["e"],
    });
    await waitFor("engine.tick for the NOOP", () => h.notifications("engine.tick").some((m) => m.data.drained.some((d: Msg) => d.mutationId === "mut_01JA00000000000000000000E1")));
    const t = h.notifications("engine.tick").find((m) => m.data.drained.length > 0)!;
    expect(t.data).toMatchObject({ drained: [{ mutationId: "mut_01JA00000000000000000000E1", state: "NOOP" }], changed: false });
  });

  test("engine.error: a loop error is sent redacted and the loop goes on; engine.humanSync: a commit by the loop's watcher", async () => {
    const secret = "sk-or-v1-engine-error-secret-0000";
    const { h, repo } = await initialized({ OPENROUTER_API_KEY: secret });
    const coord = h.server.session.coord;
    await waitFor("the forced tick", () => h.server.session.engine.status().lastTick !== undefined);
    const drain = coord.drainQueued.bind(coord);
    coord.drainQueued = async () => {
      throw new Error(`provider said: bad key ${secret}`);
    };
    await waitFor("engine.error", () => h.notifications("engine.error").length >= 1);
    expect(h.notifications("engine.error")[0]!.data).toEqual({ message: `provider said: bad key ${REDACTED}` });
    expect(h.logs.join("\n")).toContain(`watch loop error: provider said: bad key ${REDACTED}`);
    expect(JSON.stringify(h.out) + h.logs.join("\n")).not.toContain(secret);
    coord.drainQueued = drain;

    // Human Sync: only the loop's watcher commits here (integrate() would also run a Human Sync pass)
    const integrate = coord.integrate.bind(coord);
    coord.integrate = async () => ({ status: "nothing-to-integrate", integratedMutationIds: [], mainSha: "" });
    writeFileSync(join(repo, "knowledge", "edited.md"), noteMd({ id: "01JA0000000000000000000002", title: "Edited", sections: { Claim: "An edit." } }));
    try {
      await waitFor("engine.humanSync", () => h.notifications("engine.humanSync").length === 1, 15_000);
    } finally {
      coord.integrate = integrate;
    }
    const sha = h.notifications("engine.humanSync")[0]!.data.sha;
    expect(sha).toBe((await coord.mainHead()));
  });
});
