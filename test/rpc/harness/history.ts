/**
 * Steps for the history and diff transcripts (T1.8): what a user does with
 * Git directly in the knowledge repo, beside the server under test.
 *
 * - `repo.git {repo, args}`: run `git -C <repo> …args` as the user would
 *   (the repo's identity, or a fallback one; no editor), and fail unless it
 *   exits 0. For commits the other steps cannot make: a `git revert`, which
 *   carries no `Actor` trailer, or a `git rm` and a commit. The server's
 *   loop may hold `index.lock` for a moment (its Human Sync runs
 *   `git status`), so a command refused for a held `*.lock` is retried.
 * - `repo.prune {repo, objects}`: what a later `git gc` does to objects no
 *   ref reaches any more: expire every reflog now (every worktree's,
 *   including the agent worktree's) and `gc --prune=now`. Then each listed
 *   object (a sha, through `ctx.subs`) must be gone from the object store
 *   (`git cat-file -e` fails), or the step fails, so a transcript asserting
 *   `beforeUnavailable` cannot pass with the blob still readable.
 */
import { identityEnv } from "../../../src/git/git";
import { serverEnv } from "./process";
import { registerStep, sleep, stepString, stepStrings, type StepContext } from "./steps";
import type { Step } from "./transcript";

const LOCK_RETRIES = 50;
const LOCK_RETRY_MS = 20;

function repoOf(step: Step, ctx: StepContext): string {
  return ctx.subs.apply(stepString(step, "repo"));
}

interface GitRun {
  code: number;
  stdout: string;
  stderr: string;
}

function runGit(ctx: StepContext, repo: string, args: string[]): GitRun {
  const r = Bun.spawnSync(["git", "-C", repo, ...args], { env: serverEnv(ctx.home, { ...identityEnv(repo), GIT_EDITOR: "true" }), stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
}

/** `git …args`, retried while another process holds one of the repo's lock files; throws unless it exits 0. */
async function gitOrThrow(ctx: StepContext, repo: string, args: string[], op: string): Promise<GitRun> {
  for (let attempt = 0; ; attempt++) {
    const r = runGit(ctx, repo, args);
    if (r.code === 0) return r;
    if (attempt < LOCK_RETRIES && /\.lock'?: File exists|Unable to create '.*\.lock'|cannot lock ref/i.test(r.stderr)) {
      await sleep(LOCK_RETRY_MS);
      continue;
    }
    throw new Error(`step ${op}: git ${args.join(" ")} exited ${r.code}\n${r.stderr}${r.stdout}`);
  }
}

registerStep("repo.git", async (step, ctx) => {
  const repo = repoOf(step, ctx);
  await gitOrThrow(ctx, repo, ctx.subs.applyDeep(stepStrings(step, "args")), "repo.git");
});

registerStep("repo.prune", async (step, ctx) => {
  const repo = repoOf(step, ctx);
  const objects = ctx.subs.applyDeep(stepStrings(step, "objects"));
  await gitOrThrow(ctx, repo, ["reflog", "expire", "--expire=now", "--expire-unreachable=now", "--all"], "repo.prune");
  await gitOrThrow(ctx, repo, ["gc", "-q", "--prune=now"], "repo.prune");
  const kept = objects.filter((o) => runGit(ctx, repo, ["cat-file", "-e", o]).code === 0);
  if (kept.length > 0) throw new Error(`step repo.prune: ${kept.join(", ")} still in the object store after gc --prune=now`);
});
