/**
 * File diffs computed in core (CR-4; src/git/diff.ts, docs/mac-app/protocol.md
 * §7 `FileDiff`):
 *
 * - `unifiedDiff`: one format for proposals and commits (`--- a/<path>` /
 *   `+++ b/<path>`, `/dev/null` for an absent side, Git's hunks with 3 lines
 *   of context, no `diff --git` / `index` lines); counts exclude the header;
 *   identical sides give `""`; binary files give one line; the user's Git
 *   config and diff environment never change the output.
 * - `proposalDiff`: one entry per write; added / modified / deleted; an
 *   unchanged write is listed with an empty diff; a snapshot blob pruned by
 *   `git gc` gives `beforeUnavailable` and `unified: null`; nothing is
 *   written to the object store.
 * - `commitDiff`: against the first parent, the empty tree for a root
 *   commit; limited to a path.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitDiff, proposalDiff, unifiedDiff } from "../../src/git/diff";
import { readBlob } from "../../src/git/git";
import type { Proposal } from "../../src/core/types";
import { blobAt, commitAsHuman, git, gitOk, hashObject, makeTempKnowledgeRepo, noteMd, revParse, writeNote, type TempRepo } from "../harness";

let repos: TempRepo[] = [];
const restoreEnv: (() => void)[] = [];
afterEach(() => {
  for (const r of repos) r.cleanup();
  repos = [];
  for (const f of restoreEnv.splice(0).reverse()) f();
});

function repo(): TempRepo {
  const r = makeTempKnowledgeRepo();
  repos.push(r);
  return r;
}

function setEnv(key: string, value: string): void {
  const prev = process.env[key];
  process.env[key] = value;
  restoreEnv.push(() => {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  });
}

const lines = (n: number, f: (i: number) => string = (i) => `line ${i}`) => Array.from({ length: n }, (_, i) => `${f(i + 1)}\n`).join("");

describe("unifiedDiff", () => {
  test("modified, added and deleted files: header, hunks and counts", () => {
    expect(unifiedDiff("k/a.md", "a\nb\nc\n", "a\nB\nc\n")).toEqual({ unified: "--- a/k/a.md\n+++ b/k/a.md\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n", additions: 1, deletions: 1 });
    expect(unifiedDiff("k/a.md", null, "x\ny\n")).toEqual({ unified: "--- /dev/null\n+++ b/k/a.md\n@@ -0,0 +1,2 @@\n+x\n+y\n", additions: 2, deletions: 0 });
    expect(unifiedDiff("k/a.md", "x\ny\n", null)).toEqual({ unified: "--- a/k/a.md\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-x\n-y\n", additions: 0, deletions: 2 });
  });

  test("identical sides, two absent sides and an empty file added give an empty diff", () => {
    const none = { unified: "", additions: 0, deletions: 0 };
    expect(unifiedDiff("a.md", "same\n", "same\n")).toEqual(none);
    expect(unifiedDiff("a.md", Buffer.from("same\n"), "same\n")).toEqual(none);
    expect(unifiedDiff("a.md", null, null)).toEqual(none);
    expect(unifiedDiff("a.md", null, "")).toEqual(none);
  });

  test("3 lines of context; changes further apart are separate hunks", () => {
    const before = lines(20);
    const after = before.replace("line 2\n", "line two\n").replace("line 18\n", "line eighteen\n");
    const d = unifiedDiff("a.md", before, after);
    expect(d.unified.match(/^@@ .*$/gm)).toEqual(["@@ -1,5 +1,5 @@", "@@ -15,6 +15,6 @@"]);
    expect([d.additions, d.deletions]).toEqual([2, 2]);
  });

  test("counts only hunk lines: a frontmatter fence or a `+++` line in the content is counted once, the header never", () => {
    const d = unifiedDiff("n.md", "---\nid: 1\n---\nbody\n", "----\nid: 1\n---\n+++ body\n");
    expect(d.unified).toBe("--- a/n.md\n+++ b/n.md\n@@ -1,4 +1,4 @@\n----\n+----\n id: 1\n ---\n-body\n++++ body\n");
    expect([d.additions, d.deletions]).toEqual([2, 2]);
  });

  test("a missing newline at end of file is marked and not counted", () => {
    expect(unifiedDiff("a.md", "a", "a\n")).toEqual({ unified: "--- a/a.md\n+++ b/a.md\n@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+a\n", additions: 1, deletions: 1 });
  });

  test("binary content gives one line and zero counts", () => {
    expect(unifiedDiff("img.png", Buffer.from("a\0b"), Buffer.from("a\0c"))).toEqual({ unified: "Binary files a/img.png and b/img.png differ\n", additions: 0, deletions: 0 });
    expect(unifiedDiff("img.png", null, Buffer.from("a\0b")).unified).toBe("Binary files /dev/null and b/img.png differ\n");
  });

  test("the user's Git config and diff environment do not change the output", () => {
    const before = `${lines(12)}\n${lines(3, (i) => `tail ${i}`)}`;
    const after = before.replace("line 2\n", "line two\n").replace("tail 2\n", "tail two\n");
    const plain = unifiedDiff("a.md", before, after);
    const dir = mkdtempSync(join(tmpdir(), "brain-gitconfig-"));
    restoreEnv.push(() => rmSync(dir, { recursive: true, force: true }));
    const config = join(dir, "gitconfig");
    writeFileSync(config, "[diff]\n\tnoprefix = true\n\tsuppressBlankEmpty = true\n\tinterHunkContext = 20\n\talgorithm = patience\n\tcontext = 9\n");
    setEnv("GIT_CONFIG_GLOBAL", config);
    setEnv("GIT_DIFF_OPTS", "--unified=9");
    expect(unifiedDiff("a.md", before, after)).toEqual(plain);
    expect(plain.unified.match(/^@@ /gm)?.length).toBe(2);
  });
});

function proposal(targets: Proposal["targets"], writes: Proposal["writes"]): Pick<Proposal, "targets" | "writes"> {
  return { targets, writes };
}

describe("proposalDiff", () => {
  test("one entry per write, in order: modified, deleted, added and an unchanged write; nothing is written to the object store", () => {
    const r = repo();
    const a = writeNote(r.path, "knowledge/a.md", { title: "A", sections: { Claim: "a" } });
    const b = writeNote(r.path, "knowledge/b.md", { title: "B", sections: { Claim: "b" } });
    const c = writeNote(r.path, "knowledge/c.md", { title: "C", sections: { Claim: "c" } });
    commitAsHuman(r.path, "user: seed");
    const target = (n: { id: string; path: string }) => ({ noteId: n.id, path: n.path, blobHash: blobAt(r.path, "main", n.path)! });
    const archived = a.content.replace("status: active", "status: archived");
    const created = noteMd({ id: "01JA0000000000000000000NEW", title: "New", sections: { Claim: "new" } });
    const diff = proposalDiff(
      r.path,
      proposal([target(a), target(b), target(c)], [
        { path: a.path, content: archived },
        { path: b.path, content: null },
        { path: "knowledge/new.md", content: created },
        { path: c.path, content: c.content },
      ]),
    );
    expect(diff.map((d) => [d.path, d.change, d.additions, d.deletions])).toEqual([
      [a.path, "modified", 1, 1],
      [b.path, "deleted", 0, b.content.split("\n").length - 1],
      ["knowledge/new.md", "added", created.split("\n").length - 1, 0],
      [c.path, "modified", 0, 0],
    ]);
    expect(diff[0]!.unified).toBe(unifiedDiff(a.path, a.content, archived).unified);
    expect(diff[0]!.unified).toContain("\n-status: active\n+status: archived\n");
    expect(diff[1]!.unified!.startsWith(`--- a/${b.path}\n+++ /dev/null\n@@ -1,`)).toBe(true);
    expect(diff[2]!.unified!.startsWith("--- /dev/null\n+++ b/knowledge/new.md\n@@ -0,0 +1,")).toBe(true);
    expect(diff[3]!.unified).toBe("");
    for (const d of diff) expect(d.beforeUnavailable).toBeUndefined();
    // Read only: the after sides were never hashed into the object store.
    expect(gitOk(r.path, "cat-file", "-e", hashObject(archived))).toBe(false);
    expect(gitOk(r.path, "cat-file", "-e", hashObject(created))).toBe(false);
  });

  test("a snapshot blob pruned by git gc: unified null, zero counts, beforeUnavailable", () => {
    const r = repo();
    const n = writeNote(r.path, "knowledge/a.md", { title: "A", sections: { Claim: "first draft" } });
    commitAsHuman(r.path, "user: draft");
    const snapshot = blobAt(r.path, "main", n.path)!;
    expect(readBlob(r.path, snapshot)?.toString()).toBe(n.content);
    // The draft only ever existed in a commit that is rewritten away.
    writeNote(r.path, n.path, { id: n.id, title: "A", sections: { Claim: "final" } });
    git(r.path, "add", "-A");
    git(r.path, "commit", "-q", "--amend", "--no-edit");
    git(r.path, "reflog", "expire", "--expire=now", "--expire-unreachable=now", "--all");
    git(r.path, "gc", "-q", "--prune=now");
    expect(gitOk(r.path, "cat-file", "-e", snapshot)).toBe(false);
    expect(readBlob(r.path, snapshot)).toBeNull();

    const archived = n.content.replace("status: active", "status: archived");
    expect(proposalDiff(r.path, proposal([{ noteId: n.id, path: n.path, blobHash: snapshot }], [{ path: n.path, content: archived }]))).toEqual([
      { path: n.path, change: "modified", unified: null, additions: 0, deletions: 0, beforeUnavailable: true },
    ]);
    expect(proposalDiff(r.path, proposal([{ noteId: n.id, path: n.path, blobHash: snapshot }], [{ path: n.path, content: null }]))[0]).toEqual({
      path: n.path,
      change: "deleted",
      unified: null,
      additions: 0,
      deletions: 0,
      beforeUnavailable: true,
    });
  });

  test("a snapshot hash that is not an object name is unavailable, never passed to git as an option", () => {
    const r = repo();
    const d = proposalDiff(r.path, proposal([{ noteId: "x", path: "knowledge/x.md", blobHash: "--output=/tmp/x" }], [{ path: "knowledge/x.md", content: "x\n" }]));
    expect(d[0]!.beforeUnavailable).toBe(true);
  });
});

describe("commitDiff", () => {
  test("a root commit against the empty tree: every file added, in path order; an empty file has an empty diff", () => {
    const r = repo();
    const root = revParse(r.path, "main");
    const d = commitDiff(r.path, root);
    expect(d.map((x) => [x.path, x.change])).toEqual([
      [".gitignore", "added"],
      ["AGENTS.md", "added"],
      ["brain.toml", "added"],
      ["knowledge/.keep", "added"],
    ]);
    expect(d[1]).toEqual({ path: "AGENTS.md", change: "added", unified: "--- /dev/null\n+++ b/AGENTS.md\n@@ -0,0 +1 @@\n+# Agents\n", additions: 1, deletions: 0 });
    expect(d[3]).toEqual({ path: "knowledge/.keep", change: "added", unified: "", additions: 0, deletions: 0 });
  });

  test("against the first parent: modified, added and deleted files; limited to a path or a directory", () => {
    const r = repo();
    writeNote(r.path, "knowledge/a.md", { id: "01JA0000000000000000000001", title: "A", sections: { Claim: "a" } });
    const b = writeNote(r.path, "knowledge/b.md", { id: "01JA0000000000000000000002", title: "B", sections: { Claim: "b" } });
    commitAsHuman(r.path, "user: seed");
    writeNote(r.path, "knowledge/a.md", { id: "01JA0000000000000000000001", title: "A", sections: { Claim: "a, revised" } });
    unlinkSync(join(r.path, "knowledge/b.md"));
    const c = writeNote(r.path, "knowledge/c.md", { id: "01JA0000000000000000000003", title: "C", sections: { Claim: "c" } });
    const sha = commitAsHuman(r.path, "user: revise");
    const d = commitDiff(r.path, sha);
    const lineCount = (s: string) => s.split("\n").length - 1;
    expect(d.map((x) => [x.path, x.change, x.additions, x.deletions])).toEqual([
      ["knowledge/a.md", "modified", 1, 1],
      ["knowledge/b.md", "deleted", 0, lineCount(b.content)],
      ["knowledge/c.md", "added", lineCount(c.content), 0],
    ]);
    expect(d[0]!.unified).toContain("\n-a\n+a, revised\n");
    expect(commitDiff(r.path, sha, { path: "knowledge/b.md" }).map((x) => x.path)).toEqual(["knowledge/b.md"]);
    expect(commitDiff(r.path, sha, { path: "knowledge" }).length).toBe(3);
    expect(commitDiff(r.path, sha, { path: "AGENTS.md" })).toEqual([]);
    // Literal paths: pathspec magic is not interpreted.
    expect(commitDiff(r.path, sha, { path: ":(glob)**/a.md" })).toEqual([]);
  });

  test("a merge commit is compared with its first parent only", () => {
    const r = repo();
    git(r.path, "checkout", "-q", "-b", "side");
    writeNote(r.path, "knowledge/side.md", { title: "Side" });
    commitAsHuman(r.path, "user: side");
    git(r.path, "checkout", "-q", "main");
    writeNote(r.path, "knowledge/main.md", { title: "Main" });
    commitAsHuman(r.path, "user: main");
    git(r.path, "merge", "-q", "--no-ff", "--no-edit", "side");
    const merge = revParse(r.path, "main");
    expect(commitDiff(r.path, merge).map((x) => [x.path, x.change])).toEqual([["knowledge/side.md", "added"]]);
  });
});
