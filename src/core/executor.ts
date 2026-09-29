/**
 * Model-free mutation executor (spec §12; I-3, I-4, I-6, I-14, I-15, I-21).
 *
 * Runs in the agent worktree against the current `agent/repo` tree. Writes
 * the planner's materialized `FileWrite`s verbatim, verifies the touched
 * path set equals the declared write set, normalizes and validates the
 * result, and commits with Mutation-ID trailers. Steps 13–14 of §12 (index
 * reconcile, integration) are the caller's via `afterCommit`.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { AGENT_BRANCH, AUTOMATIC_MUTATION_TYPES } from "./types";
import type {
  ExecutionResult,
  FileWrite,
  Mutation,
  MutationState,
  ParsedNote,
  RepoPaths,
  TargetPrecondition,
  ValidationIssue,
} from "./types";
import type { Queue } from "./queue";
import { describeFailures, validatePreconditions } from "./preconditions";
import { isNotePath, slugFromPath, slugKey } from "./slug";
import { formatCommitMessage, gitWith, logGrepTrailer, lsTree, revParse, showFile, statusPorcelain } from "../git/git";
import { agentCommitEnv, resetAgentWorktree } from "../git/worktree";
import { NoteParseError, parseNote } from "../markdown/parse";
import { serializeNote } from "../markdown/serialize";
import { buildNamespace, checkAliasCollision, validateNote } from "../markdown/validate";

export interface ExecutorContext {
  paths: RepoPaths;
  queue: Queue;
  /** §12 steps 13–14 hook; called after the commit is recorded as COMMITTED. */
  afterCommit?: (sha: string) => Promise<void>;
}

/** States that never execute again (I-6; BLOCKED resolves to REPLAN). */
const NON_EXECUTABLE: readonly MutationState[] = ["REPLAN", "BLOCKED", "INTEGRATED", "NOOP"];

const PROTECTED_STATUSES = new Set(["superseded", "archived"]);

function isAutomatic(type: Mutation["type"]): boolean {
  return (AUTOMATIC_MUTATION_TYPES as readonly string[]).includes(type);
}

function tryParse(path: string, raw: string | null): ParsedNote | null {
  if (raw === null || !isNotePath(path)) return null;
  try {
    return parseNote(path, raw);
  } catch (e) {
    if (e instanceof NoteParseError) return null;
    throw e;
  }
}

/** Every parsable note in `tree` keyed by path. */
function notesInTree(repo: string, tree: string): Map<string, ParsedNote> {
  const out = new Map<string, ParsedNote>();
  for (const entry of lsTree(repo, tree)) {
    if (!isNotePath(entry.path)) continue;
    const note = tryParse(entry.path, showFile(repo, tree, entry.path));
    if (note) out.set(entry.path, note);
  }
  return out;
}

function issueError(issue: ValidationIssue): string {
  return `${issue.code}: ${issue.message}${issue.path ? ` (${issue.path})` : ""}`;
}

/**
 * Declared write set: paths of present targets plus the write paths that
 * name an absent target's slug. Returns null with a reason when the writes
 * do not map 1:1 onto the targets.
 */
export function declaredWriteSet(mutation: Mutation): { paths: Set<string>; error?: string } {
  const presentPaths = new Set<string>();
  for (const t of mutation.targets) if (t.kind === "present") presentPaths.add(t.path);
  const absentKeys = new Map<string, TargetPrecondition & { kind: "absent" }>();
  for (const t of mutation.targets) if (t.kind === "absent") absentKeys.set(slugKey(t.slug), t);

  const paths = new Set<string>(presentPaths);
  const matchedAbsent = new Set<string>();
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const w of mutation.writes) {
    if (seen.has(w.path)) problems.push(`duplicate write for ${w.path}`);
    seen.add(w.path);
    if (presentPaths.has(w.path)) continue;
    const key = slugKey(slugFromPath(w.path));
    if (isNotePath(w.path) && absentKeys.has(key)) {
      matchedAbsent.add(key);
      paths.add(w.path);
      continue;
    }
    problems.push(`write ${w.path} is not a declared target`);
  }
  for (const key of absentKeys.keys()) {
    if (!matchedAbsent.has(key)) problems.push(`absent target ${JSON.stringify(absentKeys.get(key)!.slug)} has no write`);
  }
  return problems.length ? { paths, error: problems.join("; ") } : { paths };
}

function applyWrites(root: string, writes: FileWrite[]): void {
  for (const w of writes) {
    const abs = join(root, w.path);
    if (w.content === null) {
      if (existsSync(abs)) rmSync(abs, { force: true });
      continue;
    }
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, w.content);
  }
}

/**
 * Step 10: title-change normalization plus validation of the post-state.
 * Returns the first issue (as `CODE: message`) or null when valid. Rewrites
 * files in the worktree when normalization changes them.
 */
function normalizeAndValidate(
  root: string,
  mutation: Mutation,
  before: Map<string, ParsedNote>,
  presentPaths: Set<string>,
): string | null {
  const automatic = isAutomatic(mutation.type);
  const after = new Map<string, ParsedNote>(before);
  const written: ParsedNote[] = [];

  for (const w of mutation.writes) {
    if (w.content === null) {
      after.delete(w.path);
      continue;
    }
    if (!isNotePath(w.path)) continue;
    let note: ParsedNote;
    try {
      note = parseNote(w.path, w.content);
    } catch (e) {
      if (e instanceof NoteParseError) return `NOTE_PARSE_ERROR: ${e.message}`;
      throw e;
    }
    const old = presentPaths.has(w.path) ? before.get(w.path) : undefined;
    if (old) {
      if (old.frontmatter.id !== note.frontmatter.id) {
        return `ID_CHANGE_FORBIDDEN: ${w.path} id ${old.frontmatter.id} → ${note.frontmatter.id}`;
      }
      // §22: a title change appends the old title as an alias unless present.
      const oldTitle = old.title.trim();
      if (oldTitle !== "" && oldTitle !== note.title.trim()) {
        const have = new Set(note.frontmatter.aliases.map(slugKey));
        if (!have.has(slugKey(oldTitle))) {
          note.frontmatter.aliases = [...note.frontmatter.aliases, oldTitle];
          const rewritten = serializeNote(note);
          writeFileSync(join(root, w.path), rewritten);
          note = parseNote(w.path, rewritten);
        }
      }
      if (automatic) {
        const os = old.frontmatter.status;
        const ns = note.frontmatter.status;
        if (os !== ns && !(os === "active" && ns === "tentative")) {
          return `STATUS_TRANSITION_FORBIDDEN: ${w.path} ${os} → ${ns} requires RECONCILE_EVOLUTION`;
        }
        if (old.frontmatter.type !== note.frontmatter.type) {
          return `TYPE_CHANGE_FORBIDDEN: ${w.path} ${old.frontmatter.type} → ${note.frontmatter.type} requires RECONCILE_EVOLUTION`;
        }
      }
    }
    after.set(w.path, note);
    written.push(note);
  }

  for (const note of written) {
    for (const issue of validateNote(note)) return issueError(issue);
    const others: ParsedNote[] = [];
    for (const [p, n] of after) if (p !== note.path) others.push(n);
    for (const o of others) {
      if (o.slugKey === note.slugKey) {
        return issueError({ code: "SLUG_COLLISION", message: `slug ${JSON.stringify(note.slug)} collides with ${o.path}`, path: note.path });
      }
      if (o.frontmatter.id === note.frontmatter.id) {
        return issueError({ code: "DUPLICATE_ID", message: `id ${note.frontmatter.id} is also used by ${o.path}`, path: note.path });
      }
    }
    const ns = buildNamespace(others);
    const selfId = note.frontmatter.id;
    if (ns.has(note.slugKey) && ns.get(note.slugKey) !== selfId) {
      return issueError({
        code: "SLUG_COLLISION",
        message: `slug ${JSON.stringify(note.slug)} collides with an alias of note ${ns.get(note.slugKey)}`,
        path: note.path,
      });
    }
    for (const alias of note.frontmatter.aliases) {
      const c = checkAliasCollision(alias, ns, selfId);
      if (c) return issueError({ ...c, path: note.path });
    }
  }
  return null;
}

/** Execute a queued mutation in the agent worktree (spec §12). */
export async function executeMutation(ctx: ExecutorContext, mutationId: string): Promise<ExecutionResult> {
  const { queue, paths } = ctx;
  const wt = paths.agentWorktree;
  const row = queue.get(mutationId);
  if (!row) throw new Error(`executor: unknown mutation ${mutationId}`);
  if (NON_EXECUTABLE.includes(row.state)) {
    return { mutationId, state: row.state, commitSha: row.commitSha, error: `not executable in state ${row.state}` };
  }
  const mutation = queue.getMutation(mutationId)!;

  const fail = (state: MutationState, error: string, extra: Partial<ExecutionResult> = {}): ExecutionResult => {
    queue.setState(mutationId, state, { lastError: error });
    return { mutationId, state, error, ...extra };
  };

  // 1. RUNNING
  queue.setState(mutationId, "RUNNING", { attemptInc: 1 });

  // 2. Idempotency by Mutation-ID trailer.
  const existing = logGrepTrailer(wt, AGENT_BRANCH, "Mutation-ID", mutationId);
  if (existing.length > 0) {
    const sha = existing[0]!;
    queue.setState(mutationId, "COMMITTED", { commitSha: sha, lastError: null });
    return { mutationId, state: "COMMITTED", commitSha: sha };
  }

  // 3. Preconditions against the agent branch tree.
  const pre = validatePreconditions(wt, AGENT_BRANCH, mutation.targets);
  if (!pre.ok) return fail("REPLAN", `PRECONDITION_FAILED: ${describeFailures(pre.failures)}`);

  // 4. Automatic mutations never touch superseded/archived notes (I-15).
  const presentPaths = new Set<string>();
  for (const t of mutation.targets) if (t.kind === "present") presentPaths.add(t.path);
  const before = new Map<string, ParsedNote>();
  for (const p of presentPaths) {
    const n = tryParse(p, showFile(wt, AGENT_BRANCH, p));
    if (n) before.set(p, n);
  }
  if (isAutomatic(mutation.type)) {
    for (const n of before.values()) {
      if (PROTECTED_STATUSES.has(n.frontmatter.status)) {
        return fail("REPLAN", "PROPOSAL_REQUIRED", { proposalRequired: true });
      }
    }
  }

  // 5. Clean worktree.
  if (statusPorcelain(wt).length > 0) resetAgentWorktree(paths);

  // 6. Apply the materialized patch verbatim.
  applyWrites(wt, mutation.writes);

  // 7–8. Touched paths; empty diff is NOOP.
  const touched = new Set(statusPorcelain(wt).map((e) => e.path));
  if (touched.size === 0) {
    queue.setState(mutationId, "NOOP", { lastError: null });
    return { mutationId, state: "NOOP" };
  }

  // 9. Exact write set (I-3).
  const declared = declaredWriteSet(mutation);
  const extra = [...touched].filter((p) => !declared.paths.has(p));
  const missing = [...declared.paths].filter((p) => !touched.has(p));
  if (declared.error || extra.length || missing.length) {
    resetAgentWorktree(paths);
    const parts: string[] = [];
    if (declared.error) parts.push(declared.error);
    if (extra.length) parts.push(`undeclared paths touched: ${extra.join(", ")}`);
    if (missing.length) parts.push(`declared paths not touched: ${missing.join(", ")}`);
    return fail("FAILED_INVALID_EXECUTION", `WRITE_SET_MISMATCH: ${parts.join("; ")}`);
  }

  // 10. Normalize + validate against the post-state namespace.
  const treeNotes = notesInTree(wt, AGENT_BRANCH);
  const issue = normalizeAndValidate(wt, mutation, treeNotes, presentPaths);
  if (issue) {
    resetAgentWorktree(paths);
    return fail("FAILED", issue);
  }

  // 11. Commit with trailers (§54).
  const message = formatCommitMessage(`knowledge: ${mutation.summary}`, {
    mutationId,
    mutationType: mutation.type,
    actor: "agent",
    replans: mutation.replans,
  });
  let sha: string;
  try {
    gitWith(wt, ["add", "-A"]);
    gitWith(wt, ["commit", "-q", "--no-verify", "-F", "-"], { stdin: message, env: agentCommitEnv() });
    sha = revParse(wt, "HEAD");
  } catch (e) {
    resetAgentWorktree(paths);
    return fail("FAILED", `COMMIT_FAILED: ${(e as Error).message}`);
  }

  // 12. COMMITTED.
  queue.setState(mutationId, "COMMITTED", { commitSha: sha, lastError: null });
  if (ctx.afterCommit) await ctx.afterCommit(sha);
  return { mutationId, state: "COMMITTED", commitSha: sha };
}
