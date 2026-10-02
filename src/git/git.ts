/**
 * Thin Git subprocess wrapper. Always `git -C <repo> …`, never `cd`.
 *
 * Only plumbing that the engine needs; higher-level operations (worktree
 * setup, execution, rebuild) compose these.
 */
import type { CommitTrailers, MutationType } from "../core/types";
import { isNotePath, slugFromPath, slugKey } from "../core/slug";

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface GitRunOptions {
  /** Extra environment (merged over process.env). */
  env?: Record<string, string | undefined>;
  /** Data piped to stdin. */
  stdin?: string | Uint8Array;
}

export class GitError extends Error {
  readonly repo: string;
  readonly args: string[];
  readonly code: number;
  readonly stderr: string;
  readonly stdout: string;
  constructor(repo: string, args: string[], result: GitResult) {
    super(`git -C ${repo} ${args.join(" ")} failed (${result.code}): ${result.stderr.trim() || result.stdout.trim()}`);
    this.name = "GitError";
    this.repo = repo;
    this.args = args;
    this.code = result.code;
    this.stderr = result.stderr;
    this.stdout = result.stdout;
  }
}

function toEnv(extra?: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  if (extra) for (const [k, v] of Object.entries(extra)) if (v !== undefined) env[k] = v;
  return env;
}

/** Run git; never throws on non-zero exit. */
export function runGit(repo: string, args: string[], opts: GitRunOptions = {}): GitResult {
  const spawnOpts: Parameters<typeof Bun.spawnSync>[1] = { env: toEnv(opts.env) };
  if (opts.stdin !== undefined) {
    spawnOpts.stdin = typeof opts.stdin === "string" ? Buffer.from(opts.stdin, "utf8") : opts.stdin;
  }
  const r = Bun.spawnSync(["git", "-C", repo, ...args], spawnOpts);
  return {
    code: r.exitCode,
    stdout: r.stdout ? r.stdout.toString() : "",
    stderr: r.stderr ? r.stderr.toString() : "",
  };
}

/** Run git; throws GitError on non-zero exit. Returns trimmed stdout. */
export function git(repo: string, ...args: string[]): string {
  return gitWith(repo, args);
}

/** Like `git` but with options. Returns trimmed stdout. */
export function gitWith(repo: string, args: string[], opts: GitRunOptions = {}): string {
  const r = runGit(repo, args, opts);
  if (r.code !== 0) throw new GitError(repo, args, r);
  return r.stdout.trim();
}

/** True when the command succeeds. */
export function gitOk(repo: string, ...args: string[]): boolean {
  return runGit(repo, args).code === 0;
}

export function revParse(repo: string, ref: string): string {
  return git(repo, "rev-parse", "--verify", "--quiet", ref);
}

/** True when `ref` resolves to a commit. */
export function refExists(repo: string, ref: string): boolean {
  return runGit(repo, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).code === 0;
}

/** True when `dir` is itself the top level of a git worktree (not merely inside one). */
export function isRepoRoot(dir: string): boolean {
  const r = runGit(dir, ["rev-parse", "--show-toplevel"]);
  if (r.code !== 0) return false;
  const top = r.stdout.trim();
  try {
    const fs = require("node:fs") as typeof import("node:fs");
    return fs.realpathSync(top) === fs.realpathSync(dir);
  } catch {
    return false;
  }
}

/**
 * Throw unless `repo` is the top level of its own Git repository. Git
 * commands run in a directory without its own `.git` act on the nearest
 * enclosing repository (a dotfiles repo in `$HOME`, say), so `agent/repo`
 * would be created there.
 */
export function assertOwnRepo(repo: string): void {
  if (!isRepoRoot(repo)) throw new Error(`${repo}: ${NOT_OWN_REPO}`);
}

export const NOT_OWN_REPO = "not the top level of a git repository; run `brain init` first";

/** Blob hash of `path` in `tree` (a commit, tree, or ref), or null when absent. */
export function blobAt(repo: string, tree: string, path: string): string | null {
  const r = runGit(repo, ["rev-parse", "--verify", "--quiet", `${tree}:${path}`]);
  if (r.code !== 0) return null;
  const sha = r.stdout.trim();
  return sha === "" ? null : sha;
}

/** File contents of `path` in `tree`, or null when absent. */
export function showFile(repo: string, tree: string, path: string): string | null {
  const r = runGit(repo, ["show", `${tree}:${path}`]);
  if (r.code !== 0) return null;
  return r.stdout;
}

export interface TreeEntry {
  path: string;
  blob: string;
  mode: string;
}

/** Recursive listing of blobs (files only) in `tree`. */
export function lsTree(repo: string, tree: string): TreeEntry[] {
  const r = runGit(repo, ["ls-tree", "-r", "-z", tree]);
  if (r.code !== 0) throw new GitError(repo, ["ls-tree", "-r", "-z", tree], r);
  const out = r.stdout;
  const entries: TreeEntry[] = [];
  for (const rec of out.split("\0")) {
    if (rec === "") continue;
    const tab = rec.indexOf("\t");
    if (tab < 0) continue;
    const meta = rec.slice(0, tab).split(" ");
    const path = rec.slice(tab + 1);
    const mode = meta[0] ?? "";
    const type = meta[1] ?? "";
    const sha = meta[2] ?? "";
    if (type !== "blob") continue;
    entries.push({ path, blob: sha, mode });
  }
  return entries;
}

/**
 * Paths whose content differs between trees `from` and `to` (commits, trees
 * or refs), in Git's path order. Plumbing (`diff-tree`), so the user's diff
 * config never applies, and without rename detection: a rename lists both
 * its old and its new path. Empty when the trees are identical.
 */
export function changedPaths(repo: string, from: string, to: string): string[] {
  const args = ["diff-tree", "-r", "-z", "--name-only", "--no-renames", from, to];
  const r = runGit(repo, args);
  if (r.code !== 0) throw new GitError(repo, args, r);
  return r.stdout.split("\0").filter((p) => p !== "");
}

/** Paths of `*.md` files in `tree` whose slug matches `slug` (case-insensitive, normalized). */
export function pathsWithSlug(repo: string, tree: string, slug: string): string[] {
  const key = slugKey(slug);
  return lsTree(repo, tree)
    .filter((e) => isNotePath(e.path) && slugKey(slugFromPath(e.path)) === key)
    .map((e) => e.path);
}

/** True when any `*.md` file in `tree` has basename `slug` (case-insensitive). */
export function treeHasSlug(repo: string, tree: string, slug: string): boolean {
  return pathsWithSlug(repo, tree, slug).length > 0;
}

/**
 * Commits reachable from `ref` carrying trailer `<key>: <value>`, newest
 * first. Uses `--grep … --fixed-strings` for the search and confirms with the
 * parsed trailer so a prefix (`mut_01` vs `mut_012`) never matches.
 */
export function logGrepTrailer(repo: string, ref: string, key: string, value: string): string[] {
  const r = runGit(repo, [
    "log",
    "-z",
    `--format=%H%x1f%(trailers:key=${key},valueonly)`,
    `--grep=${key}: ${value}`,
    "--fixed-strings",
    ref,
    "--",
  ]);
  if (r.code !== 0) return [];
  const shas: string[] = [];
  for (const rec of r.stdout.split("\0")) {
    if (rec.trim() === "") continue;
    const sep = rec.indexOf("\x1f");
    const sha = (sep < 0 ? rec : rec.slice(0, sep)).trim();
    const values = sep < 0 ? "" : rec.slice(sep + 1);
    const matches = values
      .split("\n")
      .map((v) => v.trim())
      .some((v) => v === value);
    if (matches) shas.push(sha);
  }
  return shas;
}

export interface StatusEntry {
  /** Two-character XY status from `git status --porcelain`. */
  status: string;
  path: string;
  /** Original path for renames/copies. */
  origPath?: string;
}

/** `git status --porcelain -z` parsed; empty array means clean. */
export function statusPorcelain(repo: string): StatusEntry[] {
  const args = ["status", "--porcelain", "-z", "--untracked-files=all"];
  const r = runGit(repo, args);
  if (r.code !== 0) throw new GitError(repo, args, r);
  const tokens = r.stdout.split("\0");
  const entries: StatusEntry[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!;
    if (tok === "") continue;
    const status = tok.slice(0, 2);
    const path = tok.slice(3);
    const entry: StatusEntry = { status, path };
    if (status.includes("R") || status.includes("C")) {
      i++;
      const orig = tokens[i];
      if (orig !== undefined && orig !== "") entry.origPath = orig;
    }
    entries.push(entry);
  }
  return entries;
}

export function isClean(repo: string): boolean {
  return statusPorcelain(repo).length === 0;
}

const TRAILER_KEYS = {
  mutationId: "Mutation-ID",
  mutationType: "Mutation-Type",
  actor: "Actor",
  replans: "Replans",
} as const;

const TRAILER_LINE_RE = /^([A-Za-z][A-Za-z0-9-]*):\s*(.*)$/;

/** Parse the trailer block (last paragraph of `Key: value` lines) of a commit message. */
export function parseTrailers(message: string): CommitTrailers {
  const lines = message.replace(/\r\n/g, "\n").replace(/\s+$/, "").split("\n");
  // Trailer block: the last paragraph, every line of which is `Key: value`.
  let start = lines.length;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (line.trim() === "") break;
    start = i;
  }
  const block = lines.slice(start);
  const values = new Map<string, string>();
  const allTrailers = block.length > 0 && block.every((l) => TRAILER_LINE_RE.test(l));
  if (allTrailers && start > 0) {
    for (const line of block) {
      const m = line.match(TRAILER_LINE_RE)!;
      values.set(m[1]!.toLowerCase(), m[2]!.trim());
    }
  }
  const actorRaw = values.get("actor");
  const actor: CommitTrailers["actor"] =
    actorRaw === "agent" || actorRaw === "human-sync" || actorRaw === "human" ? actorRaw : "human";
  const out: CommitTrailers = { actor };
  const mid = values.get(TRAILER_KEYS.mutationId.toLowerCase());
  if (mid) out.mutationId = mid;
  const mtype = values.get(TRAILER_KEYS.mutationType.toLowerCase());
  if (mtype) out.mutationType = mtype as MutationType;
  const replans = values.get(TRAILER_KEYS.replans.toLowerCase());
  if (replans) out.replans = replans;
  return out;
}

/** `<subject>\n\n<trailers>\n` in the canonical order of spec §7.1 / §54. */
export function formatCommitMessage(subject: string, trailers: CommitTrailers): string {
  const lines: string[] = [];
  if (trailers.mutationId) lines.push(`${TRAILER_KEYS.mutationId}: ${trailers.mutationId}`);
  if (trailers.mutationType) lines.push(`${TRAILER_KEYS.mutationType}: ${trailers.mutationType}`);
  lines.push(`${TRAILER_KEYS.actor}: ${trailers.actor}`);
  if (trailers.replans) lines.push(`${TRAILER_KEYS.replans}: ${trailers.replans}`);
  return `${subject.trim()}\n\n${lines.join("\n")}\n`;
}

/** Full commit message of `sha`. */
export function commitMessage(repo: string, sha: string): string {
  return runGit(repo, ["log", "-1", "--format=%B", sha]).stdout;
}

/** Trailers of commit `sha`. */
export function trailersOf(repo: string, sha: string): CommitTrailers {
  return parseTrailers(commitMessage(repo, sha));
}

/**
 * Git blob id of `content` (SHA-1 over `blob <bytes>\0<content>`), identical
 * to `git hash-object --stdin` for SHA-1 repositories. Pure; no subprocess.
 */
export function hashObject(content: string | Uint8Array): string {
  const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : content;
  const hasher = new Bun.CryptoHasher("sha1");
  hasher.update(`blob ${bytes.byteLength}\0`);
  hasher.update(bytes);
  return hasher.digest("hex");
}

/** Default identity used only when the repository has none configured. */
export const FALLBACK_IDENTITY_ENV = {
  GIT_AUTHOR_NAME: "brain",
  GIT_AUTHOR_EMAIL: "brain@localhost",
  GIT_COMMITTER_NAME: "brain",
  GIT_COMMITTER_EMAIL: "brain@localhost",
} as const;

/** Env that guarantees `git commit` has an identity, without writing config. */
export function identityEnv(repo: string): Record<string, string> {
  const name = runGit(repo, ["config", "user.name"]);
  const email = runGit(repo, ["config", "user.email"]);
  const haveEnv = process.env.GIT_AUTHOR_NAME && process.env.GIT_COMMITTER_NAME;
  if ((name.code === 0 && name.stdout.trim() && email.code === 0 && email.stdout.trim()) || haveEnv) return {};
  return { ...FALLBACK_IDENTITY_ENV };
}

// ---------------------------------------------------------------------------
// objects by name (diffs and history, CR-4)
// ---------------------------------------------------------------------------

/** A full or abbreviated object name in hex (4 to 64 digits): never an option, a ref name or a revision expression. */
export const OBJECT_NAME_RE = /^[0-9a-f]{4,64}$/;

/**
 * Raw bytes of blob `blob`, or null when it is not readable: not in the
 * object store (never written, or pruned by `git gc`), not a blob, or not an
 * object name. Reads only (`git cat-file blob`).
 */
export function readBlob(repo: string, blob: string): Buffer | null {
  if (!OBJECT_NAME_RE.test(blob)) return null;
  const r = Bun.spawnSync(["git", "-C", repo, "cat-file", "blob", blob], { env: toEnv(), stdout: "pipe", stderr: "pipe" });
  return r.exitCode === 0 ? Buffer.from(r.stdout) : null;
}

/**
 * The full name of commit `name` (a full or abbreviated hex object name), or
 * null when `name` is not hex, is ambiguous, or does not name a commit.
 * Only hex names are accepted: no ref names, no revision expressions.
 */
export function resolveCommit(repo: string, name: string): string | null {
  if (!OBJECT_NAME_RE.test(name)) return null;
  const r = runGit(repo, ["rev-parse", "--verify", "--quiet", `${name}^{commit}`]);
  const sha = r.stdout.trim();
  return r.code === 0 && sha !== "" ? sha : null;
}

/** The parents of commit `sha`, first parent first (empty for a root commit). */
export function commitParents(repo: string, sha: string): string[] {
  const args = ["rev-list", "--parents", "--max-count=1", sha, "--"];
  const r = runGit(repo, args);
  if (r.code !== 0) throw new GitError(repo, args, r);
  return r.stdout.trim().split(" ").slice(1).filter((p) => p !== "");
}
