/**
 * CR-1 acceptance test 2 (docs/mac-app/design.md §5.2; spec §34): two
 * processes accept and reject the same PENDING proposal at the same time,
 * and exactly one decision wins.
 * - A winning accept leaves the proposal ACCEPTED (here the mutation
 *   integrates), and the reject fails with PROPOSAL_NOT_PENDING.
 * - A winning reject leaves it REJECTED, and the accept returns
 *   `REPLAN` / `"STALE"` without executing: no queue row and no commit with
 *   its Mutation-ID.
 *
 * Each child process opens its own coordinator on the shared repo and calls
 * `acceptProposal` or `rejectProposal` when the test writes a proposal id to
 * its stdin. Rounds released together leave the winner to the race. To show
 * both outcomes deterministically, the forced rounds also hold a write
 * transaction on `proposals.sqlite` (the "gate"): no decision can be written
 * while it is open. The winner is released first and the test waits until it
 * holds the worktree lock; then the loser is released, and the gate opens
 * only once the loser's call has started. So the loser's call is in flight
 * before the winner's decision exists, and runs its own check after it.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { Subprocess } from "bun";
import { Database } from "bun:sqlite";
import { join, resolve } from "node:path";
import { AGENT_BRANCH } from "../../src/core/types";
import type { Proposal } from "../../src/core/types";
import { isLockHeld, readLockHolder, WORKTREE_LOCK } from "../../src/sync/lock";
import { blobAt, commitAsHuman, commitsWithMutationId, isClean, newMutationId, revParse, seedNote, setupEnv, type Env } from "../harness";

const ROOT = join(import.meta.dir, "..", "..");
const COORD_MODULE = join(ROOT, "src", "core", "coordinator.ts");
const LOCK_MODULE = join(ROOT, "src", "sync", "lock.ts");
const CLI = resolve(ROOT, "src", "cli.ts");
const TIMEOUT_MS = 120_000;
/** Free-race rounds, alternating which child is sent the proposal id first. */
const FREE_ROUNDS = 4;
const REJECT_NOTE = "rejected in the race";
/** Removed from the CLI child's env, as in cli.test.ts: no model keys or provider settings leak in. */
const PROVIDER_VARS = [
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
];

type Role = "accept" | "reject";

interface Msg {
  ev: "READY" | "CALLING" | "RESULT";
  pid: number;
  id?: string;
  at?: number;
  ok?: boolean;
  value?: any;
  error?: { name?: string; code?: string; status?: string; message: string };
}

let env: Env | null = null;
let children: Subprocess<"pipe", "pipe", "pipe">[] = [];
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
    await sleep(2);
  }
}

/** The child: open a coordinator, then decide each proposal id read from stdin, reporting on stdout. */
function childScript(role: Role, repo: string): string {
  const call = role === "accept" ? "coord.acceptProposal(id)" : `coord.rejectProposal(id, ${JSON.stringify(REJECT_NOTE)})`;
  return `
    const { openCoordinator } = await import(${JSON.stringify(COORD_MODULE)});
    const { setLockHolderKind } = await import(${JSON.stringify(LOCK_MODULE)});
    const { createInterface } = await import("node:readline");
    setLockHolderKind(${JSON.stringify(role)});
    const out = (m) => process.stdout.write("MSG " + JSON.stringify({ pid: process.pid, ...m }) + "\\n");
    const coord = await openCoordinator(${JSON.stringify(repo)});
    out({ ev: "READY" });
    for await (const line of createInterface({ input: process.stdin })) {
      const id = line.trim();
      if (!id) continue;
      out({ ev: "CALLING", id, at: Date.now() });
      try {
        const value = await ${call};
        out({ ev: "RESULT", id, at: Date.now(), ok: true, value: value ?? null });
      } catch (e) {
        out({ ev: "RESULT", id, at: Date.now(), ok: false, error: { name: e?.name, code: e?.code, status: e?.status, message: String(e?.message ?? e) } });
      }
    }
    await coord.close();
  `;
}

interface Child {
  role: Role;
  pid: number;
  send(proposalId: string): void;
  /** The first message `ev` for `id`; never consumes. */
  next(ev: Msg["ev"], id?: string): Promise<Msg>;
  seen(ev: Msg["ev"], id: string): boolean;
  diag(): string;
  end(): Promise<number>;
}

async function spawnChild(role: Role, e: Env): Promise<Child> {
  const childEnv: Record<string, string> = { ...(process.env as Record<string, string>), BRAIN_HOME: e.home };
  delete childEnv["BRAIN_TEST_EXECUTE_DELAY_MS"];
  const proc = Bun.spawn([process.execPath, "-e", childScript(role, e.repo.path)], {
    env: childEnv,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  children.push(proc);
  const msgs: Msg[] = [];
  let out = "";
  let err = "";
  void (async () => {
    const decoder = new TextDecoder();
    let buf = "";
    for await (const chunk of proc.stdout) {
      const text = decoder.decode(chunk, { stream: true });
      out += text;
      buf += text;
      for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line.startsWith("MSG ")) msgs.push(JSON.parse(line.slice(4)) as Msg);
      }
    }
  })();
  void (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of proc.stderr) err += decoder.decode(chunk, { stream: true });
  })();
  const find = (ev: Msg["ev"], id?: string) => msgs.find((m) => m.ev === ev && (id === undefined || m.id === id));
  const diag = () => `${role} child (pid ${proc.pid}) exit=${proc.exitCode}\nstdout:\n${out}\nstderr:\n${err}`;
  const child: Child = {
    role,
    pid: proc.pid,
    send(id) {
      proc.stdin.write(`${id}\n`);
      proc.stdin.flush();
    },
    async next(ev, id) {
      await until(`${role} ${ev}${id ? ` ${id}` : ""}`, () => find(ev, id) !== undefined || proc.exitCode !== null, diag);
      const m = find(ev, id);
      if (!m) throw new Error(`${role} child exited before ${ev}\n${diag()}`);
      return m;
    },
    seen: (ev, id) => find(ev, id) !== undefined,
    diag,
    async end() {
      proc.stdin.end();
      return proc.exited;
    },
  };
  await child.next("READY");
  return child;
}

function mkProposal(p: Pick<Proposal, "operation" | "targets" | "writes">): Proposal {
  const id = newMutationId().replace(/^mut_/, "prop_");
  return { proposalId: id, mutationId: newMutationId(), evidence: ["conversation://unit/1"], reasoning: "unit", createdAt: new Date().toISOString(), status: "PENDING", ...p };
}

/** A PENDING ARCHIVE proposal for a fresh note on main, integrated so agent/repo has it too. */
async function pendingProposal(e: Env, slug: string): Promise<Proposal> {
  const x = seedNote(e, `knowledge/${slug}.md`, { title: slug.toUpperCase(), sections: { Claim: `${slug} claim` } });
  await e.coord.integrate();
  const p = mkProposal({
    operation: "ARCHIVE",
    targets: [{ noteId: x.id, path: x.path, blobHash: blobAt(e.repo.path, "main", x.path)! }],
    writes: [{ path: x.path, content: x.content.replace("status: active", "status: archived") }],
  });
  await e.coord.submitProposal(p);
  return p;
}

/** The stored proposal, read without the lock and without a staleness refresh. */
function stored(e: Env, id: string): { status: string; decision_note: string | null } {
  const db = new Database(e.coord.paths.proposalsDb, { readonly: true });
  try {
    return db.query("SELECT status, decision_note FROM proposals WHERE proposal_id = ?").get(id) as { status: string; decision_note: string | null };
  } finally {
    db.close();
  }
}

function queueRow(e: Env, mutationId: string): { state: string } | null {
  const db = new Database(e.coord.paths.queueDb, { readonly: true });
  try {
    return db.query("SELECT state FROM mutations WHERE mutation_id = ?").get(mutationId) as { state: string } | null;
  } finally {
    db.close();
  }
}

/**
 * Exactly one decision took effect, and the loser saw it: the invariants of
 * design §5.2 test 2 for whichever side won. Returns the winner.
 */
function checkOneWinner(e: Env, p: Proposal, acc: Msg, rej: Msg, heads: { main: string; agent: string }): Role {
  const repo = e.repo.path;
  const row = stored(e, p.proposalId);
  const diag = JSON.stringify({ accept: acc, reject: rej, stored: row });
  let winner: Role;
  if (rej.ok) {
    winner = "reject";
    expect({ row, diag }).toEqual({ row: { status: "REJECTED", decision_note: REJECT_NOTE }, diag });
    // The accept found it decided and executed nothing.
    expect({ accept: acc.ok ? acc.value : acc.error, diag }).toEqual({ accept: { mutationId: p.mutationId, state: "REPLAN", error: "STALE" }, diag });
    expect(queueRow(e, p.mutationId)).toBeNull();
    expect(commitsWithMutationId(repo, "main", p.mutationId)).toEqual([]);
    expect(commitsWithMutationId(repo, AGENT_BRANCH, p.mutationId)).toEqual([]);
    expect({ main: revParse(repo, "main"), agent: revParse(repo, AGENT_BRANCH) }).toEqual(heads);
  } else {
    winner = "accept";
    // The proposal was fresh, so the accepted mutation applied: ACCEPTED, not STALE via REPLAN.
    expect({ accept: acc.ok ? { state: acc.value.state, mutationId: acc.value.mutationId } : acc.error, diag }).toEqual({
      accept: { state: "INTEGRATED", mutationId: p.mutationId },
      diag,
    });
    expect({ row, diag }).toEqual({ row: { status: "ACCEPTED", decision_note: null }, diag });
    // The reject lost the compare-and-set and wrote nothing.
    expect({ reject: rej.error, diag }).toEqual({
      reject: {
        name: "ProposalNotPendingError",
        code: "PROPOSAL_NOT_PENDING",
        status: "ACCEPTED",
        message: `proposal ${p.proposalId} is already ACCEPTED (PROPOSAL_NOT_PENDING)`,
      },
      diag,
    });
    expect(queueRow(e, p.mutationId)).toEqual({ state: "INTEGRATED" });
    expect(commitsWithMutationId(repo, "main", p.mutationId).length).toBe(1);
    expect(commitsWithMutationId(repo, AGENT_BRANCH, p.mutationId).length).toBe(1);
  }
  expect(isClean(e.coord.paths.agentWorktree)).toBe(true);
  return winner;
}

const headsOf = (e: Env) => ({ main: revParse(e.repo.path, "main"), agent: revParse(e.repo.path, AGENT_BRANCH) });

/** Release both children together; the race picks the winner. */
async function freeRound(e: Env, acc: Child, rej: Child, p: Proposal, acceptFirst: boolean): Promise<Role> {
  const heads = headsOf(e);
  for (const c of acceptFirst ? [acc, rej] : [rej, acc]) c.send(p.proposalId);
  const [a, r] = await Promise.all([acc.next("RESULT", p.proposalId), rej.next("RESULT", p.proposalId)]);
  return checkOneWinner(e, p, a, r, heads);
}

/**
 * Force `winner` to decide first while `loser`'s call is already in flight
 * (see the file comment). Returns the winner as checked.
 */
async function forcedRound(e: Env, acc: Child, rej: Child, p: Proposal, winnerRole: Role): Promise<Role> {
  const heads = headsOf(e);
  const [winner, loser] = winnerRole === "accept" ? [acc, rej] : [rej, acc];
  const runtimeDir = e.coord.paths.runtimeDir;
  const id = p.proposalId;
  const diag = () => `${winner.diag()}\n${loser.diag()}`;
  const gate = new Database(e.coord.paths.proposalsDb);
  let gateOpen = false;
  const openGate = () => {
    if (gateOpen) return;
    gateOpen = true;
    gate.exec("ROLLBACK");
    gate.close();
  };
  try {
    gate.exec("BEGIN IMMEDIATE"); // no proposal decision can be written until openGate()
    winner.send(id);
    await until(
      `the ${winner.role} child to hold the worktree lock`,
      () => readLockHolder(runtimeDir, WORKTREE_LOCK)?.pid === winner.pid,
      diag,
    );
    loser.send(id);
    await loser.next("CALLING", id);
    await sleep(150); // the loser is now waiting for the worktree lock
    // The winner is still inside its section, its decision not yet written; neither call has returned.
    expect(isLockHeld(runtimeDir, WORKTREE_LOCK)).toBe(true);
    expect(readLockHolder(runtimeDir, WORKTREE_LOCK)).toMatchObject({ kind: winner.role, pid: winner.pid });
    expect(stored(e, id).status).toBe("PENDING");
    expect([winner.seen("RESULT", id), loser.seen("RESULT", id)]).toEqual([false, false]);
    openGate();
  } finally {
    openGate();
  }
  const [w, l] = await Promise.all([winner.next("RESULT", id), loser.next("RESULT", id)]);
  const lCalling = await loser.next("CALLING", id);
  // The loser called before the winner's decision returned.
  expect(lCalling.at!).toBeLessThan(w.at!);
  const [a, r] = winnerRole === "accept" ? [w, l] : [l, w];
  return checkOneWinner(e, p, a, r, heads);
}

describe("concurrent accept and reject of one proposal across processes (CR-1 acceptance test 2)", () => {
  test(
    "exactly one decision wins: forced in each order, and released together",
    async () => {
      env = await setupEnv();
      const e = env;
      const acc = await spawnChild("accept", e);
      const rej = await spawnChild("reject", e);

      // Forced orders: each winner at least once.
      expect(await forcedRound(e, acc, rej, await pendingProposal(e, "forced-accept"), "accept")).toBe("accept");
      expect(await forcedRound(e, acc, rej, await pendingProposal(e, "forced-reject"), "reject")).toBe("reject");

      // Released together: whichever wins, exactly one decision took effect.
      const winners: Role[] = [];
      for (let i = 0; i < FREE_ROUNDS; i++) winners.push(await freeRound(e, acc, rej, await pendingProposal(e, `free-${i}`), i % 2 === 0));
      expect(winners).toHaveLength(FREE_ROUNDS);

      expect(await acc.end()).toBe(0);
      expect(await rej.end()).toBe(0);
      expect(isLockHeld(e.coord.paths.runtimeDir, WORKTREE_LOCK)).toBe(false);
      expect(isClean(e.coord.paths.agentWorktree)).toBe(true);
    },
    TIMEOUT_MS,
  );

  test(
    "the CLI maps a lost reject to an error and reports accept of a decided proposal as REPLAN (STALE)",
    async () => {
      env = await setupEnv();
      const e = env;
      const accepted = await pendingProposal(e, "cli-accepted");
      const rejected = await pendingProposal(e, "cli-rejected");
      const stale = await pendingProposal(e, "cli-stale");
      expect((await e.coord.acceptProposal(accepted.proposalId)).state).toBe("INTEGRATED");
      await e.coord.rejectProposal(rejected.proposalId, "first");
      // `stale`'s target changes and reaches agent/repo; it is not marked STALE until the next refresh.
      const stalePath = join(e.repo.path, stale.targets[0]!.path);
      await Bun.write(stalePath, (await Bun.file(stalePath).text()) + "\nedited by a human\n");
      commitAsHuman(e.repo.path, "user: edit cli-stale");
      e.clock.advance(60_000);
      await e.coord.integrate();
      expect(stored(e, stale.proposalId)).toEqual({ status: "PENDING", decision_note: null });
      const cliEnv: Record<string, string> = { ...(process.env as Record<string, string>), BRAIN_HOME: e.home };
      for (const k of PROVIDER_VARS) delete cliEnv[k];
      const brain = (...args: string[]) => {
        const r = Bun.spawnSync([process.execPath, CLI, ...args], {
          cwd: e.repo.path,
          env: cliEnv,
          stdout: "pipe",
          stderr: "pipe",
          stdin: "ignore",
        });
        return { code: r.exitCode, out: r.stdout.toString().trim(), err: r.stderr.toString().trim() };
      };

      // First CLI call, so the staleness refresh inside this reject is the one that marks it.
      expect(brain("proposals", "reject", stale.proposalId, "--note", "no")).toEqual({
        code: 1,
        out: "",
        err: `proposal ${stale.proposalId} is already STALE`,
      });
      expect(brain("proposals", "reject", accepted.proposalId, "--note", "late")).toEqual({
        code: 1,
        out: "",
        err: `proposal ${accepted.proposalId} is already ACCEPTED`,
      });
      expect(brain("proposals", "reject", rejected.proposalId, "--note", "again")).toEqual({
        code: 1,
        out: "",
        err: `proposal ${rejected.proposalId} is already REJECTED`,
      });
      expect(brain("proposals", "accept", rejected.proposalId)).toEqual({ code: 0, out: `${rejected.proposalId}: REPLAN (STALE)`, err: "" });
      expect(brain("proposals", "reject", "prop_nope")).toEqual({ code: 1, out: "", err: "unknown proposal prop_nope" });
      expect(brain("proposals", "accept", "prop_nope")).toEqual({ code: 1, out: "", err: "unknown proposal prop_nope" });

      expect(stored(e, accepted.proposalId)).toEqual({ status: "ACCEPTED", decision_note: null });
      expect(stored(e, rejected.proposalId)).toEqual({ status: "REJECTED", decision_note: "first" });
      expect(stored(e, stale.proposalId)).toEqual({ status: "STALE", decision_note: null });
      expect(queueRow(e, rejected.mutationId)).toBeNull();
    },
    TIMEOUT_MS,
  );
});
