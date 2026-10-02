/**
 * Steps for proposal decision transcripts (T1.6): a decision made by another
 * `brain` process, `brain proposals accept|reject <id>`, run in the
 * background beside the server under test, optionally held inside its
 * critical section by core's test-only hold hook (`DECISION_HOLD_ENV`,
 * src/core/coordinator.ts). Fields pass through `ctx.subs`, so a proposal id
 * bound from an earlier result names the actual proposal.
 *
 * - `decision.start {name, repo, decision: "accept" | "reject", proposalId,
 *   note?, hold?}`: start `brain proposals <decision> <proposalId> --json`
 *   with this run's BRAIN_HOME and no model. With `hold` (a file name under
 *   the temp root), the CLI's decision stops at the top of its locked
 *   section, holding the worktree lock, until `decision.release`.
 * - `decision.awaitHeld {name}`: wait until that decision is held inside its
 *   section (core writes `<hold>.held`). Its process holds the worktree lock
 *   from then until it is released, so a decision sent to the server now
 *   waits for it and enters the critical section second.
 * - `decision.release {name}`: let the held decision go on.
 * - `decision.await {name, expectExitCode, expectResult?, expectStderr?}`:
 *   wait for the CLI to exit, then check its exit code, its JSON output
 *   against `expectResult` (the service layer's result: `ExecutionResult`
 *   for accept, `{proposalId, status}` for reject; subset match, as for a
 *   server message without matchers), and that stderr contains
 *   `expectStderr`.
 */
import { existsSync, writeFileSync } from "node:fs";
import { isAbsolute, join, normalize } from "node:path";
import type { Subprocess } from "bun";
import { DECISION_HOLD_ENV } from "../../../src/core/coordinator";
import { matchMessage } from "./match";
import { CLI, serverEnv } from "./process";
import { registerStep, sleep, stepString, type StepContext } from "./steps";
import type { Step } from "./transcript";

const WAIT_MS = 20_000;
const CHILD_TIMEOUT_MS = 60_000;

interface Decision {
  proc: Subprocess<"ignore", "pipe", "pipe">;
  /** The release file, when the decision is held. */
  hold?: string;
  /** Exit code, stdout and stderr, once the process has exited. */
  outcome: Promise<[number, string, string]>;
}

function decisionOf(step: Step, ctx: StepContext): Decision {
  const name = stepString(step, "name");
  const d = ctx.state.get(`decision:${name}`) as Decision | undefined;
  if (d === undefined) throw new Error(`step ${step.op}: no decision ${JSON.stringify(name)} was started`);
  return d;
}

function holdOf(step: Step, d: Decision): string {
  if (d.hold === undefined) throw new Error(`step ${step.op}: decision ${String(step["name"])} was started without hold`);
  return d.hold;
}

registerStep("decision.start", (step, ctx) => {
  const name = stepString(step, "name");
  if (ctx.state.has(`decision:${name}`)) throw new Error(`step decision.start: decision ${JSON.stringify(name)} was already started`);
  const decision = stepString(step, "decision");
  if (decision !== "accept" && decision !== "reject") throw new Error(`step decision.start: decision must be "accept" or "reject", got ${JSON.stringify(decision)}`);
  const repo = ctx.subs.apply(stepString(step, "repo"));
  const proposalId = ctx.subs.apply(stepString(step, "proposalId"));
  const args = ["proposals", decision, proposalId, "--repo", repo, "--json"];
  if (step["note"] !== undefined) args.push("--note", stepString(step, "note"));
  let hold: string | undefined;
  if (step["hold"] !== undefined) {
    const file = stepString(step, "hold");
    if (isAbsolute(file) || normalize(file).startsWith("..")) throw new Error(`step decision.start: hold must be relative to the temp root, got ${file}`);
    hold = join(ctx.tmp, file);
  }
  const proc = Bun.spawn([process.execPath, CLI, ...args], {
    cwd: ctx.tmp,
    env: serverEnv(ctx.home, hold === undefined ? {} : { [DECISION_HOLD_ENV]: hold }),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const outcome = Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  ctx.defer(async () => {
    try {
      proc.kill("SIGKILL");
    } catch {}
    await outcome.catch(() => undefined);
  });
  ctx.state.set(`decision:${name}`, { proc, hold, outcome } satisfies Decision);
});

registerStep("decision.awaitHeld", async (step, ctx) => {
  const d = decisionOf(step, ctx);
  const held = `${holdOf(step, d)}.held`;
  const deadline = Date.now() + WAIT_MS;
  while (!existsSync(held)) {
    if (d.proc.exitCode !== null) {
      const [code, stdout, stderr] = await d.outcome;
      throw new Error(`decision.awaitHeld: the decision exited (${code}) before it was held\n--- stdout ---\n${stdout}--- stderr ---\n${stderr}`);
    }
    if (Date.now() > deadline) throw new Error(`decision.awaitHeld: not held after ${WAIT_MS} ms`);
    await sleep(10);
  }
});

registerStep("decision.release", (step, ctx) => {
  writeFileSync(holdOf(step, decisionOf(step, ctx)), "");
});

registerStep("decision.await", async (step, ctx) => {
  const d = decisionOf(step, ctx);
  const expectExitCode = step["expectExitCode"];
  if (typeof expectExitCode !== "number") throw new Error("step decision.await: expectExitCode must be a number");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`decision.await: the decision did not exit within ${CHILD_TIMEOUT_MS} ms`)), CHILD_TIMEOUT_MS);
  });
  const [code, stdout, stderr] = await Promise.race([d.outcome, timeout]).finally(() => clearTimeout(timer));
  const output = `--- stdout ---\n${stdout}--- stderr ---\n${stderr}`;
  if (code !== expectExitCode) throw new Error(`decision.await: exit code ${code}, expected ${expectExitCode}\n${output}`);
  if (step["expectResult"] !== undefined) {
    let result: unknown;
    try {
      result = JSON.parse(stdout);
    } catch {
      throw new Error(`decision.await: stdout is not JSON\n${output}`);
    }
    const f = matchMessage(step["expectResult"], result, undefined, ctx.subs);
    if (f) throw new Error(`decision.await: result does not match at ${f.pointer || "/"}: ${f.reason}\n${output}`);
  }
  if (step["expectStderr"] !== undefined) {
    const want = ctx.subs.apply(stepString(step, "expectStderr"));
    if (!stderr.includes(want)) throw new Error(`decision.await: stderr does not contain ${JSON.stringify(want)}\n${output}`);
  }
});
