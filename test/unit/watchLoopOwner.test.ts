/**
 * Loop-owner lock (CR-10; docs/mac-app/design.md §5.3 item 2): `brain watch`
 * runs the loop only while it holds the repo's loop-owner lock, waits while
 * another process holds it, and `brain doctor` reports ownership from the
 * lock and its side file, never from `watch.pid`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { Subprocess } from "bun";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describeLoopOwnerWait, waitForLoopOwner } from "../../src/cli/watch";
import { loopOwnerCheck, runDoctor, WATCH_PID_FILE } from "../../src/config/doctor";
import { repoPaths } from "../../src/core/brainHome";
import { acquireLock, isLockHeld, LOOP_OWNER_LOCK, lockFilePath, lockHolderPath, readLockHolder, type LockHandle } from "../../src/sync/lock";
import { commitAsHuman, makeTempKnowledgeRepo, withBrainHome, writeNote } from "../harness";

const CLI = resolve(import.meta.dir, "../../src/cli.ts");
/** Per-test timeout for tests that spawn `brain watch`. */
const SPAWN_TIMEOUT_MS = 60_000;
/** A short `--interval` for spawned watchers. */
const INTERVAL_MS = 200;
/**
 * Generous bound from SIGKILLing the owner to the waiter's acquisition and to
 * its forced tick. The lock is free as soon as the kernel reaps the owner and
 * the waiter retries within the primitive's backoff (≤ 50 ms); the bound only
 * absorbs process scheduling, the open sequence and the tick on a loaded CI
 * machine.
 */
const TAKEOVER_BOUND_MS = 10_000;
const SVC = "svc";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

let children: Subprocess[] = [];
let cleanups: (() => void)[] = [];
afterEach(async () => {
  for (const c of children) {
    try {
      c.kill("SIGKILL");
    } catch {}
    await c.exited;
  }
  children = [];
  for (const f of cleanups) f();
  cleanups = [];
});

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "brain-loop-owner-"));
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

/** Every model/key variable is removed: `bun test` auto-loads the developer's `.env`, and these children must be hermetic. */
const PROVIDER_VARS = [
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
function childEnv(brainHome: string, extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = { ...(process.env as Record<string, string>), BRAIN_HOME: brainHome };
  for (const k of PROVIDER_VARS) delete env[k];
  return { ...env, ...extra };
}

interface WatchChild {
  proc: Subprocess;
  pid: number;
  /** stderr so far. */
  stderr(): string;
  /** All of stderr, once the child has closed it. */
  done(): Promise<string>;
  /** Resolves with the time the pattern was first seen on stderr. */
  waitFor(pattern: string | RegExp, timeoutMs?: number): Promise<number>;
}

/** `brain watch --repo <dir> --interval INTERVAL_MS …` with stderr read incrementally. */
function spawnWatch(brainHome: string, repoDir: string, args: string[], env: Record<string, string> = {}): WatchChild {
  const proc = Bun.spawn([process.execPath, CLI, "watch", "--repo", repoDir, "--interval", String(INTERVAL_MS), ...args], {
    env: childEnv(brainHome, env),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  children.push(proc);
  let buf = "";
  let eof = false;
  const pump = (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of proc.stderr) buf += decoder.decode(chunk, { stream: true });
    eof = true;
    return buf;
  })();
  void new Response(proc.stdout).text(); // keep stdout drained
  return {
    proc,
    pid: proc.pid,
    stderr: () => buf,
    done: () => pump,
    async waitFor(pattern, timeoutMs = SPAWN_TIMEOUT_MS / 2) {
      const deadline = Date.now() + timeoutMs;
      const seen = () => (typeof pattern === "string" ? buf.includes(pattern) : pattern.test(buf));
      while (!seen()) {
        if (eof) throw new Error(`watch (pid ${proc.pid}) closed stderr before printing ${String(pattern)}; stderr:\n${buf}`);
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${String(pattern)} from watch (pid ${proc.pid}); stderr:\n${buf}`);
        await sleep(10);
      }
      return Date.now();
    },
  };
}

/** A temp `BRAIN_HOME` (also set in this process, for in-process probes) and a knowledge repo. */
function setup(): { home: string; repoDir: string; runtimeDir: string; pidFile: string } {
  const bh = withBrainHome();
  const repo = makeTempKnowledgeRepo();
  cleanups.push(repo.cleanup, bh.cleanup);
  const runtimeDir = repoPaths(repo.path, repo.repoId).runtimeDir;
  return { home: bh.home, repoDir: repo.path, runtimeDir, pidFile: join(runtimeDir, WATCH_PID_FILE) };
}

function ownerLine(runtimeDir: string) {
  return loopOwnerCheck(runtimeDir, SVC);
}

const ACQUIRED = "watch: acquired the loop-owner lock";
const WAITING = "; waiting until it exits";

describe("waitForLoopOwner", () => {
  test("a free lock is taken at once, with no log line, recorded as the given kind, and held under Bun.gc(true) until released", async () => {
    const dir = tempDir();
    const log: string[] = [];
    const h = await waitForLoopOwner(dir, { holderKind: "watch", stopped: () => false, log: (l) => log.push(l) });
    expect(h).not.toBeNull();
    expect(log).toEqual([]);
    expect(existsSync(lockFilePath(dir, LOOP_OWNER_LOCK))).toBe(true);
    expect(lockFilePath(dir, LOOP_OWNER_LOCK)).toBe(join(dir, "locks", "loop-owner.sqlite"));
    expect(readLockHolder(dir, LOOP_OWNER_LOCK)).toMatchObject({ lock: "loop-owner", kind: "watch", pid: process.pid });
    let leaks = 0;
    for (let i = 0; i < 10; i++) {
      Bun.gc(true);
      await sleep(10);
      if (!isLockHeld(dir, LOOP_OWNER_LOCK)) leaks++;
    }
    expect(leaks).toBe(0);
    h!.release();
    expect(isLockHeld(dir, LOOP_OWNER_LOCK)).toBe(false);
    expect(readLockHolder(dir, LOOP_OWNER_LOCK)).toBeNull();
  });

  test("while another holder has it: logs that holder once, keeps waiting, and takes over when it is released", async () => {
    const dir = tempDir();
    const other = await acquireLock(dir, LOOP_OWNER_LOCK, { mode: "blocking" }, { holderKind: "rpc" });
    const log: string[] = [];
    let got: LockHandle | null = null;
    const waiting = waitForLoopOwner(dir, { holderKind: "watch", stopped: () => false, log: (l) => log.push(l), sliceMs: 50 }).then((h) => (got = h));
    await sleep(400); // several slices
    expect(got).toBeNull();
    expect(log).toHaveLength(1);
    expect(log[0]).toBe(describeLoopOwnerWait(readLockHolder(dir, LOOP_OWNER_LOCK)));
    expect(log[0]).toMatch(new RegExp(`^watch: the loop for this repo is owned by rpc \\(pid ${process.pid}, since \\d{4}-\\d\\d-\\d\\dT[^)]+\\); waiting until it exits$`));
    other.release();
    const h = await waiting;
    expect(h).not.toBeNull();
    expect(readLockHolder(dir, LOOP_OWNER_LOCK)).toMatchObject({ kind: "watch", pid: process.pid });
    expect(log).toHaveLength(1);
    h!.release();
  });

  test("a stop request ends the wait with null and leaves the holder in place", async () => {
    const dir = tempDir();
    const other = await acquireLock(dir, LOOP_OWNER_LOCK, { mode: "blocking" }, { holderKind: "rpc" });
    try {
      let stop = false;
      const waiting = waitForLoopOwner(dir, { holderKind: "watch", stopped: () => stop, log: () => {}, sliceMs: 50 });
      await sleep(120);
      stop = true;
      const t0 = Date.now();
      expect(await waiting).toBeNull();
      expect(Date.now() - t0).toBeLessThan(1_000);
      expect(isLockHeld(dir, LOOP_OWNER_LOCK)).toBe(true);
      expect(readLockHolder(dir, LOOP_OWNER_LOCK)?.kind).toBe("rpc");
    } finally {
      other.release();
    }
  });

  test("without a side file the waiting line names no holder", () => {
    expect(describeLoopOwnerWait(null)).toBe("watch: the loop for this repo is owned by another process; waiting until it exits");
  });
});

describe("brain doctor: loop owner", () => {
  test("not running / running (kind, pid) / running (holder unknown), decided by the lock alone", async () => {
    const dir = tempDir();
    expect(ownerLine(dir)).toEqual({ name: "watch", status: "info", detail: `not running; ${SVC}`, required: false });
    expect(existsSync(lockFilePath(dir, LOOP_OWNER_LOCK))).toBe(false); // probing creates nothing

    const h = await acquireLock(dir, LOOP_OWNER_LOCK, { mode: "try" }, { holderKind: "watch" });
    expect(ownerLine(dir)).toEqual({ name: "watch", status: "ok", detail: `running (watch, pid ${process.pid}); ${SVC}`, required: false });
    h!.release();
    expect(ownerLine(dir).detail).toBe(`not running; ${SVC}`);

    const anon = await acquireLock(dir, LOOP_OWNER_LOCK, { mode: "try" }, { recordHolder: false });
    expect(ownerLine(dir)).toEqual({ name: "watch", status: "ok", detail: `running (holder unknown); ${SVC}`, required: false });
    anon!.release();

    // a stale watch.pid naming a live pid does not make the loop "running"
    writeFileSync(join(dir, WATCH_PID_FILE), `${process.pid}\n`);
    expect(ownerLine(dir).detail).toBe(`not running; ${SVC}`);
  });
});

describe("brain watch: loop-owner lock (CR-10)", () => {
  test(
    "a second brain watch waits while the first holds the lock; SIGINT ends the wait; a clean stop releases everything",
    async () => {
      const { home, repoDir, runtimeDir, pidFile } = setup();
      const a = spawnWatch(home, repoDir, ["--no-embeddings"]);
      await a.waitFor("watching ");
      expect(a.stderr()).toContain(`${ACQUIRED} (pid ${a.pid})`);
      expect(a.stderr()).not.toContain(WAITING);
      expect(readFileSync(pidFile, "utf8")).toBe(`${a.pid}\n`);
      expect(ownerLine(runtimeDir)).toEqual({ name: "watch", status: "ok", detail: `running (watch, pid ${a.pid}); ${SVC}`, required: false });

      const b = spawnWatch(home, repoDir, ["--no-embeddings"]);
      await b.waitFor(new RegExp(`owned by watch \\(pid ${a.pid}, since [^)]+\\); waiting until it exits`));
      await sleep(INTERVAL_MS * 5);
      // still waiting: not acquired, never opened the repo or ran a tick, logged the holder once, wrote nothing
      expect(b.stderr()).not.toContain(ACQUIRED);
      expect(b.stderr()).not.toContain("watching ");
      expect(b.stderr().split(WAITING)).toHaveLength(2);
      expect(readFileSync(pidFile, "utf8")).toBe(`${a.pid}\n`);
      expect(readLockHolder(runtimeDir, LOOP_OWNER_LOCK)).toMatchObject({ kind: "watch", pid: a.pid });
      expect(ownerLine(runtimeDir).detail).toBe(`running (watch, pid ${a.pid}); ${SVC}`);

      // the wait is asynchronous: SIGINT ends it promptly with exit 0 and touches nothing
      const t0 = Date.now();
      b.proc.kill("SIGINT");
      expect(await b.proc.exited).toBe(0);
      expect(Date.now() - t0).toBeLessThan(5_000);
      expect(await b.done()).toMatch(/stopped\n$/);
      expect(b.stderr()).not.toContain(ACQUIRED);
      expect(readFileSync(pidFile, "utf8")).toBe(`${a.pid}\n`);
      expect(isLockHeld(runtimeDir, LOOP_OWNER_LOCK)).toBe(true);
      expect(readLockHolder(runtimeDir, LOOP_OWNER_LOCK)?.pid).toBe(a.pid);

      // a clean stop of the owner removes watch.pid and the side file and releases the lock
      a.proc.kill("SIGTERM");
      expect(await a.proc.exited).toBe(0);
      expect(await a.done()).toMatch(/stopped\n$/);
      expect(existsSync(pidFile)).toBe(false);
      expect(existsSync(lockHolderPath(runtimeDir, LOOP_OWNER_LOCK))).toBe(false);
      expect(isLockHeld(runtimeDir, LOOP_OWNER_LOCK)).toBe(false);
      expect(ownerLine(runtimeDir)).toEqual({ name: "watch", status: "info", detail: `not running; ${SVC}`, required: false });
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    "after the owner is SIGKILLed, the waiting brain watch takes over at once and runs a forced tick",
    async () => {
      const { home, repoDir, runtimeDir, pidFile } = setup();
      writeNote(repoDir, "knowledge/takeover.md", { title: "Takeover", sections: { Claim: "The next loop owner embeds what the last one left." } });
      commitAsHuman(repoDir, "user: add takeover note");
      // A never embeds; its open sequence indexes the note. A tick of B embeds it only when forced,
      // because nothing changes after B takes over, so "embedded 1 notes" marks B's forced tick.
      const a = spawnWatch(home, repoDir, ["--no-embeddings"]);
      await a.waitFor("watching ");
      const b = spawnWatch(home, repoDir, [], { BRAIN_EMBEDDINGS: "hashing" });
      await b.waitFor(new RegExp(`owned by watch \\(pid ${a.pid}, since [^)]+\\); waiting until it exits`));
      await sleep(INTERVAL_MS * 3);
      expect(b.stderr()).not.toContain(ACQUIRED);
      expect(b.stderr()).not.toContain("watch: embedded");

      const killedAt = Date.now();
      a.proc.kill("SIGKILL");
      await a.proc.exited;
      const acquiredAt = await b.waitFor(`${ACQUIRED} (pid ${b.pid})`, TAKEOVER_BOUND_MS);
      const tickedAt = await b.waitFor("watch: embedded 1 notes", TAKEOVER_BOUND_MS);
      expect(acquiredAt - killedAt).toBeLessThan(TAKEOVER_BOUND_MS);
      expect(tickedAt - killedAt).toBeLessThan(TAKEOVER_BOUND_MS);
      const log = b.stderr();
      expect(log.indexOf(WAITING)).toBeLessThan(log.indexOf(ACQUIRED));
      expect(log.indexOf(ACQUIRED)).toBeLessThan(log.indexOf("watching "));
      expect(log.indexOf("watching ")).toBeLessThan(log.indexOf("watch: embedded 1 notes"));

      // B owns the loop now: the side file names it and A's stale watch.pid was overwritten
      expect(readLockHolder(runtimeDir, LOOP_OWNER_LOCK)).toMatchObject({ kind: "watch", pid: b.pid });
      expect(readFileSync(pidFile, "utf8")).toBe(`${b.pid}\n`);
      expect(ownerLine(runtimeDir).detail).toBe(`running (watch, pid ${b.pid}); ${SVC}`);

      b.proc.kill("SIGINT");
      expect(await b.proc.exited).toBe(0);
      expect(existsSync(pidFile)).toBe(false);
      expect(isLockHeld(runtimeDir, LOOP_OWNER_LOCK)).toBe(false);
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    "a stale watch.pid naming a reused pid changes nothing",
    async () => {
      const { home, repoDir, runtimeDir, pidFile } = setup();
      // Left by a daemon that crashed; its pid now belongs to a live, unrelated process (this test runner).
      mkdirSync(runtimeDir, { recursive: true });
      writeFileSync(pidFile, `${process.pid}\n`);
      expect(ownerLine(runtimeDir)).toEqual({ name: "watch", status: "info", detail: `not running; ${SVC}`, required: false });
      const report = await runDoctor({ offline: true, repoRoot: repoDir, gitVersion: () => "git version 2.45.0", env: {} });
      expect(report.checks.find((c) => c.name === "watch")).toMatchObject({ status: "info", detail: expect.stringMatching(/^not running; /) });

      // brain watch does not wait for it: it takes the free lock at once and replaces the file
      const w = spawnWatch(home, repoDir, ["--no-embeddings"]);
      await w.waitFor("watching ");
      expect(w.stderr()).toContain(`${ACQUIRED} (pid ${w.pid})`);
      expect(w.stderr()).not.toContain(WAITING);
      expect(readFileSync(pidFile, "utf8")).toBe(`${w.pid}\n`);
      expect(ownerLine(runtimeDir).detail).toBe(`running (watch, pid ${w.pid}); ${SVC}`);

      w.proc.kill("SIGINT");
      expect(await w.proc.exited).toBe(0);
      expect(existsSync(pidFile)).toBe(false);
      expect(ownerLine(runtimeDir).detail).toBe(`not running; ${SVC}`);
    },
    SPAWN_TIMEOUT_MS,
  );
});
