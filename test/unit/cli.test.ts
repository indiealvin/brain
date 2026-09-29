import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { commitAsHuman, writeNote } from "../harness";
import { parseArgs, findRepoRoot } from "../../src/cli";

const CLI = resolve(import.meta.dir, "../../src/cli.ts");

let home: string;
let repo: string;

function run(args: string[], opts: { cwd?: string } = {}): { code: number; out: string; err: string } {
  const r = Bun.spawnSync(["bun", CLI, ...args], {
    cwd: opts.cwd ?? repo,
    env: { ...process.env, BRAIN_HOME: home },
    stdout: "pipe",
    stderr: "pipe",
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
