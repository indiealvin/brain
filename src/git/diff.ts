/**
 * File diffs computed in core (CR-4; docs/mac-app/protocol.md §7 `FileDiff`,
 * docs/mac-app/design.md §7). Swift renders them and never computes one.
 *
 * - `proposalDiff`: each of a proposal's `writes` against its target's
 *   snapshot blob (`targets[].blobHash`).
 * - `commitDiff`: a commit against its first parent (a root commit against
 *   the empty tree).
 *
 * Both go through `unifiedDiff`, so their output has one format: a
 * `--- a/<path>` / `+++ b/<path>` header (`/dev/null` for an absent side),
 * then Git's hunks with 3 lines of context, each headed by a bare
 * `@@ -l,s +l,s @@` line (Git's function-context text is dropped). There
 * are no `diff --git`, `index` or mode lines. A binary file gives one
 * `Binary files a/<path> and b/<path> differ` line. Identical sides give
 * `""`. `additions` / `deletions` count the `+` / `-` lines of the hunks,
 * never the header (a note's frontmatter fence `---` would otherwise be
 * miscounted).
 *
 * Read only: no object, ref or index is written. Blobs are read with
 * `git cat-file blob` and trees compared with `git diff-tree`. The two sides
 * of a file are written to a private temp dir outside the repo and compared
 * with `git diff --no-index`, with the user's and the system's Git config
 * and diff environment shut out, so the format does not depend on the
 * machine.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Proposal } from "../core/types";
import { commitParents, GitError, readBlob, runGit } from "./git";

/** One file of a proposal or a commit (protocol §7). */
export interface FileDiff {
  path: string;
  change: "added" | "modified" | "deleted";
  /** Unified diff, 3 lines of context; null only with `beforeUnavailable`. */
  unified: string | null;
  additions: number;
  deletions: number;
  /** The before side (a proposal's snapshot blob) is no longer in the object store. */
  beforeUnavailable?: true;
}

export const DIFF_CONTEXT_LINES = 3;

/** One side of a file diff: its content, or null when the file is absent on that side. */
export type DiffSide = string | Uint8Array | null;

export interface UnifiedDiff {
  unified: string;
  additions: number;
  deletions: number;
}

const NO_DIFF: UnifiedDiff = { unified: "", additions: 0, deletions: 0 };
const DEV_NULL = "/dev/null";
/** A hunk header and the "function context" text Git may append to it. */
const HUNK_HEADER_RE = /^(@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@).*$/gm;

/**
 * Variables that would make `git diff --no-index` read a repository, extra
 * config, or other diff options. Dropped from its environment.
 */
const DIFF_ENV_DROP = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CONFIG",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_COUNT",
  "GIT_DIFF_OPTS",
  "GIT_EXTERNAL_DIFF",
];

/** `git diff --no-index` in `dir`: no system or global config, no repository above `dir`. */
function isolatedDiffEnv(dir: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !DIFF_ENV_DROP.includes(k)) env[k] = v;
  env["GIT_CONFIG_NOSYSTEM"] = "1";
  env["GIT_CONFIG_GLOBAL"] = DEV_NULL;
  env["GIT_CEILING_DIRECTORIES"] = dirname(dir);
  return env;
}

function bytesOf(side: string | Uint8Array): Uint8Array {
  return typeof side === "string" ? Buffer.from(side, "utf8") : side;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.byteLength === b.byteLength && Buffer.compare(a, b) === 0;
}

/**
 * The unified diff of `path` from `before` to `after` (null: the file is
 * absent on that side), with `DIFF_CONTEXT_LINES` of context. Format: see
 * the module comment.
 */
export function unifiedDiff(path: string, before: DiffSide, after: DiffSide): UnifiedDiff {
  if (before === null && after === null) return NO_DIFF;
  if (before !== null && after !== null && sameBytes(bytesOf(before), bytesOf(after))) return NO_DIFF;
  const dir = mkdtempSync(join(tmpdir(), "brain-diff-"));
  try {
    const a = before === null ? DEV_NULL : join(dir, "a");
    const b = after === null ? DEV_NULL : join(dir, "b");
    if (before !== null) writeFileSync(a, bytesOf(before));
    if (after !== null) writeFileSync(b, bytesOf(after));
    const args = ["diff", "--no-index", "--no-color", "--no-ext-diff", "--no-textconv", `-U${DIFF_CONTEXT_LINES}`, "--", a, b];
    const r = Bun.spawnSync(["git", "-C", dir, ...args], { env: isolatedDiffEnv(dir), stdout: "pipe", stderr: "pipe" });
    const stdout = r.stdout ? r.stdout.toString() : "";
    // 0: no difference; 1: differences; anything else is an error.
    if (r.exitCode !== 0 && r.exitCode !== 1) throw new GitError(dir, args, { code: r.exitCode, stdout, stderr: r.stderr ? r.stderr.toString() : "" });
    return normalizeDiff(path, before === null, after === null, stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Git's output for one file pair, rewritten to this module's format. */
function normalizeDiff(path: string, added: boolean, deleted: boolean, out: string): UnifiedDiff {
  const from = added ? DEV_NULL : `a/${path}`;
  const to = deleted ? DEV_NULL : `b/${path}`;
  // The header (`diff --git`, mode, `index`, `---`, `+++` lines) ends at the first hunk.
  const first = /^@@ /m.exec(out);
  if (first === null) {
    // No hunks: a binary pair, or an empty file added or deleted.
    return /^Binary files .* differ$/m.test(out) ? { unified: `Binary files ${from} and ${to} differ\n`, additions: 0, deletions: 0 } : NO_DIFF;
  }
  // Hunk headers lose the "function context" Git appends after the second "@@".
  const hunks = out.slice(first.index).replace(HUNK_HEADER_RE, "$1");
  let additions = 0;
  let deletions = 0;
  // Inside the hunks every line starts with "@@", " ", "+", "-" or "\" (no newline at end of file).
  for (const line of hunks.split("\n")) {
    if (line.startsWith("+")) additions++;
    else if (line.startsWith("-")) deletions++;
  }
  return { unified: `--- ${from}\n+++ ${to}\n${hunks}`, additions, deletions };
}

/**
 * The review diff of a proposal (design §7): one `FileDiff` per write, in
 * `writes` order. The before side is the snapshot blob of the target with
 * the write's path; the after side is the write's content.
 *
 * - `change`: `"deleted"` when `content` is null; `"added"` when no target
 *   has the write's path (no snapshot: a create); `"modified"` otherwise,
 *   also when the content equals the snapshot (an empty diff).
 * - A snapshot blob that is no longer in the object store (an old,
 *   non-PENDING proposal after a rebuild and `git gc`, protocol §7) gives
 *   `unified: null`, zero counts and `beforeUnavailable: true`.
 */
export function proposalDiff(repo: string, proposal: Pick<Proposal, "targets" | "writes">): FileDiff[] {
  return proposal.writes.map((w) => {
    const target = proposal.targets.find((t) => t.path === w.path);
    const change: FileDiff["change"] = w.content === null ? "deleted" : target === undefined ? "added" : "modified";
    if (target === undefined) return { path: w.path, change, ...unifiedDiff(w.path, null, w.content) };
    const before = readBlob(repo, target.blobHash);
    if (before === null) return { path: w.path, change, unified: null, additions: 0, deletions: 0, beforeUnavailable: true };
    return { path: w.path, change, ...unifiedDiff(w.path, before, w.content) };
  });
}

/** One entry of `git diff-tree --raw -z`. */
interface RawChange {
  srcMode: string;
  dstMode: string;
  srcBlob: string;
  dstBlob: string;
  status: string;
  path: string;
}

const GITLINK_MODE = "160000";

/** `diff-tree -r -z --raw --no-renames` output: `:<mode> <mode> <sha> <sha> <status>\0<path>\0` per file. */
function parseRaw(out: string): RawChange[] {
  const tokens = out.split("\0");
  const changes: RawChange[] = [];
  for (let i = 0; i + 1 < tokens.length; i += 2) {
    const meta = tokens[i]!;
    if (!meta.startsWith(":")) break;
    const [srcMode, dstMode, srcBlob, dstBlob, status] = meta.slice(1).split(" ");
    changes.push({ srcMode: srcMode!, dstMode: dstMode!, srcBlob: srcBlob!, dstBlob: dstBlob!, status: status!, path: tokens[i + 1]! });
  }
  return changes;
}

/**
 * `diff-tree` arguments comparing `sha` with its first parent (looked up
 * when not given; null for a root commit), or with the empty tree for a
 * root commit.
 */
function againstFirstParent(repo: string, sha: string, firstParent?: string | null): string[] {
  const parent = firstParent === undefined ? (commitParents(repo, sha)[0] ?? null) : firstParent;
  return parent === null ? ["--root", sha] : [parent, sha];
}

/** Content of one side of a raw change: a submodule shows as Git prints it. Null when the object is not readable. */
function sideContent(repo: string, mode: string, blob: string): Buffer | null {
  if (mode === GITLINK_MODE) return Buffer.from(`Subproject commit ${blob}\n`, "utf8");
  return readBlob(repo, blob);
}

/**
 * The paths commit `sha` changed against its first parent (the empty tree
 * for a root commit), in Git's path order. Without rename detection: a
 * rename lists its old and its new path. `firstParent` (null for a root
 * commit) saves looking it up when the caller has it.
 */
export function commitPaths(repo: string, sha: string, firstParent?: string | null): string[] {
  const args = ["diff-tree", "-r", "-z", "--name-only", "--no-renames", "--no-commit-id", ...againstFirstParent(repo, sha, firstParent)];
  const r = runGit(repo, args);
  if (r.code !== 0) throw new GitError(repo, args, r);
  return r.stdout.split("\0").filter((p) => p !== "");
}

/**
 * The diff of commit `sha` (a full commit name) against its first parent, or
 * against the empty tree for a root commit: one `FileDiff` per changed file,
 * in Git's path order, limited to `path` (a file, or a directory prefix)
 * when given. A type change (file ↔ symlink) is `"modified"`. A before blob
 * that cannot be read gives `beforeUnavailable`, as for a proposal.
 */
export function commitDiff(repo: string, sha: string, opts: { path?: string } = {}): FileDiff[] {
  const args = ["diff-tree", "-r", "-z", "--raw", "--no-renames", "--no-commit-id", ...againstFirstParent(repo, sha), "--", ...(opts.path === undefined ? [] : [opts.path])];
  const r = runGit(repo, args, { env: { GIT_LITERAL_PATHSPECS: "1" } });
  if (r.code !== 0) throw new GitError(repo, args, r);
  return parseRaw(r.stdout).map((c) => {
    const change: FileDiff["change"] = c.status === "A" ? "added" : c.status === "D" ? "deleted" : "modified";
    const before = change === "added" ? null : sideContent(repo, c.srcMode, c.srcBlob);
    if (change !== "added" && before === null) return { path: c.path, change, unified: null, additions: 0, deletions: 0, beforeUnavailable: true };
    let after: Buffer | null = null;
    if (change !== "deleted") {
      after = sideContent(repo, c.dstMode, c.dstBlob);
      if (after === null) throw new Error(`commit ${sha}: object ${c.dstBlob} (${c.path}) is missing from the object store`);
    }
    return { path: c.path, change, ...unifiedDiff(c.path, before, after) };
  });
}
