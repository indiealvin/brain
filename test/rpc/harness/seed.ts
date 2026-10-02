/**
 * Seeding steps for transcripts that read existing state (T1.4's read
 * methods): notes on `main`, mutations and proposals made by another `brain`
 * process, and session files. Every path field is written with the recorded
 * temp root and rewritten through `ctx.subs`.
 *
 * - `repo.writeNote {repo, path, note, commit?}`: write a note into the user
 *   worktree. `note` is a `NoteSpec` (test/harness: `id`, `title`, `type?`,
 *   `status?`, `created?`, `aliases?`, `sections?`). With `commit`, commit
 *   everything in the worktree on `main` as a human, with that subject.
 *   Without it the edit stays uncommitted.
 * - `repo.quiescence {repo, ms}`: set brain.toml's `sync.quiescence_ms` and
 *   commit it on `main`. A long quiescence keeps Human Sync from ever
 *   committing an uncommitted edit, so an integration that the edit blocks
 *   stays refused whichever process runs the loop (the server itself from
 *   T1.7 on).
 * - `core {repo, ops}`: run coordinator calls in a child `bun` process with
 *   this run's BRAIN_HOME (another writer under CR-1; coreChild.ts):
 *   - `{op: "submit", mutation, expect?}`: `coord.submit`; fails unless the
 *     resulting state is `expect`, when given;
 *   - `{op: "submitProposal", proposal}`: `coord.submitProposal`;
 *   - `{op: "syncOnce", expect?}`: a Human Sync pass that finds every edit
 *     quiescent (a `human-sync` commit); fails unless `committed` is
 *     `expect`, when given.
 *   A `present` target (or proposal target) without `noteId` / `blobHash`
 *   gets them from agent HEAD at that point; a write may give `note` (a
 *   `NoteSpec`) instead of `content`. See coreChild.ts for the defaults.
 * - `conversation.seed {repo, sessionId, createdAt, turns: [{role, text, at}]}`:
 *   write a session file in the conversation store's format, with fixed ids
 *   and timestamps (turn ids are allocated in order, as the store does).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { formatTurnId } from "../../../src/conversation/store";
import { repoPaths } from "../../../src/core/brainHome";
import { formatCommitMessage, gitWith, identityEnv } from "../../../src/git/git";
import { CONFIG_FILE, configToToml, loadConfig } from "../../../src/markdown/repo";
import { noteMd, type NoteSpec } from "../../harness";
import { serverEnv } from "./process";
import { registerStep, stepString, type StepContext } from "./steps";
import type { Step } from "./transcript";

const CORE_CHILD = resolve(import.meta.dir, "coreChild.ts");

function repoOf(step: Step, ctx: StepContext): string {
  return ctx.subs.apply(stepString(step, "repo"));
}

function objectField(step: Step, field: string): Record<string, unknown> {
  const v = step[field];
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error(`step ${step.op}: ${field} must be an object`);
  return v as Record<string, unknown>;
}

/** Commit everything in the user worktree on `main`, as a human. */
function commitAsHuman(repo: string, subject: string): void {
  gitWith(repo, ["add", "-A"]);
  gitWith(repo, ["commit", "-q", "--no-verify", "-F", "-"], { stdin: formatCommitMessage(subject, { actor: "human" }), env: identityEnv(repo) });
}

registerStep("repo.writeNote", (step, ctx) => {
  const repo = repoOf(step, ctx);
  const abs = join(repo, stepString(step, "path"));
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, noteMd(objectField(step, "note") as unknown as NoteSpec));
  if (step["commit"] !== undefined) commitAsHuman(repo, stepString(step, "commit"));
});

registerStep("repo.quiescence", (step, ctx) => {
  const repo = repoOf(step, ctx);
  const ms = step["ms"];
  if (typeof ms !== "number" || !Number.isInteger(ms) || ms < 0) throw new Error("step repo.quiescence: ms must be a non-negative integer");
  const config = loadConfig(repo);
  writeFileSync(join(repo, CONFIG_FILE), configToToml({ ...config, sync: { ...config.sync, quiescenceMs: ms } }));
  commitAsHuman(repo, `user: sync.quiescence_ms = ${ms}`);
});

registerStep("core", async (step, ctx) => {
  const repo = repoOf(step, ctx);
  const ops = step["ops"];
  if (!Array.isArray(ops)) throw new Error("step core: ops must be an array");
  const child = Bun.spawn([process.execPath, CORE_CHILD, repo], {
    cwd: ctx.tmp,
    env: serverEnv(ctx.home),
    stdin: Buffer.from(JSON.stringify(ctx.subs.applyDeep(ops)), "utf8"),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (code !== 0) throw new Error(`core child exited with ${code}:\n${stderr}${stdout}`);
});

registerStep("conversation.seed", (step, ctx) => {
  const repo = repoOf(step, ctx);
  const sessionId = stepString(step, "sessionId");
  const createdAt = stepString(step, "createdAt");
  const turns = step["turns"];
  if (!Array.isArray(turns)) throw new Error("step conversation.seed: turns must be an array");
  const dir = conversationsDir(ctx, repo);
  mkdirSync(dir, { recursive: true });
  const lines = [JSON.stringify({ kind: "session", sessionId, createdAt })];
  turns.forEach((t: { role: string; text: string; at: string }, i) => {
    lines.push(JSON.stringify({ kind: "turn", turnId: formatTurnId(i + 1), role: t.role, text: t.text, at: t.at }));
  });
  writeFileSync(join(dir, `${sessionId}.jsonl`), lines.join("\n") + "\n", { flag: "wx" });
});

/** The conversation store directory of knowledge repo `repo` under this run's BRAIN_HOME. */
export function conversationsDir(ctx: StepContext, repo: string): string {
  return withBrainHome(ctx.home, () => repoPaths(repo, loadConfig(repo).repoId).conversationsDir);
}

/** `repoPaths` reads BRAIN_HOME from the env: evaluate it against this run's home, then restore. */
function withBrainHome<T>(home: string, fn: () => T): T {
  const prev = process.env.BRAIN_HOME;
  process.env.BRAIN_HOME = home;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.BRAIN_HOME;
    else process.env.BRAIN_HOME = prev;
  }
}
