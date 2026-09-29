/**
 * Index projection of a Git commit (spec §41–43, §21 human rename, §42 history
 * rewrite; invariants I-21, I-22, I-23).
 *
 * Entry points:
 *
 *   reconcileIndex(paths, repoId, targetCommit, opts?)  → ReconcileResult
 *     Bring index.sqlite from `index_meta.indexed_commit` to `targetCommit`.
 *     Incremental via `git diff --name-status -M` when the old commit is still
 *     reachable; full rebuild otherwise (or when nothing was indexed yet).
 *
 *   rebuildIndex(paths, targetCommit, opts?)             → ReconcileResult
 *     Unconditional full rebuild (§42). Same row content as the incremental
 *     path: both run through `applyBatch`.
 *
 * The index reads Git objects only (`git show`, `git ls-tree`, `git diff`)
 * from `opts.repo ?? paths.agentWorktree`; it never reads the user worktree
 * filesystem. Everything happens inside one SQLite transaction, including the
 * `index_meta.indexed_commit` update, so a crash leaves the previous state.
 *
 * The caller (coordinator) is responsible for acting on `renames` — spec §21
 * says each human rename enqueues `ADD_ALIAS(oldSlug)`. This module only
 * reports them. Note that a rename is reported whenever the same `id` moved
 * path, even if the note already carries the old slug as an alias (e.g. after
 * an agent RENAME_SLUG); the caller should skip those.
 *
 * Determinism: no timestamps are stored; every collision rule below is
 * "lowest path wins" so a full rebuild and an incremental reconcile produce
 * identical rows for the same tree.
 */
import { createHash } from "node:crypto";
import { basename } from "node:path";
import type { ParsedNote, ReconcileResult, RepoPaths } from "../core/types";
import { isNotePath, slugKey } from "../core/slug";
import { GitError, lsTree, runGit, showFile } from "../git/git";
import { splitFrontmatter } from "../markdown/frontmatter";
import { NoteParseError, parseNote } from "../markdown/parse";
import { aliasesOfNote, noteById, noteByPath, resolveKey, type NoteRow } from "./queries";
import { clearIndex, indexedCommitOf, openIndex, repoIdOf, setIndexMeta, type IndexDb } from "./schema";

export { resolveKey } from "./queries";

export interface ReconcileOptions {
  /**
   * Any checkout of the knowledge repo, used only for object reads
   * (`git -C <repo> show|ls-tree|diff`). Defaults to `paths.agentWorktree`.
   */
  repo?: string;
  /** Receives one line per skipped note (unparsable, duplicate id, namespace collision). Default: console.warn. */
  log?: (message: string) => void;
}

export interface RebuildOptions extends ReconcileOptions {
  /** Stored in `index_meta.repo_id`. Defaults to `basename(paths.stateDir)` (= repo_id per §6). */
  repoId?: string;
}

/** Sections whose text feeds the retrieval content hash / embedding input (§26, §44–48). */
export const RETRIEVAL_SECTIONS = ["Claim", "Evidence", "Evolution"] as const;

function sectionText(note: ParsedNote, name: string): string {
  if (name in note.sections) return note.sections[name]!;
  const want = name.toLowerCase();
  for (const [k, v] of Object.entries(note.sections)) if (k.toLowerCase() === want) return v;
  return "";
}

/**
 * `sha1(title + "\n" + Claim + "\n" + Evidence + "\n" + Evolution)` (hex), where
 * a missing section contributes the empty string. Section lookup is
 * case-insensitive on the heading text. Phase 7 re-embeds a note only when
 * this value changes.
 */
export function retrievalContentHash(note: ParsedNote): string {
  const parts = [note.title, ...RETRIEVAL_SECTIONS.map((s) => sectionText(note, s))];
  return createHash("sha1").update(parts.join("\n"), "utf8").digest("hex");
}

/** Text stored in `notes_fts.body`: the raw Markdown with the frontmatter block removed. */
export function bodyForFts(note: ParsedNote): string {
  return splitFrontmatter(note.raw)?.body ?? note.raw;
}

/** Text embedded for retrieval: title + the retrieval sections (§44–48). */
export function retrievalText(note: ParsedNote): string {
  return [note.title, ...RETRIEVAL_SECTIONS.map((s) => sectionText(note, s))].filter((s) => s !== "").join("\n\n");
}

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

function resolveCommit(repo: string, ref: string): string {
  const args = ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`];
  const r = runGit(repo, args);
  if (r.code !== 0 || r.stdout.trim() === "") throw new GitError(repo, args, r);
  return r.stdout.trim();
}

function commitReachable(repo: string, sha: string): boolean {
  return runGit(repo, ["cat-file", "-e", `${sha}^{commit}`]).code === 0;
}

interface PathDiff {
  /** Note paths that no longer exist at `to` (deleted, or renamed away). */
  removed: string[];
  /** Note paths present at `to` whose content or location changed. */
  changed: string[];
}

/**
 * `git diff --name-status -M -z <from> <to>` restricted to note paths.
 * R/C entries carry two paths; each side is classified independently, so a
 * rename from `.md` to a non-note path is a removal and vice versa.
 */
function diffNotePaths(repo: string, from: string, to: string): PathDiff {
  const args = ["diff", "--name-status", "-M", "-z", from, to];
  const r = runGit(repo, args);
  if (r.code !== 0) throw new GitError(repo, args, r);
  const tokens = r.stdout.split("\0");
  const removed = new Set<string>();
  const changed = new Set<string>();
  let i = 0;
  while (i < tokens.length) {
    const status = tokens[i]!;
    if (status === "") {
      i += 1;
      continue;
    }
    const code = status[0]!;
    if (code === "R" || code === "C") {
      const oldPath = tokens[i + 1] ?? "";
      const newPath = tokens[i + 2] ?? "";
      i += 3;
      if (code === "R" && isNotePath(oldPath)) removed.add(oldPath);
      if (isNotePath(newPath)) changed.add(newPath);
      continue;
    }
    const path = tokens[i + 1] ?? "";
    i += 2;
    if (!isNotePath(path)) continue;
    if (code === "D") removed.add(path);
    else changed.add(path); // A, M, T and anything exotic (U, X, B)
  }
  return { removed: [...removed].sort(), changed: [...changed].sort() };
}

/** `path → blob sha` for every note in `commit`'s tree. */
function noteTree(repo: string, commit: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const e of lsTree(repo, commit)) if (isNotePath(e.path)) m.set(e.path, e.blob);
  return m;
}

// ---------------------------------------------------------------------------
// Row maintenance
// ---------------------------------------------------------------------------

function deleteNoteRows(db: IndexDb, noteId: string, includingEmbeddings: boolean): void {
  db.run("DELETE FROM links WHERE source_note_id = ?", [noteId]);
  db.run("DELETE FROM aliases WHERE note_id = ?", [noteId]);
  db.run("DELETE FROM notes_fts WHERE note_id = ?", [noteId]);
  db.run("DELETE FROM notes WHERE note_id = ?", [noteId]);
  if (includingEmbeddings) db.run("DELETE FROM embeddings WHERE note_id = ?", [noteId]);
}

function keysOf(db: IndexDb, row: NoteRow): string[] {
  return [row.slugKey, ...aliasesOfNote(db, row.noteId).map(slugKey)];
}

interface OldState {
  path: string;
  slug: string;
  keys: string[];
}

interface Batch {
  /** Paths whose rows must go (left the tree, or moved away). */
  removedPaths: Iterable<string>;
  /** Paths to (re)index from `commit`'s tree. */
  changedPaths: Iterable<string>;
}

interface BatchOutcome {
  renames: ReconcileResult["renames"];
  /** Paths whose rows changed (removed, replaced or indexed), sorted. Non-note `*.md` files are not listed. */
  touchedPaths: string[];
  /** Notes now present in the index because of this batch. */
  indexed: { noteId: string; path: string }[];
}

/**
 * The single indexing routine (§43). Both the incremental path and the full
 * rebuild run through here, so their rows cannot drift.
 *
 * Order of operations:
 *   1. parse every changed path (sorted) from `commit`'s tree; skip + log
 *      unparsable files and duplicate ids (lowest path wins);
 *   2. snapshot the old rows of every note the batch touches, collecting
 *      their slug/alias keys;
 *   3. delete those rows (embeddings only for notes that are truly gone);
 *   4. insert notes, aliases and FTS rows (lowest path wins on slug_key /
 *      alias_key collisions with notes outside the batch);
 *   5. insert links for the batch's notes, resolving against the namespace;
 *   6. re-resolve every `links` row whose target_key is in the union of old
 *      and new keys (I-23);
 *   7. report renames: same id, different path than the snapshot (§21).
 */
function applyBatch(db: IndexDb, repo: string, commit: string, batch: Batch, log: (m: string) => void): BatchOutcome {
  const tree = noteTree(repo, commit);
  const changedSet = new Set<string>();
  for (const p of batch.changedPaths) if (tree.has(p)) changedSet.add(p);
  const removedOnly = new Set<string>();
  for (const p of batch.removedPaths) if (!changedSet.has(p)) removedOnly.add(p);
  const changed = [...changedSet].sort();

  // 1. parse
  const parsed = new Map<string, ParsedNote>(); // id → note (first sorted path wins)
  const invalidPaths: string[] = []; // changed paths whose rows must be removed instead
  const notRename = new Set<string>(); // ids that moved only because a duplicate copy won
  for (const path of changed) {
    const raw = showFile(repo, commit, path);
    if (raw === null) {
      invalidPaths.push(path);
      continue;
    }
    if (splitFrontmatter(raw) === null) {
      // A Markdown file with no frontmatter block (README.md, AGENTS.md, …) is
      // not a note: skipped silently, but any stale rows at that path go.
      invalidPaths.push(path);
      continue;
    }
    let note: ParsedNote;
    try {
      note = parseNote(path, raw);
    } catch (e) {
      if (!(e instanceof NoteParseError)) throw e;
      log(`index: skipping unparsable note ${path}: ${e.message}`);
      invalidPaths.push(path);
      continue;
    }
    const id = note.frontmatter.id;
    const dup = parsed.get(id);
    if (dup) {
      log(`index: skipping ${path}: duplicate id ${id} (already at ${dup.path})`);
      invalidPaths.push(path);
      continue;
    }
    const existing = noteById(db, id);
    if (existing && existing.path !== path && tree.has(existing.path) && !changedSet.has(existing.path)) {
      // Same id at two paths in the tree, the other one unchanged: lowest path wins.
      if (existing.path < path) {
        log(`index: skipping ${path}: duplicate id ${id} (already at ${existing.path})`);
        invalidPaths.push(path);
        continue;
      }
      log(`index: ${path} takes over id ${id} from ${existing.path} (duplicate id)`);
      notRename.add(id);
    }
    parsed.set(id, note);
  }

  // 2. snapshot
  const batchIds = new Set(parsed.keys());
  const deleteIds = new Set<string>();
  for (const p of [...removedOnly, ...invalidPaths]) {
    const row = noteByPath(db, p);
    if (row && !batchIds.has(row.noteId)) deleteIds.add(row.noteId);
  }
  for (const note of parsed.values()) {
    const row = noteByPath(db, note.path);
    if (row && !batchIds.has(row.noteId)) deleteIds.add(row.noteId);
  }
  const old = new Map<string, OldState>();
  for (const id of [...batchIds, ...deleteIds]) {
    const row = noteById(db, id);
    if (row) old.set(id, { path: row.path, slug: row.slug, keys: keysOf(db, row) });
  }

  // 3. delete
  const affected = new Set<string>();
  for (const [id, state] of old) {
    for (const k of state.keys) affected.add(k);
    deleteNoteRows(db, id, deleteIds.has(id));
  }

  // 4. insert notes / aliases / fts (sorted by path)
  const notes = [...parsed.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const inserted: ParsedNote[] = [];
  const insNote = db.query(
    `INSERT INTO notes (note_id, slug, slug_key, path, title, type, status, created_at, blob_hash, retrieval_content_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insAlias = db.query("INSERT INTO aliases (alias, alias_key, note_id) VALUES (?, ?, ?)");
  const insFts = db.query("INSERT INTO notes_fts (note_id, title, body) VALUES (?, ?, ?)");
  for (const note of notes) {
    const id = note.frontmatter.id;
    const slugOwner = db.query("SELECT note_id, path FROM notes WHERE slug_key = ?").get(note.slugKey) as { note_id: string; path: string } | null;
    if (slugOwner) {
      if (slugOwner.path < note.path) {
        log(`index: skipping ${note.path}: slug "${note.slug}" collides with ${slugOwner.path}`);
        continue;
      }
      log(`index: ${note.path} shadows ${slugOwner.path}: slug "${note.slug}" collision`);
      const loser = noteById(db, slugOwner.note_id)!;
      for (const k of keysOf(db, loser)) affected.add(k);
      deleteNoteRows(db, slugOwner.note_id, true);
    }
    insNote.run(
      id,
      note.slug,
      note.slugKey,
      note.path,
      note.title,
      note.frontmatter.type,
      note.frontmatter.status,
      note.frontmatter.created,
      tree.get(note.path) ?? "",
      retrievalContentHash(note),
    );
    affected.add(note.slugKey);
    const seenAliasKeys = new Set<string>();
    for (const alias of note.frontmatter.aliases) {
      const key = slugKey(alias);
      if (key === "" || seenAliasKeys.has(key)) continue;
      seenAliasKeys.add(key);
      const owner = db
        .query("SELECT a.note_id AS note_id, n.path AS path FROM aliases a JOIN notes n ON n.note_id = a.note_id WHERE a.alias_key = ?")
        .get(key) as { note_id: string; path: string } | null;
      if (owner) {
        if (owner.path < note.path) {
          log(`index: ${note.path}: alias "${alias}" already owned by ${owner.path}; skipped`);
          continue;
        }
        log(`index: ${note.path}: alias "${alias}" taken over from ${owner.path}`);
        db.run("DELETE FROM aliases WHERE alias_key = ?", [key]);
      }
      insAlias.run(alias, key, id);
      affected.add(key);
    }
    insFts.run(id, note.title, bodyForFts(note));
    inserted.push(note);
  }

  // 5. links (after every note/alias of the batch is visible)
  const insLink = db.query(
    "INSERT INTO links (source_note_id, target_key, target_note_id, relationship, resolved, section) VALUES (?, ?, ?, ?, ?, ?)",
  );
  for (const note of inserted) {
    for (const link of note.links) {
      const target = resolveKey(db, link.targetKey);
      insLink.run(note.frontmatter.id, link.targetKey, target, link.relationship, target === null ? 0 : 1, link.section);
    }
  }

  // 6. re-resolve links whose target namespace entry changed
  const upd = db.query("UPDATE links SET target_note_id = ?, resolved = ? WHERE target_key = ?");
  for (const key of affected) {
    const target = resolveKey(db, key);
    upd.run(target, target === null ? 0 : 1, key);
  }

  // 7. renames
  const renames: ReconcileResult["renames"] = [];
  for (const note of inserted) {
    const id = note.frontmatter.id;
    const prev = old.get(id);
    if (prev && prev.path !== note.path && !notRename.has(id)) {
      renames.push({ noteId: id, oldPath: prev.path, newPath: note.path, oldSlug: prev.slug });
    }
  }

  const touched = new Set<string>();
  for (const state of old.values()) touched.add(state.path);
  for (const note of inserted) touched.add(note.path);
  return {
    renames,
    touchedPaths: [...touched].sort(),
    indexed: inserted.map((n) => ({ noteId: n.frontmatter.id, path: n.path })),
  };
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

function fullRebuild(db: IndexDb, repo: string, repoId: string, commit: string, log: (m: string) => void): ReconcileResult {
  // Snapshot id → (path, slug) so human renames are still reported when the
  // previous state is unusable for a diff (§21 "differs from the previous
  // index state"). Empty on a fresh index.
  const before = new Map<string, { path: string; slug: string }>();
  for (const r of db.query("SELECT note_id, path, slug FROM notes").all() as { note_id: string; path: string; slug: string }[]) {
    before.set(r.note_id, { path: r.path, slug: r.slug });
  }
  clearIndex(db);
  const outcome = applyBatch(db, repo, commit, { removedPaths: [], changedPaths: noteTree(repo, commit).keys() }, log);
  const renames: ReconcileResult["renames"] = [];
  for (const n of outcome.indexed) {
    const prev = before.get(n.noteId);
    if (prev && prev.path !== n.path) renames.push({ noteId: n.noteId, oldPath: prev.path, newPath: n.path, oldSlug: prev.slug });
  }
  setIndexMeta(db, repoId, commit);
  return { indexedCommit: commit, changedPaths: outcome.touchedPaths, renames, fullRebuild: true };
}

/**
 * Reconcile an already-open index to `targetCommit`. See `reconcileIndex`.
 * Exposed for callers that keep a long-lived handle; runs in one transaction.
 */
export function reconcileIndexDb(
  db: IndexDb,
  repo: string,
  repoId: string,
  targetCommit: string,
  log: (m: string) => void = defaultLog,
): ReconcileResult {
  const target = resolveCommit(repo, targetCommit);
  return db.transaction((): ReconcileResult => {
    const indexed = indexedCommitOf(db);
    const storedRepo = repoIdOf(db);
    if (indexed === target && (storedRepo === null || storedRepo === repoId)) {
      if (storedRepo === null) setIndexMeta(db, repoId, target);
      return { indexedCommit: target, changedPaths: [], renames: [], fullRebuild: false };
    }
    if (indexed === null || (storedRepo !== null && storedRepo !== repoId) || !commitReachable(repo, indexed)) {
      if (storedRepo !== null && storedRepo !== repoId) log(`index: repo_id changed (${storedRepo} → ${repoId}); rebuilding`);
      else if (indexed !== null) log(`index: indexed commit ${indexed} is unreachable; rebuilding`);
      return fullRebuild(db, repo, repoId, target, log);
    }
    const diff = diffNotePaths(repo, indexed, target);
    const outcome = applyBatch(db, repo, target, { removedPaths: diff.removed, changedPaths: diff.changed }, log);
    setIndexMeta(db, repoId, target);
    return { indexedCommit: target, changedPaths: outcome.touchedPaths, renames: outcome.renames, fullRebuild: false };
  })();
}

function defaultLog(message: string): void {
  console.warn(message);
}

/**
 * Bring `paths.indexDb` to `targetCommit` (a sha or ref; stored as the full
 * sha). Behaviour (§41–43):
 *
 *   - `indexed_commit == target`            → no-op, `changedPaths: []`.
 *   - no `indexed_commit`, or it is not a reachable commit in `repo`, or the
 *     stored repo_id differs                → full rebuild (`fullRebuild: true`).
 *   - otherwise                              → `git diff --name-status -M`
 *     restricted to `*.md`; A/M/T/C index the path, D removes it, R removes the
 *     old and indexes the new; then links whose target slug/alias was added or
 *     removed are re-resolved.
 *
 * `renames` lists notes whose `id` already existed at a different path
 * (git R, or D+A with the same id). The caller enqueues `ADD_ALIAS(oldSlug)`
 * (§21); nothing is enqueued here.
 *
 * Unparsable notes are skipped and logged, never thrown. Throws `GitError`
 * only when `targetCommit` itself cannot be resolved in `repo`.
 */
export async function reconcileIndex(
  paths: RepoPaths,
  repoId: string,
  targetCommit: string,
  opts: ReconcileOptions = {},
): Promise<ReconcileResult> {
  const repo = opts.repo ?? paths.agentWorktree;
  const db = openIndex(paths.indexDb);
  try {
    return reconcileIndexDb(db, repo, repoId, targetCommit, opts.log ?? defaultLog);
  } finally {
    db.close();
  }
}

/**
 * Unconditional full rebuild of `paths.indexDb` at `targetCommit` (§42):
 * drops every projected row, indexes every `*.md` in the commit's tree,
 * resolves all links, and sets `indexed_commit`. Produces exactly the rows an
 * incremental reconcile to the same commit would.
 */
export async function rebuildIndex(paths: RepoPaths, targetCommit: string, opts: RebuildOptions = {}): Promise<ReconcileResult> {
  const repo = opts.repo ?? paths.agentWorktree;
  const db = openIndex(paths.indexDb);
  try {
    const repoId = opts.repoId ?? basename(paths.stateDir);
    const target = resolveCommit(repo, targetCommit);
    return db.transaction(() => fullRebuild(db, repo, repoId, target, opts.log ?? defaultLog))();
  } finally {
    db.close();
  }
}
