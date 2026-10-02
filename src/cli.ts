#!/usr/bin/env bun
/**
 * `brain` command-line entry point (Phase 11a): the CLI adapter over the
 * service layer in src/commands (CR-2; docs/mac-app/design.md §3). This file
 * keeps what is terminal-specific: argument parsing, repo resolution from
 * `--repo` / cwd, text rendering, spinners, streaming to stdout, signal
 * handling, the REPL, interactive `setup`, exit codes and the mapping of
 * typed errors to `CliError`.
 *
 * Every command except `init` opens the coordinator for the resolved repo,
 * runs crash recovery (spec §17 steps 1–6, including accept reconciliation,
 * via `recover()`; step 5 again via `reconcileIndex()` after the agent branch
 * catches up), then does its work. Repo resolution: `--repo <dir>`,
 * else walk up from cwd until a `brain.toml` is found.
 *
 * `chat` runs the conversation pipeline (src/pipeline): the reply is
 * printed as soon as it exists; knowledge maintenance runs afterwards and
 * its summary is printed when it arrives. The process never exits with a
 * knowledge update in flight.
 */
import pkg from "../package.json" with { type: "json" };
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { CliError } from "./cli/errors";
import { installWatchService, uninstallWatchService, watchServiceStatus } from "./cli/service";
import { createWatchEmbedder, resolveWatchProvider, waitForLoopOwner, watchTick, type WatchEmbedder } from "./cli/watch";
import { createKnowledgeTracker, openSession, openSessionDeps, type KnowledgeTracker, type OpenedSessionDeps } from "./commands/conversation";
import { ServiceError } from "./commands/errors";
import { refreshIndex, search } from "./commands/notes";
import { proposalsAccept, proposalsGet, proposalsList, proposalsReject } from "./commands/proposals";
import { chatEmbeddingProvider, chatModelProvider } from "./commands/providers";
import { findRepoRoot, initRepo, integrate, openRepo, QUEUE_STATES, repoStatus, syncOnce } from "./commands/repo";
import { formatDoctorReport, runDoctor, WATCH_PID_FILE } from "./config/doctor";
import {
  applyUserConfigToEnv,
  loadUserConfig,
  maskKey,
  saveUserConfig,
  type EmbeddingsProviderName,
  type ModelProviderName,
  type UserConfig,
} from "./config/userConfig";
import { SessionBusyError } from "./conversation/turnLock";
import { repoPaths } from "./core/brainHome";
import type { EmbeddingProvider, Proposal } from "./core/types";
import { openIndex, type IndexDb } from "./index/schema";
import { CONFIG_FILE, loadConfig } from "./markdown/repo";
import { createEmbeddingProvider, DEFAULT_MODEL } from "./model";
import { DEFAULT_OPENROUTER_EMBEDDING_DIMS, DEFAULT_OPENROUTER_EMBEDDING_MODEL, DEFAULT_OPENROUTER_MODEL } from "./model/openrouter";
import { formatKnowledgeSummary } from "./pipeline/knowledge";
import { ProposalNotPendingError, UnknownProposalError } from "./proposal/store";
import { runTurn, type SessionDeps } from "./pipeline/session";
import { runStdioServer } from "./rpc/stdio";
import { startHumanSyncWatcher } from "./sync/humanSync";
import { setLockHolderKind } from "./sync/lock";

const USER_CONFIG_FILE_HINT = "$BRAIN_HOME/config.toml";

export const USAGE = `usage: brain <command> [options]

commands:
  setup [--provider anthropic|openrouter] [--key <key>] [--model <id>]
        [--embeddings hashing|openrouter] [--embedding-model <id>] [--dims <n>]
        [--yes] [--offline]            write ${USER_CONFIG_FILE_HINT}; prompts on a TTY,
                                     flags override prompts, --yes accepts defaults;
                                     then runs the doctor checks
  doctor [--offline]                 check git, BRAIN_HOME, config, keys, live model access
                                     and (inside a repo) heads/queue/watch; exit 1 on failure
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
  watch [--interval ms] [--no-embeddings]
                                     daemon: human sync + drain/integrate loop until SIGINT;
                                     keeps embeddings fresh after every change (needs the
                                     OpenRouter key when embeddings=openrouter; hashing is offline);
                                     one loop per repo: waits while another process owns it
  watch --install [--interval ms]    run the daemon as a user service for this repo
                                     (systemd --user on Linux, launchd on macOS); one unit per repo
  watch --uninstall | --status       stop + remove the service / report whether it is running
  chat [--session <id>] [--once "<text>"] [--wait]
                                     talk to your knowledge base; REPL on stdin unless --once
                                     (/quit, /proposals). --wait prints the knowledge summary
                                     before exiting in --once mode (it is always awaited).
  rpc --stdio                        JSONL protocol server for the Mac app (docs/mac-app/protocol.md);
                                     stdout carries protocol lines only, logs go to stderr

options:
  --repo <dir>   knowledge repo (default: walk up from cwd to find ${CONFIG_FILE})
  --json         machine-readable output where sensible
  -h, --help     this text
  --version      print version

environment:
  BRAIN_HOME           app state and ${USER_CONFIG_FILE_HINT} (default ~/.brain)
  BRAIN_MODEL_MOCK=1   chat without credentials: canned reply, no knowledge extraction
  BRAIN_MODEL_SCRIPT=<file>
                       tests: answer chat, extractor and planner calls from a JSON script
                       (src/pipeline/scripted.ts); wins over BRAIN_MODEL_MOCK
  OPENROUTER_API_KEY, ANTHROPIC_API_KEY, BRAIN_MODEL_PROVIDER, BRAIN_MODEL, BRAIN_EFFORT,
  BRAIN_EMBEDDINGS, BRAIN_EMBEDDING_MODEL, BRAIN_EMBEDDING_DIMS
                       override the config file (environment always wins)
`;

// ---------------------------------------------------------------------------
// arg parsing
// ---------------------------------------------------------------------------

export interface ParsedArgs {
  positional: string[];
  flags: Record<string, string | boolean>;
}

/** `--k v`, `--k=v`, `--flag` (boolean when followed by another flag or nothing), `-h`. */
export const VALUE_FLAGS: readonly string[] = ["repo", "limit", "note", "interval", "session", "once", "provider", "key", "model", "embeddings", "embedding-model", "dims"];

export function parseArgs(argv: string[], valueFlags: readonly string[] = VALUE_FLAGS): ParsedArgs {
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

export { CliError, findRepoRoot };

// ---------------------------------------------------------------------------
// repo resolution
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// output helpers
// ---------------------------------------------------------------------------

interface Io {
  out: (line: string) => void;
  err: (line: string) => void;
  /** Raw stdout write (no newline) for streamed reply text. */
  write: (chunk: string) => void;
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
  const r = initRepo(dir);
  emit(io, r, () =>
    [
      `${r.createdConfig ? "initialized" : "repaired"} knowledge repo at ${r.path}`,
      `repo_id: ${r.repoId}`,
      ...(r.written.length ? [`written: ${r.written.join(", ")}`] : []),
      ...(r.commitSha ? [`initial commit: ${short(r.commitSha)}`] : []),
    ].join("\n"),
  );
}

async function cmdStatus(args: ParsedArgs, io: Io): Promise<void> {
  const { coord } = await openRepo(resolveRepo(args.flags));
  try {
    const data = await repoStatus(coord);
    const { mainHead: main, agentHead: agent, indexedCommit: indexed, queue } = data;
    emit(io, data, () =>
      [
        `repo:      ${data.repo}`,
        `repo_id:   ${data.repoId}`,
        `state:     ${data.stateDir}`,
        `main:      ${short(main)}`,
        `agent:     ${short(agent)}${agent === main ? " (integrated)" : ""}`,
        `indexed:   ${indexed ? short(indexed) : "(none)"}${indexed === agent ? " (current)" : ""}`,
        `queue:     ${QUEUE_STATES.filter((s) => queue[s]! > 0).map((s) => `${s}=${queue[s]}`).join(" ") || "empty"}`,
        `proposals: ${data.pendingProposals} pending`,
      ].join("\n"),
    );
  } finally {
    await coord.close();
  }
}

async function cmdSync(args: ParsedArgs, io: Io): Promise<void> {
  const { coord } = await openRepo(resolveRepo(args.flags));
  try {
    const r = await syncOnce(coord);
    emit(io, r, () => (r.committed ? `committed ${short(r.sha ?? "")} (${r.reason})` : `nothing committed (${r.reason})`));
  } finally {
    await coord.close();
  }
}

async function cmdIntegrate(args: ParsedArgs, io: Io): Promise<void> {
  const { coord } = await openRepo(resolveRepo(args.flags));
  try {
    const data = await integrate(coord);
    const { drained, integration: r } = data;
    emit(io, data, () =>
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
  const { coord, reconciled } = await openRepo(resolveRepo(args.flags));
  try {
    const r = await refreshIndex(coord, reconciled, { rebuild: args.flags["rebuild"] === true, embeddings: () => createEmbeddingProvider() });
    emit(io, r, () =>
      [
        `indexed: ${short(r.indexedCommit)}${r.fullRebuild ? " (full rebuild)" : ""}`,
        `notes: ${r.notes}`,
        `changed: ${r.changedPaths.length}`,
        `renames: ${r.renames.length}`,
        `embedded: ${r.embedded}`,
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
  const { coord } = await openRepo(resolveRepo(args.flags));
  try {
    const data = await search(coord, query, { limit, embeddings: createEmbeddingProvider() });
    const rows = data.hits;
    emit(io, data, () =>
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
    await coord.close();
  }
}

function proposalLine(p: Proposal): string {
  return `${p.proposalId}  ${p.status.padEnd(8)}  ${p.operation.padEnd(20)}  ${p.targets.map((t) => t.path).join(", ")}`;
}

/** Map the core's typed proposal errors (protocol.md §4: UNKNOWN_PROPOSAL, PROPOSAL_NOT_PENDING) to CLI errors. */
function proposalCliError(e: unknown): never {
  if (e instanceof UnknownProposalError) throw new CliError(`unknown proposal ${e.proposalId}`);
  if (e instanceof ProposalNotPendingError) throw new CliError(`proposal ${e.proposalId} is already ${e.status}`);
  throw e;
}

async function cmdProposals(args: ParsedArgs, io: Io): Promise<void> {
  const sub = args.positional[1] ?? "list";
  const id = args.positional[2];
  const { coord } = await openRepo(resolveRepo(args.flags));
  try {
    switch (sub) {
      case "list": {
        const all = await proposalsList(coord);
        emit(io, all, () => (all.length === 0 ? "no proposals" : all.map(proposalLine).join("\n")));
        return;
      }
      case "show": {
        if (!id) throw new CliError("proposals show: <id> required", 2);
        const p = await proposalsGet(coord, id).catch(proposalCliError);
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
        const r = await proposalsAccept(coord, id).catch(proposalCliError);
        emit(io, r, () => `${id}: ${r.state}${r.commitSha ? ` ${short(r.commitSha)}` : ""}${r.error ? ` (${r.error})` : ""}`);
        return;
      }
      case "reject": {
        if (!id) throw new CliError("proposals reject: <id> required", 2);
        // The PENDING check is the core's compare-and-set (CR-1); a lost one is ProposalNotPendingError.
        const r = await proposalsReject(coord, id, flagString(args.flags, "note")).catch(proposalCliError);
        emit(io, r, () => `${id}: REJECTED`);
        return;
      }
      default:
        throw new CliError(`proposals: unknown subcommand ${sub}\n\n${USAGE}`, 2);
    }
  } finally {
    await coord.close();
  }
}

/**
 * `watch --install/--uninstall/--status` (src/cli/service.ts). Needs only
 * brain.toml (repo_id), not an open coordinator; a missing repo is a usage
 * error (exit 2) rather than the generic exit 1 of the other commands.
 */
function cmdWatchService(args: ParsedArgs, io: Io): number {
  let repoDir: string;
  try {
    repoDir = resolveRepo(args.flags);
  } catch (e) {
    throw new CliError(`watch --install/--uninstall/--status: ${e instanceof Error ? e.message : String(e)}`, 2);
  }
  const repoId = loadConfig(repoDir).repoId;
  if (args.flags["install"] === true) {
    const r = installWatchService({ repoDir, repoId, intervalMs: flagInt(args.flags, "interval", 1000) });
    emit(io, { installed: true, kind: r.spec.kind, path: r.spec.path, name: r.spec.name }, () => r.lines.join("\n"));
    return 0;
  }
  if (args.flags["uninstall"] === true) {
    const r = uninstallWatchService(repoId);
    emit(io, { installed: false, kind: r.spec.kind, path: r.spec.path, name: r.spec.name }, () => r.lines.join("\n"));
    return 0;
  }
  const s = watchServiceStatus(repoId);
  emit(io, { installed: s.installed, running: s.running, kind: s.spec.kind, path: s.spec.path, name: s.spec.name }, () => s.lines.join("\n"));
  return s.running ? 0 : 1;
}

/**
 * `brain watch`: human-sync watcher + one `watchTick` per interval (drain,
 * integrate, refresh embeddings when something changed). The embedding
 * provider is created once; if that fails the daemon runs without embeddings.
 *
 * Loop ownership (CR-10; docs/mac-app/design.md §5.3 item 2): only the holder
 * of the repo's loop-owner lock runs the loop. The daemon waits for the lock
 * before it opens the repo, holds it for its whole life and releases it last.
 * While another process holds it, the daemon logs who (once) and keeps
 * waiting; SIGINT / SIGTERM end the wait. The lock is kernel-released, so a
 * SIGKILLed owner is taken over at once.
 *
 * The repo is opened only after the lock is acquired, for three reasons:
 * - a waiting daemon touches no repo state: today's open sequence
 *   (`ensureAgentWorktree`, `recover()`) can reset the agent worktree, and it
 *   must not do that under a live loop owner (design §5.1);
 * - recovery runs when the daemon takes over, which is exactly when a
 *   SIGKILLed previous owner may have left a dirty agent worktree or a
 *   `RUNNING` row, not hours earlier when the wait began;
 * - it follows the lock order (design §5.2): loop owner, then worktree, which
 *   the open sequence takes.
 * Repo and `brain.toml` errors still surface before waiting.
 *
 * Whoever acquires the lock runs a forced tick at once (design §5.2,
 * continuous recovery). `watch.pid` is kept for compatibility only: written
 * after the lock is acquired and removed on a clean stop, while the lock is
 * still held. Nothing reads it to decide anything; `brain doctor` reads the
 * lock and its side file.
 */
async function cmdWatch(args: ParsedArgs, io: Io): Promise<number> {
  if (args.flags["install"] === true || args.flags["uninstall"] === true || args.flags["status"] === true) return cmdWatchService(args, io);
  const intervalMs = flagInt(args.flags, "interval", 1000);
  const repoDir = resolveRepo(args.flags);
  const runtimeDir = repoPaths(repoDir, loadConfig(repoDir).repoId).runtimeDir;
  setLockHolderKind("watch"); // every lock this process holds names it as `watch` in the side file

  // One handler for the whole command: while waiting it ends the wait, once running it stops the loop.
  // It unregisters itself, so a second signal terminates at once (the kernel releases the locks).
  let stopping = false;
  let wake!: () => void;
  const stopped = new Promise<void>((r) => {
    wake = r;
  });
  const onSignal = () => {
    stopping = true;
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    wake();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    let provider: EmbeddingProvider | null = null;
    if (args.flags["no-embeddings"] === true) io.err("watch: embeddings disabled (--no-embeddings)");
    else provider = resolveWatchProvider(() => createEmbeddingProvider(), io.err);

    const owner = await waitForLoopOwner(runtimeDir, { holderKind: "watch", stopped: () => stopping, log: io.err });
    if (owner === null) {
      io.err("stopped");
      return 0;
    }
    // `owner` is held until the `finally` below releases it, after the coordinator is closed.
    try {
      io.err(`watch: acquired the loop-owner lock (pid ${process.pid})`);
      const { coord } = await openRepo(repoDir);
      const pidFile = join(coord.paths.runtimeDir, WATCH_PID_FILE);
      let db: IndexDb | null = null;
      try {
        try {
          mkdirSync(coord.paths.runtimeDir, { recursive: true });
          writeFileSync(pidFile, `${process.pid}\n`);
        } catch (e) {
          io.err(`warning: cannot write ${pidFile}: ${e instanceof Error ? e.message : String(e)}`);
        }
        let embedder: WatchEmbedder | null = null;
        if (provider !== null) {
          db = openIndex(coord.paths.indexDb);
          embedder = createWatchEmbedder({ db, provider, log: io.err });
        }
        if (!stopping) {
          io.err(`watching ${coord.paths.userWorktree} (interval ${intervalMs}ms); Ctrl-C to stop`);
          const clock = { now: () => Date.now() };
          const syncWatcher = startHumanSyncWatcher(coord.paths, coord.config, clock, intervalMs, async (now) => {
            const r = await coord.syncOnce(now);
            if (r.committed) io.err(`human sync: committed ${short(r.sha ?? "")}`);
            return r;
          });
          const deps = { coord, embedder, log: io.err };
          let running = false;
          const tick = async (force: boolean) => {
            if (running) return;
            running = true;
            try {
              await watchTick(deps, { force });
            } catch (e) {
              io.err(`watch loop error: ${e instanceof Error ? e.message : String(e)}`);
            } finally {
              running = false;
            }
          };
          // The new loop owner's forced tick: drain and integrate at once, and embed whatever the
          // recovery reconcile left stale (including notes a `--no-embeddings` owner never embedded).
          await tick(true);
          const loop = setInterval(() => void tick(false), intervalMs);
          await stopped;
          clearInterval(loop);
          syncWatcher.stop();
          while (running) await new Promise((r) => setTimeout(r, 50)); // let an in-flight tick finish before closing the db
        }
      } finally {
        try {
          unlinkSync(pidFile);
        } catch {}
        db?.close();
        await coord.close();
      }
      io.err("stopped");
      return 0;
    } finally {
      owner.release();
    }
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}

/**
 * `brain chat`: the reply is printed as soon as it exists; the knowledge
 * update is printed when it arrives (in the REPL possibly after the next
 * prompt — that is the intended async UX). Every in-flight update is awaited
 * before the process exits (a CLI must not exit with a mutation in flight).
 */

/**
 * Terminal wait indicator. Only animates when stderr is a TTY (tests and
 * pipes see nothing); frames are written with \r and cleared by `stop()`,
 * which is idempotent so a streaming reply can stop it on its first delta.
 */
function startSpinner(label: string): { stop: () => void } {
  if (process.stderr.isTTY !== true) return { stop: () => {} };
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  const started = Date.now();
  let i = 0;
  const draw = () => {
    const secs = Math.floor((Date.now() - started) / 1000);
    process.stderr.write(`\r\x1b[2K${frames[i++ % frames.length]} ${label}${secs >= 3 ? ` (${secs}s)` : ""}`);
  };
  draw();
  const timer = setInterval(draw, 80);
  let stopped = false;
  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      process.stderr.write("\r\x1b[2K");
    },
  };
}

async function withSpinner<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const spinner = startSpinner(label);
  try {
    return await fn();
  } finally {
    spinner.stop();
  }
}

/**
 * Writes streamed reply deltas to stdout so the bytes equal what
 * `io.out(reply.trim())` would have printed: leading whitespace is skipped,
 * trailing whitespace is held back until more text follows, and `end()`
 * terminates the line only if something was written (the caller prints the
 * reply itself otherwise, e.g. an empty reply or a provider without `stream`).
 */
function replyWriter(io: Io, hooks: StreamHooks): { delta: (text: string) => void; end: () => boolean } {
  let started = false;
  let held = "";
  return {
    delta: (text) => {
      if (!started) {
        text = text.replace(/^\s+/, "");
        if (text === "") return;
        started = true;
        hooks.onFirst?.();
      }
      const trailing = /\s*$/.exec(text)![0];
      const body = text.slice(0, text.length - trailing.length);
      if (body === "") {
        held += trailing;
        return;
      }
      io.write(held + body);
      held = trailing;
    },
    end: () => {
      if (started) io.write("\n");
      hooks.onEnd?.();
      return started;
    },
  };
}

interface StreamHooks {
  /** First visible reply text is about to be written (stdout is now mid-line). */
  onFirst?: () => void;
  /** The reply line was terminated (or nothing was streamed); stdout is at a line start again. */
  onEnd?: () => void;
}

/** One turn with the reply streamed to stdout; the spinner runs until the first delta. `--json` never streams. */
async function streamedTurn(deps: SessionDeps, sessionId: string, text: string, io: Io, hooks: StreamHooks = {}): Promise<Awaited<ReturnType<typeof runTurn>>> {
  const spinner = startSpinner("thinking…");
  const writer = replyWriter(io, {
    onFirst: () => {
      spinner.stop();
      hooks.onFirst?.();
    },
    onEnd: hooks.onEnd,
  });
  let r: Awaited<ReturnType<typeof runTurn>>;
  try {
    r = await runTurn(deps, sessionId, text, { onDelta: writer.delta });
  } catch (e) {
    writer.end(); // terminate a partially streamed line before the error is reported
    throw e;
  } finally {
    spinner.stop();
  }
  if (!writer.end()) io.out(r.reply);
  return r;
}

/**
 * `SESSION_BUSY` (CR-9): another writer held the session's turn lock past the
 * bound, and nothing was appended. `--once` reports it as a one-line error
 * with exit code 1; the REPL prints the same line and keeps reading.
 */
async function sessionBusyAsCliError<T>(p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch (e) {
    if (e instanceof SessionBusyError) throw new CliError(e.message);
    throw e;
  }
}

async function cmdChat(args: ParsedArgs, io: Io): Promise<void> {
  const once = flagString(args.flags, "once");
  if (args.flags["once"] === true || (once !== undefined && once.trim() === "")) throw new CliError("chat --once: text required", 2);
  const wait = args.flags["wait"] === true;
  const model = chatModelProvider({ log: io.err });
  // Mock and script modes must never touch the network: pair them with offline embeddings.
  const embeddings = chatEmbeddingProvider();
  const { coord } = await openRepo(resolveRepo(args.flags));
  const inFlight = createKnowledgeTracker();
  let opened: OpenedSessionDeps | null = null;
  try {
    opened = await openSessionDeps(coord, { model, embeddings });
    const { deps } = opened;
    const session = openSession(deps.store, flagString(args.flags, "session"));
    const sessionId = session.sessionId;
    io.err(`session ${sessionId}${session.resumed ? ` (resumed, ${session.turnCount} turns)` : ""}`);
    const track = inFlight.track;

    if (once !== undefined) {
      if (io.json) {
        const r = track(await sessionBusyAsCliError(withSpinner("thinking…", () => runTurn(deps, sessionId, once))));
        const knowledge = await r.knowledge;
        emit(io, { sessionId, reply: r.reply, contextNotes: r.contextNotes, knowledge, summary: formatKnowledgeSummary(knowledge) }, () => "");
        return;
      }
      const r = track(await sessionBusyAsCliError(streamedTurn(deps, sessionId, once, io)));
      // never rejects; always awaited before exit
      const knowledge = await withSpinner("updating knowledge…", () => r.knowledge);
      if (wait) io.out(formatKnowledgeSummary(knowledge));
      for (const e of knowledge.errors) io.err(`knowledge: ${e}`);
      return;
    }

    await chatRepl(deps, sessionId, io, track);
  } finally {
    // Drain before closing: `coord.close()` closes the queue under any in-flight submit().
    await inFlight.drain();
    opened?.close();
    await coord.close();
  }
}

async function chatRepl(deps: SessionDeps, sessionId: string, io: Io, track: KnowledgeTracker["track"]): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "> ", terminal: process.stdin.isTTY === true });
  io.err("type a message; /proposals lists pending proposals; /quit or Ctrl-D exits");
  let busy: Promise<void> = Promise.resolve();
  let closed = false;
  // A knowledge summary from an earlier turn may finish while a later reply is
  // still streaming; it is queued rather than injected into the half-written line.
  let midLine = false;
  const pending: string[] = [];

  const say = (line: string) => {
    if (midLine) {
      pending.push(line);
      return;
    }
    io.out(line);
    if (!closed) rl.prompt(true);
  };
  const hooks: StreamHooks = {
    onFirst: () => {
      midLine = true;
    },
    onEnd: () => {
      midLine = false;
      for (const line of pending.splice(0)) io.out(line);
    },
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
      const pending = await proposalsList(deps.coord, { status: "PENDING" });
      io.out(pending.length === 0 ? "no pending proposals" : pending.map(proposalLine).join("\n"));
      return;
    }
    if (text.startsWith("/")) {
      io.out(`unknown command ${text}; commands: /proposals, /quit`);
      return;
    }
    try {
      const r = track(await streamedTurn(deps, sessionId, text, io, hooks));
      if (process.stderr.isTTY === true) io.err("\x1b[2m… updating knowledge in the background; the summary will appear when it finishes\x1b[0m");
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
// setup / doctor (first-run configuration; src/config)
// ---------------------------------------------------------------------------

/** `--repo <dir>` (must exist) or the nearest brain.toml above cwd; null when neither. */
function resolveRepoOrNull(flags: ParsedArgs["flags"]): string | null {
  return flagString(flags, "repo") !== undefined ? resolveRepo(flags) : findRepoRoot(process.cwd());
}

/** One line from the terminal; the prompt goes to stderr so stdout stays machine-readable. */
function ask(question: string, dflt: string): Promise<string> {
  return new Promise((done) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: process.stdin.isTTY === true });
    rl.question(`${question}${dflt ? ` [${dflt}]` : ""}: `, (answer) => {
      rl.close();
      const a = answer.trim();
      done(a === "" ? dflt : a);
    });
  });
}

/**
 * Read a secret without echo: readline in terminal mode echoes typed
 * characters to `output`, so a discarding stream hides them while line
 * editing (backspace) keeps working. Falls back to a plain line off a pipe.
 */
function askHidden(question: string): Promise<string> {
  return new Promise((done) => {
    const tty = process.stdin.isTTY === true;
    process.stderr.write(question);
    const muted = new Writable({ write: (_chunk, _enc, cb) => cb() });
    const rl = createInterface({ input: process.stdin, output: tty ? muted : undefined, terminal: tty });
    rl.question("", (answer) => {
      rl.close();
      if (tty) process.stderr.write("\n");
      done(answer.trim());
    });
  });
}

function parseChoice<T extends string>(flag: string, raw: string | undefined, allowed: readonly T[]): T | undefined {
  if (raw === undefined) return undefined;
  const v = raw.trim().toLowerCase();
  if (!allowed.includes(v as T)) throw new CliError(`--${flag} must be one of ${allowed.join(" | ")}; got ${JSON.stringify(raw)}`, 2);
  return v as T;
}

const MODEL_PROVIDERS = ["anthropic", "openrouter"] as const;
const EMBEDDING_PROVIDERS = ["hashing", "openrouter"] as const;

/**
 * `brain setup`: interactive on a TTY (current values as defaults), flag-driven
 * otherwise; flags always override prompts and `--yes` accepts every default.
 * Writes `$BRAIN_HOME/config.toml` (mode 0600), then runs the doctor checks
 * against the new file (with the *startup* environment layered on top, so a
 * previously loaded config never shadows what was just saved).
 */
async function cmdSetup(args: ParsedArgs, io: Io, startupEnv: NodeJS.ProcessEnv): Promise<number> {
  const f = args.flags;
  const existing: UserConfig = loadUserConfig({ warn: io.err }) ?? {};
  const yes = f["yes"] === true;
  const interactive = !yes && process.stdin.isTTY === true;
  const keyFlag = flagString(f, "key");
  if (f["key"] === true || (keyFlag !== undefined && keyFlag.trim() === "")) throw new CliError("setup: --key needs a value", 2);

  // provider: flag > existing file > key prefix > openrouter
  let provider: ModelProviderName =
    parseChoice("provider", flagString(f, "provider"), MODEL_PROVIDERS) ??
    existing.model?.provider ??
    (keyFlag?.startsWith("sk-ant-") ? "anthropic" : "openrouter");
  if (interactive && flagString(f, "provider") === undefined) {
    provider = parseChoice("provider", await ask("model provider (anthropic | openrouter)", provider), MODEL_PROVIDERS)!;
  }
  const sameProvider = existing.model?.provider === provider;

  // key: flag > prompt (blank keeps the existing one) > existing file > environment
  const envKeyName = provider === "openrouter" ? "OPENROUTER_API_KEY" : "ANTHROPIC_API_KEY";
  const existingKey = existing.keys?.[provider];
  let key = keyFlag?.trim();
  if (key === undefined && interactive) {
    const hint = existingKey ? ` [keep ${maskKey(existingKey)}]` : "";
    key = await askHidden(`${provider} API key (${envKeyName}, input hidden)${hint}: `);
  }
  if (!key) key = existingKey; // never overwrite an existing key with an empty answer
  const envKey = (startupEnv[envKeyName] ?? "").trim() || (provider === "anthropic" ? (startupEnv["ANTHROPIC_AUTH_TOKEN"] ?? "").trim() : "");
  if (!key && !envKey) throw new CliError(`setup: no ${provider} key; pass --key <key> (or set ${envKeyName})`, 2);

  // model
  const defaultModel = provider === "openrouter" ? DEFAULT_OPENROUTER_MODEL : DEFAULT_MODEL;
  let model = flagString(f, "model")?.trim() || (sameProvider ? existing.model?.model : undefined) || defaultModel;
  if (interactive && flagString(f, "model") === undefined) model = await ask("model id", model);

  // embeddings (Anthropic has no embeddings endpoint → hashing unless told otherwise)
  const defaultEmbeddings: EmbeddingsProviderName = provider === "openrouter" ? "openrouter" : "hashing";
  let embeddings: EmbeddingsProviderName =
    parseChoice("embeddings", flagString(f, "embeddings"), EMBEDDING_PROVIDERS) ?? (sameProvider ? existing.embeddings?.provider : undefined) ?? defaultEmbeddings;
  if (interactive && flagString(f, "embeddings") === undefined) {
    if (provider === "anthropic") io.err("note: Anthropic has no embeddings endpoint; `openrouter` embeddings need an OpenRouter key, `hashing` works offline");
    embeddings = parseChoice("embeddings", await ask("embeddings (hashing | openrouter)", embeddings), EMBEDDING_PROVIDERS)!;
  }
  let embeddingModel = flagString(f, "embedding-model")?.trim() || existing.embeddings?.model || DEFAULT_OPENROUTER_EMBEDDING_MODEL;
  let dims = flagInt(f, "dims", existing.embeddings?.dims ?? DEFAULT_OPENROUTER_EMBEDDING_DIMS);
  let openrouterKey = existing.keys?.openrouter;
  if (provider === "openrouter" && key) openrouterKey = key;
  if (embeddings === "openrouter") {
    if (interactive && flagString(f, "embedding-model") === undefined) embeddingModel = await ask("embedding model id", embeddingModel);
    if (interactive && flagString(f, "dims") === undefined) {
      const d = Number.parseInt(await ask("embedding dims", String(dims)), 10);
      if (!Number.isFinite(d)) throw new CliError("dims must be an integer", 2);
      dims = d;
    }
    if (provider === "anthropic" && !openrouterKey && interactive) {
      const k = await askHidden("OpenRouter API key for embeddings (OPENROUTER_API_KEY, input hidden): ");
      if (k) openrouterKey = k;
    }
  }
  if (!Number.isInteger(dims) || dims <= 0) throw new CliError(`--dims must be a positive integer, got ${dims}`, 2);

  const cfg: UserConfig = {
    model: { provider, model, effort: sameProvider ? existing.model?.effort : undefined },
    keys: {
      openrouter: openrouterKey,
      anthropic: provider === "anthropic" && key ? key : existing.keys?.anthropic,
    },
    embeddings: embeddings === "openrouter" ? { provider: "openrouter", model: embeddingModel, dims } : { provider: "hashing" },
  };
  const path = saveUserConfig(cfg);

  const savedKey = cfg.keys?.[provider];
  const lines = [
    `wrote ${path} (mode 0600)`,
    `model:      ${provider} / ${model}`,
    `key:        ${savedKey ? maskKey(savedKey) : `(from ${envKeyName} in the environment)`}`,
    `embeddings: ${embeddings === "openrouter" ? `openrouter / ${embeddingModel} (${dims} dims)` : "hashing (offline)"}`,
  ];
  if (provider === "anthropic" && embeddings === "hashing") {
    lines.push("note: Anthropic has no embeddings endpoint, so semantic search uses the offline hashing embedder.", "      For better semantic search: `brain setup --embeddings openrouter --key <openrouter-key>` (with --provider anthropic keeps the Anthropic model).");
  }
  if (embeddings === "openrouter" && !cfg.keys?.openrouter && !(startupEnv["OPENROUTER_API_KEY"] ?? "").trim()) {
    lines.push("warning: embeddings=openrouter but no OpenRouter key is configured; set one with `brain setup --embeddings openrouter --provider openrouter --key <key>` or use --embeddings hashing");
  }

  // doctor against the file just written (startup env wins over it, as at every launch)
  let repoRoot: string | null = null;
  try {
    repoRoot = resolveRepoOrNull(f);
  } catch {}
  const report = await runDoctor({ env: applyUserConfigToEnv(cfg, { ...startupEnv }), repoRoot, offline: f["offline"] === true });
  emit(
    io,
    {
      path,
      config: { ...cfg, keys: { openrouter: cfg.keys?.openrouter ? maskKey(cfg.keys.openrouter) : undefined, anthropic: cfg.keys?.anthropic ? maskKey(cfg.keys.anthropic) : undefined } },
      doctor: report,
    },
    () => [...lines, "", formatDoctorReport(report)].join("\n"),
  );
  return 0;
}

async function cmdDoctor(args: ParsedArgs, io: Io): Promise<number> {
  const report = await runDoctor({ offline: args.flags["offline"] === true, repoRoot: resolveRepoOrNull(args.flags) });
  emit(io, report, () => formatDoctorReport(report));
  return report.ok ? 0 : 1;
}

// ---------------------------------------------------------------------------
// rpc
// ---------------------------------------------------------------------------

/**
 * `brain rpc --stdio`: the JSONL server the Mac app spawns (src/rpc,
 * docs/mac-app/protocol.md). stdio is the only transport. The server exits
 * the process itself once it has drained (protocol §3).
 */
async function cmdRpc(args: ParsedArgs, io: Io): Promise<number> {
  if (args.flags["stdio"] !== true || args.positional.length > 1) {
    io.err("usage: brain rpc --stdio (stdio is the only transport)");
    return 2;
  }
  return runStdioServer();
}

// ---------------------------------------------------------------------------
// dispatch
// ---------------------------------------------------------------------------

export async function main(argv: string[], io: Io = { out: console.log, err: console.error, write: (chunk) => void process.stdout.write(chunk), json: false }): Promise<number> {
  const args = parseArgs(argv);
  io.json = args.flags["json"] === true;
  const cmd = args.positional[0];
  if (args.flags["version"] === true || cmd === "version") {
    io.out(`brain ${pkg.version}`);
    return 0;
  }
  if (args.flags["help"] === true || cmd === "help") {
    io.out(USAGE);
    return 0;
  }
  if (!cmd) {
    io.err(USAGE);
    return 2;
  }
  // The RPC server never projects config.toml onto process.env: it builds a private env
  // per protocol.md §3 (design §10), so it is dispatched before the projection below.
  if (cmd === "rpc") return await cmdRpc(args, io);
  // First-run configuration: project $BRAIN_HOME/config.toml onto unset environment
  // variables before any provider is created. `setup` works from the raw environment
  // so an existing file never shadows the values it is about to write.
  const startupEnv: NodeJS.ProcessEnv = { ...process.env };
  if (cmd !== "setup") applyUserConfigToEnv(loadUserConfig({ warn: io.err }));
  try {
    switch (cmd) {
      case "setup":
        return await cmdSetup(args, io, startupEnv);
      case "doctor":
        return await cmdDoctor(args, io);
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
        return await cmdWatch(args, io);
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
    // The service layer's typed errors (NO_MODEL, UNKNOWN_SESSION, …) are one-line user errors, like CliError.
    if (e instanceof ServiceError) {
      io.err(e.message);
      return 1;
    }
    io.err(`error: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
