/**
 * CR-9 (T0.7): the per-session turn lock and on-disk turn ids
 * (docs/mac-app/design.md §5.4). The three §5.4 tests: a holder keeps the
 * lock longer than the bound and the second writer gets `SESSION_BUSY`; a
 * holder releases within the bound and the second writer proceeds, in order;
 * and both again with the second writer in another process
 * (`brain chat --once --session`).
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import type { Subprocess } from "bun";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ModelCompleteInput, ModelProvider } from "../../src/core/types";
import { openConversationStore, type ConversationStore } from "../../src/conversation/store";
import { acquireTurnLock, SESSION_BUSY, SessionBusyError, TURN_LOCK_WAIT_MS, turnLockName } from "../../src/conversation/turnLock";
import { EXTRACTOR_SYSTEM_PROMPT } from "../../src/extract/prompts";
import { openIndex, type IndexDb } from "../../src/index/schema";
import { loadConfig } from "../../src/markdown/repo";
import { CHAT_SYSTEM_PROMPT } from "../../src/pipeline/chat";
import type { ModelScript, ScriptCallLogLine } from "../../src/pipeline/scripted";
import { runTurn } from "../../src/pipeline/session";
import { HashingEmbeddingProvider } from "../../src/retrieval/embeddings";
import { isLockHeld, lockFilePath } from "../../src/sync/lock";
import { setupEnv, type Env } from "../harness";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const turnView = (store: ConversationStore, s: string) => store.getTurns(s).map((t) => ({ turnId: t.turnId, role: t.role, text: t.text }));

// ---------------------------------------------------------------------------
// The lock helper
// ---------------------------------------------------------------------------

describe("acquireTurnLock", () => {
  let runtimeDir: string;
  beforeEach(() => {
    runtimeDir = join(mkdtempSync(join(tmpdir(), "brain-turnlock-")), "runtime");
  });
  afterEach(() => {
    rmSync(resolve(runtimeDir, ".."), { recursive: true, force: true });
  });

  test("one lock file per session; a bounded wait ends in SessionBusyError; other sessions are independent", async () => {
    const s = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
    const other = "01BX5ZZKBKACTAV9WEVGEMMVRZ";
    expect(TURN_LOCK_WAIT_MS).toBe(1000);
    expect(turnLockName(s)).toBe(`turn-${s}`);

    const held = await acquireTurnLock(runtimeDir, s);
    expect(existsSync(lockFilePath(runtimeDir, `turn-${s}`))).toBe(true);
    expect(isLockHeld(runtimeDir, turnLockName(s))).toBe(true);

    // another session's lock is free
    const otherHandle = await acquireTurnLock(runtimeDir, other, 0);
    otherHandle.release();

    const started = Date.now();
    const err = await acquireTurnLock(runtimeDir, s, 100).then(
      () => null,
      (e: unknown) => e,
    );
    expect(Date.now() - started).toBeGreaterThanOrEqual(100);
    expect(err).toBeInstanceOf(SessionBusyError);
    expect((err as SessionBusyError).code).toBe(SESSION_BUSY);
    expect((err as SessionBusyError).sessionId).toBe(s);
    expect((err as SessionBusyError).message).toContain("SESSION_BUSY");

    // released within the bound: the waiter acquires
    const waiter = acquireTurnLock(runtimeDir, s);
    await sleep(100);
    held.release();
    const second = await waiter;
    expect(second.held).toBe(true);
    second.release();
    expect(isLockHeld(runtimeDir, turnLockName(s))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// runTurn, both writers in this process
// ---------------------------------------------------------------------------

describe("runTurn holds the session's turn lock from the user append to the assistant append", () => {
  const embeddings = new HashingEmbeddingProvider();
  let env: Env;
  let db: IndexDb | null = null;
  let store: ConversationStore;

  beforeEach(async () => {
    env = await setupEnv();
    await env.coord.reconcileIndex();
    db = openIndex(env.coord.paths.indexDb);
    store = openConversationStore(env.coord.paths.conversationsDir);
  });
  afterEach(async () => {
    db?.close();
    db = null;
    await env.cleanup();
  });

  /** The chat reply to exactly this user message fails. */
  const FAILING_TEXT = "fail please";
  const lastUser = (input: ModelCompleteInput) => [...input.messages].reverse().find((m) => m.role === "user")?.content ?? "";

  /**
   * Chat replies `reply to <last user text>`; a reply to a text in `gates`
   * waits for that gate, and the reply to `FAILING_TEXT` throws. `chatStarted` resolves when a chat call for a text
   * arrives (the user turn is appended and the lock is held by then). The
   * extractor finds nothing and records whether the turn lock was held.
   */
  function gatedModel(gates: Record<string, Promise<void>>, onExtractor: () => void = () => {}) {
    const started = new Map<string, { promise: Promise<void>; resolve: () => void }>();
    const chatStarted = (text: string): Promise<void> => {
      if (!started.has(text)) started.set(text, deferred());
      return started.get(text)!.promise;
    };
    const chatCalls: ModelCompleteInput[] = [];
    const model: ModelProvider = {
      async complete(input) {
        if (input.system === EXTRACTOR_SYSTEM_PROMPT) {
          onExtractor();
          return '{"candidates": []}';
        }
        if (input.system.startsWith(CHAT_SYSTEM_PROMPT)) {
          chatCalls.push(input);
          const text = lastUser(input);
          void chatStarted(text);
          started.get(text)!.resolve();
          const gate = gates[text];
          if (gate) await gate;
          if (text === FAILING_TEXT) throw new Error("model unavailable");
          return `reply to ${text}`;
        }
        throw new Error("unexpected call");
      },
    };
    return { model, chatStarted, chatCalls };
  }

  function deps(model: ModelProvider) {
    return { coord: env.coord, db: db!, model, embeddings, config: env.coord.config, store, today: "2026-10-02" };
  }

  test(
    "(§5.4 test 1) the holder keeps the lock longer than the bound: the second writer gets SESSION_BUSY and appends nothing",
    async () => {
      const s = store.createSession();
      const gate = deferred();
      const { model, chatStarted, chatCalls } = gatedModel({ first: gate.promise });

      const first = runTurn(deps(model), s, "first");
      await chatStarted("first"); // user₁ is appended and the reply is in flight
      expect(isLockHeld(env.coord.paths.runtimeDir, turnLockName(s))).toBe(true);

      const started = Date.now();
      const err = await runTurn(deps(model), s, "second").then(
        () => null,
        (e: unknown) => e,
      );
      expect(Date.now() - started).toBeGreaterThanOrEqual(TURN_LOCK_WAIT_MS);
      expect(err).toBeInstanceOf(SessionBusyError);
      expect((err as SessionBusyError).code).toBe("SESSION_BUSY");
      expect((err as SessionBusyError).sessionId).toBe(s);
      expect(chatCalls.length).toBe(1); // the busy writer made no model call
      expect(turnView(store, s)).toEqual([{ turnId: "000001", role: "user", text: "first" }]);

      // the lock is per session: another session is not blocked
      const other = store.createSession();
      const r3 = await runTurn(deps(model), other, "elsewhere");
      expect(r3.assistantTurn).toMatchObject({ turnId: "000002", text: "reply to elsewhere" });
      await r3.knowledge;

      gate.resolve();
      const r1 = await first;
      await r1.knowledge;
      expect(turnView(store, s)).toEqual([
        { turnId: "000001", role: "user", text: "first" },
        { turnId: "000002", role: "assistant", text: "reply to first" },
      ]);
      expect(isLockHeld(env.coord.paths.runtimeDir, turnLockName(s))).toBe(false);
    },
    15_000,
  );

  test("(§5.4 test 2) the holder releases within the bound: the second writer proceeds after it, in order", async () => {
    const s = store.createSession();
    const gate = deferred();
    const { model, chatStarted, chatCalls } = gatedModel({ first: gate.promise });

    const first = runTurn(deps(model), s, "first");
    await chatStarted("first");
    const second = runTurn(deps(model), s, "second");
    await sleep(200); // the second writer is waiting for the lock
    expect(turnView(store, s)).toEqual([{ turnId: "000001", role: "user", text: "first" }]);
    gate.resolve();

    const [r1, r2] = await Promise.all([first, second]);
    await Promise.all([r1.knowledge, r2.knowledge]);
    expect(turnView(store, s)).toEqual([
      { turnId: "000001", role: "user", text: "first" },
      { turnId: "000002", role: "assistant", text: "reply to first" },
      { turnId: "000003", role: "user", text: "second" },
      { turnId: "000004", role: "assistant", text: "reply to second" },
    ]);
    expect([r1.turn.turnId, r1.assistantTurn.turnId, r2.turn.turnId, r2.assistantTurn.turnId]).toEqual(["000001", "000002", "000003", "000004"]);
    // the second reply saw the first turn's reply: user₂ was appended after assistant₁
    expect(chatCalls[1]!.messages).toEqual([
      { role: "user", content: "first" },
      { role: "assistant", content: "reply to first" },
      { role: "user", content: "second" },
    ]);
  });

  test("the lock is released when the reply fails, and before knowledge maintenance runs", async () => {
    const s = store.createSession();
    const heldDuringExtractor: boolean[] = [];
    const { model } = gatedModel({}, () => heldDuringExtractor.push(isLockHeld(env.coord.paths.runtimeDir, turnLockName(s))));

    await expect(runTurn(deps(model), s, FAILING_TEXT)).rejects.toThrow("model unavailable");
    expect(isLockHeld(env.coord.paths.runtimeDir, turnLockName(s))).toBe(false);
    expect(turnView(store, s)).toEqual([{ turnId: "000001", role: "user", text: FAILING_TEXT }]);

    // the next writer gets the lock at once and numbers on from the file
    const started = Date.now();
    const r = await runTurn(deps(model), s, "again", { awaitKnowledge: true });
    expect(Date.now() - started).toBeLessThan(TURN_LOCK_WAIT_MS);
    expect([r.turn.turnId, r.assistantTurn.turnId]).toEqual(["000002", "000003"]);
    expect(heldDuringExtractor).toEqual([false]);
  });
});

// ---------------------------------------------------------------------------
// Across processes: two `brain chat --once --session <id>`
// ---------------------------------------------------------------------------

describe("turn lock across processes (brain chat --once --session)", () => {
  const CLI = resolve(import.meta.dir, "../../src/cli.ts");
  /** Child env: no model keys or provider settings leak in from the developer's environment. */
  const STRIP = [
    "OPENROUTER_API_KEY",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "BRAIN_MODEL_PROVIDER",
    "BRAIN_MODEL",
    "BRAIN_EFFORT",
    "BRAIN_EMBEDDINGS",
    "BRAIN_EMBEDDING_MODEL",
    "BRAIN_EMBEDDING_DIMS",
    "BRAIN_MODEL_MOCK",
    "BRAIN_MODEL_SCRIPT",
    "BRAIN_MODEL_SCRIPT_LOG",
  ];
  let dir: string;
  let home: string;
  let repo: string;
  let children: Subprocess[] = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "brain-turnlock-cli-"));
    home = join(dir, "home");
    repo = join(dir, "repo");
    mkdirSync(home);
    mkdirSync(repo);
  });
  afterEach(async () => {
    for (const c of children) {
      try {
        c.kill("SIGKILL");
      } catch {}
      await c.exited;
    }
    children = [];
    rmSync(dir, { recursive: true, force: true });
  });

  function childEnv(extra: Record<string, string>): Record<string, string> {
    const env: Record<string, string> = { ...(process.env as Record<string, string>), BRAIN_HOME: home };
    for (const k of STRIP) delete env[k];
    return { ...env, ...extra };
  }

  /** `brain <args>` in the background; stderr is collected as it arrives. */
  function spawnBrain(args: string[], extra: Record<string, string>) {
    const proc = Bun.spawn(["bun", CLI, ...args], { cwd: repo, env: childEnv(extra), stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    children.push(proc);
    const stdout = new Response(proc.stdout).text();
    let err = "";
    const stderrDone = (async () => {
      const decoder = new TextDecoder();
      for await (const chunk of proc.stderr) err += decoder.decode(chunk, { stream: true });
    })();
    return {
      proc,
      /** Resolves once stderr contains `text`; throws if the process exits first. */
      async waitForErr(text: string): Promise<void> {
        let exited = false;
        void proc.exited.then(() => (exited = true));
        while (!err.includes(text)) {
          if (exited) {
            await stderrDone;
            if (err.includes(text)) return;
            throw new Error(`brain ${args.join(" ")} exited (${proc.exitCode}) before printing ${JSON.stringify(text)}; stderr: ${err}`);
          }
          await sleep(10);
        }
      },
      async done(): Promise<{ code: number; out: string; err: string }> {
        const code = await proc.exited;
        await stderrDone;
        return { code, out: await stdout, err };
      },
    };
  }

  function writeScript(name: string, script: ModelScript): string {
    const path = join(dir, `${name}.json`);
    writeFileSync(path, JSON.stringify(script));
    return path;
  }

  function readCallLog(path: string): ScriptCallLogLine[] {
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as ScriptCallLogLine);
  }

  async function waitForChatCall(logPath: string): Promise<void> {
    const deadline = Date.now() + 30_000;
    while (!readCallLog(logPath).some((l) => l.role === "chat")) {
      if (Date.now() > deadline) throw new Error(`no chat call logged in ${logPath}`);
      await sleep(10);
    }
  }

  /** `brain init`, then an empty session created directly in the store under BRAIN_HOME. */
  function initRepoWithSession(): { store: ConversationStore; sessionId: string } {
    const init = Bun.spawnSync(["bun", CLI, "init", repo], { cwd: repo, env: childEnv({}), stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    expect(init.exitCode).toBe(0);
    const store = openConversationStore(join(home, "repos", loadConfig(repo).repoId, "conversations"));
    return { store, sessionId: store.createSession() };
  }

  const NOTHING_EXTRACTED = { response: { candidates: [] }, repeat: true as const };

  /** Writer A: its reply is held until `release-a` exists. */
  function startHolder(sessionId: string) {
    const scriptA = writeScript("a", { chunkDelayMs: 0, chat: [{ response: "reply one", hold: "release-a" }], extractor: [NOTHING_EXTRACTED] });
    const a = spawnBrain(["chat", "--once", "first", "--session", sessionId], { BRAIN_MODEL_SCRIPT: scriptA });
    return { a, logA: join(dir, "a.calls.jsonl"), release: () => writeFileSync(join(dir, "release-a"), "") };
  }

  function startSecond(sessionId: string) {
    const scriptB = writeScript("b", { chunkDelayMs: 0, chat: [{ response: "reply two" }], extractor: [NOTHING_EXTRACTED] });
    return { b: spawnBrain(["chat", "--once", "second", "--session", sessionId], { BRAIN_MODEL_SCRIPT: scriptB }), logB: join(dir, "b.calls.jsonl") };
  }

  test(
    "(§5.4 test 3, held) another process holds the session longer than the bound: `brain chat --once` prints SESSION_BUSY and exits 1",
    async () => {
      const { store, sessionId } = initRepoWithSession();
      const { a, logA, release } = startHolder(sessionId);
      await waitForChatCall(logA); // A appended user₁ and holds the turn lock while its reply is held

      const { b, logB } = startSecond(sessionId);
      const rb = await b.done();
      expect(rb.code).toBe(1);
      expect(rb.err).toContain("resumed, 1 turns");
      const busy = rb.err.split("\n").filter((l) => l.includes(SESSION_BUSY));
      expect(busy).toEqual([`session ${sessionId} is busy: another turn is in progress (SESSION_BUSY); try again when it finishes`]);
      expect(rb.err).not.toContain("    at "); // a one-line error, no stack
      expect(rb.out).toBe("");
      expect(readCallLog(logB)).toEqual([]); // B never called the model
      expect(turnView(store, sessionId)).toEqual([{ turnId: "000001", role: "user", text: "first" }]);

      release();
      const ra = await a.done();
      expect(ra.code).toBe(0);
      expect(ra.out).toBe("reply one\n");
      expect(turnView(store, sessionId)).toEqual([
        { turnId: "000001", role: "user", text: "first" },
        { turnId: "000002", role: "assistant", text: "reply one" },
      ]);
    },
    60_000,
  );

  test(
    "(§5.4 test 3, released) another process releases within the bound: the second `brain chat --once` proceeds after it, in order",
    async () => {
      const { store, sessionId } = initRepoWithSession();
      const { a, logA, release } = startHolder(sessionId);
      await waitForChatCall(logA); // A holds the turn lock

      const { b, logB } = startSecond(sessionId);
      // B prints this line right before its turn, while A still holds the lock; B now waits for it.
      await b.waitForErr("resumed, 1 turns");
      release(); // A's reply lands and A releases the lock well within B's bound

      const [ra, rb] = await Promise.all([a.done(), b.done()]);
      expect(rb.err).not.toContain(SESSION_BUSY);
      expect(ra.code).toBe(0);
      expect(rb.code).toBe(0);
      expect(ra.out).toBe("reply one\n");
      expect(rb.out).toBe("reply two\n");
      expect(turnView(store, sessionId)).toEqual([
        { turnId: "000001", role: "user", text: "first" },
        { turnId: "000002", role: "assistant", text: "reply one" },
        { turnId: "000003", role: "user", text: "second" },
        { turnId: "000004", role: "assistant", text: "reply two" },
      ]);
      // B's reply saw A's whole turn: user₂ was appended after assistant₁
      const chatB = readCallLog(logB).filter((l) => l.role === "chat");
      expect(chatB.length).toBe(1);
      expect(chatB[0]!.messages).toEqual([
        { role: "user", content: "first" },
        { role: "assistant", content: "reply one" },
        { role: "user", content: "second" },
      ]);
    },
    60_000,
  );
});
