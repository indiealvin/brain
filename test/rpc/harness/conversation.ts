/**
 * Steps for `conversation.send` transcripts (T1.5): the server's scripted
 * model (CR-6, header `modelScript`), a second writer in another process, and
 * the session file on disk. Paths and ids pass through `ctx.subs`.
 *
 * - `modelScript.awaitCall {role, count?=1}`: wait until the server's call log
 *   (`<tmp>/model-script.calls.jsonl`) holds `count` calls of `role` ("chat",
 *   "extractor", "planner"). A call is logged before its `hold` waits, so
 *   after `awaitCall chat` a held reply is in flight: the user turn is
 *   appended and the session's turn lock is held.
 * - `modelScript.expectCalls {role, count}`: the call log holds exactly
 *   `count` calls of `role` so far (e.g. a `SESSION_BUSY` send made none).
 * - `modelScript.release {file}`: create the release file `<tmp>/<file>`,
 *   which lets every call held on it (`"hold": "<file>"` in the script) go on.
 * - `chat.once {repo, sessionId, text, expectExitCode, expectStderr?}`: run
 *   `brain chat --once <text> --session <sessionId> --repo <repo>` in another
 *   process with this run's BRAIN_HOME and `BRAIN_MODEL_MOCK=1`, wait for it
 *   to exit, and check its exit code and that stderr contains `expectStderr`.
 * - `conversation.expectTurns {repo, sessionId, turns: [{turnId?, role, text}]}`:
 *   the session file holds exactly these turns, in order. Read from disk, so
 *   it also works after `shutdown`.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, normalize } from "node:path";
import { openConversationStore } from "../../../src/conversation/store";
import { defaultCallLogPath, type ScriptCallLogLine } from "../../../src/pipeline/scripted";
import { CLI, serverEnv } from "./process";
import { MODEL_SCRIPT_FILE } from "./replay";
import { conversationsDir } from "./seed";
import { registerStep, sleep, stepString, type StepContext } from "./steps";
import type { Step } from "./transcript";

const WAIT_MS = 20_000;
const CHILD_TIMEOUT_MS = 30_000;

function callLog(ctx: StepContext): ScriptCallLogLine[] {
  const path = defaultCallLogPath(join(ctx.tmp, MODEL_SCRIPT_FILE));
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as ScriptCallLogLine);
}

function callsOf(ctx: StepContext, role: string): number {
  return callLog(ctx).filter((l) => l.role === role).length;
}

function stepCount(step: Step, field: string, fallback?: number): number {
  const v = step[field] ?? fallback;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0) throw new Error(`step ${step.op}: ${field} must be a non-negative integer`);
  return v;
}

registerStep("modelScript.awaitCall", async (step, ctx) => {
  const role = stepString(step, "role");
  const count = stepCount(step, "count", 1);
  const deadline = Date.now() + WAIT_MS;
  while (callsOf(ctx, role) < count) {
    if (Date.now() > deadline) throw new Error(`modelScript.awaitCall: ${callsOf(ctx, role)} ${role} call(s) logged, waited for ${count}`);
    await sleep(10);
  }
});

registerStep("modelScript.expectCalls", (step, ctx) => {
  const role = stepString(step, "role");
  const count = stepCount(step, "count");
  const got = callsOf(ctx, role);
  if (got !== count) throw new Error(`modelScript.expectCalls: expected ${count} ${role} call(s), the call log has ${got}`);
});

registerStep("modelScript.release", (step, ctx) => {
  const file = stepString(step, "file");
  if (isAbsolute(file) || normalize(file).startsWith("..")) throw new Error(`modelScript.release: file must be relative to the script's directory, got ${file}`);
  writeFileSync(join(ctx.tmp, file), "");
});

registerStep("chat.once", async (step, ctx) => {
  const repo = ctx.subs.apply(stepString(step, "repo"));
  const sessionId = ctx.subs.apply(stepString(step, "sessionId"));
  const text = stepString(step, "text");
  const expectExitCode = stepCount(step, "expectExitCode");
  const expectStderr = step["expectStderr"] === undefined ? undefined : stepString(step, "expectStderr");
  const child = Bun.spawn([process.execPath, CLI, "chat", "--once", text, "--session", sessionId, "--repo", repo], {
    cwd: ctx.tmp,
    env: serverEnv(ctx.home, { BRAIN_MODEL_MOCK: "1" }),
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
  if (code !== expectExitCode) throw new Error(`chat.once: exit code ${code}, expected ${expectExitCode}\n${output}`);
  if (expectStderr !== undefined && !stderr.includes(expectStderr)) throw new Error(`chat.once: stderr does not contain ${JSON.stringify(expectStderr)}\n${output}`);
});

registerStep("conversation.expectTurns", (step, ctx) => {
  const repo = ctx.subs.apply(stepString(step, "repo"));
  const sessionId = ctx.subs.apply(stepString(step, "sessionId"));
  const want = step["turns"];
  if (!Array.isArray(want)) throw new Error("step conversation.expectTurns: turns must be an array");
  const got = openConversationStore(conversationsDir(ctx, repo)).getTurns(sessionId);
  const view = got.map((t, i) => {
    const w = want[i] as Record<string, unknown> | undefined;
    return w !== undefined && "turnId" in w ? { turnId: t.turnId, role: t.role, text: t.text } : { role: t.role, text: t.text };
  });
  const expected = ctx.subs.applyDeep(want);
  if (JSON.stringify(view) !== JSON.stringify(expected)) throw new Error(`conversation.expectTurns: session ${sessionId} holds ${JSON.stringify(view)}, expected ${JSON.stringify(expected)}`);
});
