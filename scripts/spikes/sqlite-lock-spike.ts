// Spike: verify the bun:sqlite lock and data_version assumptions in
// docs/mac-app/design.md §5.2 and §5.3 item 4.
//
// Run: bun scripts/spikes/sqlite-lock-spike.ts   (SPIKE_TMP=<dir> to choose the temp root)
// Exit code 0 when every check passes.
//
// Result 2026-09-29, Linux, Bun 1.4.2, SQLite 3.53.2: 30/30 pass. Check A8
// documents a hazard, not a guarantee: a lock connection that nothing
// references is garbage-collected and its lock released, so lock handles
// must stay strongly reachable. macOS is not yet verified. Task T0.1 of
// docs/mac-app/implementation-plan.md ports this script into
// test/unit/sqliteLockPlatform.test.ts and runs it on both CI runners.
import { Database } from "bun:sqlite";
import { mkdtempSync, existsSync, openSync, closeSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(process.env.SPIKE_TMP ?? tmpdir(), "lockspike-"));
const lockFile = join(dir, "worktree.sqlite");
const dataFile = join(dir, "data.sqlite");
// Initialize the lock file once, as the lock primitive must: on an empty (0-byte) file every
// BEGIN IMMEDIATE initializes page 1, which is a write and creates a rollback journal.
{
  const init = new Database(lockFile, { create: true });
  init.exec("PRAGMA user_version = 1");
  init.close();
}
const results: { name: string; ok: boolean; detail: string }[] = [];
const record = (name: string, ok: boolean, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
  } catch (e: any) {
    return String(e?.code ?? e?.message ?? e);
  }
}

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
const holderPath = join(dir, "holder.ts");
await Bun.write(holderPath, HOLDER);

async function startHolder(mode = ""): Promise<{ proc: ReturnType<typeof Bun.spawn>; sleeperPid?: number }> {
  const proc = Bun.spawn(["bun", holderPath, lockFile, mode], { stdout: "pipe", stderr: "inherit" });
  const reader = proc.stdout.getReader();
  let buf = "";
  let sleeperPid: number | undefined;
  while (!buf.includes("HELD")) {
    const { value, done } = await reader.read();
    if (done) throw new Error("holder exited early: " + buf);
    buf += new TextDecoder().decode(value);
  }
  const m = buf.match(/SLEEPER (\d+)/);
  if (m) sleeperPid = Number(m[1]);
  reader.releaseLock();
  return { proc, sleeperPid };
}

// A. Same process, two connections: second BEGIN IMMEDIATE with busy_timeout 0 → SQLITE_BUSY immediately.
{
  const a = open(lockFile, 0);
  const b = open(lockFile, 0);
  const ra = tryBegin(a);
  const t0 = performance.now();
  const rb = tryBegin(b);
  const dt = performance.now() - t0;
  record("A1 same-process: first BEGIN IMMEDIATE acquires", ra === "ok", ra);
  record("A2 same-process: second connection gets SQLITE_BUSY", rb === "SQLITE_BUSY", `${rb} in ${dt.toFixed(1)} ms`);
  record("A3 same-process: busy_timeout 0 returns without waiting", dt < 50, `${dt.toFixed(1)} ms`);
  a.exec("ROLLBACK");
  const rb2 = tryBegin(b);
  record("A4 same-process: acquires after holder releases", rb2 === "ok", rb2);
  b.exec("ROLLBACK");

  // A5. Opening and closing a third connection must not drop the first one's lock (POSIX close() pitfall).
  tryBegin(a);
  const c = open(lockFile, 0);
  c.close();
  const fd = openSync(lockFile, "r"); // a raw fd on the same file, then close it
  closeSync(fd);
  const rb3 = tryBegin(b);
  record("A5 same-process: closing another connection / raw fd keeps the lock", rb3 === "SQLITE_BUSY", rb3);
  a.exec("ROLLBACK");
  a.close();
  b.close();
}

// A6. Lock held across awaits (async work inside the critical section).
{
  const a = open(lockFile, 0);
  const b = open(lockFile, 0);
  const ra = tryBegin(a);
  await sleep(200);
  const rb = tryBegin(b);
  record("A6 lock survives across awaits in the holder", ra === "ok" && rb === "SQLITE_BUSY", `holder: ${ra}; probe: ${rb}`);
  a.exec("ROLLBACK");
  a.close();
  b.close();
}

// A7. In-process: a lock held by a withLock-shaped async function survives forced GC; an unreachable one does not.
{
  async function withLock<T>(fn: () => Promise<T>): Promise<T> {
    const db = open(lockFile, 0);
    if (tryBegin(db) !== "ok") throw new Error("could not lock");
    try { return await fn(); } finally { db.exec("ROLLBACK"); db.close(); }
  }
  const probe = open(lockFile, 0);
  let leaks = 0;
  await withLock(async () => {
    for (let i = 0; i < 20; i++) { Bun.gc(true); if (tryBegin(probe) === "ok") { leaks++; probe.exec("ROLLBACK"); } await sleep(20); }
  });
  record("A7 withLock shape: held across awaits with forced GC", leaks === 0, `acquired ${leaks}/20`);
  probe.close();
  // A8 uses its own lock file, so an orphan that is never collected cannot contaminate checks B–H.
  const orphanFile = join(dir, "orphan.sqlite");
  { const init = new Database(orphanFile, { create: true }); init.exec("PRAGMA user_version = 1"); init.close(); }
  const oprobe = open(orphanFile, 0);
  let orphanGot = "";
  (() => { const orphan = open(orphanFile, 0); orphanGot = tryBegin(orphan); })(); // no reference kept
  const heldBeforeGc = tryBegin(oprobe) === "SQLITE_BUSY";
  record("A8a (setup) the orphan acquired and the probe is BUSY before GC", orphanGot === "ok" && heldBeforeGc, `orphan: ${orphanGot}; busy before GC: ${heldBeforeGc}`);
  let freed = false;
  for (let i = 0; i < 20 && !freed; i++) { Bun.gc(true); await sleep(20); if (tryBegin(oprobe) === "ok") { freed = true; oprobe.exec("ROLLBACK"); } }
  record("A8 (hazard, informational) an unreachable lock connection is GC'd and its lock released", freed, freed ? "released by GC — lock handles must stay strongly reachable" : "not released on this platform (safer; A7 is the guarantee)");
  oprobe.close();
}

// B. Bounded wait: busy_timeout 1000 waits ~1 s then BUSY; released within the bound → acquires.
{
  const a = open(lockFile, 0);
  const b = open(lockFile, 1000);
  const ra = tryBegin(a);
  const t0 = performance.now();
  const rb = tryBegin(b);
  const dt = performance.now() - t0;
  record("B1 bounded wait: BUSY after ~1 s while held", ra === "ok" && rb === "SQLITE_BUSY" && dt >= 900 && dt < 2500, `holder: ${ra}; ${rb} after ${dt.toFixed(0)} ms`);
  a.exec("ROLLBACK");
  a.close();
  b.close();
}
{
  // Released within the bound, by another *process* (in-process release can't happen while b's busy handler blocks the event loop).
  const holder = await startHolder();
  const b = open(lockFile, 1500);
  const t0 = performance.now();
  // busy handler sleeps synchronously; the kill timer can't fire in this process, so kill from a helper instead.
  const killer = Bun.spawn(["sh", "-c", `sleep 0.3; kill -9 ${holder.proc.pid}`]);
  const rb = tryBegin(b);
  const dt = performance.now() - t0;
  record("B2 bounded wait: acquires when the holder goes away within the bound", rb === "ok" && dt >= 250 && dt < 1500, `${rb} after ${dt.toFixed(0)} ms (holder killed at ~300 ms)`);
  if (rb === "ok") b.exec("ROLLBACK");
  b.close();
  await killer.exited;
  await holder.proc.exited;
}

// C. Cross-process: child holds; parent gets BUSY; SIGKILL child → parent acquires.
{
  const holder = await startHolder();
  const b = open(lockFile, 0);
  let leaks = 0;
  for (let i = 0; i < 30; i++) { if (tryBegin(b) === "ok") { leaks++; b.exec("ROLLBACK"); } await sleep(50); }
  record("C0 cross-process: still held after 1.5 s of forced GC in the holder", leaks === 0, `acquired ${leaks}/30 probes`);
  const rb = tryBegin(b);
  record("C1 cross-process: parent gets SQLITE_BUSY while child holds", rb === "SQLITE_BUSY", rb);
  holder.proc.kill("SIGKILL");
  await holder.proc.exited;
  const rb2 = tryBegin(b);
  record("C2 cross-process: kernel releases the lock when the holder is SIGKILLed", rb2 === "ok", rb2);
  if (rb2 === "ok") b.exec("ROLLBACK");
  b.close();
}
// C3a: a lock-style holder (empty transaction on an initialized lock file) writes nothing and leaves no journal.
{
  const holder = await startHolder();
  holder.proc.kill("SIGKILL");
  await holder.proc.exited;
  const journal = existsSync(lockFile + "-journal");
  const c = open(lockFile, 0);
  const rc = tryBegin(c);
  record("C3a lock-style holder killed: no journal left, next acquisition clean", !journal && rc === "ok", `journal: ${journal}; ${rc}`);
  if (rc === "ok") c.exec("ROLLBACK");
  c.close();
}
// C3c (informational): on an uninitialized (0-byte) file, even an empty BEGIN IMMEDIATE creates a journal.
{
  const raw = join(dir, "uninitialized.sqlite");
  const u = open(raw, 0);
  tryBegin(u);
  const journal = existsSync(raw + "-journal");
  u.exec("ROLLBACK");
  u.close();
  record("C3c (informational) uninitialized lock file: BEGIN IMMEDIATE creates a journal", journal, journal ? "initialize lock files once" : "no journal");
}
// C3b: a writer killed after spilling dirty pages leaves a genuinely hot journal; the next BEGIN IMMEDIATE rolls it back.
{
  const hotFile = join(dir, "hot.sqlite");
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
  const spillerPath = join(dir, "spiller.ts");
  await Bun.write(spillerPath, SPILLER);
  const p = Bun.spawn(["bun", spillerPath, hotFile], { stdout: "pipe" });
  const reader = p.stdout.getReader();
  let buf = "";
  while (!buf.includes("HELD")) buf += new TextDecoder().decode((await reader.read()).value);
  p.kill("SIGKILL");
  await p.exited;
  const j = hotFile + "-journal";
  const magic = existsSync(j) ? Buffer.from(await Bun.file(j).slice(0, 8).arrayBuffer()).toString("hex") : "";
  const isHot = magic === "d9d505f920a163d7"; // rollback-journal header magic, written only once pages reach the db file
  const c = open(hotFile, 0);
  const rc = tryBegin(c);
  const gone = !existsSync(j);
  const rows = rc === "ok" ? (c.query("SELECT COUNT(*) AS n FROM w").get() as { n: number }).n : -1;
  if (rc === "ok") c.exec("ROLLBACK");
  const integrity = (c.query("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check;
  record("C3b hot journal from a killed writer: rolled back by the next BEGIN IMMEDIATE", isHot && rc === "ok" && gone && rows === 1 && integrity === "ok", `hot: ${isHot}; ${rc}; journal removed: ${gone}; rows: ${rows}; integrity: ${integrity}`);
  c.close();
}

// D. Spawned child: holder spawns a long-lived child (like git), then holder is SIGKILLed.
{
  const holder = await startHolder("spawn-sleeper");
  const b = open(lockFile, 0);
  const rd = tryBegin(b);
  record("D1 holder with spawned child holds the lock", rd === "SQLITE_BUSY", rd);
  holder.proc.kill("SIGKILL");
  await holder.proc.exited;
  let sleeperAlive = false;
  try {
    process.kill(holder.sleeperPid!, 0);
    sleeperAlive = true;
  } catch {}
  const rb = tryBegin(b);
  record("D2 lock released on holder death while a spawned child is still alive", rb === "ok" && sleeperAlive, `${rb}; sleeper alive: ${sleeperAlive}`);
  if (rb === "ok") b.exec("ROLLBACK");
  b.close();
  try {
    process.kill(holder.sleeperPid!, "SIGKILL");
  } catch {}
}

// E. data_version on a dedicated poll connection (WAL data DB, like queue/proposals/index).
{
  const w1 = open(dataFile, 5000);
  w1.exec("PRAGMA journal_mode = WAL");
  w1.exec("CREATE TABLE IF NOT EXISTS t (x INTEGER)");
  const poll = open(dataFile, 5000);
  const dv = () => (poll.query("PRAGMA data_version").get() as { data_version: number }).data_version;
  const v0 = dv();
  record("E1 data_version is stable with no writes", dv() === v0);
  w1.exec("INSERT INTO t VALUES (1)");
  const v1 = dv();
  record("E2 changes after a commit on another connection in the same process", v1 !== v0, `${v0} → ${v1}`);
  const w2 = Bun.spawnSync(["bun", "-e", `import {Database} from "bun:sqlite"; const d=new Database(${JSON.stringify(dataFile)}); d.exec("PRAGMA busy_timeout=5000"); d.exec("INSERT INTO t VALUES (2)"); d.close();`]);
  const v2 = dv();
  record("E3 changes after a commit in another process", w2.exitCode === 0 && v2 !== v1, `${v1} → ${v2}`);
  poll.exec("INSERT INTO t VALUES (3)");
  const v3 = dv();
  record("E4 (expected) unchanged by the poll connection's own commit", v3 === v2, `${v2} → ${v3}`);
  w1.close();
  poll.close();
}

// F. Mutual exclusion under contention across processes: N workers, each loop: acquire (blocking-ish), O_EXCL marker, work, remove, release.
{
  const marker = join(dir, "in-critical-section");
  const WORKER = `
import { Database } from "bun:sqlite";
import { openSync, closeSync, unlinkSync } from "node:fs";
const [file, marker, n] = process.argv.slice(2);
const db = new Database(file); db.exec("PRAGMA busy_timeout = 10000");
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
  const workerPath = join(dir, "worker.ts");
  await Bun.write(workerPath, WORKER);
  const procs = Array.from({ length: 4 }, () => Bun.spawn(["bun", workerPath, lockFile, marker, "150"], { stdout: "pipe" }));
  const outs = await Promise.all(procs.map(async (p) => (await new Response(p.stdout).text()).trim()));
  const total = outs.map((o) => Number(o.match(/VIOLATIONS (\d+)/)?.[1] ?? NaN)).reduce((a, b) => a + b, 0);
  record("F1 4 processes × 150 acquisitions: never two in the critical section", total === 0, `violations=${total}; ${outs.join(" | ")}`);
}

// G. Holder SIGKILLed while two waiters contend (design §5.2 third test).
{
  const marker = join(dir, "in-cs-g");
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
  const waiterPath = join(dir, "waiter.ts");
  await Bun.write(waiterPath, WAITER);
  const holder = await startHolder();
  const waiters = [0, 1].map(() => Bun.spawn(["bun", waiterPath, lockFile, marker], { stdout: "pipe" }));
  await sleep(1000);
  const beforeKill = existsSync(marker);
  record("G0 waiters stay blocked while the holder lives (1 s, forced GC)", !beforeKill && waiters.every((w) => w.exitCode === null));
  holder.proc.kill("SIGKILL");
  const outs = await Promise.all(waiters.map(async (p) => (await new Response(p.stdout).text()).trim()));
  const bothRan = outs.every((o) => o.startsWith("DONE"));
  const viol = outs.reduce((a, o) => a + Number(o.split(" ")[1] ?? 1), 0);
  record("G1 holder SIGKILLed with two waiters: both run, never together", bothRan && viol === 0, outs.join(" | "));
}

// H. The shape the implementation must use (design §5.2): busy_timeout = 0 plus async retries.
{
  async function acquireAsync(file: string, deadlineMs: number | null): Promise<Database | null> {
    const db = open(file, 0);
    const start = Date.now();
    let backoff = 5;
    for (;;) {
      if (tryBegin(db) === "ok") return db;
      if (deadlineMs !== null && Date.now() - start >= deadlineMs) { db.close(); return null; }
      await sleep(backoff);
      backoff = Math.min(50, backoff * 2);
    }
  }
  // H1: the event loop stays responsive while a waiter waits.
  const holder = await startHolder();
  let ticks = 0;
  const t = setInterval(() => ticks++, 10);
  const t0 = Date.now();
  const got = await acquireAsync(lockFile, 600);
  const waited = Date.now() - t0;
  clearInterval(t);
  record("H1 bounded async wait gives up at its deadline", got === null && waited >= 600 && waited < 900, `waited ${waited} ms`);
  record("H2 event loop keeps running while waiting", ticks >= 30, `${ticks} timer ticks in ${waited} ms`);
  // H3: holder dies mid-wait → the async waiter acquires.
  const killer = Bun.spawn(["sh", "-c", `sleep 0.3; kill -9 ${holder.proc.pid}`]);
  const t1 = Date.now();
  const got2 = await acquireAsync(lockFile, null);
  record("H3 unbounded async wait acquires after the holder dies", got2 !== null && Date.now() - t1 >= 250, `after ${Date.now() - t1} ms`);
  got2?.exec("ROLLBACK");
  got2?.close();
  await killer.exited;
  await holder.proc.exited;
  // H4: cross-process contention using the async shape never admits two holders.
  const marker = join(dir, "in-cs-h");
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
  const awPath = join(dir, "async-worker.ts");
  await Bun.write(awPath, ASYNC_WORKER);
  const procs = Array.from({ length: 4 }, () => Bun.spawn(["bun", awPath, lockFile, marker, "100"], { stdout: "pipe" }));
  const outs = await Promise.all(procs.map(async (p) => (await new Response(p.stdout).text()).trim()));
  const total = outs.map((o) => Number(o.match(/VIOLATIONS (\d+)/)?.[1] ?? NaN)).reduce((a, b) => a + b, 0);
  record("H4 4 processes × 100 async acquisitions: never two in the critical section", total === 0, `violations=${total}`);
}

const informational = new Set([
  "A8 (hazard, informational) an unreachable lock connection is GC'd and its lock released",
  "C3c (informational) uninitialized lock file: BEGIN IMMEDIATE creates a journal",
]);
const failed = results.filter((r) => !r.ok && !informational.has(r.name));
const infoFailed = results.filter((r) => !r.ok && informational.has(r.name)).length;
console.log(`\n${results.length - failed.length - infoFailed}/${results.length} passed (${failed.length} required failed, ${infoFailed} informational failed); bun ${Bun.version}; sqlite ${(new Database(":memory:").query("select sqlite_version() v").get() as { v: string }).v}; ${process.platform}`);
process.exit(failed.length === 0 ? 0 : 1);
