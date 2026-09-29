import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { blobAt, git, gitWith, revParse } from "../../src/git/git";
import { targetNoteKeys, validatePreconditions } from "../../src/core/preconditions";
import type { TargetPrecondition } from "../../src/core/types";

const ENV = {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
};

let repo: string;
let first = "";
let second = "";
let xBlob = "";

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "brain-pre-unit-"));
  git(repo, "init", "-q", "-b", "main");
  mkdirSync(join(repo, "knowledge", "sub"), { recursive: true });
  writeFileSync(join(repo, "knowledge", "x.md"), "# X\n");
  writeFileSync(join(repo, "knowledge", "sub", "Café-Note.md"), "# C\n");
  git(repo, "add", "-A");
  gitWith(repo, ["commit", "-q", "-m", "first"], { env: ENV });
  first = revParse(repo, "HEAD");
  xBlob = blobAt(repo, first, "knowledge/x.md")!;
  // second commit: edit x, move café note, add y
  writeFileSync(join(repo, "knowledge", "x.md"), "# X\nmore\n");
  git(repo, "mv", "knowledge/sub/Café-Note.md", "knowledge/cafe-note.md");
  writeFileSync(join(repo, "knowledge", "y.md"), "# Y\n");
  git(repo, "add", "-A");
  gitWith(repo, ["commit", "-q", "-m", "second"], { env: ENV });
  second = revParse(repo, "HEAD");
  // dirty the filesystem to prove validation reads trees, not the worktree
  writeFileSync(join(repo, "knowledge", "x.md"), "# X dirty\n");
  writeFileSync(join(repo, "knowledge", "z.md"), "# Z\n");
});

afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("validatePreconditions", () => {
  test("present matches when the blob is unchanged", () => {
    const r = validatePreconditions(repo, first, [{ kind: "present", noteId: "n", path: "knowledge/x.md", blobHash: xBlob }]);
    expect(r).toEqual({ ok: true, failures: [] });
  });

  test("present fails on blob change, on a missing path, and on a moved file", () => {
    const changed = validatePreconditions(repo, second, [{ kind: "present", noteId: "n", path: "knowledge/x.md", blobHash: xBlob }]);
    expect(changed.ok).toBe(false);
    expect(changed.failures[0]!.reason).toContain("knowledge/x.md");

    const missing = validatePreconditions(repo, first, [{ kind: "present", noteId: "n", path: "knowledge/nope.md", blobHash: xBlob }]);
    expect(missing.ok).toBe(false);
    expect(missing.failures[0]!.reason).toContain("missing");

    const cafeBlob = blobAt(repo, first, "knowledge/sub/Café-Note.md")!;
    const moved = validatePreconditions(repo, second, [
      { kind: "present", noteId: "c", path: "knowledge/sub/Café-Note.md", blobHash: cafeBlob },
    ]);
    expect(moved.ok).toBe(false);
  });

  test("absent passes when no such slug exists and fails case/diacritic-insensitively anywhere in the tree", () => {
    expect(validatePreconditions(repo, first, [{ kind: "absent", slug: "y" }]).ok).toBe(true);
    expect(validatePreconditions(repo, second, [{ kind: "absent", slug: "y" }]).ok).toBe(false);
    expect(validatePreconditions(repo, first, [{ kind: "absent", slug: "cafe-note" }]).ok).toBe(false);
    expect(validatePreconditions(repo, first, [{ kind: "absent", slug: "CAFÉ-NOTE" }]).ok).toBe(false);
    expect(validatePreconditions(repo, second, [{ kind: "absent", slug: "Café-Note" }]).ok).toBe(false);
  });

  test("reads trees, never the worktree filesystem", () => {
    // x.md is dirty on disk and z.md is untracked; HEAD's tree is what counts.
    const r = validatePreconditions(repo, "HEAD", [
      { kind: "present", noteId: "n", path: "knowledge/x.md", blobHash: blobAt(repo, second, "knowledge/x.md")! },
      { kind: "absent", slug: "z" },
    ]);
    expect(r.ok).toBe(true);
  });

  test("reports every failure, not just the first", () => {
    const r = validatePreconditions(repo, second, [
      { kind: "present", noteId: "n", path: "knowledge/x.md", blobHash: xBlob },
      { kind: "absent", slug: "Y" },
      { kind: "present", noteId: "m", path: "knowledge/y.md", blobHash: blobAt(repo, second, "knowledge/y.md")! },
    ]);
    expect(r.ok).toBe(false);
    expect(r.failures.length).toBe(2);
  });
});

describe("targetNoteKeys", () => {
  test("note ids for present targets, normalized slug keys for absent targets, deduplicated", () => {
    const targets: TargetPrecondition[] = [
      { kind: "present", noteId: "01A", path: "knowledge/a.md", blobHash: "x" },
      { kind: "absent", slug: "Café Note" },
      { kind: "present", noteId: "01A", path: "knowledge/a.md", blobHash: "x" },
      { kind: "absent", slug: "cafe note" },
    ];
    expect(targetNoteKeys({ targets })).toEqual(["01A", "slug:cafe note"]);
  });
});
