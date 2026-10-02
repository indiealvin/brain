/**
 * CR-1 (T0.4; docs/mac-app/design.md §5.2): every public coordinator method
 * that writes takes the cross-process worktree lock exactly once, at the top.
 * While a holder in another process has the lock, each such method waits and
 * changes nothing; once the holder is gone it completes. The unlocked public
 * methods (`enqueue`, `submitProposal`, the reads) do not wait. A public
 * method started from inside a section that already holds the lock fails at
 * once instead of deadlocking.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { Subprocess } from "bun";
import { Database } from "bun:sqlite";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openCoordinator, type ProposalDetail } from "../../src/core/coordinator";
import { AGENT_BRANCH } from "../../src/core/types";
import type { ExecutionResult, Proposal, RepoCoordinator } from "../../src/core/types";
import { isLockHeld, LockReentryError, withRepoWorktreeLock, WORKTREE_LOCK } from "../../src/sync/lock";
import {
  blobAt,
  commitsWithMutationId,
  createMutation,
  forceQueueState,
  isClean,
  makeTempKnowledgeRepo,
  mutationIdsOn,
  newMutationId,
  quiescentNow,
  revParse,
  seedNote,
  setupEnv,
  withBrainHome,
  writeNote,
  type Env,
} from "../harness";

const LOCK_MODULE = join(import.meta.dir, "..", "..", "src", "sync", "lock.ts");
/** How long a method must stay pending while another process holds the lock. */
const PENDING_MS = 300;
const SPAWN_TIMEOUT_MS = 60_000;

type Coord = RepoCoordinator & { drainQueued(): Promise<ExecutionResult[]>; proposalDetail(proposalId: string): Promise<ProposalDetail> };

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

/** A child process that takes the worktree lock, prints HELD and holds it until it is killed. */
async function holdInAnotherProcess(runtimeDir: string): Promise<Subprocess> {
  const script = `
    const { withRepoWorktreeLock, setLockHolderKind } = await import(${JSON.stringify(LOCK_MODULE)});
    setLockHolderKind("test-holder");
    await withRepoWorktreeLock(${JSON.stringify(runtimeDir)}, async () => {
      console.log("HELD");
      await new Promise(() => {});
    });
  `;
  const proc = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "inherit", stdin: "ignore" });
  children.push(proc);
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (!buf.includes("HELD")) {
    const r = await reader.read();
    if (r.done) throw new Error(`holder exited before taking the lock; output: ${buf}`);
    buf += decoder.decode(r.value, { stream: true });
  }
  reader.releaseLock();
  return proc;
}

/** Everything a locked method could change, read without taking the lock. */
function snapshot(e: Env): unknown {
  const repo = e.repo.path;
  const proposals = new Database(e.coord.paths.proposalsDb, { readonly: true });
  const queue = new Database(e.coord.paths.queueDb, { readonly: true });
  try {
    return {
      main: revParse(repo, "main"),
      agent: revParse(repo, AGENT_BRANCH),
      userClean: isClean(repo),
      agentClean: isClean(e.coord.paths.agentWorktree),
      queue: queue.query("SELECT mutation_id, state, commit_sha FROM mutations ORDER BY seq").all(),
      proposals: proposals.query("SELECT proposal_id, status FROM proposals ORDER BY proposal_id").all(),
    };
  } finally {
    proposals.close();
    queue.close();
  }
}

function proposalStatus(e: Env, id: string): string | undefined {
  const db = new Database(e.coord.paths.proposalsDb, { readonly: true });
  try {
    return (db.query("SELECT status FROM proposals WHERE proposal_id = ?").get(id) as { status: string } | null)?.status;
  } finally {
    db.close();
  }
}

function mkProposal(p: Pick<Proposal, "operation" | "targets" | "writes">): Proposal {
  const id = newMutationId().replace(/^mut_/, "prop_");
  return { proposalId: id, mutationId: newMutationId(), evidence: ["conversation://unit/1"], reasoning: "unit", createdAt: new Date().toISOString(), status: "PENDING", ...p };
}

/** A PENDING ARCHIVE proposal for a note seeded on main (and integrated, so agent/repo has it too). */
async function archiveProposal(e: Env, slug: string, opts: { staleBlob?: boolean } = {}): Promise<Proposal> {
  const x = seedNote(e, `knowledge/${slug}.md`, { title: slug.toUpperCase(), sections: { Claim: `${slug} claim` } });
  await e.coord.integrate();
  const blob = opts.staleBlob ? "0".repeat(40) : blobAt(e.repo.path, "main", x.path)!;
  const p = mkProposal({
    operation: "ARCHIVE",
    targets: [{ noteId: x.id, path: x.path, blobHash: blob }],
    writes: [{ path: x.path, content: x.content.replace("status: active", "status: archived") }],
  });
  await e.coord.submitProposal(p);
  return p;
}

interface Row {
  method: string;
  /** Runs before the lock is taken by the other process; returns what `call` and `check` need. */
  setup: (e: Env) => Promise<Record<string, any>>;
  call: (c: Coord, ctx: Record<string, any>, e: Env) => Promise<unknown>;
  /** The method did its work once it could take the lock. */
  check: (result: any, ctx: Record<string, any>, e: Env) => void | Promise<void>;
}

const ROWS: Row[] = [
  {
    method: "submit",
    setup: async () => ({ m: createMutation("knowledge/submitted.md", { title: "Submitted" }) }),
    call: (c, { m }) => c.submit(m),
    check: (r, { m }, e) => {
      expect(r.state).toBe("INTEGRATED");
      expect(mutationIdsOn(e.repo.path, "main")).toEqual([m.mutationId]);
    },
  },
  {
    method: "execute",
    setup: async (e) => {
      const m = createMutation("knowledge/executed.md", { title: "Executed" });
      await e.coord.enqueue(m);
      return { m };
    },
    call: (c, { m }) => c.execute(m.mutationId),
    check: (r, { m }, e) => {
      expect(r.state).toBe("COMMITTED");
      expect(commitsWithMutationId(e.repo.path, AGENT_BRANCH, m.mutationId).length).toBe(1);
    },
  },
  {
    method: "drainQueued",
    setup: async (e) => {
      const m = createMutation("knowledge/drained.md", { title: "Drained" });
      await e.coord.enqueue(m);
      return { m };
    },
    call: (c) => c.drainQueued(),
    check: async (r: ExecutionResult[], { m }, e) => {
      expect(r.map((x) => [x.mutationId, x.state])).toEqual([[m.mutationId, "COMMITTED"]]);
      expect((await e.coord.getMutation(m.mutationId))?.state).toBe("INTEGRATED");
    },
  },
  {
    method: "integrate",
    setup: async (e) => {
      const m = createMutation("knowledge/integrated.md", { title: "Integrated" });
      await e.coord.enqueue(m);
      expect((await e.coord.execute(m.mutationId)).state).toBe("COMMITTED");
      return { m };
    },
    call: (c) => c.integrate(),
    check: (r, { m }) => {
      expect(r.status).toBe("integrated");
      expect(r.integratedMutationIds).toEqual([m.mutationId]);
    },
  },
  {
    method: "rebuild",
    setup: async (e) => {
      const m = createMutation("knowledge/rebuilt.md", { title: "Rebuilt" });
      await e.coord.enqueue(m);
      expect((await e.coord.execute(m.mutationId)).state).toBe("COMMITTED");
      seedNote(e, "knowledge/human.md", { title: "Human" }); // main moves under the pending commit
      return { m };
    },
    call: (c) => c.rebuild(),
    check: (r, { m }, e) => {
      expect(r.replayed).toEqual([m.mutationId]);
      expect(revParse(e.repo.path, `${AGENT_BRANCH}~1`)).toBe(revParse(e.repo.path, "main"));
    },
  },
  {
    method: "syncOnce",
    setup: async (e) => {
      writeNote(e.repo.path, "knowledge/typed.md", { title: "Typed" });
      return { now: quiescentNow(e) };
    },
    call: (c, { now }) => c.syncOnce(now),
    check: (r, _ctx, e) => {
      expect(r.committed).toBe(true);
      expect(r.sha).toBe(revParse(e.repo.path, "main"));
      expect(isClean(e.repo.path)).toBe(true);
    },
  },
  {
    method: "recover",
    setup: async (e) => {
      const m = createMutation("knowledge/recovered.md", { title: "Recovered" });
      await e.coord.enqueue(m);
      forceQueueState(e, m.mutationId, "RUNNING"); // a crashed holder's row
      return { m };
    },
    call: (c) => c.recover(),
    check: async (_r, { m }, e) => {
      expect((await e.coord.getMutation(m.mutationId))?.state).toBe("COMMITTED");
      expect(commitsWithMutationId(e.repo.path, AGENT_BRANCH, m.mutationId).length).toBe(1);
    },
  },
  {
    method: "reconcileIndex",
    setup: async () => ({}),
    call: (c) => c.reconcileIndex(),
    check: (r, _ctx, e) => {
      expect(r.indexedCommit).toBe(revParse(e.repo.path, AGENT_BRANCH));
    },
  },
  {
    method: "listProposals",
    setup: async (e) => ({ p: await archiveProposal(e, "listed", { staleBlob: true }) }),
    call: (c) => c.listProposals(),
    check: (r: Proposal[], { p }) => {
      // the staleness refresh (a write) ran under the lock
      expect(r.map((x) => [x.proposalId, x.status])).toEqual([[p.proposalId, "STALE"]]);
    },
  },
  {
    method: "proposalDetail",
    setup: async (e) => ({ p: await archiveProposal(e, "detailed", { staleBlob: true }) }),
    call: (c, { p }) => c.proposalDetail(p.proposalId),
    check: (r: ProposalDetail, { p }) => {
      // the staleness refresh (a write) and the diff ran under the lock
      expect(r.proposal.status).toBe("STALE");
      expect(r.diff).toEqual([{ path: p.writes[0].path, change: "modified", unified: null, additions: 0, deletions: 0, beforeUnavailable: true }]);
    },
  },
  {
    method: "acceptProposal",
    setup: async (e) => ({ p: await archiveProposal(e, "accepted") }),
    call: (c, { p }) => c.acceptProposal(p.proposalId),
    check: (r, { p }, e) => {
      expect(r.state).toBe("INTEGRATED");
      expect(proposalStatus(e, p.proposalId)).toBe("ACCEPTED");
      expect(mutationIdsOn(e.repo.path, "main")).toEqual([p.mutationId]);
    },
  },
  {
    method: "rejectProposal",
    setup: async (e) => ({ p: await archiveProposal(e, "rejected") }),
    call: (c, { p }) => c.rejectProposal(p.proposalId, "no"),
    check: (_r, { p }, e) => {
      expect(proposalStatus(e, p.proposalId)).toBe("REJECTED");
    },
  },
];

describe("every public write waits for a worktree lock held by another process (CR-1)", () => {
  for (const row of ROWS) {
    test(
      `${row.method}() waits, changes nothing while it waits, and completes once the holder is gone`,
      async () => {
        env = await setupEnv();
        const e = env;
        const ctx = await row.setup(e);
        const holder = await holdInAnotherProcess(e.coord.paths.runtimeDir);
        expect(isLockHeld(e.coord.paths.runtimeDir, WORKTREE_LOCK)).toBe(true);
        const before = snapshot(e);

        let settled = false;
        const p = row.call(e.coord as Coord, ctx, e).finally(() => {
          settled = true;
        });
        await sleep(PENDING_MS);
        expect(settled).toBe(false);
        expect(snapshot(e)).toEqual(before);

        holder.kill("SIGKILL"); // the kernel releases the holder's lock
        await holder.exited;
        await row.check(await p, ctx, e);
        expect(isClean(e.coord.paths.agentWorktree)).toBe(true);
        expect(isLockHeld(e.coord.paths.runtimeDir, WORKTREE_LOCK)).toBe(false);
      },
      SPAWN_TIMEOUT_MS,
    );
  }
});

describe("openCoordinator ensures the agent worktree under the lock (CR-1)", () => {
  test(
    "while another process holds the lock, opening waits and leaves that process's agent-worktree writes alone",
    async () => {
      const bh = withBrainHome();
      const repo = makeTempKnowledgeRepo();
      try {
        const first = await openCoordinator(repo.path);
        const { agentWorktree, runtimeDir } = first.paths;
        await first.close();

        // Another process is mid-execution (spec §12 step 6): its files are in the agent worktree.
        const holder = await holdInAnotherProcess(runtimeDir);
        writeFileSync(join(agentWorktree, "knowledge", "in-flight.md"), "being written by the lock holder\n");
        let opened = false;
        const opening = openCoordinator(repo.path).then((c) => {
          opened = true;
          return c;
        });
        await sleep(PENDING_MS);
        expect(opened).toBe(false);
        expect(existsSync(join(agentWorktree, "knowledge", "in-flight.md"))).toBe(true); // not reset under the holder

        // The holder dies; its leftovers are reset by the next opener, which now holds the lock.
        holder.kill("SIGKILL");
        await holder.exited;
        const coord = await opening;
        try {
          expect(existsSync(join(agentWorktree, "knowledge", "in-flight.md"))).toBe(false);
          expect(isClean(agentWorktree)).toBe(true);
          expect(isLockHeld(runtimeDir, WORKTREE_LOCK)).toBe(false);
        } finally {
          await coord.close();
        }
      } finally {
        repo.cleanup();
        bh.cleanup();
      }
    },
    SPAWN_TIMEOUT_MS,
  );

  test("opening from inside a section that holds the lock fails at once instead of deadlocking", async () => {
    env = await setupEnv();
    const e = env;
    const err = await withRepoWorktreeLock(e.coord.paths.runtimeDir, () => openCoordinator(e.repo.path).then(() => null, (x: unknown) => x));
    expect(err).toBeInstanceOf(LockReentryError);
  });
});

describe("the unlocked public methods do not wait for the worktree lock", () => {
  test(
    "enqueue, submitProposal and the reads complete while another process holds the lock",
    async () => {
      env = await setupEnv();
      const e = env;
      const x = seedNote(e, "knowledge/x.md", { title: "X" });
      const holder = await holdInAnotherProcess(e.coord.paths.runtimeDir);

      const m = createMutation("knowledge/queued.md", { title: "Queued" });
      const p = mkProposal({
        operation: "ARCHIVE",
        targets: [{ noteId: x.id, path: x.path, blobHash: blobAt(e.repo.path, "main", x.path)! }],
        writes: [{ path: x.path, content: x.content.replace("status: active", "status: archived") }],
      });
      const work = (async () => {
        await e.coord.enqueue(m);
        await e.coord.submitProposal(p);
        return {
          row: await e.coord.getMutation(m.mutationId),
          rows: await e.coord.listMutations(),
          main: await e.coord.mainHead(),
          agent: await e.coord.agentHead(),
          negative: await e.coord.negativeEvidenceFor([x.id]),
        };
      })();
      const r = await Promise.race([work, sleep(5_000).then(() => null)]);
      expect(r).not.toBeNull();
      expect(r!.row?.state).toBe("QUEUED");
      expect(r!.rows.map((x) => x.mutationId)).toEqual([m.mutationId]);
      expect(r!.main).toBe(revParse(e.repo.path, "main"));
      expect(r!.agent).toBe(revParse(e.repo.path, AGENT_BRANCH));
      expect(r!.negative).toEqual([]);
      expect(proposalStatus(e, p.proposalId)).toBe("PENDING");
      expect(isLockHeld(e.coord.paths.runtimeDir, WORKTREE_LOCK)).toBe(true);
      holder.kill("SIGKILL");
      await holder.exited;
    },
    SPAWN_TIMEOUT_MS,
  );
});

describe("a public write never nests the worktree lock", () => {
  test("called from inside a section that holds the lock, it rejects with LockReentryError at once instead of deadlocking", async () => {
    env = await setupEnv();
    const e = env;
    const c = e.coord as Coord;
    const calls: [string, () => Promise<unknown>][] = [
      ["submit", () => c.submit(createMutation("knowledge/nested.md", { title: "Nested" }))],
      ["execute", () => c.execute("mut_unknown")],
      ["drainQueued", () => c.drainQueued()],
      ["integrate", () => c.integrate()],
      ["rebuild", () => c.rebuild()],
      ["syncOnce", () => c.syncOnce()],
      ["recover", () => c.recover()],
      ["reconcileIndex", () => c.reconcileIndex()],
      ["listProposals", () => c.listProposals()],
      ["acceptProposal", () => c.acceptProposal("prop_unknown")],
      ["rejectProposal", () => c.rejectProposal("prop_unknown")],
    ];
    const outcomes = await withRepoWorktreeLock(c.paths.runtimeDir, async () => {
      const out: [string, string][] = [];
      for (const [name, call] of calls) {
        const t0 = Date.now();
        const err = await call().then(
          () => null,
          (x: unknown) => x,
        );
        out.push([name, `${err instanceof LockReentryError ? "LockReentryError" : String(err)} ${Date.now() - t0 < 1_000 ? "fast" : "slow"}`]);
      }
      return out;
    });
    expect(outcomes).toEqual(calls.map(([name]) => [name, "LockReentryError fast"]));

    // Inside a coordinator method's own section the in-process mutex is held too, so a nested public
    // call would wait on the mutex before it ever reached the lock. It is refused before the mutex.
    // (`exclusive` is the private helper every locked method runs through.)
    const exclusive = (c as unknown as { exclusive<T>(fn: () => Promise<T>): Promise<T> }).exclusive.bind(c);
    const inner = await exclusive(async () => {
      const t0 = Date.now();
      const err = await c.integrate().then(
        () => null,
        (x: unknown) => x,
      );
      return { reentry: err instanceof LockReentryError, ms: Date.now() - t0 };
    });
    expect(inner.reentry).toBe(true);
    expect(inner.ms).toBeLessThan(1_000);

    // Nothing was left behind: the coordinator still works once the section is over.
    const m = createMutation("knowledge/after.md", { title: "After" });
    expect((await c.submit(m)).state).toBe("INTEGRATED");
  });
});
