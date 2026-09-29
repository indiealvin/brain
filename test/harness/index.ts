/**
 * Test harness. Independent of the implementation: uses its own git runner so
 * validation does not depend on the code under test.
 *
 * READ-ONLY for implementers.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import type {
  Clock,
  Mutation,
  MutationType,
  NoteStatus,
  NoteType,
  RepoCoordinator,
  TargetPrecondition,
  FileWrite,
} from "../../src/core/types";

// ---------------------------------------------------------------------------
// git
// ---------------------------------------------------------------------------

export function git(repo: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", "-C", repo, ...args], {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.com",
      GIT_COMMITTER_NAME: "fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.com",
    },
  });
  if (r.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed (${r.exitCode}): ${r.stderr.toString()}`);
  }
  return r.stdout.toString().trim();
}

export function gitOk(repo: string, ...args: string[]): boolean {
  const r = Bun.spawnSync(["git", "-C", repo, ...args]);
  return r.exitCode === 0;
}

export function revParse(repo: string, ref: string): string {
  return git(repo, "rev-parse", ref);
}

/** Blob hash of `path` at `rev`, or null when absent. */
export function blobAt(repo: string, rev: string, path: string): string | null {
  const r = Bun.spawnSync(["git", "-C", repo, "rev-parse", `${rev}:${path}`]);
  if (r.exitCode !== 0) return null;
  return r.stdout.toString().trim();
}

export function fileAt(repo: string, rev: string, path: string): string | null {
  const r = Bun.spawnSync(["git", "-C", repo, "show", `${rev}:${path}`]);
  if (r.exitCode !== 0) return null;
  return r.stdout.toString();
}

export function hashObject(content: string): string {
  const r = Bun.spawnSync(["git", "hash-object", "--stdin"], { stdin: Buffer.from(content) });
  return r.stdout.toString().trim();
}

export function revList(repo: string, ref: string): string[] {
  const out = git(repo, "rev-list", ref);
  return out ? out.split("\n") : [];
}

/** Mutation-IDs found in commit trailers on `ref`, oldest first. */
export function mutationIdsOn(repo: string, ref: string): string[] {
  const out = git(repo, "log", "--reverse", "--format=%(trailers:key=Mutation-ID,valueonly)", ref);
  return out
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function commitsWithMutationId(repo: string, ref: string, id: string): string[] {
  const out = git(repo, "log", "--format=%H", `--grep=Mutation-ID: ${id}`, "--fixed-strings", ref);
  return out ? out.split("\n") : [];
}

export function filesInCommit(repo: string, sha: string): string[] {
  const out = git(repo, "show", "--name-only", "--format=", sha);
  return out ? out.split("\n").filter(Boolean) : [];
}

export function trailer(repo: string, sha: string, key: string): string {
  return git(repo, "log", "-1", `--format=%(trailers:key=${key},valueonly)`, sha).trim();
}

export function isClean(repo: string): boolean {
  return git(repo, "status", "--porcelain") === "";
}

export function dirtyPaths(repo: string): string[] {
  // Do not trim: an unstaged-only entry starts with a space (" M path").
  const r = Bun.spawnSync(["git", "-C", repo, "status", "--porcelain", "-z"]);
  const out = r.stdout.toString();
  return out
    .split("\0")
    .filter(Boolean)
    .map((l) => l.slice(3));
}

/** Commit everything as a human (simulates a manual `git commit`). */
export function commitAsHuman(repo: string, message = "user: manual edit"): string {
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", `${message}\n\nActor: human`);
  return revParse(repo, "HEAD");
}

// ---------------------------------------------------------------------------
// brain home + knowledge repo
// ---------------------------------------------------------------------------

export function withBrainHome(): { home: string; cleanup: () => void } {
  const home = mkdtempSync(join(tmpdir(), "brain-home-"));
  process.env.BRAIN_HOME = home;
  return {
    home,
    cleanup: () => {
      try {
        rmSync(home, { recursive: true, force: true });
      } catch {}
    },
  };
}

let repoCounter = 0;
export function newRepoId(): string {
  repoCounter += 1;
  return `01FIXTURE${String(repoCounter).padStart(17, "0")}`.slice(0, 26);
}

export interface TempRepo {
  path: string;
  repoId: string;
  cleanup: () => void;
}

/** A knowledge repo with brain.toml, initial commit on main. */
export function makeTempKnowledgeRepo(opts: { quiescenceMs?: number } = {}): TempRepo {
  const path = mkdtempSync(join(tmpdir(), "brain-repo-"));
  const repoId = newRepoId();
  git(path, "init", "-q", "-b", "main");
  git(path, "config", "user.name", "fixture");
  git(path, "config", "user.email", "fixture@example.com");
  mkdirSync(join(path, "knowledge"), { recursive: true });
  writeFileSync(
    join(path, "brain.toml"),
    `version = 1
repo_id = "${repoId}"

[links]
relationships = ["related", "supports", "contradicts", "extends", "example-of"]

[sync]
quiescence_ms = ${opts.quiescenceMs ?? 1500}

[grounding]
low_content_max_tokens = 4
confirmation_lexicon = ["yes", "yeah", "yep", "exactly", "right", "correct", "agreed", "i agree", "that's it", "that's what i mean"]
`,
  );
  writeFileSync(join(path, ".gitignore"), ".obsidian/workspace*\n.brain/\n");
  writeFileSync(join(path, "AGENTS.md"), "# Agents\n");
  writeFileSync(join(path, "knowledge", ".keep"), "");
  git(path, "add", "-A");
  git(path, "commit", "-q", "-m", "init");
  return {
    path,
    repoId,
    cleanup: () => {
      try {
        rmSync(path, { recursive: true, force: true });
      } catch {}
    },
  };
}

// ---------------------------------------------------------------------------
// notes
// ---------------------------------------------------------------------------

export interface NoteSpec {
  id?: string;
  created?: string;
  type?: NoteType;
  status?: NoteStatus;
  aliases?: string[];
  title: string;
  /** Section name → body. Rendered as `## Name\nbody`. */
  sections?: Record<string, string>;
}

let noteCounter = 0;
export function newNoteId(): string {
  noteCounter += 1;
  return `01NOTE${String(noteCounter).padStart(20, "0")}`.slice(0, 26);
}

export function noteMd(spec: NoteSpec): string {
  const fm: string[] = [
    "---",
    `id: ${spec.id ?? newNoteId()}`,
    `created: ${spec.created ?? "2026-09-28"}`,
    `type: ${spec.type ?? "idea"}`,
    `status: ${spec.status ?? "active"}`,
  ];
  if (spec.aliases && spec.aliases.length) {
    fm.push("aliases:");
    for (const a of spec.aliases) fm.push(`  - ${a}`);
  }
  fm.push("---");
  const parts = [fm.join("\n"), `# ${spec.title}`, ""];
  for (const [name, body] of Object.entries(spec.sections ?? {})) {
    parts.push(`## ${name}`, body.trim(), "");
  }
  return parts.join("\n");
}

/** Write a note file (does not commit). Returns {path, content, id}. */
export function writeNote(repo: string, relPath: string, spec: NoteSpec): { path: string; content: string; id: string } {
  const id = spec.id ?? newNoteId();
  const content = noteMd({ ...spec, id });
  const abs = join(repo, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  return { path: relPath, content, id };
}

export function readFile(repo: string, relPath: string): string | null {
  const abs = join(repo, relPath);
  return existsSync(abs) ? readFileSync(abs, "utf8") : null;
}

/** Parse the `id:` line from note markdown. */
export function idOf(content: string): string {
  const m = content.match(/^id:\s*(\S+)/m);
  if (!m) throw new Error("no id in note");
  return m[1]!;
}

export function aliasesOf(content: string): string[] {
  const fm = content.split("---")[1] ?? "";
  const out: string[] = [];
  let inAliases = false;
  for (const line of fm.split("\n")) {
    if (/^aliases:/.test(line)) {
      inAliases = true;
      continue;
    }
    if (inAliases) {
      const m = line.match(/^\s+-\s+(.*)$/);
      if (m) out.push(m[1]!.trim());
      else if (line.trim()) inAliases = false;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// mutations
// ---------------------------------------------------------------------------

let mutCounter = 0;
export function newMutationId(): string {
  mutCounter += 1;
  return `mut_01FIX${String(mutCounter).padStart(18, "0")}`.slice(0, 30);
}

export function present(noteId: string, path: string, blobHash: string): TargetPrecondition {
  return { kind: "present", noteId, path, blobHash };
}
export function absent(slug: string): TargetPrecondition {
  return { kind: "absent", slug };
}

export function mkMutation(
  partial: Partial<Mutation> & { type: MutationType; targets: TargetPrecondition[]; writes: FileWrite[] },
): Mutation {
  return {
    mutationId: partial.mutationId ?? newMutationId(),
    type: partial.type,
    summary: partial.summary ?? `${partial.type.toLowerCase()} fixture`,
    targets: partial.targets,
    writes: partial.writes,
    dependsOn: partial.dependsOn ?? [],
    replans: partial.replans,
    evidence: partial.evidence ?? ["conversation://fixture/1"],
    reasoning: partial.reasoning,
  };
}

/** CREATE mutation for a new note. */
export function createMutation(relPath: string, spec: NoteSpec, extra: Partial<Mutation> = {}): Mutation {
  const slug = relPath.replace(/^.*\//, "").replace(/\.md$/, "");
  return mkMutation({ ...extra, type: "CREATE", targets: [absent(slug)], writes: [{ path: relPath, content: noteMd(spec) }] });
}

/** ENRICH-style mutation replacing the note at `relPath` (base blob taken from `rev`). */
export function replaceMutation(
  repo: string,
  rev: string,
  relPath: string,
  newContent: string,
  extra: Partial<Mutation> & { type?: MutationType } = {},
): Mutation {
  const base = fileAt(repo, rev, relPath);
  if (base == null) throw new Error(`no ${relPath} at ${rev}`);
  const blob = blobAt(repo, rev, relPath)!;
  return mkMutation({
    ...extra,
    type: extra.type ?? "ENRICH",
    targets: [present(idOf(base), relPath, blob)],
    writes: [{ path: relPath, content: newContent }],
  });
}

// ---------------------------------------------------------------------------
// clock + coordinator
// ---------------------------------------------------------------------------

export class FakeClock implements Clock {
  constructor(public t: number = Date.now()) {}
  now(): number {
    return this.t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

export interface Env {
  repo: TempRepo;
  home: string;
  clock: FakeClock;
  coord: RepoCoordinator;
  cleanup: () => Promise<void>;
}

export async function setupEnv(opts: { quiescenceMs?: number } = {}): Promise<Env> {
  const { home, cleanup: cleanHome } = withBrainHome();
  const repo = makeTempKnowledgeRepo(opts);
  const clock = new FakeClock();
  const { openCoordinator } = await import("../../src/core/coordinator");
  const coord = await openCoordinator(repo.path, { clock });
  return {
    repo,
    home,
    clock,
    coord,
    cleanup: async () => {
      await coord.close();
      repo.cleanup();
      cleanHome();
    },
  };
}

export async function reopen(env: Env): Promise<RepoCoordinator> {
  await env.coord.close();
  const { openCoordinator } = await import("../../src/core/coordinator");
  env.coord = await openCoordinator(env.repo.path, { clock: env.clock });
  return env.coord;
}

/** Force a queue row state (simulates crash). Depends on spec §11 table shape. */
export function forceQueueState(env: Env, mutationId: string, state: string): void {
  const { Database } = require("bun:sqlite");
  const db = new Database(env.coord.paths.queueDb);
  db.run("UPDATE mutations SET state = ? WHERE mutation_id = ?", [state, mutationId]);
  db.close();
}

/** Seed a note on main via a human commit. Returns path/content/id and the commit sha. */
export function seedNote(env: Env, relPath: string, spec: NoteSpec): { path: string; content: string; id: string; sha: string } {
  const n = writeNote(env.repo.path, relPath, spec);
  const sha = commitAsHuman(env.repo.path, `user: add ${relPath}`);
  return { ...n, sha };
}

/** Quiescent "now" for Human Sync: well past any mtime. */
export function quiescentNow(env: Env): number {
  return Date.now() + 60_000;
}
