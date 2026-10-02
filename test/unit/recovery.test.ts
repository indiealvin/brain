/**
 * CR-1 (T0.6; docs/mac-app/design.md §5.2; spec §17, §34): accept
 * reconciliation and continuous recovery.
 *
 * - Acceptance test 4: a crash between the ACCEPTED write and the enqueue
 *   (injected with the test-only `ACCEPT_CRASH_ENV` hook in a `brain
 *   proposals accept` process) is completed after a restart: exactly one
 *   commit with the proposal's Mutation-ID, and the proposal ACCEPTED. When
 *   the target changed while the process was down, nothing commits and the
 *   proposal is STALE. A process that was already running completes it at its
 *   next drain, without a restart.
 * - A `RUNNING` row and a dirty agent worktree left by a SIGKILLed process
 *   are resolved by another process's next `drainQueued`, without a restart
 *   and without `recover()`.
 * - An accepted mutation that committed but was invalidated at rebuild before
 *   it integrated leaves its proposal STALE after the next staleness refresh
 *   or drain.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { Subprocess } from "bun";
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { ACCEPT_CRASH_ENV } from "../../src/core/coordinator";
import { EXECUTE_DELAY_ENV } from "../../src/core/executor";
import { AGENT_BRANCH } from "../../src/core/types";
import type { ExecutionResult, Proposal, RepoCoordinator } from "../../src/core/types";
import { isLockHeld, WORKTREE_LOCK } from "../../src/sync/lock";
import {
  blobAt,
  commitAsHuman,
  commitsWithMutationId,
  createMutation,
  fileAt,
  forceQueueState,
  isClean,
  newMutationId,
  reopen,
  revParse,
  seedNote,
  setupEnv,
  trailer,
  type Env,
} from "../harness";

const ROOT = join(import.meta.dir, "..", "..");
const CLI = resolve(ROOT, "src", "cli.ts");
const COORD_MODULE = join(ROOT, "src", "core", "coordinator.ts");
const SPAWN_TIMEOUT_MS = 60_000;

/** Removed from every child's env: no model keys or provider settings, and no test hook unless a test sets it. */
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
  ACCEPT_CRASH_ENV,
];

type Coord = RepoCoordinator & { drainQueued(): Promise<ExecutionResult[]> };

let env: Env | null = null;
let children: Subprocess[] = [];
afterEach(async () => {
  for (const c of children) {
    try {
      c.kill("SIGKILL");
    } catch {}
    await c.exited;
  }
  children = [];
  if (env) await env.cleanup();
  env = null;
});

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function until(what: string, cond: () => boolean, diag: () => string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}\n${diag()}`);
    await sleep(10);
  }
}

function childEnv(e: Env, extra: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = { ...(process.env as Record<string, string>), BRAIN_HOME: e.home };
  for (const k of STRIP) delete out[k];
  return { ...out, ...extra };
}

function mkProposal(p: Pick<Proposal, "operation" | "targets" | "writes">): Proposal {
  const id = newMutationId().replace(/^mut_/, "prop_");
  return { proposalId: id, mutationId: newMutationId(), evidence: ["conversation://unit/1"], reasoning: "unit", createdAt: new Date().toISOString(), status: "PENDING", ...p };
}

/** A PENDING ARCHIVE proposal for a note seeded on main and integrated, so agent/repo has it too. */
async function archiveProposal(e: Env, slug: string): Promise<{ p: Proposal; path: string; content: string; archived: string }> {
  const x = seedNote(e, `knowledge/${slug}.md`, { title: slug.toUpperCase(), sections: { Claim: `${slug} claim` } });
  await e.coord.integrate();
  const archived = x.content.replace("status: active", "status: archived");
  const p = mkProposal({
    operation: "ARCHIVE",
    targets: [{ noteId: x.id, path: x.path, blobHash: blobAt(e.repo.path, "main", x.path)! }],
    writes: [{ path: x.path, content: archived }],
  });
  await e.coord.submitProposal(p);
  return { p, path: x.path, content: x.content, archived };
}

/** The stored proposal, read without the lock and without a staleness refresh. */
function storedProposal(e: Env, id: string): { status: string; resolved_at: string | null } | null {
  const db = new Database(e.coord.paths.proposalsDb, { readonly: true });
  try {
    return db.query("SELECT status, resolved_at FROM proposals WHERE proposal_id = ?").get(id) as { status: string; resolved_at: string | null } | null;
  } finally {
    db.close();
  }
}

interface RawRow {
  state: string;
  type: string;
  summary: string;
  targets_json: string;
  writes_json: string;
  depends_on_json: string;
  evidence_json: string;
  reasoning: string | null;
  attempt_count: number;
  last_error: string | null;
}

function queueRow(e: Env, mutationId: string): RawRow | null {
  const db = new Database(e.coord.paths.queueDb, { readonly: true });
  try {
    return db.query("SELECT * FROM mutations WHERE mutation_id = ?").get(mutationId) as RawRow | null;
  } finally {
    db.close();
  }
}

/** `brain proposals accept <id>` with the crash hook: the process SIGKILLs itself after the ACCEPTED write. */
function acceptAndCrash(e: Env, proposalId: string): void {
  const r = Bun.spawnSync([process.execPath, CLI, "proposals", "accept", proposalId], {
    cwd: e.repo.path,
    env: childEnv(e, { [ACCEPT_CRASH_ENV]: "1" }),
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const diag = `exit=${r.exitCode} signal=${r.signalCode}\nstdout:\n${r.stdout.toString()}\nstderr:\n${r.stderr.toString()}`;
  expect({ signal: r.signalCode ?? null, out: r.stdout.toString(), diag: r.signalCode === "SIGKILL" ? "" : diag }).toEqual({ signal: "SIGKILL", out: "", diag: "" });
}

/** The crash hit the window: the decision is recorded, the mutation is not, and the dead holder's lock is gone. */
function expectCrashedBetweenAcceptAndEnqueue(e: Env, p: Proposal): void {
  expect(storedProposal(e, p.proposalId)?.status).toBe("ACCEPTED");
  expect(queueRow(e, p.mutationId)).toBeNull();
  expect(commitsWithMutationId(e.repo.path, AGENT_BRANCH, p.mutationId)).toEqual([]);
  expect(commitsWithMutationId(e.repo.path, "main", p.mutationId)).toEqual([]);
  expect(isLockHeld(e.coord.paths.runtimeDir, WORKTREE_LOCK)).toBe(false);
}

/** The reconciled accept ran exactly the mutation `acceptProposal` builds from the proposal, and it integrated. */
function expectAcceptCompleted(e: Env, p: Proposal, path: string, archived: string): void {
  const repo = e.repo.path;
  expect(commitsWithMutationId(repo, "main", p.mutationId).length).toBe(1);
  expect(commitsWithMutationId(repo, AGENT_BRANCH, p.mutationId).length).toBe(1);
  expect(storedProposal(e, p.proposalId)?.status).toBe("ACCEPTED");
  const row = queueRow(e, p.mutationId)!;
  expect({
    state: row.state,
    type: row.type,
    summary: row.summary,
    targets: JSON.parse(row.targets_json),
    writes: JSON.parse(row.writes_json),
    dependsOn: JSON.parse(row.depends_on_json),
    evidence: JSON.parse(row.evidence_json),
    reasoning: row.reasoning,
  }).toEqual({
    state: "INTEGRATED",
    type: "ARCHIVE",
    summary: `archive ${path.replace(/^.*\//, "")}`,
    targets: p.targets.map((t) => ({ kind: "present", ...t })),
    writes: p.writes,
    dependsOn: [],
    evidence: p.evidence,
    reasoning: p.reasoning,
  });
  const sha = commitsWithMutationId(repo, "main", p.mutationId)[0]!;
  expect(trailer(repo, sha, "Mutation-Type")).toBe("ARCHIVE");
  expect(fileAt(repo, "main", path)).toBe(archived);
  expect(revParse(repo, AGENT_BRANCH)).toBe(revParse(repo, "main"));
  expect(isClean(e.coord.paths.agentWorktree)).toBe(true);
  expect(isClean(repo)).toBe(true);
}

describe("an accept completes after a crash between the ACCEPTED write and the enqueue (CR-1 acceptance test 4)", () => {
  test(
    "after a restart (open + recover) there is exactly one commit with the Mutation-ID and the proposal is ACCEPTED",
    async () => {
      env = await setupEnv();
      const e = env;
      const { p, path, archived } = await archiveProposal(e, "crashed");

      acceptAndCrash(e, p.proposalId);
      expectCrashedBetweenAcceptAndEnqueue(e, p);

      // Restart: what every `brain` command does on open (`openRepo` → `recover()`).
      const coord = await reopen(e);
      await coord.recover();
      expectAcceptCompleted(e, p, path, archived);

      // Idempotent: another restart, and a drain, change nothing.
      const heads = { main: revParse(e.repo.path, "main"), agent: revParse(e.repo.path, AGENT_BRANCH) };
      await (await reopen(e)).recover();
      expect(await (e.coord as Coord).drainQueued()).toEqual([]);
      expectAcceptCompleted(e, p, path, archived);
      expect({ main: revParse(e.repo.path, "main"), agent: revParse(e.repo.path, AGENT_BRANCH) }).toEqual(heads);
      expect(queueRow(e, p.mutationId)!.attempt_count).toBe(1);
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    "when the target changes while the process is down, nothing commits and the proposal is STALE",
    async () => {
      env = await setupEnv();
      const e = env;
      const repo = e.repo.path;
      const { p, path, content } = await archiveProposal(e, "changed");

      acceptAndCrash(e, p.proposalId);
      expectCrashedBetweenAcceptAndEnqueue(e, p);

      const human = content.replace("changed claim", "edited by the human while brain was down");
      await Bun.write(join(repo, path), human);
      const humanSha = commitAsHuman(repo, "user: edit changed");

      const coord = await reopen(e);
      await coord.recover();
      expect(commitsWithMutationId(repo, "main", p.mutationId)).toEqual([]);
      expect(commitsWithMutationId(repo, AGENT_BRANCH, p.mutationId)).toEqual([]);
      expect(storedProposal(e, p.proposalId)?.status).toBe("STALE");
      const row = queueRow(e, p.mutationId)!;
      expect(row.state).toBe("REPLAN");
      expect(row.last_error).toStartWith("PRECONDITION_FAILED");
      expect(revParse(repo, "main")).toBe(humanSha);
      expect(fileAt(repo, "main", path)).toBe(human);
      expect(isClean(e.coord.paths.agentWorktree)).toBe(true);

      // REPLAN is terminal (I-6): nothing replays it later.
      await (await reopen(e)).recover();
      expect(await (e.coord as Coord).drainQueued()).toEqual([]);
      expect(commitsWithMutationId(repo, AGENT_BRANCH, p.mutationId)).toEqual([]);
      expect(storedProposal(e, p.proposalId)?.status).toBe("STALE");
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    "a process that was already running completes the accept at its next drain, without a restart",
    async () => {
      env = await setupEnv();
      const e = env;
      const coord = e.coord as Coord; // opened before the crash; never reopened or recovered below
      const { p, path, archived } = await archiveProposal(e, "drained");

      acceptAndCrash(e, p.proposalId);
      expectCrashedBetweenAcceptAndEnqueue(e, p);

      const drained = await coord.drainQueued();
      expect(drained.map((r) => [r.mutationId, r.state])).toEqual([[p.mutationId, "INTEGRATED"]]);
      expectAcceptCompleted(e, p, path, archived);
      expect(e.coord).toBe(coord);
    },
    SPAWN_TIMEOUT_MS,
  );
});

describe("recovery runs at the start of every drain (CR-1)", () => {
  test(
    "a RUNNING row and a dirty agent worktree left by a SIGKILLed process are resolved by another process's next drain",
    async () => {
      env = await setupEnv();
      const e = env;
      const repo = e.repo.path;
      const coord = e.coord as Coord; // this "other process" was open all along; it never restarts or calls recover()
      const m = createMutation("knowledge/killed.md", { title: "Killed" });
      await coord.enqueue(m);
      const written = join(coord.paths.agentWorktree, "knowledge", "killed.md");

      // Another process executes it and is SIGKILLed mid-execution: files written, nothing committed.
      const script = `
        const { openCoordinator } = await import(${JSON.stringify(COORD_MODULE)});
        const coord = await openCoordinator(${JSON.stringify(repo)});
        console.log("OPEN");
        const r = await coord.execute(${JSON.stringify(m.mutationId)});
        console.log("DONE " + JSON.stringify(r));
      `;
      const proc = Bun.spawn([process.execPath, "-e", script], {
        env: childEnv(e, { [EXECUTE_DELAY_ENV]: "60000" }),
        stdout: "pipe",
        stderr: "pipe",
        stdin: "ignore",
      });
      children.push(proc);
      let out = "";
      void (async () => {
        const decoder = new TextDecoder();
        for await (const chunk of proc.stdout) out += decoder.decode(chunk, { stream: true });
      })();
      let err = "";
      void (async () => {
        const decoder = new TextDecoder();
        for await (const chunk of proc.stderr) err += decoder.decode(chunk, { stream: true });
      })();
      const diag = () => `child exit=${proc.exitCode}\nstdout:\n${out}\nstderr:\n${err}`;
      await until("the child to be mid-execution", () => proc.exitCode !== null || (queueRow(e, m.mutationId)?.state === "RUNNING" && existsSync(written)), diag);
      expect(proc.exitCode).toBeNull();
      proc.kill("SIGKILL");
      await proc.exited;
      expect(proc.signalCode).toBe("SIGKILL");

      // What the dead process left behind.
      expect(queueRow(e, m.mutationId)!.state).toBe("RUNNING");
      expect(isClean(coord.paths.agentWorktree)).toBe(false);
      expect(commitsWithMutationId(repo, AGENT_BRANCH, m.mutationId)).toEqual([]);
      expect(isLockHeld(coord.paths.runtimeDir, WORKTREE_LOCK)).toBe(false);

      const drained = await coord.drainQueued();
      expect(drained.map((r) => [r.mutationId, r.state])).toEqual([[m.mutationId, "COMMITTED"]]);
      const row = queueRow(e, m.mutationId)!;
      expect({ state: row.state, attempts: row.attempt_count, lastError: row.last_error }).toEqual({ state: "INTEGRATED", attempts: 2, lastError: null });
      expect(commitsWithMutationId(repo, AGENT_BRANCH, m.mutationId).length).toBe(1);
      expect(commitsWithMutationId(repo, "main", m.mutationId).length).toBe(1);
      expect(fileAt(repo, "main", "knowledge/killed.md")).toContain("# Killed");
      expect(isClean(coord.paths.agentWorktree)).toBe(true);
      expect(e.coord).toBe(coord);
    },
    SPAWN_TIMEOUT_MS,
  );

  test("a RUNNING row whose commit is on agent/repo becomes COMMITTED at the next drain, without re-executing (I-7)", async () => {
    env = await setupEnv();
    const e = env;
    const repo = e.repo.path;
    const coord = e.coord as Coord;
    const m = createMutation("knowledge/committed.md", { title: "Committed" });
    await coord.enqueue(m);
    expect((await coord.execute(m.mutationId)).state).toBe("COMMITTED");
    const agent = revParse(repo, AGENT_BRANCH);
    forceQueueState(e, m.mutationId, "RUNNING"); // its holder died between the commit and the queue update

    expect(await coord.drainQueued()).toEqual([]);
    const row = queueRow(e, m.mutationId)!;
    expect({ state: row.state, attempts: row.attempt_count }).toEqual({ state: "COMMITTED", attempts: 1 });
    expect(revParse(repo, AGENT_BRANCH)).toBe(agent);
    expect(commitsWithMutationId(repo, AGENT_BRANCH, m.mutationId).length).toBe(1);
    expect((await coord.integrate()).integratedMutationIds).toEqual([m.mutationId]);
  });

  test("a BLOCKED row becomes REPLAN at the next drain and never executes (§17 step 4)", async () => {
    env = await setupEnv();
    const e = env;
    const coord = e.coord as Coord;
    const m = createMutation("knowledge/blocked.md", { title: "Blocked" });
    await coord.enqueue(m);
    forceQueueState(e, m.mutationId, "BLOCKED");

    expect(await coord.drainQueued()).toEqual([]);
    expect(queueRow(e, m.mutationId)!.state).toBe("REPLAN");
    expect(commitsWithMutationId(e.repo.path, AGENT_BRANCH, m.mutationId)).toEqual([]);
  });
});

describe("an accepted mutation invalidated at rebuild leaves its proposal STALE (§34, CR-1)", () => {
  /**
   * Accept while the human has an unsaved edit of the target, so the accepted
   * mutation commits on agent/repo but integration is refused. The edit then
   * lands on main (Human Sync), and the rebuild sends the mutation to REPLAN.
   * Returns the proposal, still ACCEPTED: the rebuild itself marks nothing.
   */
  async function acceptedThenInvalidated(e: Env): Promise<Proposal> {
    const repo = e.repo.path;
    const { p, path, content } = await archiveProposal(e, "edited");
    const human = content.replace("edited claim", "the human's edit");
    await Bun.write(join(repo, path), human); // newer than the clock: not quiescent yet

    const r = await e.coord.acceptProposal(p.proposalId);
    expect(r.state).toBe("COMMITTED"); // integration refused: the dirty target would be overwritten
    expect(storedProposal(e, p.proposalId)?.status).toBe("ACCEPTED");
    expect(commitsWithMutationId(repo, AGENT_BRANCH, p.mutationId).length).toBe(1);

    e.clock.advance(60_000);
    const ir = await e.coord.integrate(); // Human Sync commits the edit; main moved, so rebuild
    expect(ir.integratedMutationIds).toEqual([]);
    expect(queueRow(e, p.mutationId)!.state).toBe("REPLAN");
    expect(queueRow(e, p.mutationId)!.last_error).toStartWith("PRECONDITION_FAILED");
    expect(fileAt(repo, "main", path)).toBe(human);
    expect(commitsWithMutationId(repo, "main", p.mutationId)).toEqual([]);
    expect(commitsWithMutationId(repo, AGENT_BRANCH, p.mutationId)).toEqual([]);
    expect(storedProposal(e, p.proposalId)?.status).toBe("ACCEPTED");
    return p;
  }

  test("the next listProposals staleness refresh marks it STALE", async () => {
    env = await setupEnv();
    const p = await acceptedThenInvalidated(env);
    const listed = (await env.coord.listProposals()).find((q) => q.proposalId === p.proposalId)!;
    expect(listed.status).toBe("STALE");
    expect(listed.resolvedAt).toBe(new Date(env.clock.now()).toISOString());
    expect(storedProposal(env, p.proposalId)?.status).toBe("STALE");
  });

  test("the next drain marks it STALE and executes nothing", async () => {
    env = await setupEnv();
    const p = await acceptedThenInvalidated(env);
    const main = revParse(env.repo.path, "main");
    expect(await (env.coord as Coord).drainQueued()).toEqual([]);
    expect(storedProposal(env, p.proposalId)?.status).toBe("STALE");
    expect(queueRow(env, p.mutationId)!.state).toBe("REPLAN");
    expect(revParse(env.repo.path, "main")).toBe(main);
  });
});
