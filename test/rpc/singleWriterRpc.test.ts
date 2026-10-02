/**
 * CR-1 acceptance test 1 (docs/mac-app/design.md §5.2) with the RPC server as
 * one of the writers (protocol §9; T1.7). Three processes write to one repo
 * at the same moment:
 *
 * - the loop owner, draining and integrating every 50 ms;
 * - a `brain chat --once` whose knowledge run submits a mutation;
 * - `brain rpc --stdio`, whose `conversation.send` knowledge run submits one.
 *
 * The loop owner is either a `brain watch --interval 50` (the server runs no
 * loop, `loopOwner: "other"`) or the server itself (`engine.intervalMs: 50`,
 * `loopOwner: "self"`), so the server is a writer through its pipeline in
 * both cases and through its loop in the second.
 *
 * As in test/unit/singleWriter.test.ts, both planner calls are held until both
 * have arrived and then released together, and every process runs with the
 * executor's test-only delay between writing a mutation's files and reading
 * them back, so executions without the cross-process lock would overlap.
 * Afterwards there is no FAILED or FAILED_INVALID_EXECUTION row, every
 * Mutation-ID is on `agent/repo` exactly once and INTEGRATED, and the agent
 * worktree is clean.
 *
 * This is a Bun test rather than a transcript: the server under test needs
 * the executor delay in its environment, which a transcript header cannot
 * give it, and the assertions are on repo state, not on protocol messages.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Subprocess } from "bun";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXECUTE_DELAY_ENV } from "../../src/core/executor";
import type { ModelScript } from "../../src/pipeline/scripted";
import { commitsWithMutationId, fileAt, git, mutationIdsOn } from "../harness";
import { CLI, killAllServers, RpcProcess, serverEnv } from "./harness";

const TIMEOUT_MS = 90_000;
/** Long enough that two executions started together always overlap. */
const EXECUTE_DELAY_MS = 400;
const INTERVAL_MS = 50;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

let dir: string;
let home: string;
let repo: string;
let children: Subprocess[] = [];

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "brain-single-writer-rpc-")));
  home = join(dir, "home");
  repo = join(dir, "repo");
  mkdirSync(home);
  mkdirSync(repo);
});
afterEach(async () => {
  await killAllServers();
  for (const c of children) {
    try {
      c.kill("SIGKILL");
    } catch {}
    await c.exited;
  }
  children = [];
  rmSync(dir, { recursive: true, force: true });
});

const delay = { [EXECUTE_DELAY_ENV]: String(EXECUTE_DELAY_MS) };

function runSync(args: string[]): number {
  return Bun.spawnSync([process.execPath, CLI, ...args], { cwd: repo, env: serverEnv(home), stdout: "pipe", stderr: "pipe", stdin: "ignore" }).exitCode;
}

/** `brain <args>` in the background, stderr collected as it arrives. */
function spawnBrain(args: string[], extra: Record<string, string>) {
  const proc = Bun.spawn([process.execPath, CLI, ...args], { cwd: repo, env: serverEnv(home, extra), stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  children.push(proc);
  void new Response(proc.stdout).text();
  let err = "";
  const stderrDone = (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of proc.stderr) err += decoder.decode(chunk, { stream: true });
  })();
  return {
    proc,
    stderr: () => err,
    async done(): Promise<{ code: number; err: string }> {
      const code = await proc.exited;
      await stderrDone;
      return { code, err };
    },
  };
}

async function until(what: string, cond: () => boolean, diag: () => string, timeoutMs = 30_000): Promise<void> {
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

/** One writer's script: a reply, one grounded candidate, and a plan that creates `slug` once `release` exists. */
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

const writers = {
  chat: { slug: "undo-replaces-approval", title: "Undo replaces approval", text: "Cheap undo means an agent can act first and be reviewed afterwards." },
  rpc: { slug: "review-after-the-fact", title: "Review after the fact", text: "Reviewing agent changes after the fact scales better than approving each one." },
};

async function scenario(loopOwner: "watch" | "rpc"): Promise<void> {
  expect(runSync(["init", repo])).toBe(0);
  expect(runSync(["status"])).toBe(0); // the agent worktree and index exist before the race starts
  const repoId = readFileSync(join(repo, "brain.toml"), "utf8").match(/repo_id = "([^"]+)"/)![1]!;
  const stateDir = join(home, "repos", repoId);
  for (const [name, w] of Object.entries(writers)) writeFileSync(join(dir, `${name}.json`), JSON.stringify(writerScript(w.slug, w.title, "release-planners"), null, 2));

  const watch = loopOwner === "watch" ? spawnBrain(["watch", "--interval", String(INTERVAL_MS), "--no-embeddings"], delay) : null;
  if (watch !== null) await until("the watch loop", () => watch.stderr().includes("watching "), () => watch.stderr());

  const server = RpcProcess.spawn({ home, cwd: dir, env: { ...delay, BRAIN_MODEL_SCRIPT: join(dir, "rpc.json") } });
  const chat = spawnBrain(["chat", "--once", writers.chat.text], { ...delay, BRAIN_MODEL_SCRIPT: join(dir, "chat.json") });
  const diag = () => [watch ? `watch:\n${watch.stderr()}` : "", `chat:\n${chat.stderr()}`, `rpc:\n${server.stderrTail()}`].join("\n");

  const init = await server.request("init", "initialize", { protocolVersion: 1, client: { name: "test", version: "0" }, repoPath: repo, env: { BRAIN_EMBEDDINGS: "hashing" }, engine: { intervalMs: INTERVAL_MS } });
  expect(init["type"]).toBe("result");
  expect((init["data"] as { engine: { loopOwner: string } }).engine.loopOwner).toBe(loopOwner === "rpc" ? "self" : "other");
  const created = await server.request("c", "conversation.create");
  const sessionId = (created["data"] as { sessionId: string }).sessionId;
  const sent = await server.request("send", "conversation.send", { sessionId, text: writers.rpc.text });
  expect(sent["type"]).toBe("result");

  // Both planners are waiting and the loop is running; release both writers at once.
  await until("both planner calls", () => plannerCallArrived(join(dir, "chat.calls.jsonl")) && plannerCallArrived(join(dir, "rpc.calls.jsonl")), diag);
  writeFileSync(join(dir, "release-planners"), "");

  expect((await chat.done()).code).toBe(0);
  const done = await server.waitFor((m) => m["type"] === "knowledge.event" && (m["data"] as { event: { type: string } }).event.type === "done", { timeoutMs: 30_000 });
  const update = (done["data"] as { event: { update: { mutations: { state: string }[]; errors: string[] } } }).event.update;
  expect({ update, diag: update.errors.length > 0 ? diag() : "" }).toMatchObject({ update: { errors: [] }, diag: "" });
  await sleep(INTERVAL_MS * 4); // a few more loop ticks

  server.send({ id: "bye", method: "shutdown", params: {} });
  expect(await server.finished).toBe(0);
  if (watch !== null) {
    watch.proc.kill("SIGINT");
    expect((await watch.done()).code).toBe(0);
  }

  const db = new Database(join(stateDir, "queue.sqlite"), { readonly: true });
  let rows: { mutation_id: string; state: string; last_error: string | null }[];
  try {
    rows = db.query("SELECT mutation_id, state, last_error FROM mutations ORDER BY seq").all() as typeof rows;
  } finally {
    db.close();
  }
  const failed = rows.filter((r) => r.state === "FAILED" || r.state === "FAILED_INVALID_EXECUTION");
  expect({ failed, diag: failed.length > 0 ? diag() : "" }).toEqual({ failed: [], diag: "" });
  // one row per writer: an enqueue that lost a race to another process would leave none
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
  expect(git(join(stateDir, "worktrees", "agent"), "status", "--porcelain")).toBe("");
  for (const w of Object.values(writers)) expect(fileAt(repo, "main", `knowledge/${w.slug}.md`)).toContain(`# ${w.title}`);
}

describe("one writer at a time across processes, with the RPC server as a writer (CR-1 acceptance test 1)", () => {
  test("brain watch --interval 50 owns the loop; brain chat --once and conversation.send write at once", () => scenario("watch"), TIMEOUT_MS);
  test("the RPC server owns the loop (intervalMs 50); brain chat --once and conversation.send write at once", () => scenario("rpc"), TIMEOUT_MS);
});
