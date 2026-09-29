import { describe, test, expect } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { repoPaths, resolveBrainHome } from "../../src/core/brainHome";
import { isMutationId, isUlid, mutationId, noteId, ulid } from "../../src/core/ids";
import { initKnowledgeRepo, loadConfig, ConfigError, parseConfig, configToToml } from "../../src/markdown/repo";
import { git, refExists, trailersOf, isClean } from "../../src/git/git";

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  try {
    return fn();
  } finally {
    for (const k of Object.keys(vars)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

describe("brainHome", () => {
  test("resolveBrainHome honors BRAIN_HOME and falls back to ~/.brain", () => {
    expect(withEnv({ BRAIN_HOME: "/tmp/x/brain" }, resolveBrainHome)).toBe("/tmp/x/brain");
    expect(withEnv({ BRAIN_HOME: undefined }, resolveBrainHome)).toBe(join(homedir(), ".brain"));
    expect(withEnv({ BRAIN_HOME: "   " }, resolveBrainHome)).toBe(join(homedir(), ".brain"));
  });

  test("repoPaths follows the spec §6 layout", () => {
    const p = withEnv({ BRAIN_HOME: "/tmp/bh" }, () => repoPaths("/work/repo", "01REPO"));
    expect(p).toEqual({
      userWorktree: "/work/repo",
      stateDir: "/tmp/bh/repos/01REPO",
      agentWorktree: "/tmp/bh/repos/01REPO/worktrees/agent",
      indexDb: "/tmp/bh/repos/01REPO/index.sqlite",
      usageDb: "/tmp/bh/repos/01REPO/usage.sqlite",
      proposalsDb: "/tmp/bh/repos/01REPO/proposals.sqlite",
      queueDb: "/tmp/bh/repos/01REPO/queue.sqlite",
      conversationsDir: "/tmp/bh/repos/01REPO/conversations",
      runtimeDir: "/tmp/bh/repos/01REPO/runtime",
    });
    expect(() => repoPaths("/work/repo", "../escape")).toThrow();
    expect(() => repoPaths("/work/repo", "..")).toThrow();
    expect(() => repoPaths("/work/repo", ".")).toThrow();
    expect(() => repoPaths("/work/repo", "")).toThrow();
  });
});

describe("ids", () => {
  test("ulid shape, monotonicity, prefixes", () => {
    const a = ulid(1_700_000_000_000);
    const b = ulid(1_700_000_000_000);
    const c = ulid(1_700_000_000_001);
    expect(isUlid(a)).toBe(true);
    expect(a.length).toBe(26);
    expect(a.slice(0, 10)).toBe(b.slice(0, 10));
    expect(b > a).toBe(true);
    expect(c > b).toBe(true);
    expect(isMutationId(mutationId())).toBe(true);
    expect(isUlid(noteId())).toBe(true);
    expect(isMutationId("mut_x")).toBe(false);
    expect(new Set(Array.from({ length: 200 }, () => ulid())).size).toBe(200);
  });
});

describe("config + init", () => {
  test("parseConfig maps snake_case to camelCase and applies defaults", () => {
    const c = parseConfig('version = 1\nrepo_id = "01K"\n[sync]\nquiescence_ms = 10\n');
    expect(c).toEqual({
      version: 1,
      repoId: "01K",
      links: { relationships: ["related", "supports", "contradicts", "extends", "example-of"] },
      sync: { quiescenceMs: 10 },
      grounding: {
        lowContentMaxTokens: 4,
        confirmationLexicon: ["yes", "yeah", "yep", "exactly", "right", "correct", "agreed", "i agree", "that's it", "that's what i mean"],
      },
    });
    expect(parseConfig(configToToml(c))).toEqual(c);
    expect(() => parseConfig('repo_id = "x"')).toThrow(ConfigError);
    expect(() => parseConfig("version = 1")).toThrow(ConfigError);
    expect(() => parseConfig('version = 2\nrepo_id = "x"')).toThrow(ConfigError);
    expect(() => parseConfig('version = 1\nrepo_id = "x"\n[sync]\nquiescence_ms = "slow"')).toThrow(ConfigError);
    expect(() => parseConfig("version = 1\nrepo_id = [")).toThrow(ConfigError);
  });

  test("initKnowledgeRepo creates a repo with the standard files and is idempotent", () => {
    const dir = mkdtempSync(join(tmpdir(), "brain-init-"));
    try {
      const r = withEnv({ GIT_AUTHOR_NAME: undefined, GIT_COMMITTER_NAME: undefined, GIT_AUTHOR_EMAIL: undefined, GIT_COMMITTER_EMAIL: undefined }, () =>
        initKnowledgeRepo(dir, { quiescenceMs: 42 }),
      );
      expect(r.createdRepo).toBe(true);
      expect(r.createdConfig).toBe(true);
      expect(r.commitSha).toBeDefined();
      expect(r.written.sort()).toEqual([".gitignore", "AGENTS.md", "brain.toml", "knowledge/.keep"]);
      expect(isUlid(r.config.repoId)).toBe(true);
      expect(readFileSync(join(dir, ".gitignore"), "utf8")).toBe(".obsidian/workspace*\n.brain/\n");
      expect(existsSync(join(dir, "AGENTS.md"))).toBe(true);
      expect(git(dir, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
      expect(isClean(dir)).toBe(true);
      expect(trailersOf(dir, r.commitSha!)).toEqual({ actor: "human" });
      expect(git(dir, "ls-files").split("\n").sort()).toEqual([".gitignore", "AGENTS.md", "brain.toml", "knowledge/.keep"]);

      const cfg = loadConfig(dir);
      expect(cfg.sync.quiescenceMs).toBe(42);
      expect(cfg.repoId).toBe(r.config.repoId);

      // Second run: nothing changes, repo_id preserved, no new commit.
      const r2 = initKnowledgeRepo(dir, { repoId: "SHOULD_BE_IGNORED" });
      expect(r2.createdRepo).toBe(false);
      expect(r2.createdConfig).toBe(false);
      expect(r2.commitSha).toBeUndefined();
      expect(r2.written).toEqual([]);
      expect(r2.config.repoId).toBe(r.config.repoId);
      expect(git(dir, "rev-list", "--count", "HEAD")).toBe("1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("initKnowledgeRepo on an existing repo with a partial .gitignore merges lines and keeps history", () => {
    const dir = mkdtempSync(join(tmpdir(), "brain-init2-"));
    try {
      git(dir, "init", "-q", "-b", "main");
      writeFileSync(join(dir, ".gitignore"), ".brain/\nnode_modules/");
      writeFileSync(join(dir, "README.md"), "hi\n");
      git(dir, "add", "-A");
      git(dir, "-c", "user.name=x", "-c", "user.email=x@example.com", "commit", "-q", "-m", "existing");
      const r = initKnowledgeRepo(dir);
      expect(r.createdRepo).toBe(false);
      expect(r.commitSha).toBeUndefined();
      expect(refExists(dir, "HEAD")).toBe(true);
      expect(git(dir, "rev-list", "--count", "HEAD")).toBe("1");
      expect(readFileSync(join(dir, ".gitignore"), "utf8")).toBe(".brain/\nnode_modules/\n.obsidian/workspace*\n");
      expect(r.written.sort()).toEqual([".gitignore", "AGENTS.md", "brain.toml", "knowledge/.keep"]);
      expect(loadConfig(dir).repoId).toBe(r.config.repoId);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("loadConfig fails clearly when brain.toml is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "brain-nocfg-"));
    try {
      expect(() => loadConfig(dir)).toThrow(ConfigError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
