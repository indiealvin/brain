/**
 * Write-set preconditions (spec §8–9; I-1).
 *
 * Validation reads Git trees only, never a worktree filesystem.
 */
import type { Mutation, TargetPrecondition } from "./types";
import { blobAt, treeHasSlug } from "../git/git";
import { slugKey } from "./slug";

export interface PreconditionFailure {
  target: TargetPrecondition;
  reason: string;
}

export interface PreconditionResult {
  ok: boolean;
  failures: PreconditionFailure[];
}

/**
 * Check every target against `tree` (a commit, ref or tree-ish) of `repo`:
 * `present` requires the blob at `path` to equal `blobHash` (a missing or
 * moved file fails); `absent` requires no `*.md` with that slug anywhere in
 * the tree (case-insensitive, normalized).
 */
export function validatePreconditions(repo: string, tree: string, targets: TargetPrecondition[]): PreconditionResult {
  const failures: PreconditionFailure[] = [];
  for (const target of targets) {
    if (target.kind === "present") {
      const actual = blobAt(repo, tree, target.path);
      if (actual === null) {
        failures.push({ target, reason: `${target.path}: missing in ${tree}` });
      } else if (actual !== target.blobHash) {
        failures.push({ target, reason: `${target.path}: blob ${actual} != expected ${target.blobHash}` });
      }
    } else if (treeHasSlug(repo, tree, target.slug)) {
      failures.push({ target, reason: `slug ${JSON.stringify(target.slug)} already exists in ${tree}` });
    }
  }
  return { ok: failures.length === 0, failures };
}

/** `noteKey` for a single target: note id for present, `slug:<slugKey>` for absent. */
export function targetNoteKey(target: TargetPrecondition): string {
  return target.kind === "present" ? target.noteId : `slug:${slugKey(target.slug)}`;
}

/**
 * Keys identifying the notes a mutation touches (spec §10 rule 2): note ids
 * for present targets and `slug:<slugKey>` for absent (CREATE) targets.
 */
export function targetNoteKeys(mutation: Pick<Mutation, "targets">): string[] {
  const keys: string[] = [];
  for (const t of mutation.targets) {
    const k = targetNoteKey(t);
    if (!keys.includes(k)) keys.push(k);
  }
  return keys;
}

/** One-line description of failures for `lastError`. */
export function describeFailures(failures: PreconditionFailure[]): string {
  return failures.map((f) => f.reason).join("; ");
}
