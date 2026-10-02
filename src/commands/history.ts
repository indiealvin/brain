/**
 * Service layer, history (CR-4; docs/mac-app/protocol.md §4 History): the
 * commits on `main` with their parsed trailers (`history.list`), and one
 * commit's diff (`history.diff`). Returns data; adapters format it.
 *
 * Reads only, and takes no lock: `git rev-list` and `git diff-tree` in the
 * user worktree's repository (src/git/diff.ts for the diff). `main` is what
 * the user owns; pending agent commits show through `mutations.list`
 * instead.
 *
 * Parameters are checked here, so every adapter rejects the same input: a
 * commit must be a hex object name of a commit (`UnknownCommitError`,
 * `INVALID_PARAMS`), and a path must be relative to the repository root
 * without `..` (`INVALID_PARAMS`). Paths are literal (no pathspec magic); a
 * directory path matches every file under it.
 */
import { isAbsolute } from "node:path";
import { MAIN_BRANCH, type CommitTrailers, type MutationType, type RepoCoordinator } from "../core/types";
import { commitDiff, commitPaths, type FileDiff } from "../git/diff";
import { commitParents, GitError, parseTrailers, resolveCommit, revParse, runGit } from "../git/git";
import { isAncestor } from "../git/worktree";
import { ServiceError, UnknownCommitError } from "./errors";

export const DEFAULT_HISTORY_PAGE = 50;

/** One commit on `main` (protocol §7). Trailers per docs/spec.md §54, parsed by `parseTrailers`. */
export interface HistoryEntry {
  sha: string;
  /** Committer date, ISO-8601 in UTC (`Date.toISOString`). */
  committedAt: string;
  subject: string;
  /** A commit without an `Actor` trailer (a user's own `git revert`, say) is `"human"`. */
  actor: CommitTrailers["actor"];
  mutationId?: string;
  mutationType?: MutationType;
  replans?: string;
  /** Files changed against the first parent (the empty tree for a root commit), in Git's path order; all of them, whatever `path` filtered on. */
  paths: string[];
}

/** A repository-relative path parameter: not empty, not absolute, no `..` segment, no NUL. */
function checkPath(path: string): string {
  if (path === "" || path.includes("\0") || isAbsolute(path) || path.split(/[\\/]/).includes("..")) {
    throw new ServiceError("INVALID_PARAMS", `path must be relative to the repository root, without "..": ${JSON.stringify(path)}`);
  }
  return path;
}

/** Field separator and record marker of the `rev-list --format` below; neither occurs in a sha, a date or a subject. */
const FS = "\x1f";
const RS = "\x1e";
const LOG_FORMAT = `${RS}%H${FS}%P${FS}%ct${FS}%s${FS}%B`;

/**
 * Commits on `main`, newest first, following first parents only (`main` is
 * linear by ff-only integration; a merge made by hand is one entry, compared
 * with its first parent).
 *
 * - `path`: only commits that changed that file (or a file under that
 *   directory) against their first parent. `paths` still lists every file.
 * - `before`: only commits older than that one (exclusive), for paging with
 *   the last `sha` of the previous page. It must be on `main`
 *   (`UnknownCommitError` otherwise, as for a sha that names no commit).
 * - `limit` (> 0): at most that many entries.
 */
export function historyList(coord: RepoCoordinator, opts: { path?: string; limit?: number; before?: string } = {}): HistoryEntry[] {
  const repo = coord.paths.userWorktree;
  const limit = opts.limit ?? DEFAULT_HISTORY_PAGE;
  if (!Number.isInteger(limit) || limit <= 0) throw new ServiceError("INVALID_PARAMS", "limit must be a positive integer");
  const path = opts.path === undefined ? undefined : checkPath(opts.path);
  let start = revParse(repo, MAIN_BRANCH);
  if (opts.before !== undefined) {
    const before = resolveCommit(repo, opts.before);
    if (before === null) throw new UnknownCommitError("before", opts.before);
    if (!isAncestor(repo, before, start)) throw new UnknownCommitError("before", opts.before, `before: ${opts.before} is not on ${MAIN_BRANCH}`);
    const parent = commitParents(repo, before)[0];
    if (parent === undefined) return []; // the root commit: nothing is older
    start = parent;
  }
  const args = ["rev-list", "--first-parent", "--no-commit-header", `--format=${LOG_FORMAT}`, `--max-count=${limit}`, start, "--", ...(path === undefined ? [] : [path])];
  const r = runGit(repo, args, { env: { GIT_LITERAL_PATHSPECS: "1" } });
  if (r.code !== 0) throw new GitError(repo, args, r);
  return r.stdout
    .split(RS)
    .filter((rec) => rec.trim() !== "")
    .map((rec) => {
      const [sha, parents, ct, subject, ...body] = rec.split(FS);
      const firstParent = parents!.split(" ")[0] || null; // "" for a root commit
      const entry: HistoryEntry = {
        sha: sha!,
        committedAt: new Date(Number(ct) * 1000).toISOString(),
        subject: subject!,
        ...parseTrailers(body.join(FS)),
        paths: commitPaths(repo, sha!, firstParent),
      };
      return entry;
    });
}

/**
 * The diff of commit `sha` against its first parent (the empty tree for a
 * root commit), limited to `path` when given: one `FileDiff` per changed
 * file. Any commit of the repository is accepted, not only those on `main`
 * (a `QueueRow.commitSha` on `agent/repo`, say). `UnknownCommitError` when
 * `sha` names no commit.
 */
export function historyDiff(coord: RepoCoordinator, opts: { sha: string; path?: string }): FileDiff[] {
  const repo = coord.paths.userWorktree;
  const path = opts.path === undefined ? undefined : checkPath(opts.path);
  const sha = resolveCommit(repo, opts.sha);
  if (sha === null) throw new UnknownCommitError("sha", opts.sha);
  return commitDiff(repo, sha, { path });
}
