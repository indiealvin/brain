#!/usr/bin/env bun
/**
 * `brain` command-line entry point (Phase 11a).
 *
 * Every command except `init` opens the coordinator for the resolved repo,
 * runs crash recovery (spec §17 steps 1–4 via `recover()`, step 5 via
 * `reconcileIndex()`), then does its work. Repo resolution: `--repo <dir>`,
 * else walk up from cwd until a `brain.toml` is found.
 *
 * `chat` runs the conversation pipeline (src/pipeline): the reply is
 * printed as soon as it exists; knowledge maintenance runs afterwards and
 * its summary is printed when it arrives. The process never exits with a
 * knowledge update in flight.
 */
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { openConversationStore } from "./conversation/store";
import { openCoordinator } from "./core/coordinator";
import type { ExecutionResult, ModelProvider, MutationState, Proposal, ReconcileResult, RepoCoordinator } from "./core/types";
import { rebuildIndex } from "./index/reconcile";
import { noteById } from "./index/queries";
import { indexedCommitOf, openIndex } from "./index/schema";
import { CONFIG_FILE, initKnowledgeRepo } from "./markdown/repo";
import { createEmbeddingProvider, createModelProvider } from "./model";
import { formatKnowledgeSummary, type KnowledgeUpdate } from "./pipeline/knowledge";
import { createMockModelProvider, mockModelRequested } from "./pipeline/mock";
import { runTurn } from "./pipeline/session";
import { ensureEmbeddings } from "./retrieval/embeddings";
import { hybridSearch } from "./retrieval/hybrid";
import { fastForwardAgentToMain } from "./git/worktree";
import { startHumanSyncWatcher } from "./sync/humanSync";
import { withRepoWorktreeLock } from "./sync/lock";

export const USAGE = `usage: brain <command> [options]

commands:
  init [dir]                         create or repair a knowledge repo (default: cwd)
  status                             heads, queue counts, pending proposals, indexed commit
  sync                               run one Human Sync pass (commit quiescent edits on main)
  integrate                          execute queued mutations and fast-forward main
  index [--rebuild]                  reconcile (or fully rebuild) index.sqlite and embeddings
  search <query...> [--limit n]      hybrid search over the index
  proposals list                     list proposals
  proposals show <id>                show one proposal
  proposals accept <id>              accept a proposal (executes it)
  proposals reject <id> [--note t]   reject a proposal
  watch [--interval ms]              daemon: human sync + drain/integrate loop until SIGINT
  chat [--session <id>] [--once "<text>"] [--wait]
                                     talk to your knowledge base; REPL on stdin unless --once
                                     (/quit, /proposals). --wait prints the knowledge summary
                                     before exiting in --once mode (it is always awaited).

options:
  --repo <dir>   knowledge repo (default: walk up from cwd to find ${CONFIG_FILE})
  --json         machine-readable output where sensible
  -h, --help     this text

environment:
  BRAIN_MODEL_MOCK=1   chat without credentials: canned reply, no knowledge extraction
  BRAIN_MODEL, BRAIN_EFFORT, BRAIN_EMBEDDINGS   see src/model/index.ts
`;

// ---------------------------------------------------------------------------
// arg parsing
// ---------------------------------------------------------------------------

export interface ParsedArgs {
  positional: string[];
  flags: Record<string, string | boolean>;
}

/** `--k v`, `--k=v`, `--flag` (boolean when followed by another flag or nothing), `-h`. */
export function parseArgs(argv: string[], valueFlags: readonly string[] = ["repo", "limit", "note", "interval", "session", "once"]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (a === "-h" || a === "--help") {
      flags["help"] = true;
      continue;
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq !== -1) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
        continue;
      }
      const name = a.slice(2);
      const next = argv[i + 1];
      if (valueFlags.includes(name) && next !== undefined && !next.startsWith("--")) {
        flags[name] = next;
        i++;
      } else {
        flags[name] = true;
      }
      continue;
    }
    positional.push(a);
  }
  return { positional, flags };
}

function flagString(flags: ParsedArgs["flags"], name: string): string | undefined {
  const v = flags[name];
  return typeof v === "string" ? v : undefined;
}

function flagInt(flags: ParsedArgs["flags"], name: string, dflt: number): number {
  const v = flagString(flags, name);
  if (v === undefined) return dflt;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) throw new CliError(`--${name} must be an integer, got ${JSON.stringify(v)}`);
  return n;
}

export class CliError extends Error {
  readonly exitCode: number;
  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
  }
}

// ---------------------------------------------------------------------------
// repo resolution
// ---------------------------------------------------------------------------

/** Walk up from `start` to the first directory containing brain.toml. */
export function findRepoRoot(start: string): string | null {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, CONFIG_FILE))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function resolveRepo(flags: ParsedArgs["flags"]): string {
  const explicit = flagString(flags, "repo");
  if (explicit !== undefined) {
    const dir = resolve(explicit);
    if (!existsSync(join(dir, CONFIG_FILE))) throw new CliError(`${join(dir, CONFIG_FILE)} not found; run \`brain init ${explicit}\``);
    return dir;
  }
  const found = findRepoRoot(process.cwd());
  if (!found) throw new CliError(`no ${CONFIG_FILE} found in ${process.cwd()} or any parent; run \`brain init\` or pass --repo <dir>`);
  return found;
}

/**
 * `drainQueued` is implemented by the concrete coordinator (execute every
 * QUEUED mutation, then integrate) but is not part of the read-only
 * `RepoCoordinator` seam, so the CLI checks for it at runtime.
 */
type Coord = RepoCoordinator & { drainQueued(): Promise<ExecutionResult[]> };

/**
 * Open + recover (§17). Callers must `close()` in a finally.
 *
 * After recovery, when `main` moved ahead of `agent/repo` and the agent branch
 * has nothing un-integrated (zero-pending rebuild, §13), the agent branch is
 * fast-forwarded so the index (step 5) reflects the human's latest commits.
 * `fastForwardAgentToMain` is a no-op otherwise; a real rebuild happens in
 * `integrate`.
 */
async function openRepo(flags: ParsedArgs["flags"]): Promise<{ coord: Coord; reconciled: ReconcileResult }> {
  const opened = await openCoordinator(resolveRepo(flags));
  if (typeof (opened as Partial<Coord>).drainQueued !== "function") {
    await opened.close();
    throw new CliError("coordinator does not implement drainQueued()");
  }
  const coord = opened as Coord;
  try {
    await coord.recover();
    await withRepoWorktreeLock(coord.paths.runtimeDir, async () => void fastForwardAgentToMain(coord.paths));
    const reconciled = await coord.reconcileIndex();
    return { coord, reconciled };
  } catch (e) {
    await coord.close();
    throw e;
  }
}

// ---------------------------------------------------------------------------
// output helpers
// ---------------------------------------------------------------------------

interface Io {
  out: (line: string) => void;
  err: (line: string) => void;
  json: boolean;
}

function emit(io: Io, data: unknown, text: () => string): void {
  io.out(io.json ? JSON.stringify(data, null, 2) : text());
}

function short(sha: string): string {
  return sha.slice(0, 12);
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

async function cmdInit(args: ParsedArgs, io: Io): Promise<void> {
  const dir = args.positional[0] ?? process.cwd();
  const r = initKnowledgeRepo(dir);
  emit(io, { path: r.path, repoId: r.config.repoId, createdConfig: r.createdConfig, createdRepo: r.createdRepo, written: r.written, commitSha: r.commitSha }, () =>
    [
      `${r.createdConfig ? "initialized" : "repaired"} knowledge repo at ${r.path}`,
      `repo_id: ${r.config.repoId}`,
      ...(r.written.length ? [`written: ${r.written.join(", ")}`] : []),
      ...(r.commitSha ? [`initial commit: ${short(r.commitSha)}`] : []),
    ].join("\n"),
  );
}

const QUEUE_STATES: readonly MutationState[] = [
  "QUEUED",
  "RUNNING",
  "COMMITTED",
  "INTEGRATED",
  "NOOP",
  "REPLAN",
  "BLOCKED",
  "FAILED_INVALID_EXECUTION",
  "FAILED",
];

async function cmdStatus(args: ParsedArgs, io: Io): Promise<void> {
  const { coord } = await openRepo(args.flags);
  try {
    const [main, agent, rows, proposals] = await Promise.all([coord.mainHead(), coord.agentHead(), coord.listMutations(), coord.listProposals()]);
    const queue: Record<string, number> = {};
    for (const s of QUEUE_STATES) queue[s] = 0;
    for (const r of rows) queue[r.state] = (queue[r.state] ?? 0) + 1;
    const pending = proposals.filter((p) => p.status === "PENDING").length;
    const db = openIndex(coord.paths.indexDb);
    let indexed: string | null;
    try {
      indexed = indexedCommitOf(db);
    } finally {
      db.close();
    }
    const data = { repo: coord.paths.userWorktree, repoId: coord.config.repoId, stateDir: coord.paths.stateDir, mainHead: main, agentHead: agent, queue, pendingProposals: pending, indexedCommit: indexed };
    emit(io, data, () =>
      [
        `repo:      ${coord.paths.userWorktree}`,
        `repo_id:   ${coord.config.repoId}`,
        `state:     ${coord.paths.stateDir}`,
        `main:      ${short(main)}`,
        `agent:     ${short(agent)}${agent === main ? " (integrated)" : ""}`,
        `indexed:   ${indexed ? short(indexed) : "(none)"}${indexed === agent ? " (current)" : ""}`,
        `queue:     ${QUEUE_STATES.filter((s) => queue[s]! > 0).map((s) => `${s}=${queue[s]}`).join(" ") || "empty"}`,
        `proposals: ${pending} pending`,
      ].join("\n"),
    );
  } finally {
    await coord.close();
  }
}

async function cmdSync(args: ParsedArgs, io: Io): Promise<void> {
  const { coord } = await openRepo(args.flags);
  try {
    const r = await coord.syncOnce(Date.now());
    emit(io, r, () => (r.committed ? `committed ${short(r.sha ?? "")} (${r.reason})` : `nothing committed (${r.reason})`));
  } finally {
    await coord.close();
  }
}

async function cmdIntegrate(args: ParsedArgs, io: Io): Promise<void> {
  const { coord } = await openRepo(args.flags);
  try {
    const drained = await coord.drainQueued();
    const r = await coord.integrate();
    emit(io, { drained, integration: r }, () =>
      [
        ...(drained.length ? [`executed: ${drained.map((d) => `${d.mutationId}=${d.state}`).join(" ")}`] : []),
        `status: ${r.status}`,
        `main: ${short(r.mainSha)}`,
        `integrated: ${r.integratedMutationIds.length ? r.integratedMutationIds.join(" ") : "(none)"}`,
      ].join("\n"),
    );
  } finally {
    await coord.close();
  }
}

async function cmdIndex(args: ParsedArgs, io: Io): Promise<void> {
  const { coord, reconciled } = await openRepo(args.flags);
  try {
    const rebuild = args.flags["rebuild"] === true;
    // openRepo already reconciled to agent HEAD (§17 step 5); report that result rather than reconciling twice.
    const r = rebuild ? await rebuildIndex(coord.paths, await coord.agentHead(), { repoId: coord.config.repoId }) : reconciled;
    const db = openIndex(coord.paths.indexDb);
    let embedded: number;
    let notes: number;
    try {
      embedded = await ensureEmbeddings(db, createEmbeddingProvider());
      notes = (db.query("SELECT COUNT(*) AS n FROM notes").get() as { n: number }).n;
    } finally {
      db.close();
    }
    emit(io, { ...r, notes, embedded, rebuild }, () =>
      [
        `indexed: ${short(r.indexedCommit)}${r.fullRebuild ? " (full rebuild)" : ""}`,
        `notes: ${notes}`,
        `changed: ${r.changedPaths.length}`,
        `renames: ${r.renames.length}`,
        `embedded: ${embedded}`,
      ].join("\n"),
    );
  } finally {
    await coord.close();
  }
}

async function cmdSearch(args: ParsedArgs, io: Io): Promise<void> {
  const query = args.positional.slice(1).join(" ").trim();
  if (query === "") throw new CliError("search: query required", 2);
  const limit = flagInt(args.flags, "limit", 10);
  const { coord } = await openRepo(args.flags);
  try {
    const provider = createEmbeddingProvider();
    const db = openIndex(coord.paths.indexDb);
    try {
      await ensureEmbeddings(db, provider);
      const hits = await hybridSearch(db, provider, query, { limit });
      const rows = hits.map((h) => {
        const note = noteById(db, h.noteId);
        return { noteId: h.noteId, score: h.score, title: note?.title ?? "(unknown)", path: note?.path ?? "", signals: h.signals };
      });
      emit(io, { query, hits: rows }, () =>
        rows.length === 0
          ? "no results"
          : rows
              .map((r) => {
                const sig = (["lexical", "semantic", "graph"] as const)
                  .filter((k) => r.signals[k] !== undefined)
                  .map((k) => `${k}=${r.signals[k]!.toFixed(2)}`)
                  .join(" ");
                return `${r.score.toFixed(3)}  ${r.title}  (${r.path})  [${sig}]`;
              })
              .join("\n"),
      );
    } finally {
      db.close();
    }
  } finally {
    await coord.close();
  }
}

function proposalLine(p: Proposal): string {
  return `${p.proposalId}  ${p.status.padEnd(8)}  ${p.operation.padEnd(20)}  ${p.targets.map((t) => t.path).join(", ")}`;
}

async function cmdProposals(args: ParsedArgs, io: Io): Promise<void> {
  const sub = args.positional[1] ?? "list";
  const id = args.positional[2];
  const { coord } = await openRepo(args.flags);
  try {
    switch (sub) {
      case "list": {
        const all = await coord.listProposals();
        emit(io, all, () => (all.length === 0 ? "no proposals" : all.map(proposalLine).join("\n")));
        return;
      }
      case "show": {
        if (!id) throw new CliError("proposals show: <id> required", 2);
        const p = (await coord.listProposals()).find((x) => x.proposalId === id);
        if (!p) throw new CliError(`unknown proposal ${id}`);
        emit(io, p, () =>
          [
            proposalLine(p),
            `mutation:  ${p.mutationId}`,
            `created:   ${p.createdAt}${p.resolvedAt ? `  resolved: ${p.resolvedAt}` : ""}`,
            `evidence:  ${p.evidence.join(", ") || "(none)"}`,
            `reasoning: ${p.reasoning}`,
            ...(p.decisionNote ? [`note:      ${p.decisionNote}`] : []),
            "writes:",
            ...p.writes.map((w) => `  ${w.content === null ? "delete" : "write "} ${w.path}`),
          ].join("\n"),
        );
        return;
      }
      case "accept": {
        if (!id) throw new CliError("proposals accept: <id> required", 2);
        const r = await coord.acceptProposal(id);
        emit(io, r, () => `${id}: ${r.state}${r.commitSha ? ` ${short(r.commitSha)}` : ""}${r.error ? ` (${r.error})` : ""}`);
        return;
      }
      case "reject": {
        if (!id) throw new CliError("proposals reject: <id> required", 2);
        const p = (await coord.listProposals()).find((x) => x.proposalId === id);
        if (!p) throw new CliError(`unknown proposal ${id}`);
        if (p.status !== "PENDING") throw new CliError(`proposal ${id} is already ${p.status}`);
        await coord.rejectProposal(id, flagString(args.flags, "note"));
        emit(io, { proposalId: id, status: "REJECTED" }, () => `${id}: REJECTED`);
        return;
      }
      default:
        throw new CliError(`proposals: unknown subcommand ${sub}\n\n${USAGE}`, 2);
    }
  } finally {
    await coord.close();
  }
}

async function cmdWatch(args: ParsedArgs, io: Io): Promise<void> {
  const intervalMs = flagInt(args.flags, "interval", 1000);
  const { coord } = await openRepo(args.flags);
  const clock = { now: () => Date.now() };
  io.err(`watching ${coord.paths.userWorktree} (interval ${intervalMs}ms); Ctrl-C to stop`);
  const syncWatcher = startHumanSyncWatcher(coord.paths, coord.config, clock, intervalMs, async (now) => {
    const r = await coord.syncOnce(now);
    if (r.committed) io.err(`human sync: committed ${short(r.sha ?? "")}`);
    return r;
  });
  let running = false;
  const loop = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const drained = await coord.drainQueued();
      for (const d of drained) io.err(`executed ${d.mutationId}: ${d.state}`);
      const r = await coord.integrate();
      if (r.status !== "nothing-to-integrate") io.err(`integrate: ${r.status} main=${short(r.mainSha)}`);
    } catch (e) {
      io.err(`watch loop error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      running = false;
    }
  }, intervalMs);
  await new Promise<void>((done) => {
    const stop = () => {
      clearInterval(loop);
      syncWatcher.stop();
      done();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  await coord.close();
  io.err("stopped");
}

function chatModelProvider(io: Io): ModelProvider {
  if (mockModelRequested()) {
    io.err("BRAIN_MODEL_MOCK is set: using the mock model (canned reply, no knowledge extraction)");
    return createMockModelProvider();
  }
  return createModelProvider();
}

/**
 * `brain chat`: the reply is printed as soon as it exists; the knowledge
 * update is printed when it arrives (in the REPL possibly after the next
 * prompt — that is the intended async UX). Every in-flight update is awaited
 * before the process exits (a CLI must not exit with a mutation in flight).
 */
async function cmdChat(args: ParsedArgs, io: Io): Promise<void> {
  const once = flagString(args.flags, "once");
  if (args.flags["once"] === true || (once !== undefined && once.trim() === "")) throw new CliError("chat --once: text required", 2);
  const wait = args.flags["wait"] === true;
  const model = chatModelProvider(io);
  const embeddings = createEmbeddingProvider();
  const { coord } = await openRepo(args.flags);
  const db = openIndex(coord.paths.indexDb);
  const inFlight = new Set<Promise<KnowledgeUpdate>>();
  try {
    await ensureEmbeddings(db, embeddings);
    const store = openConversationStore(coord.paths.conversationsDir);
    const requested = flagString(args.flags, "session");
    if (requested !== undefined && !store.hasSession(requested)) throw new CliError(`unknown session ${requested} (conversations live in ${store.dir})`);
    const sessionId = requested ?? store.createSession();
    io.err(`session ${sessionId}${requested ? ` (resumed, ${store.getTurns(sessionId).length} turns)` : ""}`);
    const deps = { coord, db, model, embeddings, config: coord.config, store };

    const track = <T extends { knowledge: Promise<KnowledgeUpdate> }>(r: T): T => {
      inFlight.add(r.knowledge);
      void r.knowledge.finally(() => inFlight.delete(r.knowledge));
      return r;
    };

    if (once !== undefined) {
      const r = track(await runTurn(deps, sessionId, once));
      if (io.json) {
        const knowledge = await r.knowledge;
        emit(io, { sessionId, reply: r.reply, contextNotes: r.contextNotes, knowledge, summary: formatKnowledgeSummary(knowledge) }, () => "");
        return;
      }
      io.out(r.reply);
      const knowledge = await r.knowledge; // never rejects; always awaited before exit
      if (wait) io.out(formatKnowledgeSummary(knowledge));
      for (const e of knowledge.errors) io.err(`knowledge: ${e}`);
      return;
    }

    await chatRepl(deps, sessionId, io, track);
  } finally {
    // Drain before closing: `coord.close()` closes the queue under any in-flight submit().
    while (inFlight.size > 0) await Promise.all([...inFlight]);
    db.close();
    await coord.close();
  }
}

async function chatRepl(
  deps: Parameters<typeof runTurn>[0],
  sessionId: string,
  io: Io,
  track: <T extends { knowledge: Promise<KnowledgeUpdate> }>(r: T) => T,
): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "> ", terminal: process.stdin.isTTY === true });
  io.err("type a message; /proposals lists pending proposals; /quit or Ctrl-D exits");
  let busy: Promise<void> = Promise.resolve();
  let closed = false;

  const say = (line: string) => {
    io.out(line);
    if (!closed) rl.prompt(true);
  };

  const handle = async (line: string): Promise<void> => {
    const text = line.trim();
    if (text === "") return;
    if (text === "/quit" || text === "/exit") {
      closed = true;
      rl.close();
      return;
    }
    if (text === "/proposals") {
      const pending = (await deps.coord.listProposals()).filter((p) => p.status === "PENDING");
      io.out(pending.length === 0 ? "no pending proposals" : pending.map(proposalLine).join("\n"));
      return;
    }
    if (text.startsWith("/")) {
      io.out(`unknown command ${text}; commands: /proposals, /quit`);
      return;
    }
    try {
      const r = track(await runTurn(deps, sessionId, text));
      io.out(r.reply);
      void r.knowledge.then((u) => {
        say(formatKnowledgeSummary(u));
        for (const e of u.errors) io.err(`knowledge: ${e}`);
      });
    } catch (e) {
      io.err(`error: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  await new Promise<void>((done) => {
    rl.on("line", (line) => {
      busy = busy.then(() => handle(line)).then(() => {
        if (!closed) rl.prompt();
      });
    });
    // Ctrl-C behaves like /quit: readline only routes it through "close" when a listener exists.
    rl.on("SIGINT", () => {
      closed = true;
      rl.close();
    });
    rl.once("close", () => {
      closed = true;
      void busy.then(done, done);
    });
    rl.prompt();
  });
}

// ---------------------------------------------------------------------------
// dispatch
// ---------------------------------------------------------------------------

export async function main(argv: string[], io: Io = { out: console.log, err: console.error, json: false }): Promise<number> {
  const args = parseArgs(argv);
  io.json = args.flags["json"] === true;
  const cmd = args.positional[0];
  if (args.flags["help"] === true || cmd === "help") {
    io.out(USAGE);
    return 0;
  }
  if (!cmd) {
    io.err(USAGE);
    return 2;
  }
  try {
    switch (cmd) {
      case "init":
        await cmdInit({ ...args, positional: args.positional.slice(1) }, io);
        return 0;
      case "status":
        await cmdStatus(args, io);
        return 0;
      case "sync":
        await cmdSync(args, io);
        return 0;
      case "integrate":
        await cmdIntegrate(args, io);
        return 0;
      case "index":
        await cmdIndex(args, io);
        return 0;
      case "search":
        await cmdSearch(args, io);
        return 0;
      case "proposals":
        await cmdProposals(args, io);
        return 0;
      case "watch":
        await cmdWatch(args, io);
        return 0;
      case "chat":
        await cmdChat(args, io);
        return 0;
      default:
        io.err(`unknown command: ${cmd}\n\n${USAGE}`);
        return 2;
    }
  } catch (e) {
    if (e instanceof CliError) {
      io.err(e.message);
      return e.exitCode;
    }
    io.err(`error: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
