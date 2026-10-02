/**
 * CR-1 acceptance test 1 (docs/mac-app/design.md §5.2): `brain watch
 * --interval 50` runs while two `brain chat --once` processes, each with its
 * own scripted model (CR-6), produce mutations at the same moment. Afterwards
 * there is no FAILED or FAILED_INVALID_EXECUTION row, every Mutation-ID
 * appears exactly once on `agent/repo`, and the agent worktree is clean.
 *
 * To make the race reproducible rather than lucky, both chats' planner calls
 * are held until both have arrived and then released together, and every
 * process runs with the executor's test-only delay between writing a
 * mutation's files and reading them back (`BRAIN_TEST_EXECUTE_DELAY_MS`).
 * Without the cross-process lock the two executions overlap in the one agent
 * worktree: one resets or adds to the other's files, giving NOOP and
 * FAILED_INVALID_EXECUTION rows. With it they run one after the other.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Subprocess } from "bun";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { EXECUTE_DELAY_ENV } from "../../src/core/executor";
import type { ModelScript } from "../../src/pipeline/scripted";
import { commitsWithMutationId, fileAt, git, mutationIdsOn } from "../harness";

const CLI = resolve(import.meta.dir, "../../src/cli.ts");
const TIMEOUT_MS = 90_000;
/** Long enough that two executions started together always overlap. */
const EXECUTE_DELAY_MS = 400;

/** Child env: no model keys or provider settings leak in from the developer's environment or `.env`. */
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
  EXECUTE_DELAY_ENV,
];

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

let dir: string;
let home: string;
let repo: string;
let children: Subprocess[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "brain-single-writer-"));
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

function childEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = { ...(process.env as Record<string, string>), BRAIN_HOME: home };
  for (const k of STRIP) delete env[k];
  return { ...env, ...extra };
}

function runSync(args: string[]): { code: number; out: string; err: string } {
  const r = Bun.spawnSync(["bun", CLI, ...args], { cwd: repo, env: childEnv(), stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

/** `brain <args>` in the background, stderr collected as it arrives. */
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
    stderr: () => err,
    async done(): Promise<{ code: number; out: string; err: string }> {
      const code = await proc.exited;
      await stderrDone;
      return { code, out: await stdout, err };
    },
  };
}

async function until(what: string, cond: () => boolean, timeoutMs = 30_000, diag: () => string = () => ""): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}\n${diag()}`);
    await sleep(20);
  }
}

function plannerCallArrived(callLog: string): boolean {
  if (!existsSync(callLog)) return false;
  return readFileSync(callLog, "utf8")
    .split("\n")
    .filter(Boolean)
    .some((l) => (JSON.parse(l) as { role: string }).role === "planner");
}

/** One chat's script: a reply, one grounded candidate, and a plan that creates `slug` once `release` exists. */
function writerScript(slug: string, title: string, release: string): ModelScript {
  return {
    chunkDelayMs: 0,
    chat: [{ response: `Noted: ${title}.` }],
    extractor: [{ response: { candidates: [{ kind: "idea", claim: `${title} is worth keeping`, groundedSources: ["{{lastUser}}"], inferences: [] }] } }],
    planner: [
      {
        hold: release,
        response: {
          operations: [
            {
              op: "CREATE",
              path: `knowledge/${slug}.md`,
              content: `---\nid: NEW\ncreated: 2026-10-02\ntype: idea\nstatus: active\n---\n# ${title}\n\n## Claim\n${title} is worth keeping.\nGrounded-in: {{lastUser}}\n`,
              reasoning: "a distinct concept",
            },
          ],
        },
      },
    ],
  };
}

describe("one writer at a time across processes (CR-1 acceptance test 1)", () => {
  test(
    "brain watch --interval 50 alongside two brain chat --once: no failed rows, each Mutation-ID once on agent/repo, clean agent worktree",
    async () => {
      expect(runSync(["init", repo]).code).toBe(0);
      expect(runSync(["status"]).code).toBe(0); // the agent worktree and index exist before the race starts
      const repoId = readFileSync(join(repo, "brain.toml"), "utf8").match(/repo_id = "([^"]+)"/)![1]!;
      const stateDir = join(home, "repos", repoId);
      const agentWorktree = join(stateDir, "worktrees", "agent");

      const writers = [
        { name: "a", slug: "undo-replaces-approval", title: "Undo replaces approval", text: "Cheap undo means an agent can act first and be reviewed afterwards." },
        { name: "b", slug: "review-after-the-fact", title: "Review after the fact", text: "Reviewing agent changes after the fact scales better than approving each one." },
      ];
      for (const w of writers) writeFileSync(join(dir, `${w.name}.json`), JSON.stringify(writerScript(w.slug, w.title, "release-planners"), null, 2));
      const delay = { [EXECUTE_DELAY_ENV]: String(EXECUTE_DELAY_MS) };

      const watch = spawnBrain(["watch", "--interval", "50", "--no-embeddings"], delay);
      const chats = writers.map((w) => spawnBrain(["chat", "--once", w.text], { ...delay, BRAIN_MODEL_SCRIPT: join(dir, `${w.name}.json`) }));
      const diag = () => [`watch:\n${watch.stderr()}`, ...chats.map((c, i) => `chat ${writers[i]!.name}:\n${c.stderr()}`)].join("\n");

      // Both planners are waiting and the watcher is looping; release both writers at once.
      await until("both planner calls", () => writers.every((w) => plannerCallArrived(join(dir, `${w.name}.calls.jsonl`))), 30_000, diag);
      await until("the watch loop", () => watch.stderr().includes("watching "), 30_000, diag);
      writeFileSync(join(dir, "release-planners"), "");

      const results = await Promise.all(chats.map((c) => c.done()));
      expect(results.map((r) => r.code)).toEqual([0, 0]);
      await sleep(200); // a few more watch ticks
      watch.proc.kill("SIGINT");
      const w = await watch.done();
      expect(w.code).toBe(0);

      const db = new Database(join(stateDir, "queue.sqlite"), { readonly: true });
      let rows: { mutation_id: string; state: string; last_error: string | null }[];
      try {
        rows = db.query("SELECT mutation_id, state, last_error FROM mutations ORDER BY seq").all() as typeof rows;
      } finally {
        db.close();
      }
      const failed = rows.filter((r) => r.state === "FAILED" || r.state === "FAILED_INVALID_EXECUTION");
      expect({ failed, diag: failed.length > 0 ? diag() : "" }).toEqual({ failed: [], diag: "" });
      // one row per writer: an enqueue that lost a race to the other process would leave none
      expect({ rows: rows.length, diag: rows.length !== 2 ? diag() : "" }).toEqual({ rows: 2, diag: "" });
      for (const r of rows) {
        expect({ id: r.mutation_id, onAgent: commitsWithMutationId(repo, "agent/repo", r.mutation_id).length, state: r.state, lastError: r.last_error }).toEqual({
          id: r.mutation_id,
          onAgent: 1,
          state: "INTEGRATED",
          lastError: null,
        });
      }
      // nothing on the branch that the queue does not know about, and nothing twice
      expect(mutationIdsOn(repo, "agent/repo").sort()).toEqual(rows.map((r) => r.mutation_id).sort());
      expect(git(agentWorktree, "status", "--porcelain")).toBe("");
      for (const wr of writers) expect(fileAt(repo, "main", `knowledge/${wr.slug}.md`)).toContain(`# ${wr.title}`);
    },
    TIMEOUT_MS,
  );
});
