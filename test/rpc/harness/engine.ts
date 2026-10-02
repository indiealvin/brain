/**
 * Steps for the engine transcripts (T1.7): another loop owner, a crashed
 * daemon's leftovers, and an external `brain index`. Paths pass through
 * `ctx.subs`; every child runs with this run's BRAIN_HOME and without the
 * developer's provider variables (`serverEnv`).
 *
 * - `watch.spawn {repo, args?, env?}`: start `brain watch --repo <repo> …args`
 *   in the background and wait until it holds the loop-owner lock and runs its
 *   loop ("watching " on its stderr). One daemon per run; it is SIGKILLed in
 *   teardown if still alive.
 * - `watch.kill {signal?="SIGKILL", loopOwnerWithinMs?}`: send `signal` to the
 *   daemon and wait for it to exit. With `loopOwnerWithinMs`, the server under
 *   test must then send `engine.loopOwner` with `loopOwner: "self"` within
 *   that many ms of the signal (a generous bound on "within one interval",
 *   protocol §9). The notification is still matched by the window as usual.
 * - `watch.stalePid {repo}`: overwrite `<runtimeDir>/watch.pid` with the pid of
 *   a live process that is not a `brain watch` (this test runner): what a
 *   crashed daemon's file looks like once its pid has been reused. Nothing
 *   may read it to decide who owns the loop (design §5.3 item 2).
 * - `brain.index {repo, expectEmbedded?}`: run `brain index --repo <repo>
 *   --json` with `BRAIN_EMBEDDINGS=hashing`, wait for exit 0, and check the
 *   number of notes it embedded when `expectEmbedded` is given.
 */
import type { Subprocess } from "bun";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WATCH_PID_FILE } from "../../../src/config/doctor";
import { repoPaths } from "../../../src/core/brainHome";
import type { RepoPaths } from "../../../src/core/types";
import { loadConfig } from "../../../src/markdown/repo";
import { CLI, serverEnv } from "./process";
import { registerStep, sleep, stepString, type StepContext } from "./steps";
import type { Step } from "./transcript";

const WAIT_MS = 20_000;
const CHILD_TIMEOUT_MS = 30_000;
const WATCH_STATE = "engine.watch";

interface WatchChild {
  proc: Subprocess<"ignore", "pipe", "pipe">;
  stderr(): string;
}

function repoOf(step: Step, ctx: StepContext): string {
  return ctx.subs.apply(stepString(step, "repo"));
}

function stringArray(step: Step, field: string): string[] {
  const v = step[field] ?? [];
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) throw new Error(`step ${step.op}: ${field} must be an array of strings`);
  return v as string[];
}

function stringRecord(step: Step, field: string): Record<string, string> {
  const v = step[field] ?? {};
  if (typeof v !== "object" || v === null || Array.isArray(v) || !Object.values(v).every((x) => typeof x === "string")) throw new Error(`step ${step.op}: ${field} must be an object of strings`);
  return v as Record<string, string>;
}

/** The state paths of knowledge repo `repo` under this run's BRAIN_HOME (`repoPaths` reads BRAIN_HOME from the env). */
function pathsOf(ctx: StepContext, repo: string): RepoPaths {
  const prev = process.env.BRAIN_HOME;
  process.env.BRAIN_HOME = ctx.home;
  try {
    return repoPaths(repo, loadConfig(repo).repoId);
  } finally {
    if (prev === undefined) delete process.env.BRAIN_HOME;
    else process.env.BRAIN_HOME = prev;
  }
}

function watchOf(ctx: StepContext, op: string): WatchChild {
  const w = ctx.state.get(WATCH_STATE) as WatchChild | undefined;
  if (w === undefined) throw new Error(`step ${op}: no brain watch was spawned (watch.spawn)`);
  return w;
}

registerStep("watch.spawn", async (step, ctx) => {
  if (ctx.state.has(WATCH_STATE)) throw new Error("step watch.spawn: a brain watch is already running in this run");
  const repo = repoOf(step, ctx);
  const proc = Bun.spawn([process.execPath, CLI, "watch", "--repo", repo, ...stringArray(step, "args")], {
    cwd: ctx.tmp,
    env: serverEnv(ctx.home, stringRecord(step, "env")),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  let buf = "";
  let eof = false;
  void (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of proc.stderr) buf += decoder.decode(chunk, { stream: true });
    eof = true;
  })();
  void new Response(proc.stdout).text(); // keep stdout drained
  ctx.defer(async () => {
    try {
      proc.kill("SIGKILL");
    } catch {}
    await proc.exited;
  });
  const child: WatchChild = { proc, stderr: () => buf };
  ctx.state.set(WATCH_STATE, child);
  const deadline = Date.now() + WAIT_MS;
  while (!buf.includes("watching ")) {
    if (eof) throw new Error(`brain watch (pid ${proc.pid}) closed stderr before it started its loop:\n${buf}`);
    if (Date.now() > deadline) throw new Error(`brain watch (pid ${proc.pid}) did not start its loop within ${WAIT_MS} ms:\n${buf}`);
    await sleep(10);
  }
});

registerStep("watch.kill", async (step, ctx) => {
  const w = watchOf(ctx, "watch.kill");
  const signal = (step["signal"] === undefined ? "SIGKILL" : stepString(step, "signal")) as NodeJS.Signals;
  const within = step["loopOwnerWithinMs"];
  if (within !== undefined && (typeof within !== "number" || within <= 0)) throw new Error("step watch.kill: loopOwnerWithinMs must be a positive number");
  let ownedAt: number | null = null;
  if (within !== undefined) {
    // Never removed: the listener lives as long as this run's server, and only records a time.
    ctx.server.onMessage((msg) => {
      if (ownedAt === null && msg !== null && msg["type"] === "engine.loopOwner" && (msg["data"] as Record<string, unknown> | undefined)?.["loopOwner"] === "self") ownedAt = Date.now();
    });
  }
  const killedAt = Date.now();
  w.proc.kill(signal);
  await w.proc.exited;
  if (within === undefined) return;
  while (ownedAt === null && Date.now() - killedAt <= within) await sleep(5);
  if (ownedAt === null) throw new Error(`no engine.loopOwner {loopOwner: "self"} within ${within} ms of ${signal} to brain watch (pid ${w.proc.pid})`);
});

registerStep("watch.stalePid", (step, ctx) => {
  const runtimeDir = pathsOf(ctx, repoOf(step, ctx)).runtimeDir;
  mkdirSync(runtimeDir, { recursive: true });
  writeFileSync(join(runtimeDir, WATCH_PID_FILE), `${process.pid}\n`);
});

registerStep("brain.index", async (step, ctx) => {
  const repo = repoOf(step, ctx);
  const expectEmbedded = step["expectEmbedded"];
  if (expectEmbedded !== undefined && (typeof expectEmbedded !== "number" || !Number.isInteger(expectEmbedded))) throw new Error("step brain.index: expectEmbedded must be an integer");
  const child = Bun.spawn([process.execPath, CLI, "index", "--repo", repo, "--json"], {
    cwd: ctx.tmp,
    env: serverEnv(ctx.home, { BRAIN_EMBEDDINGS: "hashing" }),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const kill = async () => {
    try {
      child.kill("SIGKILL");
    } catch {}
    await child.exited;
  };
  ctx.defer(kill);
  const timer = setTimeout(() => void kill(), CHILD_TIMEOUT_MS);
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]).finally(() => clearTimeout(timer));
  const output = `--- stdout ---\n${stdout}--- stderr ---\n${stderr}`;
  if (code !== 0) throw new Error(`brain index: exit code ${code}\n${output}`);
  if (expectEmbedded !== undefined) {
    const embedded = (JSON.parse(stdout) as { embedded?: unknown }).embedded;
    if (embedded !== expectEmbedded) throw new Error(`brain index: embedded ${String(embedded)} notes, expected ${expectEmbedded}\n${output}`);
  }
});
