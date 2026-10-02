/**
 * Kernel-released lock primitive (CR-1; docs/mac-app/design.md §5.2).
 * Fixture 3.12 (test/fixtures/sync.test.ts) covers the in-process
 * `withRepoWorktreeLock` contract; these cover the primitive itself.
 */
import { describe, test, expect, afterEach } from "bun:test";
import type { Subprocess } from "bun";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireLock,
  createLockFile,
  isLockHeld,
  LockBusyError,
  lockFilePath,
  lockHolderPath,
  locksDir,
  readLockHolder,
  withLock,
  withRepoWorktreeLock,
  WORKTREE_LOCK,
  type LockHandle,
} from "../../src/sync/lock";
import { LONG_HELD_LOCK_MS, runDoctor, worktreeLockCheck } from "../../src/config/doctor";
import { makeTempKnowledgeRepo, withBrainHome } from "../harness";

const LOCK_MODULE = join(import.meta.dir, "..", "..", "src", "sync", "lock.ts");
/** Per-test timeout for tests that spawn `bun` children. */
const SPAWN_TIMEOUT_MS = 30_000;

let dirs: string[] = [];
let children: Subprocess[] = [];
afterEach(async () => {
  for (const c of children) {
    try {
      c.kill("SIGKILL");
    } catch {}
    await c.exited;
  }
  children = [];
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "brain-lock-"));
  dirs.push(d);
  return d;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function userVersion(file: string): number {
  const db = new Database(file, { readonly: true });
  try {
    return (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
  } finally {
    db.close();
  }
}

/** `bun -e <script>` with stdout read incrementally. */
function spawnChild(script: string) {
  const proc = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "inherit" });
  children.push(proc);
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let eof = false;
  async function readMore(): Promise<void> {
    const r = await reader.read();
    if (r.done) eof = true;
    else buf += decoder.decode(r.value, { stream: true });
  }
  return {
    proc,
    async waitFor(text: string): Promise<void> {
      while (!buf.includes(text)) {
        if (eof) throw new Error(`child exited before printing ${JSON.stringify(text)}; output: ${buf}`);
        await readMore();
      }
    },
    async output(): Promise<string> {
      while (!eof) await readMore();
      return buf;
    },
  };
}

/** A child that takes the worktree lock, prints HELD, never releases, and forces GC continuously. */
function holderScript(dir: string): string {
  return `
    const { withRepoWorktreeLock, setLockHolderKind } = await import(${JSON.stringify(LOCK_MODULE)});
    setLockHolderKind("test-holder");
    setInterval(() => Bun.gc(true), 20);
    await withRepoWorktreeLock(${JSON.stringify(dir)}, async () => {
      console.log("HELD");
      await new Promise(() => {});
    });
  `;
}

describe("lock files and the side file", () => {
  test("the first acquisition creates an initialized lock file; holding it writes nothing", async () => {
    const dir = tempDir(); // no locks/ yet
    const file = lockFilePath(dir, WORKTREE_LOCK);
    expect(file).toBe(join(dir, "locks", "worktree.sqlite"));
    const t0 = Date.now();
    const h = await acquireLock(dir, WORKTREE_LOCK, { mode: "blocking" }, { holderKind: "unit" });
    expect(h.held).toBe(true);
    expect(existsSync(file)).toBe(true);
    expect(existsSync(`${file}-journal`)).toBe(false);
    const mtime = statSync(file).mtimeMs;

    const holder = readLockHolder(dir, WORKTREE_LOCK)!;
    expect(holder.kind).toBe("unit");
    expect(holder.pid).toBe(process.pid);
    expect(holder.acquiredAtMs).toBeGreaterThanOrEqual(t0);
    expect(holder.acquiredAtMs).toBeLessThanOrEqual(Date.now());
    expect(holder.processStartedAtMs).toBeLessThanOrEqual(holder.acquiredAtMs);

    h.release();
    expect(h.held).toBe(false);
    h.release(); // idempotent
    expect(readLockHolder(dir, WORKTREE_LOCK)).toBeNull();
    expect(existsSync(lockHolderPath(dir, WORKTREE_LOCK))).toBe(false);
    // The lock file persists, initialized, untouched by the acquisition, with no journal.
    expect(readdirSync(locksDir(dir))).toEqual(["worktree.sqlite"]);
    expect(statSync(file).mtimeMs).toBe(mtime);
    expect(userVersion(file)).toBe(1);
  });

  test("an existing lock file is never replaced: a losing init keeps the inode and leaves no temp file", async () => {
    const dir = tempDir();
    const h = await acquireLock(dir, "x", { mode: "try" });
    expect(h).not.toBeNull();
    const file = lockFilePath(dir, "x");
    const ino = statSync(file).ino;
    createLockFile(file); // link() fails with EEXIST: the existing file is used as is
    expect(statSync(file).ino).toBe(ino);
    expect(readdirSync(locksDir(dir)).sort()).toEqual(["x.holder.json", "x.sqlite"]);
    expect(isLockHeld(dir, "x")).toBe(true);
    expect(await acquireLock(dir, "x", { mode: "try" })).toBeNull();
    h!.release();
    expect(isLockHeld(dir, "x")).toBe(false);
    expect(statSync(file).ino).toBe(ino);
  });

  test("lock names are validated; a missing lock file is not held and is not created by a probe", async () => {
    const dir = tempDir();
    expect(() => lockFilePath(dir, "../x")).toThrow("invalid lock name");
    expect(() => lockFilePath(dir, "")).toThrow("invalid lock name");
    await expect(acquireLock(dir, "a/b", { mode: "try" })).rejects.toThrow("invalid lock name");
    expect(isLockHeld(dir, "turn-01K0000000000000000000000")).toBe(false);
    expect(existsSync(locksDir(dir))).toBe(false);
  });
});

describe("wait modes", () => {
  test("try: null at once while held, a handle when free; withLock throws LockBusyError", async () => {
    const dir = tempDir();
    const h = (await acquireLock(dir, "k", { mode: "try" }))!;
    expect(h).not.toBeNull();
    const t0 = Date.now();
    expect(await acquireLock(dir, "k", { mode: "try" })).toBeNull();
    expect(Date.now() - t0).toBeLessThan(500);
    let ran = false;
    const err = await withLock(dir, "k", { mode: "try" }, async () => {
      ran = true;
    }).catch((e) => e);
    expect(err).toBeInstanceOf(LockBusyError);
    expect((err as LockBusyError).lock).toBe("k");
    expect(ran).toBe(false);
    h.release();
    const again = await acquireLock(dir, "k", { mode: "try" });
    expect(again).not.toBeNull();
    again!.release();
  });

  test("bounded: gives up at its deadline while held; acquires when released within the bound", async () => {
    const dir = tempDir();
    const h = (await acquireLock(dir, "turn-s1", { mode: "try" }))!;
    const t0 = Date.now();
    expect(await acquireLock(dir, "turn-s1", { mode: "bounded", timeoutMs: 300 })).toBeNull();
    const waited = Date.now() - t0;
    expect(waited).toBeGreaterThanOrEqual(300);
    expect(waited).toBeLessThan(3000);

    setTimeout(() => h.release(), 150);
    const t1 = Date.now();
    const got = await acquireLock(dir, "turn-s1", { mode: "bounded", timeoutMs: 5000 });
    expect(got).not.toBeNull();
    expect(Date.now() - t1).toBeGreaterThanOrEqual(100);
    got!.release();
  });

  test("not re-entrant within one process: a nested acquisition does not acquire", async () => {
    const dir = tempDir();
    const outer = await withRepoWorktreeLock(dir, async () => {
      expect(await acquireLock(dir, WORKTREE_LOCK, { mode: "bounded", timeoutMs: 200 })).toBeNull();
      await expect(withLock(dir, WORKTREE_LOCK, { mode: "try" }, async () => "inner")).rejects.toBeInstanceOf(LockBusyError);
      return "outer";
    });
    expect(outer).toBe("outer");
    expect(isLockHeld(dir, WORKTREE_LOCK)).toBe(false);
  });

  test("the event loop stays responsive while a waiter waits, in each mode", async () => {
    const dir = tempDir();
    const countTicks = () => {
      let ticks = 0;
      const iv = setInterval(() => ticks++, 10);
      return () => {
        clearInterval(iv);
        return ticks;
      };
    };

    // blocking: the in-process holder is released by a timer, which can only fire if the waiter yields.
    let holder = (await acquireLock(dir, WORKTREE_LOCK, { mode: "try" }))!;
    let stop = countTicks();
    setTimeout(() => holder.release(), 400);
    let t0 = Date.now();
    const blocking = await acquireLock(dir, WORKTREE_LOCK, { mode: "blocking" });
    let waited = Date.now() - t0;
    let ticks = stop();
    expect(waited).toBeGreaterThanOrEqual(350);
    expect(ticks).toBeGreaterThanOrEqual(10);
    blocking.release();

    // bounded: the waiter gives up at its deadline, and timers kept firing meanwhile.
    holder = (await acquireLock(dir, WORKTREE_LOCK, { mode: "try" }))!;
    stop = countTicks();
    t0 = Date.now();
    expect(await acquireLock(dir, WORKTREE_LOCK, { mode: "bounded", timeoutMs: 400 })).toBeNull();
    waited = Date.now() - t0;
    ticks = stop();
    expect(waited).toBeGreaterThanOrEqual(400);
    expect(ticks).toBeGreaterThanOrEqual(10);

    // try: returns without waiting.
    t0 = Date.now();
    expect(await acquireLock(dir, WORKTREE_LOCK, { mode: "try" })).toBeNull();
    expect(Date.now() - t0).toBeLessThan(200);
    holder.release();
  });

  test("many in-process contenders run strictly one at a time", async () => {
    const dir = tempDir(); // every contender also races to create the missing lock file
    let inside = 0;
    let maxInside = 0;
    const jobs = Array.from({ length: 6 }, (_, i) =>
      withRepoWorktreeLock(dir, async () => {
        inside += 1;
        maxInside = Math.max(maxInside, inside);
        await sleep(15);
        inside -= 1;
        return i;
      }),
    );
    expect((await Promise.all(jobs)).sort()).toEqual([0, 1, 2, 3, 4, 5]);
    expect(maxInside).toBe(1);
    expect(readdirSync(locksDir(dir))).toEqual(["worktree.sqlite"]);
  });
});

describe("held locks survive garbage collection", () => {
  test("withLock shape: held across awaits under Bun.gc(true)", async () => {
    const dir = tempDir();
    let leaks = 0;
    await withRepoWorktreeLock(dir, async () => {
      for (let i = 0; i < 20; i++) {
        Bun.gc(true);
        if (!isLockHeld(dir, WORKTREE_LOCK)) leaks++;
        await sleep(10);
      }
    });
    expect(leaks).toBe(0);
    expect(isLockHeld(dir, WORKTREE_LOCK)).toBe(false);
  });

  test("a handle the caller dropped stays held until released", async () => {
    const dir = tempDir();
    let ref!: WeakRef<LockHandle>;
    await (async () => {
      ref = new WeakRef((await acquireLock(dir, "dropped", { mode: "try" }))!);
    })();
    let leaks = 0;
    for (let i = 0; i < 20; i++) {
      Bun.gc(true);
      await sleep(10);
      if (!isLockHeld(dir, "dropped")) leaks++;
    }
    expect(leaks).toBe(0);
    const h = ref.deref();
    expect(h?.held).toBe(true);
    h!.release();
    expect(isLockHeld(dir, "dropped")).toBe(false);
  });
});

describe("cross-process", () => {
  test(
    "waits for a child process that holds the lock",
    async () => {
      const dir = tempDir();
      const child = spawnChild(`
        const { withRepoWorktreeLock, setLockHolderKind } = await import(${JSON.stringify(LOCK_MODULE)});
        setLockHolderKind("test-child");
        await withRepoWorktreeLock(${JSON.stringify(dir)}, async () => {
          console.log("HELD");
          await new Promise((r) => setTimeout(r, 300));
        });
      `);
      await child.waitFor("HELD");
      expect(isLockHeld(dir, WORKTREE_LOCK)).toBe(true);
      expect(readLockHolder(dir, WORKTREE_LOCK)).toMatchObject({ kind: "test-child", pid: child.proc.pid });
      const t0 = Date.now();
      const v = await withRepoWorktreeLock(dir, async () => "parent");
      expect(v).toBe("parent");
      expect(Date.now() - t0).toBeGreaterThanOrEqual(150);
      expect(await child.proc.exited).toBe(0);
      expect(readLockHolder(dir, WORKTREE_LOCK)).toBeNull();
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    "the holder is SIGKILLed, and a waiter acquires",
    async () => {
      const dir = tempDir();
      const file = lockFilePath(dir, WORKTREE_LOCK);
      const holder = spawnChild(holderScript(dir));
      await holder.waitFor("HELD");
      expect(readLockHolder(dir, WORKTREE_LOCK)).toMatchObject({ kind: "test-holder", pid: holder.proc.pid });

      // Held through continuous forced GC in the holder; a live holder is never evicted.
      let leaks = 0;
      for (let i = 0; i < 10; i++) {
        if (!isLockHeld(dir, WORKTREE_LOCK)) leaks++;
        await sleep(50);
      }
      expect(leaks).toBe(0);

      let acquired = false;
      const waiting = acquireLock(dir, WORKTREE_LOCK, { mode: "blocking" }).then((h) => {
        acquired = true;
        return h;
      });
      await sleep(300);
      expect(acquired).toBe(false);

      holder.proc.kill("SIGKILL");
      await holder.proc.exited;
      const t0 = Date.now();
      const h = await waiting;
      expect(Date.now() - t0).toBeLessThan(2000);
      expect(existsSync(`${file}-journal`)).toBe(false);
      // The dead holder's side file is overwritten by the new holder.
      expect(readLockHolder(dir, WORKTREE_LOCK)?.pid).toBe(process.pid);
      h.release();
      expect(readdirSync(locksDir(dir))).toEqual(["worktree.sqlite"]);
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    "design §5.2 test 3: a holder SIGKILLed while two waiters contend; never two in the critical section, both run",
    async () => {
      const dir = tempDir();
      const marker = join(dir, "in-critical-section");
      const holder = spawnChild(holderScript(dir));
      await holder.waitFor("HELD");

      const waiterScript = `
        const { withRepoWorktreeLock } = await import(${JSON.stringify(LOCK_MODULE)});
        const { openSync, closeSync, unlinkSync } = await import("node:fs");
        const marker = ${JSON.stringify(marker)};
        console.log("WAITING");
        await withRepoWorktreeLock(${JSON.stringify(dir)}, async () => {
          const start = Date.now();
          let v = 0;
          try { closeSync(openSync(marker, "wx")); } catch { v = 1; }
          await Bun.sleep(300);
          try { unlinkSync(marker); } catch {}
          console.log("DONE " + v + " " + start + " " + Date.now());
        });
      `;
      const waiters = [spawnChild(waiterScript), spawnChild(waiterScript)];
      for (const w of waiters) await w.waitFor("WAITING");
      await sleep(700);
      expect(existsSync(marker)).toBe(false);
      expect(waiters.every((w) => w.proc.exitCode === null)).toBe(true);

      holder.proc.kill("SIGKILL");
      await holder.proc.exited;
      const outs = await Promise.all(waiters.map((w) => w.output()));
      expect(await Promise.all(waiters.map((w) => w.proc.exited))).toEqual([0, 0]);
      const runs = outs.map((o) => {
        const m = o.match(/DONE (\d) (\d+) (\d+)/);
        expect(m).not.toBeNull();
        return { violation: Number(m![1]), start: Number(m![2]), end: Number(m![3]) };
      });
      expect(runs.map((r) => r.violation)).toEqual([0, 0]);
      const [first, second] = runs.sort((a, b) => a.start - b.start);
      expect(second!.start).toBeGreaterThanOrEqual(first!.end);
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    "two processes create the same missing lock files at once: one initialized file each, and they exclude each other",
    async () => {
      const dir = tempDir();
      const go = join(dir, "go");
      const marker = join(dir, "in-critical-section");
      const NAMES = 20;
      const script = `
        const { acquireLock } = await import(${JSON.stringify(LOCK_MODULE)});
        const { existsSync, openSync, closeSync, unlinkSync } = await import("node:fs");
        const dir = ${JSON.stringify(dir)};
        console.log("READY");
        while (!existsSync(${JSON.stringify(go)})) {}
        // Both processes reach each missing lock file's init path at about the same time.
        for (let i = 0; i < ${NAMES}; i++) (await acquireLock(dir, "race-" + i, { mode: "try" }))?.release();
        let v = 0;
        for (let i = 0; i < 5; i++) {
          const h = await acquireLock(dir, "race-0", { mode: "blocking" });
          try { closeSync(openSync(${JSON.stringify(marker)}, "wx")); } catch { v++; }
          await Bun.sleep(20);
          try { unlinkSync(${JSON.stringify(marker)}); } catch {}
          h.release();
        }
        console.log("VIOLATIONS " + v);
      `;
      const racers = [spawnChild(script), spawnChild(script)];
      for (const r of racers) await r.waitFor("READY");
      await Bun.write(go, "");
      const outs = await Promise.all(racers.map((r) => r.output()));
      expect(await Promise.all(racers.map((r) => r.proc.exited))).toEqual([0, 0]);
      expect(outs.map((o) => o.match(/VIOLATIONS (\d+)/)?.[1])).toEqual(["0", "0"]);

      const expected = Array.from({ length: NAMES }, (_, i) => `race-${i}.sqlite`).sort();
      expect(readdirSync(locksDir(dir)).sort()).toEqual(expected); // no temp, journal or side files left
      for (let i = 0; i < NAMES; i++) expect(userVersion(lockFilePath(dir, `race-${i}`))).toBe(1);
    },
    SPAWN_TIMEOUT_MS,
  );
});

describe("brain doctor: worktree lock", () => {
  test("free / held / held for a long time by a live holder", async () => {
    const dir = tempDir();
    expect(worktreeLockCheck(dir)).toEqual({ name: "worktree lock", status: "ok", detail: "free", required: false });

    const h = await acquireLock(dir, WORKTREE_LOCK, { mode: "blocking" }, { holderKind: "watch" });
    const now = Date.now();
    const recent = worktreeLockCheck(dir, now);
    expect(recent.status).toBe("ok");
    expect(recent.detail).toMatch(new RegExp(`^held by watch \\(pid ${process.pid}\\) for \\d+s$`));

    const long = worktreeLockCheck(dir, now + LONG_HELD_LOCK_MS + 60_000);
    expect(long.status).toBe("warn");
    expect(long.required).toBe(false);
    expect(long.detail).toMatch(new RegExp(`^held by watch \\(pid ${process.pid}\\) for 11m \\d+s; `));
    expect(long.detail).toContain("stop that process if it is hung");

    h.release();
    expect(worktreeLockCheck(dir).detail).toBe("free");
  });

  test("runDoctor reports the repo's worktree lock", async () => {
    const bh = withBrainHome();
    const repo = makeTempKnowledgeRepo();
    try {
      const report = await runDoctor({ offline: true, repoRoot: repo.path, gitVersion: () => "git version 2.45.0", env: {} });
      expect(report.checks.find((c) => c.name === "worktree lock")).toEqual({ name: "worktree lock", status: "ok", detail: "free", required: false });
    } finally {
      repo.cleanup();
      bh.cleanup();
    }
  });
});
