/**
 * Transcript steps: `{"dir": "test", "step": {"op": "<name>", …}}` lines the
 * Bun harness performs at that point of a replay or a recording
 * (implementation-plan T1.3). The Swift replay skips them.
 *
 * Handlers are named and registered here, next to the harness. Each lands
 * with the first task whose transcripts need it. To add one:
 *
 * ```ts
 * import { registerStep, stepString } from "./steps";
 * registerStep("watch.spawn", async (step, ctx) => {
 *   const child = spawnWatch(ctx.home, …);        // ctx.home, ctx.tmp: this run's dirs
 *   ctx.defer(() => child.kill());                 // teardown, in reverse order
 *   ctx.state.set("watch", child);                 // shared with later steps
 * });
 * ```
 * and import the module from harness/index.ts. A step that creates a value
 * which later lines must name (a URL, a pid) records it under a fixed
 * transcript value with `ctx.alias(recorded, actual)`.
 *
 * Built in:
 * - `sendRaw {line}`: write `line` (after substitution) to the server's stdin
 *   as is, for framing tests (malformed JSON, a request without an id).
 * - `expectPending {ids, forMs?}`: wait `forMs` (default 300), then fail if any
 *   of these request ids has received its terminal message. Pins drain order:
 *   "this result has not arrived while that work is held".
 */
import type { Substitutions } from "./match";
import type { ServerHandle } from "./process";
import type { Step } from "./transcript";

export interface StepContext {
  /** This run's temp root (`header.tmp` on replay) and the server's BRAIN_HOME. */
  readonly tmp: string;
  readonly home: string;
  /** The server under test. */
  readonly server: ServerHandle;
  /** Recorded → actual substitutions of this run. */
  readonly subs: Substitutions;
  /** True when "replay", false while recording a transcript. */
  readonly replaying: boolean;
  /** From now on, `recorded` in the transcript stands for `actual` in this run. */
  alias(recorded: string, actual: string): void;
  /** Whether request `id` has received its terminal message so far. */
  terminated(id: string): boolean;
  /** Teardown, run in reverse order after the transcript (pass or fail). */
  defer(cleanup: () => void | Promise<void>): void;
  /** State shared by a family of steps within one run. */
  readonly state: Map<string, unknown>;
}

export type StepHandler = (step: Step, ctx: StepContext) => void | Promise<void>;

const registry = new Map<string, StepHandler>();

export function registerStep(op: string, handler: StepHandler): void {
  if (registry.has(op)) throw new Error(`step ${op} is already registered`);
  registry.set(op, handler);
}

export function stepHandler(op: string): StepHandler {
  const h = registry.get(op);
  if (h === undefined) throw new Error(`unknown transcript step ${JSON.stringify(op)} (registered: ${[...registry.keys()].join(", ")})`);
  return h;
}

/** A required string field of a step. */
export function stepString(step: Step, field: string): string {
  const v = step[field];
  if (typeof v !== "string" || v === "") throw new Error(`step ${step.op}: ${field} must be a non-empty string`);
  return v;
}

export function stepStrings(step: Step, field: string): string[] {
  const v = step[field];
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) throw new Error(`step ${step.op}: ${field} must be an array of strings`);
  return v as string[];
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

registerStep("sendRaw", (step, ctx) => {
  ctx.server.sendRaw(ctx.subs.apply(stepString(step, "line")));
});

registerStep("expectPending", async (step, ctx) => {
  const ids = stepStrings(step, "ids");
  const forMs = typeof step["forMs"] === "number" ? step["forMs"] : 300;
  await sleep(forMs);
  const done = ids.filter((id) => ctx.terminated(id));
  if (done.length > 0) throw new Error(`expectPending: ${done.join(", ")} already received a terminal message`);
});
