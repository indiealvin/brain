/**
 * Read methods in process (docs/mac-app/protocol.md §4, §5; T1.4): the
 * properties the transcripts cannot pin down. Transcripts match server
 * messages as subsets, so they cannot show that a field is absent, and they
 * have no step that holds the worktree lock.
 *
 * - Reads never wait for the worktree lock. Only `proposals.list` takes it,
 *   because its staleness refresh writes STALE marks.
 * - `proposals.list` sends `ProposalSummary`: the `Proposal` without `writes`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { Subprocess } from "bun";
import { join } from "node:path";
import { AGENT_BRANCH, type Proposal } from "../../src/core/types";
import { createRpcServer, type RpcServer } from "../../src/rpc";
import { blobAt, commitAsHuman, makeTempKnowledgeRepo, withBrainHome, writeNote } from "../harness";

type Msg = Record<string, any>;

const LOCK_MODULE = join(import.meta.dir, "..", "..", "src", "sync", "lock.ts");
const NOTE = "knowledge/read-methods.md";
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

interface Harness {
  server: RpcServer;
  send(id: string, method: string, params?: Msg): void;
  terminal(id: string): Msg | undefined;
  request(id: string, method: string, params?: Msg): Promise<Msg>;
}

function makeServer(): Harness {
  const out: Msg[] = [];
  const server = createRpcServer({ send: (l) => out.push(JSON.parse(l)), baseEnv: {}, loadUserConfig: () => null });
  const terminal = (id: string) => out.find((m) => m.id === id && (m.type === "result" || m.type === "error"));
  const send = (id: string, method: string, params: Msg = {}) => server.handleLine(JSON.stringify({ id, method, params }));
  return {
    server,
    send,
    terminal,
    request: async (id, method, params = {}) => {
      send(id, method, params);
      const deadline = Date.now() + 20_000;
      for (;;) {
        const t = terminal(id);
        if (t) return t;
        if (Date.now() > deadline) throw new Error(`no terminal message for ${id}; got ${JSON.stringify(out)}`);
        await sleep(5);
      }
    },
  };
}

/** A temp BRAIN_HOME (restored afterwards), a knowledge repo with one note on main, and an initialized server. */
async function initializedServer(): Promise<{ h: Harness; noteId: string; content: string }> {
  const prev = process.env.BRAIN_HOME;
  const bh = withBrainHome();
  const repo = makeTempKnowledgeRepo();
  cleanups.push(() => {
    repo.cleanup();
    bh.cleanup();
    if (prev === undefined) delete process.env.BRAIN_HOME;
    else process.env.BRAIN_HOME = prev;
  });
  const n = writeNote(repo.path, NOTE, { title: "Read methods", sections: { Claim: "Reads never wait for the worktree lock." } });
  commitAsHuman(repo.path, "user: seed note");
  const h = makeServer();
  const r = await h.request("init", "initialize", { protocolVersion: 1, client: { name: "test", version: "0" }, repoPath: repo.path, env: { BRAIN_EMBEDDINGS: "hashing" } });
  expect(r.type).toBe("result");
  cleanups.push(() => h.server.shutdown("test teardown"));
  return { h, noteId: n.id, content: n.content };
}

function archiveProposal(noteId: string, blobHash: string, content: string): Proposal {
  return {
    proposalId: "prop_01JA00000000000000000000P1",
    mutationId: "mut_01JA00000000000000000000P1",
    operation: "ARCHIVE",
    targets: [{ noteId, path: NOTE, blobHash }],
    writes: [{ path: NOTE, content: content.replace("status: active", "status: archived") }],
    evidence: ["conversation://old/000001"],
    reasoning: "test",
    createdAt: "2026-10-02T00:00:00.000Z",
    status: "PENDING",
  };
}

/** A child process that takes the worktree lock, prints HELD and holds it until it is killed. */
async function holdWorktreeLock(runtimeDir: string): Promise<Subprocess> {
  const script = `
    const { withRepoWorktreeLock } = await import(${JSON.stringify(LOCK_MODULE)});
    await withRepoWorktreeLock(${JSON.stringify(runtimeDir)}, async () => {
      console.log("HELD");
      await new Promise(() => {});
    });
  `;
  const proc = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "inherit", stdin: "ignore" });
  cleanups.push(async () => {
    try {
      proc.kill("SIGKILL");
    } catch {}
    await proc.exited;
  });
  const reader = proc.stdout.getReader();
  let buf = "";
  while (!buf.includes("HELD")) {
    const r = await reader.read();
    if (r.done) throw new Error(`holder exited before taking the lock; output: ${buf}`);
    buf += new TextDecoder().decode(r.value);
  }
  reader.releaseLock();
  return proc;
}

describe("read methods and the worktree lock (protocol §5)", () => {
  test(
    "every read answers while another process holds the worktree lock; proposals.list waits for it",
    async () => {
      const { h, noteId, content } = await initializedServer();
      const coord = h.server.session.coord;
      await coord.submitProposal(archiveProposal(noteId, blobAt(coord.paths.agentWorktree, AGENT_BRANCH, NOTE)!, content));
      const created = await h.request("c0", "conversation.create");
      const sessionId = created.data.sessionId as string;
      const holder = await holdWorktreeLock(coord.paths.runtimeDir);

      h.send("p", "proposals.list");
      const reads: [string, string, Msg][] = [
        ["r1", "repo.status", {}],
        ["r2", "engine.status", {}],
        ["r3", "conversation.list", {}],
        ["r4", "conversation.create", {}],
        ["r5", "conversation.get", { sessionId }],
        ["r6", "notes.list", {}],
        ["r7", "notes.get", { noteId }],
        ["r8", "notes.search", { query: "worktree lock" }],
        ["r9", "mutations.list", {}],
      ];
      const results = await Promise.all(reads.map(([id, method, params]) => h.request(id, method, params)));
      for (const [i, r] of results.entries()) expect({ method: reads[i]![1], type: r.type }).toEqual({ method: reads[i]![1], type: "result" });
      expect(results[0]!.data.pendingProposals).toBe(1);
      expect(results[6]!.data.note.noteId).toBe(noteId);

      // Control: the refreshing read is still waiting for the holder.
      await sleep(300);
      expect(h.terminal("p")).toBeUndefined();
      holder.kill("SIGKILL");
      await holder.exited;
      const listed = await h.request("p2", "proposals.list");
      expect(listed.data.map((p: Msg) => p.status)).toEqual(["PENDING"]);
      expect(h.terminal("p")?.type).toBe("result");
    },
    60_000,
  );
});

describe("proposals.list", () => {
  test(
    "sends ProposalSummary: every Proposal field except writes",
    async () => {
      const { h, noteId, content } = await initializedServer();
      const coord = h.server.session.coord;
      const proposal = archiveProposal(noteId, blobAt(coord.paths.agentWorktree, AGENT_BRANCH, NOTE)!, content);
      await coord.submitProposal(proposal);
      const r = await h.request("1", "proposals.list");
      const { writes: _writes, ...summary } = proposal;
      expect(r.data).toEqual([summary]);
      expect(Object.keys(r.data[0])).not.toContain("writes");
    },
    60_000,
  );
});
