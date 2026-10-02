#!/usr/bin/env bun
/**
 * The child process of the `core` transcript step (seed.ts): another `brain`
 * writer, for seeding mutations and proposals that a read method then shows.
 *
 *     BRAIN_HOME=<home> bun test/rpc/harness/coreChild.ts <repo> < ops.json
 *
 * Opens the coordinator of the knowledge repo `<repo>` (taking the worktree
 * lock only where the coordinator does, CR-1) and runs the ops from stdin in
 * order:
 *
 * - `{op: "submit", mutation, expect?}`: `coord.submit(mutation)`. Defaults:
 *   `summary` "<type> <file names>", `dependsOn` [], `evidence`
 *   ["conversation://transcript/000001"]. Fails unless the resulting state is
 *   `expect`, when given.
 * - `{op: "submitProposal", proposal}`: `coord.submitProposal(proposal)`.
 *   Defaults: `status` "PENDING", `evidence` as above, `reasoning` "transcript seed".
 * - `{op: "syncOnce", expect?}`: one Human Sync pass (`coord.syncOnce`),
 *   judged two days from now so that any edit is quiescent: a `human-sync`
 *   commit of the user worktree's edits, whatever `sync.quiescence_ms` is.
 *   Fails unless `committed` is `expect`, when given.
 *
 * A `present` mutation target, or a proposal target, without `noteId` or
 * `blobHash` gets them from the file at agent HEAD at that point. A write
 * with `note` (a `NoteSpec`, test/harness) gets `content: noteMd(note)`.
 */
import { basename } from "node:path";
import { openCoordinator } from "../../../src/core/coordinator";
import { AGENT_BRANCH, type FileWrite, type Mutation, type Proposal, type RepoCoordinator, type TargetPrecondition } from "../../../src/core/types";
import { blobAt, showFile } from "../../../src/git/git";
import { parseNote } from "../../../src/markdown/parse";
import { noteMd, type NoteSpec } from "../../harness";

type Json = Record<string, any>;

const DEFAULT_EVIDENCE = ["conversation://transcript/000001"];
const SYNC_LATER_MS = 2 * 86_400_000;

/** `noteId` and `blobHash` of `path` at agent HEAD, where not given. */
function snapshot(coord: RepoCoordinator, t: Json): { noteId: string; path: string; blobHash: string } {
  const path = String(t["path"]);
  let noteId = t["noteId"] as string | undefined;
  let blobHash = t["blobHash"] as string | undefined;
  if (noteId === undefined || blobHash === undefined) {
    const raw = showFile(coord.paths.agentWorktree, AGENT_BRANCH, path);
    const blob = blobAt(coord.paths.agentWorktree, AGENT_BRANCH, path);
    if (raw === null || blob === null) throw new Error(`${path} is not at agent HEAD`);
    noteId ??= parseNote(path, raw).frontmatter.id;
    blobHash ??= blob;
  }
  return { noteId, path, blobHash };
}

function writes(list: Json[]): FileWrite[] {
  return list.map((w) => ({ path: String(w["path"]), content: w["note"] !== undefined ? noteMd(w["note"] as NoteSpec) : (w["content"] as string | null) }));
}

function mutationOf(coord: RepoCoordinator, m: Json): Mutation {
  const targets: TargetPrecondition[] = (m["targets"] as Json[]).map((t) => (t["kind"] === "present" ? { kind: "present", ...snapshot(coord, t) } : (t as TargetPrecondition)));
  const ws = writes(m["writes"] as Json[]);
  return {
    mutationId: String(m["mutationId"]),
    type: m["type"],
    summary: m["summary"] ?? `${String(m["type"]).toLowerCase()} ${ws.map((w) => basename(w.path)).join(", ")}`,
    targets,
    writes: ws,
    dependsOn: m["dependsOn"] ?? [],
    ...(m["replans"] !== undefined ? { replans: m["replans"] } : {}),
    evidence: m["evidence"] ?? DEFAULT_EVIDENCE,
    ...(m["reasoning"] !== undefined ? { reasoning: m["reasoning"] } : {}),
  };
}

function proposalOf(coord: RepoCoordinator, p: Json): Proposal {
  return {
    proposalId: String(p["proposalId"]),
    mutationId: String(p["mutationId"]),
    operation: p["operation"],
    targets: (p["targets"] as Json[]).map((t) => snapshot(coord, t)),
    writes: writes(p["writes"] as Json[]),
    evidence: p["evidence"] ?? DEFAULT_EVIDENCE,
    reasoning: p["reasoning"] ?? "transcript seed",
    createdAt: String(p["createdAt"]),
    status: p["status"] ?? "PENDING",
  };
}

const repo = process.argv[2];
if (repo === undefined) {
  process.stderr.write("usage: coreChild.ts <repo> < ops.json\n");
  process.exit(2);
}
const ops = JSON.parse(await Bun.stdin.text()) as Json[];
const coord = await openCoordinator(repo);
try {
  for (const op of ops) {
    if (op["op"] === "submit") {
      const r = await coord.submit(mutationOf(coord, op["mutation"]));
      if (op["expect"] !== undefined && r.state !== op["expect"]) throw new Error(`submit ${r.mutationId}: expected ${op["expect"]}, got ${r.state}${r.error ? ` (${r.error})` : ""}`);
      process.stdout.write(`${JSON.stringify(r)}\n`);
    } else if (op["op"] === "submitProposal") {
      await coord.submitProposal(proposalOf(coord, op["proposal"]));
    } else if (op["op"] === "syncOnce") {
      // Judged a day from now, so every edit is quiescent whatever `sync.quiescence_ms` says.
      const r = await coord.syncOnce(Date.now() + SYNC_LATER_MS);
      if (op["expect"] !== undefined && r.committed !== op["expect"]) throw new Error(`syncOnce: expected committed ${op["expect"]}, got ${JSON.stringify(r)}`);
      process.stdout.write(`${JSON.stringify(r)}\n`);
    } else {
      throw new Error(`unknown core op ${JSON.stringify(op["op"])}`);
    }
  }
} finally {
  await coord.close();
}
