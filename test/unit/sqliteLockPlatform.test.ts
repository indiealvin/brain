// Platform facts about bun:sqlite that docs/mac-app/design.md §5.2 (the CR-1
// lock) and §5.3 item 4 (data_version polling) rely on. This is the port of the
// former scripts/spikes/sqlite-lock-spike.ts; the check names (A1 … H4) are kept
// so that design and plan citations such as "spike C3c" still resolve.
//
// It exercises bun:sqlite directly, not the lock primitive in src/sync/lock.ts.
// It runs on the Linux and macOS CI jobs and logs which SQLite library
// bun:sqlite uses, so the CI log records it.
//
// - A8 and C3c are informational: their outcome is logged, never asserted.
// - B1, B2, F1, G0 and G1 use a synchronous busy_timeout. They are platform
//   facts only; the implementation must wait asynchronously (H1–H4).
// - Timing bounds are generous so a slow runner does not flake. Lower bounds
//   are kept only where they mean "really waited".
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { closeSync, existsSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TIMEOUT = 30_000;
const BUN = process.execPath;
const TAG = "[sqliteLockPlatform]";

let dir = "";
let lockFile = "";
let script: Record<"holder" | "spiller" | "worker" | "waiter" | "asyncWorker" | "identify", string>;

const spawnPiped = (cmd: string[]) => Bun.spawn(cmd, { stdout: "pipe", stderr: "inherit" });
type Child = ReturnType<typeof spawnPiped>;
const children: Child[] = [];
const strayPids = new Set<number>();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function open(file: string, busyMs: number): Database {
  const db = new Database(file, { create: true });
  db.exec(`PRAGMA busy_timeout = ${busyMs}`);
  return db;
}

/** Try BEGIN IMMEDIATE; return "ok" or the error code. */
function tryBegin(db: Database): string {
  try {
    db.exec("BEGIN IMMEDIATE");
    return "ok";
  } catch (e) {
    const code = (e as { code?: unknown } | null)?.code;
    return String(code ?? (e instanceof Error ? e.message : e));
  }
}

function release(db: Database): void {
  if (db.inTransaction) db.exec("ROLLBACK");
}

/** Initialize a lock file once, as the lock primitive must (design §5.2). */
function initLockFile(file: string): void {
  const init = new Database(file, { create: true });
  init.exec("PRAGMA user_version = 1");
  init.close();
}

/** Every helper process goes through here so afterAll can kill it. */
function spawnChild(cmd: string[]): Child {
  const proc = spawnPiped(cmd);
  children.push(proc);
  return proc;
}

async function killHard(proc: Child): Promise<void> {
  try {
    proc.kill("SIGKILL");
  } catch {}
  await proc.exited;
}

function killStray(pid: number | undefined): void {
  if (pid === undefined || !strayPids.has(pid)) return;
  strayPids.delete(pid);
  try {
    process.kill(pid, "SIGKILL");
  } catch {}
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readUntil(stream: ReadableStream<Uint8Array>, marker: string): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    while (!buf.includes(marker)) {
      const { value, done } = await reader.read();
      if (done) throw new Error(`child exited before printing ${marker}: ${JSON.stringify(buf)}`);
      buf += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
  return buf;
}

/** Start a child that holds BEGIN IMMEDIATE on the lock file; resolves once it printed HELD. */
async function startHolder(mode = ""): Promise<{ proc: Child; held: boolean; sleeperPid?: number }> {
  const proc = spawnChild([BUN, script.holder, lockFile, mode]);
  const out = await readUntil(proc.stdout, "HELD");
  const pid = out.match(/SLEEPER (\d+)/)?.[1];
  const sleeperPid = pid === undefined ? undefined : Number(pid);
  if (sleeperPid !== undefined) strayPids.add(sleeperPid);
  // The holder prints HELD only after its BEGIN IMMEDIATE returned.
  return { proc, held: out.includes("HELD"), sleeperPid };
}

/** Kill `pid` with SIGKILL after `seconds`, from a separate process (works while this one blocks). */
function killLater(pid: number, seconds: number): Child {
  return spawnChild(["sh", "-c", `sleep ${seconds}; kill -9 ${pid}`]);
}

async function collectStdout(procs: Child[]): Promise<{ outs: string[]; codes: number[] }> {
  const outs = await Promise.all(procs.map(async (p) => (await new Response(p.stdout).text()).trim()));
  const codes = await Promise.all(procs.map((p) => p.exited));
  return { outs, codes };
}

function sumViolations(outs: string[]): number {
  return outs.map((o) => Number(o.match(/VIOLATIONS (\d+)/)?.[1] ?? NaN)).reduce((a, b) => a + b, 0);
}

/** Run a scenario once; every test that asserts on it awaits the same result. */
function once<T>(fn: () => Promise<T> | T): () => Promise<T> {
  let p: Promise<T> | undefined;
  return () => (p ??= Promise.resolve().then(fn));
}

function info(line: string): void {
  console.log(`${TAG} ${line}`);
}

// ---------------------------------------------------------------------------
// Helper process sources (written under the temp dir, never under cwd)
// ---------------------------------------------------------------------------

const HOLDER = `
import { Database } from "bun:sqlite";
import { spawn } from "node:child_process";
const [file, mode] = process.argv.slice(2);
const db = new Database(file, { create: true });
db.exec("PRAGMA busy_timeout = 0");
db.exec("BEGIN IMMEDIATE");
if (mode === "spawn-sleeper") {
  // Spawn a long-lived child, like a git subprocess would be. (Whether it inherits the lock fd is not observed here.)
  const c = spawn("sleep", ["30"], { stdio: "inherit", detached: true });
  console.log("SLEEPER " + c.pid);
}
(globalThis as any).__lock = db; // strong reference: an unreachable Database is GC'd and its lock released
console.log("HELD");
setInterval(() => Bun.gc(true), 50); // force GC continuously to prove the strong reference is enough
`;

const SPILLER = `
import { Database } from "bun:sqlite";
const db = new Database(process.argv[2], { create: true });
db.exec("PRAGMA cache_size = 2"); // force dirty pages to spill into the db file mid-transaction
db.exec("CREATE TABLE IF NOT EXISTS w (x TEXT)");
db.exec("INSERT INTO w VALUES ('base')");
db.exec("BEGIN IMMEDIATE");
for (let i = 0; i < 2000; i++) db.exec("INSERT INTO w VALUES ('" + "y".repeat(200) + "')");
(globalThis as any).__db = db;
console.log("HELD");
setInterval(() => {}, 1000);
`;

// Synchronous busy_timeout (platform fact only). 20 s is generous for slow runners.
const WORKER = `
import { Database } from "bun:sqlite";
import { openSync, closeSync, unlinkSync } from "node:fs";
const [file, marker, n] = process.argv.slice(2);
const db = new Database(file); db.exec("PRAGMA busy_timeout = 20000");
let violations = 0;
for (let i = 0; i < Number(n); i++) {
  db.exec("BEGIN IMMEDIATE");
  try { closeSync(openSync(marker, "wx")); } catch { violations++; }
  const until = Date.now() + 2; while (Date.now() < until) {}
  try { unlinkSync(marker); } catch {}
  db.exec("ROLLBACK");
}
console.log("VIOLATIONS " + violations);
`;

const WAITER = `
import { Database } from "bun:sqlite";
import { openSync, closeSync, unlinkSync } from "node:fs";
const [file, marker] = process.argv.slice(2);
const db = new Database(file); db.exec("PRAGMA busy_timeout = 20000");
db.exec("BEGIN IMMEDIATE");
let v = 0; try { closeSync(openSync(marker, "wx")); } catch { v = 1; }
const until = Date.now() + 300; while (Date.now() < until) {}
try { unlinkSync(marker); } catch {}
db.exec("ROLLBACK");
console.log("DONE " + v + " " + Date.now());
`;

// The shape the implementation must use (design §5.2): busy_timeout = 0, async retries on SQLITE_BUSY only.
const ASYNC_WORKER = `
import { Database } from "bun:sqlite";
import { openSync, closeSync, unlinkSync } from "node:fs";
const [file, marker, n] = process.argv.slice(2);
const db = new Database(file); db.exec("PRAGMA busy_timeout = 0");
let v = 0;
for (let i = 0; i < Number(n); i++) {
  let backoff = 1;
  for (;;) { try { db.exec("BEGIN IMMEDIATE"); break; } catch (e: any) { if (e?.code !== "SQLITE_BUSY") throw e; await Bun.sleep(backoff); backoff = Math.min(20, backoff * 2); } }
  try { closeSync(openSync(marker, "wx")); } catch { v++; }
  await Bun.sleep(1);
  try { unlinkSync(marker); } catch {}
  db.exec("ROLLBACK");
}
console.log("VIOLATIONS " + v);
`;

// Which SQLite does bun:sqlite use? Runs in a fresh process so nothing extra is
// loaded into the test process. Linux: is a libsqlite3 shared object mapped?
// macOS: does bun:sqlite report the same version and source id as
// /usr/lib/libsqlite3.dylib (the system library, loaded through bun:ffi)?
// The SQLITE line is written (synchronously) before the identification runs,
// so even a crash in it leaves the version on record.
const IDENTIFY = `
import { Database } from "bun:sqlite";
import { readFileSync, writeSync } from "node:fs";
const db = new Database(":memory:");
const row = db.query("select sqlite_version() as version, sqlite_source_id() as sourceId").get() as { version: string; sourceId: string };
const compileOptions = (db.query("PRAGMA compile_options").all() as { compile_options: string }[]).map((r) => r.compile_options);
writeSync(1, "SQLITE " + JSON.stringify({ ...row, compileOptions }) + "\\n");
let library = "unknown";
let evidence = "";
try {
  if (process.platform === "linux") {
    const mapped = [...new Set(readFileSync("/proc/self/maps", "utf8").split("\\n").map((l) => l.trim().split(/\\s+/)[5] ?? "").filter((p) => /libsqlite3/.test(p)))];
    library = mapped.length > 0 ? "system" : "bundled";
    evidence = mapped.length > 0 ? "mapped: " + mapped.join(", ") : "no libsqlite3 shared object mapped (statically linked into bun)";
  } else if (process.platform === "darwin") {
    const { dlopen, FFIType } = await import("bun:ffi");
    const sys = dlopen("/usr/lib/libsqlite3.dylib", {
      sqlite3_libversion: { args: [], returns: FFIType.cstring },
      sqlite3_sourceid: { args: [], returns: FFIType.cstring },
    });
    const sysVersion = String(sys.symbols.sqlite3_libversion());
    const sysSourceId = String(sys.symbols.sqlite3_sourceid());
    sys.close();
    const same = sysVersion === row.version && sysSourceId === row.sourceId;
    library = same ? "system" : "bundled";
    evidence = "/usr/lib/libsqlite3.dylib is " + sysVersion + " (" + sysSourceId + ")" + (same ? ", identical to bun:sqlite" : ", differs from bun:sqlite");
  } else {
    evidence = "no identification method for " + process.platform;
  }
} catch (e) {
  library = "unknown";
  evidence = "identification failed: " + String(e);
}
writeSync(1, "LIBRARY " + JSON.stringify({ library, evidence }) + "\\n");
`;

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("bun:sqlite platform lock assumptions (design §5.2)", () => {
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "brain-sqlite-lock-"));
    lockFile = join(dir, "worktree.sqlite");
    // On an empty (0-byte) file every BEGIN IMMEDIATE initializes page 1, which
    // is a write and creates a rollback journal (C3c), so initialize it once.
    initLockFile(lockFile);
    const write = (name: string, src: string) => {
      const p = join(dir, name);
      writeFileSync(p, src);
      return p;
    };
    script = {
      holder: write("holder.ts", HOLDER),
      spiller: write("spiller.ts", SPILLER),
      worker: write("worker.ts", WORKER),
      waiter: write("waiter.ts", WAITER),
      asyncWorker: write("async-worker.ts", ASYNC_WORKER),
      identify: write("identify.ts", IDENTIFY),
    };
  });

  afterAll(async () => {
    for (const p of children) {
      try {
        p.kill("SIGKILL");
      } catch {}
    }
    await Promise.all(children.map((p) => p.exited.catch(() => undefined)));
    for (const pid of [...strayPids]) killStray(pid);
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  test(
    "platform: record which SQLite library bun:sqlite uses",
    async () => {
      const proc = spawnChild([BUN, script.identify]);
      const { outs, codes } = await collectStdout([proc]);
      const lines = (outs[0] ?? "").split("\n");
      const field = (tag: string) => {
        const line = lines.find((l) => l.startsWith(tag + " "));
        return line === undefined ? undefined : JSON.parse(line.slice(tag.length + 1));
      };
      const id = field("SQLITE") as { version: string; sourceId: string; compileOptions: string[] } | undefined;
      const lib = (field("LIBRARY") as { library: string; evidence: string } | undefined) ?? {
        library: "unknown",
        evidence: `identification process exited with code ${codes[0]} before reporting`,
      };
      expect(id).toBeDefined();
      if (!id) return;
      info(`bun ${Bun.version}; ${process.platform}/${process.arch}; sqlite ${id.version}; source_id ${id.sourceId}`);
      info(`bun:sqlite library: ${lib.library} — ${lib.evidence}`);
      info(`compile_options: ${id.compileOptions.join(" ")}`);
      // The record is about the library the checks below run against.
      const here = new Database(":memory:");
      const mine = here.query("select sqlite_version() as version, sqlite_source_id() as sourceId").get() as {
        version: string;
        sourceId: string;
      };
      here.close();
      expect(id.version).toBe(mine.version);
      expect(id.sourceId).toBe(mine.sourceId);
    },
    TIMEOUT,
  );

  // -------------------------------------------------------------------------
  describe("A same process", () => {
    // A1–A5: two connections in one process, busy_timeout 0.
    const sameProcess = once(() => {
      const a = open(lockFile, 0);
      const b = open(lockFile, 0);
      try {
        const ra = tryBegin(a);
        const t0 = performance.now();
        const rb = tryBegin(b);
        const dt = performance.now() - t0;
        release(a);
        const rb2 = tryBegin(b);
        release(b);
        // A5: opening and closing a third connection, or a raw fd on the same
        // file, must not drop the first one's lock (the POSIX close() pitfall).
        const ra3 = tryBegin(a);
        open(lockFile, 0).close();
        closeSync(openSync(lockFile, "r"));
        const rb3 = tryBegin(b);
        release(b);
        release(a);
        return { ra, rb, dt, rb2, ra3, rb3 };
      } finally {
        a.close();
        b.close();
      }
    });

    test(
      "A1 first BEGIN IMMEDIATE acquires",
      async () => {
        expect((await sameProcess()).ra).toBe("ok");
      },
      TIMEOUT,
    );
    test(
      "A2 second connection gets SQLITE_BUSY",
      async () => {
        expect((await sameProcess()).rb).toBe("SQLITE_BUSY");
      },
      TIMEOUT,
    );
    test(
      "A3 busy_timeout 0 returns without waiting",
      async () => {
        expect((await sameProcess()).dt).toBeLessThan(500);
      },
      TIMEOUT,
    );
    test(
      "A4 acquires after the holder releases",
      async () => {
        expect((await sameProcess()).rb2).toBe("ok");
      },
      TIMEOUT,
    );
    test(
      "A5 closing another connection or a raw fd on the file keeps the lock",
      async () => {
        const r = await sameProcess();
        expect(r.ra3).toBe("ok");
        expect(r.rb3).toBe("SQLITE_BUSY");
      },
      TIMEOUT,
    );

    test(
      "A6 lock survives across awaits in the holder",
      async () => {
        const a = open(lockFile, 0);
        const b = open(lockFile, 0);
        try {
          const ra = tryBegin(a);
          await Bun.sleep(200);
          const rb = tryBegin(b);
          expect(ra).toBe("ok");
          expect(rb).toBe("SQLITE_BUSY");
        } finally {
          release(b);
          release(a);
          a.close();
          b.close();
        }
      },
      TIMEOUT,
    );

    test(
      "A7 withLock shape: held across awaits with forced GC",
      async () => {
        async function withLock<T>(fn: () => Promise<T>): Promise<T> {
          const db = open(lockFile, 0);
          if (tryBegin(db) !== "ok") {
            db.close();
            throw new Error("could not lock");
          }
          try {
            return await fn();
          } finally {
            db.exec("ROLLBACK");
            db.close();
          }
        }
        const probe = open(lockFile, 0);
        let leaks = 0;
        try {
          await withLock(async () => {
            for (let i = 0; i < 20; i++) {
              Bun.gc(true);
              if (tryBegin(probe) === "ok") {
                leaks++;
                probe.exec("ROLLBACK");
              }
              await Bun.sleep(20);
            }
          });
        } finally {
          probe.close();
        }
        expect(leaks).toBe(0);
      },
      TIMEOUT,
    );

    // A8a/A8 use their own lock file, so an orphan that is never collected
    // cannot contaminate checks B–H.
    const orphan = once(async () => {
      const orphanFile = join(dir, "orphan.sqlite");
      initLockFile(orphanFile);
      const oprobe = open(orphanFile, 0);
      try {
        let orphanGot = "";
        (() => {
          const orphanDb = open(orphanFile, 0);
          orphanGot = tryBegin(orphanDb);
        })(); // no reference kept
        const heldBeforeGc = tryBegin(oprobe) === "SQLITE_BUSY";
        release(oprobe);
        let freed = false;
        for (let i = 0; i < 20 && !freed; i++) {
          Bun.gc(true);
          await Bun.sleep(20);
          if (tryBegin(oprobe) === "ok") {
            freed = true;
            oprobe.exec("ROLLBACK");
          }
        }
        return { orphanGot, heldBeforeGc, freed };
      } finally {
        oprobe.close();
      }
    });

    test(
      "A8a (setup) the orphan acquired and the probe is BUSY before GC",
      async () => {
        const r = await orphan();
        expect(r.orphanGot).toBe("ok");
        expect(r.heldBeforeGc).toBe(true);
      },
      TIMEOUT,
    );
    test(
      "A8 (informational) an unreachable lock connection is GC'd and its lock released",
      async () => {
        const r = await orphan();
        info(
          `A8 (informational): ${
            r.freed
              ? "released by GC — lock handles must stay strongly reachable"
              : "not released here (safer; A7 is the guarantee)"
          }`,
        );
      },
      TIMEOUT,
    );
  });

  // -------------------------------------------------------------------------
  describe("B bounded synchronous wait (platform fact only)", () => {
    test(
      "B1 busy_timeout 1000: BUSY after ~1 s while held",
      () => {
        const a = open(lockFile, 0);
        const b = open(lockFile, 1000);
        try {
          const ra = tryBegin(a);
          const t0 = performance.now();
          const rb = tryBegin(b);
          const dt = performance.now() - t0;
          expect(ra).toBe("ok");
          expect(rb).toBe("SQLITE_BUSY");
          expect(dt).toBeGreaterThanOrEqual(900); // really waited for the timeout
          expect(dt).toBeLessThan(5000);
        } finally {
          release(b);
          release(a);
          a.close();
          b.close();
        }
      },
      TIMEOUT,
    );

    test(
      "B2 acquires when the holder goes away within the bound",
      async () => {
        // Released by another *process*: b's busy handler blocks this event loop,
        // so the kill comes from a helper process.
        const holder = await startHolder();
        const b = open(lockFile, 5000);
        try {
          const t0 = performance.now();
          const killer = killLater(holder.proc.pid, 0.3);
          const rb = tryBegin(b);
          const dt = performance.now() - t0;
          await killer.exited;
          expect(rb).toBe("ok");
          expect(dt).toBeGreaterThanOrEqual(250); // really waited for the holder
        } finally {
          release(b);
          b.close();
          await killHard(holder.proc);
        }
      },
      TIMEOUT,
    );
  });

  // -------------------------------------------------------------------------
  describe("C cross-process", () => {
    const crossProcess = once(async () => {
      const holder = await startHolder();
      const b = open(lockFile, 0);
      try {
        let leaks = 0;
        for (let i = 0; i < 30; i++) {
          if (tryBegin(b) === "ok") {
            leaks++;
            b.exec("ROLLBACK");
          }
          await Bun.sleep(50);
        }
        const rb = tryBegin(b);
        release(b);
        holder.proc.kill("SIGKILL");
        await holder.proc.exited;
        const rb2 = tryBegin(b);
        release(b);
        return { leaks, rb, rb2 };
      } finally {
        b.close();
        await killHard(holder.proc);
      }
    });

    test(
      "C0 still held after 1.5 s of forced GC in the holder",
      async () => {
        expect((await crossProcess()).leaks).toBe(0);
      },
      TIMEOUT,
    );
    test(
      "C1 parent gets SQLITE_BUSY while the child holds",
      async () => {
        expect((await crossProcess()).rb).toBe("SQLITE_BUSY");
      },
      TIMEOUT,
    );
    test(
      "C2 the kernel releases the lock when the holder is SIGKILLed",
      async () => {
        expect((await crossProcess()).rb2).toBe("ok");
      },
      TIMEOUT,
    );

    test(
      "C3a lock-style holder killed: no journal left, next acquisition clean",
      async () => {
        // An empty transaction on an initialized lock file writes nothing.
        const holder = await startHolder();
        await killHard(holder.proc);
        const journal = existsSync(lockFile + "-journal");
        const c = open(lockFile, 0);
        try {
          const rc = tryBegin(c);
          expect(journal).toBe(false);
          expect(rc).toBe("ok");
        } finally {
          release(c);
          c.close();
        }
      },
      TIMEOUT,
    );

    test(
      "C3c (informational) uninitialized lock file: BEGIN IMMEDIATE creates a journal",
      () => {
        const raw = join(dir, "uninitialized.sqlite");
        const u = open(raw, 0);
        try {
          tryBegin(u);
          const journal = existsSync(raw + "-journal");
          info(`C3c (informational): ${journal ? "journal created — initialize lock files once" : "no journal"}`);
        } finally {
          release(u);
          u.close();
        }
      },
      TIMEOUT,
    );

    test(
      "C3b hot journal from a killed writer: rolled back by the next BEGIN IMMEDIATE",
      async () => {
        // A writer killed after spilling dirty pages leaves a genuinely hot journal.
        const hotFile = join(dir, "hot.sqlite");
        const p = spawnChild([BUN, script.spiller, hotFile]);
        await readUntil(p.stdout, "HELD");
        await killHard(p);
        const j = hotFile + "-journal";
        const magic = existsSync(j) ? Buffer.from(await Bun.file(j).slice(0, 8).arrayBuffer()).toString("hex") : "";
        // Rollback-journal header magic, written only once pages reach the db file.
        const isHot = magic === "d9d505f920a163d7";
        const c = open(hotFile, 0);
        try {
          const rc = tryBegin(c);
          const gone = !existsSync(j);
          const rows = rc === "ok" ? (c.query("SELECT COUNT(*) AS n FROM w").get() as { n: number }).n : -1;
          release(c);
          const integrity = (c.query("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check;
          expect(isHot).toBe(true);
          expect(rc).toBe("ok");
          expect(gone).toBe(true);
          expect(rows).toBe(1);
          expect(integrity).toBe("ok");
        } finally {
          release(c);
          c.close();
        }
      },
      TIMEOUT,
    );
  });

  // -------------------------------------------------------------------------
  describe("D holder with a spawned child", () => {
    const spawnedChild = once(async () => {
      const holder = await startHolder("spawn-sleeper");
      const b = open(lockFile, 0);
      try {
        const rd = tryBegin(b);
        release(b);
        holder.proc.kill("SIGKILL");
        await holder.proc.exited;
        const sleeperAlive = holder.sleeperPid !== undefined && isAlive(holder.sleeperPid);
        const rb = tryBegin(b);
        release(b);
        return { held: holder.held, sleeperPid: holder.sleeperPid, rd, sleeperAlive, rb };
      } finally {
        b.close();
        await killHard(holder.proc);
        killStray(holder.sleeperPid);
      }
    });

    test(
      "D1 a holder that spawned a long-lived child holds the lock",
      async () => {
        const r = await spawnedChild();
        expect(r.held).toBe(true);
        expect(r.sleeperPid).toBeNumber();
        expect(r.rd).toBe("SQLITE_BUSY");
      },
      TIMEOUT,
    );
    test(
      "D2 lock released on holder death while the spawned child is still alive",
      async () => {
        const r = await spawnedChild();
        expect(r.sleeperAlive).toBe(true);
        expect(r.rb).toBe("ok");
      },
      TIMEOUT,
    );
  });

  // -------------------------------------------------------------------------
  describe("E data_version on a dedicated poll connection (WAL data DB)", () => {
    const dataVersion = once(() => {
      const dataFile = join(dir, "data.sqlite");
      const w1 = open(dataFile, 5000);
      w1.exec("PRAGMA journal_mode = WAL");
      w1.exec("CREATE TABLE IF NOT EXISTS t (x INTEGER)");
      const poll = open(dataFile, 5000);
      try {
        const dv = () => (poll.query("PRAGMA data_version").get() as { data_version: number }).data_version;
        const v0 = dv();
        const v0b = dv();
        w1.exec("INSERT INTO t VALUES (1)");
        const v1 = dv();
        const w2 = Bun.spawnSync([
          BUN,
          "-e",
          `import {Database} from "bun:sqlite"; const d=new Database(${JSON.stringify(dataFile)}); d.exec("PRAGMA busy_timeout=5000"); d.exec("INSERT INTO t VALUES (2)"); d.close();`,
        ]);
        const v2 = dv();
        poll.exec("INSERT INTO t VALUES (3)");
        const v3 = dv();
        return { v0, v0b, v1, v2, v3, w2Exit: w2.exitCode };
      } finally {
        w1.close();
        poll.close();
      }
    });

    test(
      "E1 data_version is stable with no writes",
      async () => {
        const r = await dataVersion();
        expect(r.v0b).toBe(r.v0);
      },
      TIMEOUT,
    );
    test(
      "E2 changes after a commit on another connection in the same process",
      async () => {
        const r = await dataVersion();
        expect(r.v1).not.toBe(r.v0);
      },
      TIMEOUT,
    );
    test(
      "E3 changes after a commit in another process",
      async () => {
        const r = await dataVersion();
        expect(r.w2Exit).toBe(0);
        expect(r.v2).not.toBe(r.v1);
      },
      TIMEOUT,
    );
    test(
      "E4 (expected) unchanged by the poll connection's own commit",
      async () => {
        const r = await dataVersion();
        expect(r.v3).toBe(r.v2);
      },
      TIMEOUT,
    );
  });

  // -------------------------------------------------------------------------
  describe("F mutual exclusion under cross-process contention (synchronous wait)", () => {
    test(
      "F1 4 processes × 150 acquisitions: never two in the critical section",
      async () => {
        const marker = join(dir, "in-cs-f");
        const procs = Array.from({ length: 4 }, () => spawnChild([BUN, script.worker, lockFile, marker, "150"]));
        const { outs, codes } = await collectStdout(procs);
        expect(codes).toEqual([0, 0, 0, 0]);
        expect(sumViolations(outs)).toBe(0);
      },
      TIMEOUT,
    );
  });

  // -------------------------------------------------------------------------
  describe("G holder SIGKILLed while two waiters contend (synchronous wait)", () => {
    const twoWaiters = once(async () => {
      const marker = join(dir, "in-cs-g");
      const holder = await startHolder();
      try {
        const waiters = [0, 1].map(() => spawnChild([BUN, script.waiter, lockFile, marker]));
        await Bun.sleep(1000);
        const markerBeforeKill = existsSync(marker);
        const waitersRunning = waiters.every((w) => w.exitCode === null);
        holder.proc.kill("SIGKILL");
        const { outs, codes } = await collectStdout(waiters);
        return { markerBeforeKill, waitersRunning, outs, codes };
      } finally {
        await killHard(holder.proc);
      }
    });

    test(
      "G0 waiters stay blocked while the holder lives (1 s, forced GC)",
      async () => {
        const r = await twoWaiters();
        expect(r.markerBeforeKill).toBe(false);
        expect(r.waitersRunning).toBe(true);
      },
      TIMEOUT,
    );
    test(
      "G1 both waiters run after the holder is SIGKILLed, never together",
      async () => {
        const r = await twoWaiters();
        expect(r.codes).toEqual([0, 0]);
        expect(r.outs.every((o) => o.startsWith("DONE "))).toBe(true);
        const violations = r.outs.reduce((a, o) => a + Number(o.split(" ")[1] ?? 1), 0);
        expect(violations).toBe(0);
      },
      TIMEOUT,
    );
  });

  // -------------------------------------------------------------------------
  describe("H async wait shape required by design §5.2 (busy_timeout 0 + async retries)", () => {
    async function acquireAsync(file: string, deadlineMs: number | null): Promise<Database | null> {
      const db = open(file, 0);
      const start = Date.now();
      let backoff = 5;
      for (;;) {
        if (tryBegin(db) === "ok") return db;
        if (deadlineMs !== null && Date.now() - start >= deadlineMs) {
          db.close();
          return null;
        }
        await Bun.sleep(backoff);
        backoff = Math.min(50, backoff * 2);
      }
    }

    const boundedWait = once(async () => {
      const holder = await startHolder();
      try {
        let ticks = 0;
        const timer = setInterval(() => ticks++, 10);
        const t0 = Date.now();
        const got = await acquireAsync(lockFile, 600);
        const waited = Date.now() - t0;
        clearInterval(timer);
        if (got) {
          release(got);
          got.close();
        }
        return { acquired: got !== null, waited, ticks };
      } finally {
        await killHard(holder.proc);
      }
    });

    test(
      "H1 bounded async wait gives up at its deadline",
      async () => {
        const r = await boundedWait();
        expect(r.acquired).toBe(false);
        expect(r.waited).toBeGreaterThanOrEqual(600); // honored the whole deadline
        expect(r.waited).toBeLessThan(3000);
      },
      TIMEOUT,
    );
    test(
      "H2 event loop keeps running while waiting",
      async () => {
        const r = await boundedWait();
        // ~60 ticks expected; a blocked loop would give ~0.
        expect(r.ticks).toBeGreaterThanOrEqual(10);
      },
      TIMEOUT,
    );

    test(
      "H3 unbounded async wait acquires after the holder dies",
      async () => {
        const holder = await startHolder();
        try {
          const killer = killLater(holder.proc.pid, 0.3);
          const t0 = Date.now();
          const got = await acquireAsync(lockFile, null);
          const elapsed = Date.now() - t0;
          if (got) {
            release(got);
            got.close();
          }
          await killer.exited;
          expect(got).not.toBeNull();
          expect(elapsed).toBeGreaterThanOrEqual(250); // really waited for the holder
        } finally {
          await killHard(holder.proc);
        }
      },
      TIMEOUT,
    );

    test(
      "H4 4 processes × 100 async acquisitions: never two in the critical section",
      async () => {
        const marker = join(dir, "in-cs-h");
        const procs = Array.from({ length: 4 }, () => spawnChild([BUN, script.asyncWorker, lockFile, marker, "100"]));
        const { outs, codes } = await collectStdout(procs);
        expect(codes).toEqual([0, 0, 0, 0]);
        expect(sumViolations(outs)).toBe(0);
      },
      TIMEOUT,
    );
  });
});
