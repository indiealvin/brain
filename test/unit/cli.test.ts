import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { commitAsHuman, writeNote } from "../harness";
import { parseArgs, findRepoRoot } from "../../src/cli";

const CLI = resolve(import.meta.dir, "../../src/cli.ts");

let home: string;
let repo: string;

/**
 * Child env with every model/key variable removed: `bun test` auto-loads the
 * developer's `.env`, and these tests must be hermetic (no network, no real
 * key) and observe only what `$BRAIN_HOME/config.toml` or `extra` provide.
 */
const PROVIDER_VARS = [
  "OPENROUTER_API_KEY",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "BRAIN_MODEL_PROVIDER",
  "BRAIN_MODEL",
  "BRAIN_EFFORT",
  "BRAIN_EMBEDDINGS",
  "BRAIN_EMBEDDING_MODEL",
  "BRAIN_EMBEDDING_DIMS",
  "BRAIN_MODEL_MOCK",
];
function cleanEnv(brainHome: string, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = { ...(process.env as Record<string, string>), BRAIN_HOME: brainHome };
  for (const k of PROVIDER_VARS) delete env[k];
  return { ...env, ...extra };
}

function run(args: string[], opts: { cwd?: string; home?: string; env?: Record<string, string> } = {}): { code: number; out: string; err: string } {
  const r = Bun.spawnSync(["bun", CLI, ...args], {
    cwd: opts.cwd ?? repo,
    env: cleanEnv(opts.home ?? home, opts.env),
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "brain-cli-home-"));
  repo = mkdtempSync(join(tmpdir(), "brain-cli-repo-"));
});
afterAll(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

describe("brain CLI (Phase 11a)", () => {
  test("arg parser: positionals, --k v, --k=v, boolean flags, --", () => {
    const p = parseArgs(["search", "agent", "trust", "--limit", "3", "--json", "--note=hi", "--", "--literal"]);
    expect(p.positional).toEqual(["search", "agent", "trust", "--literal"]);
    expect(p.flags).toEqual({ limit: "3", json: true, note: "hi" });
    expect(parseArgs(["-h"]).flags["help"]).toBe(true);
    expect(parseArgs(["index", "--rebuild", "--repo", "x"]).flags).toEqual({ rebuild: true, repo: "x" });
  });

  test(
    "init → status → index → search → proposals list, end to end against a temp repo",
    () => {
      // no repo yet: commands that need one fail cleanly
      const none = run(["status"], { cwd: home });
      expect(none.code).toBe(1);
      expect(none.err).toContain("brain.toml");

      const init = run(["init", repo], { cwd: home });
      expect(init.code).toBe(0);
      expect(init.out).toMatch(/repo_id: [0-7][0-9A-HJKMNP-TV-Z]{25}/);
      expect(init.out).toContain("initialized");
      const repoId = init.out.match(/repo_id: (\S+)/)![1]!;

      // init is idempotent
      const again = run(["init", repo, "--json"], { cwd: home });
      expect(again.code).toBe(0);
      const j = JSON.parse(again.out);
      expect(j.repoId).toBe(repoId);
      expect(j.createdConfig).toBe(false);

      // repo resolution walks up from cwd (knowledge/ is inside the repo)
      const status0 = run(["status"], { cwd: join(repo, "knowledge") });
      expect(status0.code).toBe(0);
      expect(status0.out).toContain(`repo_id:   ${repoId}`);
      expect(status0.out).toContain("queue:     empty");
      expect(status0.out).toContain("proposals: 0 pending");
      expect(status0.out).toContain("(integrated)");

      // seed a note on main as a human would, then index + search
      writeNote(repo, "knowledge/git-agent-trust.md", {
        title: "Git agent trust",
        sections: { Claim: "Agents earn trust by committing to their own branch and integrating with fast-forward only." },
      });
      writeNote(repo, "knowledge/unrelated.md", { title: "Unrelated", sections: { Claim: "Coffee brewing temperature matters." } });
      commitAsHuman(repo);

      const index = run(["index", "--repo", repo, "--json"], { cwd: home });
      expect(index.code).toBe(0);
      const ij = JSON.parse(index.out);
      expect(ij.notes).toBe(2);
      expect(ij.embedded).toBe(2);
      // the reconcile that indexed the human commit is the one reported (not a second, no-op reconcile)
      expect(ij.changedPaths.sort()).toEqual(["knowledge/git-agent-trust.md", "knowledge/unrelated.md"]);
      const indexAgain = run(["index"]);
      expect(indexAgain.code).toBe(0);
      expect(indexAgain.out).toContain("notes: 2");
      expect(indexAgain.out).toContain("changed: 0");
      expect(indexAgain.out).toContain("embedded: 0");

      const rebuild = run(["index", "--rebuild", "--json"]);
      expect(rebuild.code).toBe(0);
      const rj = JSON.parse(rebuild.out);
      expect(rj.fullRebuild).toBe(true);
      expect(rj.notes).toBe(2);
      expect(rj.embedded).toBe(2); // a full rebuild clears the embeddings table too

      const status1 = run(["status", "--json"]);
      expect(status1.code).toBe(0);
      const sj = JSON.parse(status1.out);
      expect(sj.repoId).toBe(repoId);
      expect(sj.indexedCommit).toBe(sj.agentHead);
      expect(sj.mainHead).toBe(sj.agentHead);
      expect(sj.pendingProposals).toBe(0);

      const search = run(["search", "agent", "trust", "--limit", "1"]);
      expect(search.code).toBe(0);
      expect(search.out).toContain("Git agent trust");
      expect(search.out).toContain("knowledge/git-agent-trust.md");
      expect(search.out).toMatch(/lexical=/);
      expect(search.out).not.toContain("Unrelated");

      const searchJson = run(["search", "coffee", "--json"]);
      expect(searchJson.code).toBe(0);
      expect(JSON.parse(searchJson.out).hits[0].path).toBe("knowledge/unrelated.md");

      const noQuery = run(["search"]);
      expect(noQuery.code).toBe(2);

      const proposals = run(["proposals", "list"]);
      expect(proposals.code).toBe(0);
      expect(proposals.out.trim()).toBe("no proposals");
      const showMissing = run(["proposals", "show", "prop_nope"]);
      expect(showMissing.code).toBe(1);
      expect(showMissing.err).toContain("unknown proposal");
      const rejectMissing = run(["proposals", "reject", "prop_nope", "--note", "x"]);
      expect(rejectMissing.code).toBe(1);
      expect(rejectMissing.err).toContain("unknown proposal");

      const sync = run(["sync"]);
      expect(sync.code).toBe(0);
      expect(sync.out).toContain("clean");

      const integrate = run(["integrate"]);
      expect(integrate.code).toBe(0);
      expect(integrate.out).toContain("status: nothing-to-integrate");

      // `chat` is covered in test/unit/pipeline.test.ts (needs a model provider)

      const help = run(["--help"]);
      expect(help.code).toBe(0);
      expect(help.out).toContain("usage: brain <command>");
      const unknown = run(["bogus"]);
      expect(unknown.code).toBe(2);
      expect(run([]).code).toBe(2);
    },
    120_000,
  );

  test("findRepoRoot walks up and returns null outside a repo", () => {
    expect(findRepoRoot(join(repo, "knowledge"))).toBe(repo);
    expect(findRepoRoot(home)).toBeNull();
  });
});

describe("brain setup / doctor (first-run configuration)", () => {
  const KEY = "sk-or-v1-clitestkey00000000abcd";

  test("setup/doctor value flags parse", () => {
    const p = parseArgs(["setup", "--provider", "openrouter", "--key", KEY, "--model", "x/y", "--embeddings", "openrouter", "--embedding-model", "m", "--dims", "8", "--yes"]);
    expect(p.positional).toEqual(["setup"]);
    expect(p.flags).toEqual({ provider: "openrouter", key: KEY, model: "x/y", embeddings: "openrouter", "embedding-model": "m", dims: "8", yes: true });
  });

  test(
    "doctor --offline without config or keys exits 1 and points at brain setup; chat prints a one-line hint",
    () => {
      const fresh = mkdtempSync(join(tmpdir(), "brain-cli-fresh-"));
      try {
        const d = run(["doctor", "--offline"], { cwd: fresh, home: fresh });
        expect(d.code).toBe(1);
        expect(d.out).toContain("run `brain setup`");
        expect(d.out).toContain("some required checks failed");
        expect(d.out).toContain("[skip] live check");
        expect(d.out).toContain("not inside a knowledge repo");

        const chat = run(["chat", "--once", "hi"], { cwd: fresh, home: fresh });
        expect(chat.code).toBe(1);
        expect(chat.err.trim()).toBe("no model configured; run `brain setup`");
        expect(chat.err).not.toContain("    at "); // no stack trace

        const j = run(["doctor", "--offline", "--json"], { cwd: fresh, home: fresh });
        expect(j.code).toBe(1);
        const parsed = JSON.parse(j.out);
        expect(parsed.ok).toBe(false);
        expect(parsed.checks.find((c: { name: string }) => c.name === "git").status).toBe("ok");
      } finally {
        rmSync(fresh, { recursive: true, force: true });
      }
    },
    60_000,
  );

  test(
    "setup --yes writes $BRAIN_HOME/config.toml (0600, key masked in output), then doctor --offline passes",
    () => {
      const setupHome = mkdtempSync(join(tmpdir(), "brain-cli-setup-"));
      try {
        const s = run(["setup", "--yes", "--provider", "openrouter", "--key", KEY, "--offline"], { cwd: setupHome, home: setupHome });
        expect(s.code).toBe(0);
        expect(s.out).toContain(`wrote ${join(setupHome, "config.toml")} (mode 0600)`);
        expect(s.out).toContain("sk-or-…abcd");
        expect(s.out).not.toContain(KEY);
        expect(s.err).not.toContain(KEY);
        expect(s.out).toContain("model:      openrouter / anthropic/claude-sonnet-4.5");
        expect(s.out).toContain("embeddings: openrouter / openai/text-embedding-3-small (1536 dims)");
        expect(s.out).toContain("all required checks passed");

        const cfgPath = join(setupHome, "config.toml");
        expect(statSync(cfgPath).mode & 0o777).toBe(0o600);
        const text = readFileSync(cfgPath, "utf8");
        expect(text).toContain('provider = "openrouter"');
        expect(text).toContain(`openrouter = "${KEY}"`);
        expect(text).toContain("dims = 1536");

        const d = run(["doctor", "--offline"], { cwd: setupHome, home: setupHome });
        expect(d.code).toBe(0);
        expect(d.out).toContain("[ok]   config");
        expect(d.out).toContain("sk-or-…abcd");
        expect(d.out).not.toContain(KEY);
        expect(d.out).toContain("all required checks passed");

        // environment wins over the file
        const e = run(["doctor", "--offline", "--json"], { cwd: setupHome, home: setupHome, env: { BRAIN_MODEL: "env/model" } });
        expect(JSON.parse(e.out).checks.find((c: { name: string }) => c.name === "model provider").detail).toContain("env/model");

        // re-running with a different provider keeps the old key and never overwrites it with an empty answer
        const a = run(["setup", "--yes", "--provider", "anthropic", "--key", "sk-ant-api03-cli0000WXYZ", "--offline"], { cwd: setupHome, home: setupHome });
        expect(a.code).toBe(0);
        expect(a.out).toContain("sk-ant-…WXYZ");
        expect(a.out).toContain("embeddings: hashing (offline)");
        expect(a.out).toContain("Anthropic has no embeddings endpoint");
        expect(a.out).toContain("--embeddings openrouter");
        const text2 = readFileSync(cfgPath, "utf8");
        expect(text2).toContain(`openrouter = "${KEY}"`);
        expect(text2).toContain('anthropic = "sk-ant-api03-cli0000WXYZ"');
        expect(text2).toContain('provider = "anthropic"');
        const again = run(["setup", "--yes", "--provider", "anthropic", "--offline"], { cwd: setupHome, home: setupHome });
        expect(again.code).toBe(0);
        expect(readFileSync(cfgPath, "utf8")).toContain('anthropic = "sk-ant-api03-cli0000WXYZ"');

        // a non-integer --dims is rejected before anything is written; no key at all is a usage error
        const badDims = run(["setup", "--yes", "--provider", "openrouter", "--key", KEY, "--dims", "zero", "--offline"], { cwd: setupHome, home: setupHome });
        expect(badDims.code).toBe(1);
        expect(badDims.err).toContain("--dims");
        expect(readFileSync(cfgPath, "utf8")).toContain('provider = "anthropic"'); // untouched
        const noKey = run(["setup", "--yes", "--provider", "openrouter", "--offline"], { cwd: mkdtempSync(join(tmpdir(), "brain-cli-nokey-")), home: mkdtempSync(join(tmpdir(), "brain-cli-nokey-home-")) });
        expect(noKey.code).toBe(2);
        expect(noKey.err).toContain("--key");

        // a malformed config is a warning, not a crash
        const malformedHome = mkdtempSync(join(tmpdir(), "brain-cli-malformed-"));
        Bun.write(join(malformedHome, "config.toml"), "[model\n");
        const m = run(["doctor", "--offline"], { cwd: malformedHome, home: malformedHome });
        expect(m.err).toContain("malformed");
        expect(m.code).toBe(1);
      } finally {
        rmSync(setupHome, { recursive: true, force: true });
      }
    },
    60_000,
  );

  test(
    "doctor inside a knowledge repo reports repo_id, heads, queue and watch state",
    () => {
      const d = run(["doctor", "--offline"], { cwd: join(repo, "knowledge"), env: { OPENROUTER_API_KEY: KEY } });
      expect(d.code).toBe(0);
      expect(d.out).toMatch(/repo_id [0-7][0-9A-HJKMNP-TV-Z]{25}/);
      expect(d.out).toMatch(/heads\s+main [0-9a-f]{12}\s+agent [0-9a-f]{12}/);
      expect(d.out).toContain("queue");
      expect(d.out).toContain("watch");
      expect(d.out).toContain("unknown (no ");
      expect(d.out).toContain("watch.pid");
      const missing = run(["doctor", "--offline", "--repo", join(repo, "nope")], { env: { OPENROUTER_API_KEY: KEY } });
      expect(missing.code).toBe(1);
      expect(missing.err).toContain("brain.toml");
    },
    60_000,
  );
});
