/**
 * Service layer (CR-2; src/commands), the parts the CLI tests do not pin down:
 *
 * - `repoStatus` reads the pending-proposal count without the worktree lock
 *   and without a staleness refresh, so the count is advisory
 *   (docs/mac-app/protocol.md §5): it can include a proposal that the next
 *   `proposalsList` refresh marks STALE, and it never waits behind a lock
 *   holder in another process.
 * - Provider selection reads only the env it is given, so an adapter can pass
 *   a private env (protocol.md §3).
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { Subprocess } from "bun";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NoModelError, ServiceError } from "../../src/commands/errors";
import { proposalsList } from "../../src/commands/proposals";
import { chatEmbeddingProvider, chatModelProvider, hasModelCredentials, offlineModelRequested } from "../../src/commands/providers";
import { openRepo, pendingProposalCount, repoStatus, type Coord } from "../../src/commands/repo";
import { AGENT_BRANCH, type Proposal } from "../../src/core/types";
import { HashingEmbeddingProvider } from "../../src/retrieval/embeddings";
import { blobAt, commitAsHuman, makeTempKnowledgeRepo, newMutationId, withBrainHome, writeNote, type TempRepo } from "../harness";

const LOCK_MODULE = join(import.meta.dir, "..", "..", "src", "sync", "lock.ts");
const NOTE = "knowledge/advisory-count.md";

let cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.reverse()) await c();
  cleanups = [];
});

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** A temp BRAIN_HOME and knowledge repo with one note committed on main. */
function seededRepo(): { repo: TempRepo; content: string; noteId: string } {
  const home = withBrainHome();
  const repo = makeTempKnowledgeRepo();
  cleanups.push(() => repo.cleanup(), () => home.cleanup());
  const n = writeNote(repo.path, NOTE, { title: "Advisory count", sections: { Claim: "Status reads proposals without the lock." } });
  commitAsHuman(repo.path, "user: seed note");
  return { repo, content: n.content, noteId: n.id };
}

async function open(repo: TempRepo): Promise<Coord> {
  const { coord } = await openRepo(repo.path);
  cleanups.push(() => coord.close());
  return coord;
}

function archiveProposal(noteId: string, blobHash: string, content: string): Proposal {
  return {
    proposalId: `prop_${newMutationId().slice(4)}`,
    mutationId: newMutationId(),
    operation: "ARCHIVE",
    targets: [{ noteId, path: NOTE, blobHash }],
    writes: [{ path: NOTE, content: content.replace("status: active", "status: archived") }],
    evidence: ["conversation://old/1"],
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

describe("repoStatus: advisory pending-proposal count (protocol.md §5)", () => {
  test("pendingProposalCount is 0 before proposals.sqlite exists", () => {
    expect(pendingProposalCount(join(tmpdir(), `brain-no-such-${process.pid}-${Date.now()}.sqlite`))).toBe(0);
  });

  test(
    "a PENDING proposal whose target changed is still counted; only the proposalsList refresh marks it STALE",
    async () => {
      const { repo, content, noteId } = seededRepo();
      let coord = await open(repo);
      const before = blobAt(coord.paths.agentWorktree, AGENT_BRANCH, NOTE)!;
      await coord.submitProposal(archiveProposal(noteId, before, content));
      expect((await repoStatus(coord)).pendingProposals).toBe(1);
      await coord.close();
      cleanups.pop();

      // A human edit on main; the open sequence fast-forwards agent/repo onto it, so the target changed at agent HEAD.
      await Bun.write(join(repo.path, NOTE), `${content}\nHuman addendum.\n`);
      commitAsHuman(repo.path, "user: edit");
      coord = await open(repo);
      expect(blobAt(coord.paths.agentWorktree, AGENT_BRANCH, NOTE)).not.toBe(before);

      const status = await repoStatus(coord);
      expect(status.pendingProposals).toBe(1); // advisory: no staleness refresh
      expect(pendingProposalCount(coord.paths.proposalsDb)).toBe(1); // and nothing was written

      const [p] = await proposalsList(coord);
      expect(p!.status).toBe("STALE");
      expect((await repoStatus(coord)).pendingProposals).toBe(0);
    },
    60_000,
  );

  test(
    "repoStatus does not wait for the worktree lock; the proposalsList refresh does",
    async () => {
      const { repo, content, noteId } = seededRepo();
      const coord = await open(repo);
      await coord.submitProposal(archiveProposal(noteId, blobAt(coord.paths.agentWorktree, AGENT_BRANCH, NOTE)!, content));
      const holder = await holdWorktreeLock(coord.paths.runtimeDir);

      const status = await Promise.race([repoStatus(coord), sleep(10_000).then(() => "timed out" as const)]);
      expect(status).not.toBe("timed out");
      expect(status).toMatchObject({ pendingProposals: 1, repoId: coord.config.repoId });

      // Control: the refreshing read takes the lock, so it stays pending while the holder lives.
      let listed = false;
      const list = proposalsList(coord).then((ps) => {
        listed = true;
        return ps;
      });
      await sleep(300);
      expect(listed).toBe(false);
      holder.kill("SIGKILL");
      await holder.exited;
      expect((await list).map((p) => p.status)).toEqual(["PENDING"]);
    },
    60_000,
  );
});

describe("provider selection reads only the env it is given", () => {
  test("no credentials in the given env is NO_MODEL, whatever process.env holds", () => {
    let err: unknown;
    try {
      chatModelProvider({ env: {} });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(NoModelError);
    expect(err).toBeInstanceOf(ServiceError);
    expect((err as NoModelError).code).toBe("NO_MODEL");
    expect((err as Error).message).toBe("no model configured; run `brain setup`");
    expect(hasModelCredentials({})).toBe(false);
    expect(hasModelCredentials({ ANTHROPIC_AUTH_TOKEN: "t" })).toBe(true);
  });

  test("BRAIN_MODEL_MOCK in the given env selects the mock model, logs one line, and pairs it with offline embeddings", () => {
    const lines: string[] = [];
    const env = { BRAIN_MODEL_MOCK: "1", BRAIN_EMBEDDINGS: "openrouter" };
    expect(chatModelProvider({ env, log: (l) => lines.push(l) })).toBeDefined();
    expect(lines).toEqual(["BRAIN_MODEL_MOCK is set: using the mock model (canned reply, no knowledge extraction)"]);
    expect(offlineModelRequested(env)).toBe(true);
    expect(chatEmbeddingProvider(env)).toBeInstanceOf(HashingEmbeddingProvider);
    expect(offlineModelRequested({})).toBe(false);
  });
});
