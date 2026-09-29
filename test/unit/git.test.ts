import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  blobAt,
  formatCommitMessage,
  git,
  gitWith,
  GitError,
  hashObject,
  isClean,
  isRepoRoot,
  logGrepTrailer,
  lsTree,
  parseTrailers,
  refExists,
  revParse,
  runGit,
  showFile,
  statusPorcelain,
  trailersOf,
  treeHasSlug,
} from "../../src/git/git";

const ENV = {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
};

let repo: string;
let first = "";
let second = "";

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "brain-git-unit-"));
  git(repo, "init", "-q", "-b", "main");
  mkdirSync(join(repo, "knowledge", "sub"), { recursive: true });
  writeFileSync(join(repo, "knowledge", "Agent-Autonomy.md"), "# A\n");
  writeFileSync(join(repo, "knowledge", "sub", "café.md"), "# C\n");
  writeFileSync(join(repo, "knowledge", "notes.txt"), "not a note");
  git(repo, "add", "-A");
  gitWith(repo, ["commit", "-q", "-m", formatCommitMessage("knowledge: first", { mutationId: "mut_01", mutationType: "CREATE", actor: "agent" })], { env: ENV });
  first = revParse(repo, "HEAD");
  writeFileSync(join(repo, "knowledge", "Agent-Autonomy.md"), "# A\nmore\n");
  git(repo, "add", "-A");
  gitWith(repo, ["commit", "-q", "-m", formatCommitMessage("knowledge: second", { mutationId: "mut_012", mutationType: "ENRICH", actor: "agent", replans: "mut_00" })], { env: ENV });
  second = revParse(repo, "HEAD");
});

afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("git wrapper", () => {
  test("runGit returns code/stdout/stderr without throwing; git throws GitError", () => {
    const r = runGit(repo, ["rev-parse", "nope"]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("nope");
    expect(() => git(repo, "rev-parse", "--verify", "nope")).toThrow(GitError);
    expect(git(repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
  });

  test("revParse / refExists", () => {
    expect(revParse(repo, "main")).toBe(second);
    expect(revParse(repo, `${first}:knowledge/Agent-Autonomy.md`)).toBe(hashObject("# A\n"));
    expect(revParse(repo, "HEAD^{tree}")).toMatch(/^[0-9a-f]{40}$/);
    expect(refExists(repo, "main")).toBe(true);
    expect(refExists(repo, "agent/repo")).toBe(false);
    expect(() => revParse(repo, "agent/repo")).toThrow(GitError);
  });

  test("blobAt matches harness-style rev-parse and hashObject; null when absent", () => {
    const blob = blobAt(repo, first, "knowledge/Agent-Autonomy.md");
    expect(blob).toBe(hashObject("# A\n"));
    expect(blobAt(repo, second, "knowledge/Agent-Autonomy.md")).toBe(hashObject("# A\nmore\n"));
    expect(blobAt(repo, first, "knowledge/missing.md")).toBeNull();
    expect(blobAt(repo, "nope", "knowledge/Agent-Autonomy.md")).toBeNull();
  });

  test("hashObject agrees with `git hash-object --stdin` (including non-ASCII)", () => {
    for (const content of ["", "hello\n", "# Café ☕\n", "a".repeat(5000)]) {
      const r = Bun.spawnSync(["git", "hash-object", "--stdin"], { stdin: Buffer.from(content, "utf8") });
      expect(hashObject(content)).toBe(r.stdout.toString().trim());
    }
  });

  test("showFile returns exact content or null", () => {
    expect(showFile(repo, first, "knowledge/Agent-Autonomy.md")).toBe("# A\n");
    expect(showFile(repo, first, "knowledge/nope.md")).toBeNull();
  });

  test("lsTree lists files recursively with blob ids", () => {
    const entries = lsTree(repo, first);
    expect(entries.map((e) => e.path).sort()).toEqual(["knowledge/Agent-Autonomy.md", "knowledge/notes.txt", "knowledge/sub/café.md"]);
    expect(entries.find((e) => e.path === "knowledge/Agent-Autonomy.md")?.blob).toBe(hashObject("# A\n"));
  });

  test("treeHasSlug is case-insensitive, normalized, and only considers *.md", () => {
    expect(treeHasSlug(repo, first, "agent-autonomy")).toBe(true);
    expect(treeHasSlug(repo, first, "AGENT-AUTONOMY")).toBe(true);
    expect(treeHasSlug(repo, first, "Cafe")).toBe(true);
    expect(treeHasSlug(repo, first, "notes")).toBe(false);
    expect(treeHasSlug(repo, first, "missing")).toBe(false);
  });

  test("logGrepTrailer matches exact trailer values, not prefixes", () => {
    expect(logGrepTrailer(repo, "main", "Mutation-ID", "mut_01")).toEqual([first]);
    expect(logGrepTrailer(repo, "main", "Mutation-ID", "mut_012")).toEqual([second]);
    expect(logGrepTrailer(repo, "main", "Mutation-ID", "mut_0")).toEqual([]);
    expect(logGrepTrailer(repo, "main", "Actor", "agent")).toEqual([second, first]);
    expect(logGrepTrailer(repo, first, "Mutation-ID", "mut_012")).toEqual([]);
    expect(logGrepTrailer(repo, "no-such-ref", "Mutation-ID", "mut_01")).toEqual([]);
  });

  test("statusPorcelain / isClean", () => {
    expect(isClean(repo)).toBe(true);
    writeFileSync(join(repo, "knowledge", "Agent-Autonomy.md"), "changed\n");
    writeFileSync(join(repo, "knowledge", "new file.md"), "new\n");
    const st = statusPorcelain(repo);
    expect(st.map((e) => [e.status, e.path]).sort()).toEqual([
      [" M", "knowledge/Agent-Autonomy.md"],
      ["??", "knowledge/new file.md"],
    ]);
    expect(isClean(repo)).toBe(false);
    git(repo, "mv", "knowledge/notes.txt", "knowledge/renamed.txt");
    const ren = statusPorcelain(repo).find((e) => e.status.startsWith("R"));
    expect(ren).toEqual({ status: "R ", path: "knowledge/renamed.txt", origPath: "knowledge/notes.txt" });
    git(repo, "reset", "-q", "--hard", "HEAD");
    rmSync(join(repo, "knowledge", "new file.md"));
    expect(isClean(repo)).toBe(true);
  });

  test("trailers round-trip through formatCommitMessage / parseTrailers / git", () => {
    const msg = formatCommitMessage("knowledge: enrich x", { mutationId: "mut_A", mutationType: "ENRICH", actor: "agent", replans: "mut_B" });
    expect(msg).toBe("knowledge: enrich x\n\nMutation-ID: mut_A\nMutation-Type: ENRICH\nActor: agent\nReplans: mut_B\n");
    expect(parseTrailers(msg)).toEqual({ mutationId: "mut_A", mutationType: "ENRICH", actor: "agent", replans: "mut_B" });
    expect(parseTrailers("user: edit\n\nActor: human-sync\n")).toEqual({ actor: "human-sync" });
    expect(parseTrailers("plain message")).toEqual({ actor: "human" });
    expect(parseTrailers("subject\n\nbody text\nnot: really trailers\n\nActor: agent")).toEqual({ actor: "agent" });
    expect(parseTrailers("subject\n\nActor: someone-else")).toEqual({ actor: "human" });
    expect(trailersOf(repo, second)).toEqual({ mutationId: "mut_012", mutationType: "ENRICH", actor: "agent", replans: "mut_00" });
  });

  test("isRepoRoot distinguishes the root from subdirectories and non-repos", () => {
    expect(isRepoRoot(repo)).toBe(true);
    expect(isRepoRoot(join(repo, "knowledge"))).toBe(false);
    const plain = mkdtempSync(join(tmpdir(), "brain-plain-"));
    try {
      expect(isRepoRoot(plain)).toBe(false);
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });
});
