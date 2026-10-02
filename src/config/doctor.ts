/**
 * `brain doctor`: environment and configuration checklist.
 *
 * `runDoctor` is a pure-ish function over an injected environment, `fetch`
 * and Anthropic model lookup so unit tests never touch the network. The CLI
 * formats the returned checks; the exit code is 0 iff every *required*
 * check passed. Live checks (OpenRouter `/models`, `/embeddings`; Anthropic
 * `models.retrieve`) are skipped with `offline`. The `brain` on `PATH` is
 * probed locally (`--version`, short timeout), so it runs even with `offline`.
 */
import Anthropic from "@anthropic-ai/sdk";
import { accessSync, constants, existsSync, mkdirSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import pkg from "../../package.json" with { type: "json" };
import { defaultServiceEnv, describeInstalledService, isCompiledBinary, type ServiceEnv } from "../cli/service";
import { repoPaths, resolveBrainHome } from "../core/brainHome";
import { queueStateCounts } from "../core/queue";
import { AGENT_BRANCH, MAIN_BRANCH } from "../core/types";
import { isRepoRoot, NOT_OWN_REPO, refExists, revParse } from "../git/git";
import { loadConfig } from "../markdown/repo";
import { createAnthropicClient, DEFAULT_MODEL } from "../model/claude";
import { resolveProviderKind, type ProviderKind } from "../model/index";
import {
  DEFAULT_OPENROUTER_EMBEDDING_DIMS,
  DEFAULT_OPENROUTER_EMBEDDING_MODEL,
  DEFAULT_OPENROUTER_MODEL,
  OPENROUTER_BASE_URL,
  type FetchLike,
} from "../model/openrouter";
import { isLockHeld, LOOP_OWNER_LOCK, readLockHolder, WORKTREE_LOCK } from "../sync/lock";
import { maskKey, userConfigPath } from "./userConfig";

/**
 * 2.39 covers Xcode Command Line Tools (`2.39.5 (Apple Git-154)`). The
 * suite passes on 2.39.5 in CI (job `test-git-2-39`); the newest git
 * feature used is `init -b` (2.28). CR-7, docs/mac-app/design.md §11.
 */
export const MIN_GIT_VERSION: readonly [number, number] = [2, 39];
/**
 * Written by `brain watch` under `<runtimeDir>/` once it holds the loop-owner
 * lock, and removed on a clean stop. Kept for compatibility only: it outlives
 * a crashed daemon and its pid may be reused, so nothing reads it to decide
 * anything (`loopOwnerCheck` reads the lock instead; CR-10).
 */
export const WATCH_PID_FILE = "watch.pid";
/** A live holder of the worktree lock for longer than this is reported (design §5.2: the lock has no deadline). */
export const LONG_HELD_LOCK_MS = 10 * 60_000;
/** `<brain on PATH> --version` gets this long before it is killed and reported (a hung binary never hangs doctor). */
export const BRAIN_VERSION_PROBE_TIMEOUT_MS = 3_000;

export type CheckStatus = "ok" | "fail" | "warn" | "skip" | "info";

export interface DoctorCheck {
  name: string;
  status: CheckStatus;
  detail: string;
  /** A failing required check makes the exit code 1. */
  required: boolean;
}

export interface DoctorReport {
  checks: DoctorCheck[];
  ok: boolean;
}

export interface DoctorOptions {
  env?: NodeJS.ProcessEnv;
  /**
   * `env` is the only credential source for the live Anthropic check (CR-11
   * isolated mode, as `createModelProvider(env, {isolatedEnv: true})`): no
   * `process.env` fallback, no SDK default credential chain. For a private
   * env such as the RPC server's (`doctor.run`). Default false: the CLI keeps
   * the SDK's own lookup.
   */
  isolatedEnv?: boolean;
  /** Knowledge repo root (already resolved by the caller), or null when not inside one. */
  repoRoot?: string | null;
  offline?: boolean;
  /** Injected for tests; default global fetch. */
  fetch?: FetchLike;
  /** Injected for tests; default `createAnthropicClient(…from env, isolatedEnv).models.retrieve(model)`. Must throw on auth / not-found. */
  retrieveModel?: (model: string, env: NodeJS.ProcessEnv) => Promise<void>;
  /** Injected for tests; default runs `git --version`. */
  gitVersion?: () => string | null;
  /** Injected for tests; default the first `brain` on `env.PATH` (none when `env` has no `PATH`). */
  brainOnPath?: () => string | null;
  /** Injected for tests; default `probeBrainVersion`. Resolves to the output of `<path> --version`; rejects when it fails or hangs. */
  brainVersion?: (path: string) => Promise<string>;
  /** Injected for tests; default this process (`runningBrain()`). */
  running?: RunningBrain;
  configPath?: string;
  timeoutMs?: number;
  /** Injected for tests (platform/home); default: the real machine. Detection is file-existence only, never a shell-out. */
  service?: Partial<ServiceEnv>;
}

function envOr(env: NodeJS.ProcessEnv, name: string, dflt = ""): string {
  const v = env[name];
  return v !== undefined && v.trim() !== "" ? v.trim() : dflt;
}

function defaultGitVersion(): string | null {
  try {
    const r = Bun.spawnSync(["git", "--version"], { stdout: "pipe", stderr: "pipe" });
    if (r.exitCode !== 0) return null;
    return r.stdout.toString().trim();
  } catch {
    return null;
  }
}

/** `git version 2.43.0` / `git version 2.39.5 (Apple Git-154)` → [2, 43]. */
export function parseGitVersion(text: string): [number, number, number] | null {
  const m = text.match(/(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)];
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/**
 * The worktree lock (CR-1): a momentary try-lock tells whether anyone holds
 * it; the informational side file names the holder. A live holder that has
 * held it for `LONG_HELD_LOCK_MS` or more is a warning, since every other
 * writer waits behind it.
 */
export function worktreeLockCheck(runtimeDir: string, now = Date.now()): DoctorCheck {
  const check = (status: CheckStatus, detail: string): DoctorCheck => ({ name: "worktree lock", status, detail, required: false });
  let held: boolean;
  try {
    held = isLockHeld(runtimeDir, WORKTREE_LOCK);
  } catch (e) {
    return check("warn", `could not probe: ${errorMessage(e)}`);
  }
  if (!held) return check("ok", "free");
  const holder = readLockHolder(runtimeDir, WORKTREE_LOCK);
  if (!holder || !pidAlive(holder.pid)) return check("info", "held (holder unknown)");
  const age = Math.max(0, now - holder.acquiredAtMs);
  const who = `held by ${holder.kind} (pid ${holder.pid}) for ${formatDuration(age)}`;
  if (age < LONG_HELD_LOCK_MS) return check("ok", who);
  return check("warn", `${who}; every other writer waits behind it — stop that process if it is hung`);
}

/**
 * Loop ownership (CR-10; docs/mac-app/design.md §5.3 item 2): a momentary
 * try-lock on the loop-owner lock tells whether some process runs the repo's
 * loop; the informational side file names it (`brain watch`, later the RPC
 * server). `watch.pid` is not consulted: after a crash it names a pid that
 * may since have been reused, and a waiting `brain watch` does not run the
 * loop. `service` (installed service state) is appended to the detail.
 */
export function loopOwnerCheck(runtimeDir: string, service: string): DoctorCheck {
  const check = (status: CheckStatus, detail: string): DoctorCheck => ({ name: "watch", status, detail: `${detail}; ${service}`, required: false });
  let held: boolean;
  try {
    held = isLockHeld(runtimeDir, LOOP_OWNER_LOCK);
  } catch (e) {
    return check("warn", `unknown (could not probe the loop-owner lock: ${errorMessage(e)})`);
  }
  if (!held) return check("info", "not running");
  const holder = readLockHolder(runtimeDir, LOOP_OWNER_LOCK);
  if (!holder || !pidAlive(holder.pid)) return check("ok", "running (holder unknown)");
  return check("ok", `running (${holder.kind}, pid ${holder.pid})`);
}

/** The `brain` this process is: its version and the file it runs from. */
export interface RunningBrain {
  version: string;
  /** The compiled binary, or `src/cli.ts` when running from source (`bun src/cli.ts`). */
  path: string;
}

export function runningBrain(): RunningBrain {
  return { version: pkg.version, path: isCompiledBinary() ? process.execPath : resolve(import.meta.dir, "..", "cli.ts") };
}

/** `brain 0.1.4` (the `--version` output) → `0.1.4`; null when the text names no version. */
export function parseBrainVersion(text: string): string | null {
  const m = text.match(/\bbrain\s+v?(\d+\.\d+\.\d+\S*)/);
  return m ? m[1]! : null;
}

/**
 * Runs `<path> --version` and resolves to its stdout; rejects on a spawn
 * error, a non-zero exit, or no answer within `timeoutMs`. The child runs in
 * its own process group and the whole group is killed on timeout: killing the
 * child alone would leave a grandchild (a `sleep` in a wrapper script, say)
 * holding the stdout pipe, and doctor would wait on it.
 */
export async function probeBrainVersion(path: string, timeoutMs = BRAIN_VERSION_PROBE_TIMEOUT_MS): Promise<string> {
  const proc = Bun.spawn([path, "--version"], { stdin: "ignore", stdout: "pipe", stderr: "ignore", detached: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const hung = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      try {
        process.kill(-proc.pid, "SIGKILL");
      } catch {
        proc.kill("SIGKILL");
      }
      reject(new Error(`no answer within ${timeoutMs} ms`));
    }, timeoutMs);
  });
  try {
    const [out, code] = await Promise.race([Promise.all([new Response(proc.stdout).text(), proc.exited]), hung]);
    if (code !== 0) throw new Error(`exit code ${code}`);
    return out;
  } finally {
    clearTimeout(timer);
  }
}

function sameFile(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

/**
 * Mixed versions (docs/mac-app/design.md §5.2, §5.5 item 9): from v0.2.0 on
 * (CR-1) every `brain` sharing a `BRAIN_HOME` must be the same version. The
 * first `brain` on `PATH` (`onPath`, null when there is none) is compared with
 * this process by version string, so running from source compares the same
 * way. A mismatch, or a `brain` whose version cannot be read, is a warning
 * and never required: the exit code is unaffected.
 */
export async function brainVersionCheck(running: RunningBrain, onPath: string | null, probe: (path: string) => Promise<string>): Promise<DoctorCheck> {
  const check = (status: CheckStatus, detail: string): DoctorCheck => ({ name: "brain on PATH", status, detail, required: false });
  const self = `this brain is ${running.version} (${running.path})`;
  if (onPath === null) return check("info", `not on PATH; ${self}`);
  if (sameFile(onPath, running.path)) return check("ok", `${onPath} (this brain, ${running.version})`);
  let out: string;
  try {
    out = await probe(onPath);
  } catch (e) {
    return check("warn", `\`${onPath} --version\` failed (${errorMessage(e)}), so it may not match: ${self}`);
  }
  const version = parseBrainVersion(out);
  if (version === null) return check("warn", `\`${onPath} --version\` printed no brain version (${JSON.stringify(out.trim().slice(0, 60))}), so it may not match: ${self}`);
  if (version === running.version) return check("ok", `${onPath} is ${version}, same as this brain (${running.path})`);
  return check("warn", `${onPath} is ${version} but ${self}; mixed brain versions sharing a BRAIN_HOME are unsupported, so install one version everywhere`);
}

/**
 * The live Anthropic check: `models.retrieve(model)` with the credentials in
 * `env`. With `isolated` (CR-11, design §10) `env` is the only source: an
 * unset key, token or base URL stays unset instead of being read from
 * `process.env`, and the SDK's default credential chain is off. Without it
 * (the CLI), the SDK's own lookup fills whatever `env` lacks, as before.
 */
async function defaultRetrieveModel(model: string, env: NodeJS.ProcessEnv, timeoutMs: number, isolated: boolean): Promise<void> {
  const client = createAnthropicClient({
    apiKey: envOr(env, "ANTHROPIC_API_KEY"),
    authToken: envOr(env, "ANTHROPIC_AUTH_TOKEN"),
    baseURL: envOr(env, "ANTHROPIC_BASE_URL"),
    isolated,
    timeout: timeoutMs,
    maxRetries: 0,
  });
  await client.models.retrieve(model);
}

/** Map an SDK error to a human line; `null` when `e` is not an API error. */
function describeAnthropicError(e: unknown): string {
  if (e instanceof Anthropic.AuthenticationError) return "authentication failed (401): check ANTHROPIC_API_KEY";
  if (e instanceof Anthropic.PermissionDeniedError) return "permission denied (403): the key cannot use this model";
  if (e instanceof Anthropic.NotFoundError) return "model not found (404)";
  if (e instanceof Anthropic.APIConnectionError) return `connection error: ${e.message}`;
  if (e instanceof Anthropic.APIError) return `api error${e.status ? ` ${e.status}` : ""}: ${e.message}`;
  return errorMessage(e);
}

export async function runDoctor(opts: DoctorOptions = {}): Promise<DoctorReport> {
  const env = opts.env ?? process.env;
  const offline = opts.offline === true;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const doFetch: FetchLike = opts.fetch ?? ((input, init) => fetch(input, init));
  const checks: DoctorCheck[] = [];
  const add = (name: string, status: CheckStatus, detail: string, required = true) => checks.push({ name, status, detail, required });

  // --- git ---------------------------------------------------------------
  const gv = (opts.gitVersion ?? defaultGitVersion)();
  const parsed = gv ? parseGitVersion(gv) : null;
  if (!parsed) add("git", "fail", `git not found on PATH (need ≥ ${MIN_GIT_VERSION.join(".")})`);
  else {
    const [maj, min] = parsed;
    const okVersion = maj > MIN_GIT_VERSION[0] || (maj === MIN_GIT_VERSION[0] && min >= MIN_GIT_VERSION[1]);
    add("git", okVersion ? "ok" : "fail", okVersion ? gv! : `${gv} is older than ${MIN_GIT_VERSION.join(".")}`);
  }

  // --- brain on PATH (mixed versions; local, so it runs under --offline too) ---
  const onPath = (opts.brainOnPath ?? (() => Bun.which("brain", { PATH: env.PATH ?? "" })))();
  checks.push(await brainVersionCheck(opts.running ?? runningBrain(), onPath, opts.brainVersion ?? ((p) => probeBrainVersion(p))));

  // --- BRAIN_HOME ----------------------------------------------------------
  const home = resolveBrainHome();
  try {
    mkdirSync(home, { recursive: true });
    accessSync(home, constants.W_OK);
    add("BRAIN_HOME", "ok", `${home} (writable)`);
  } catch (e) {
    add("BRAIN_HOME", "fail", `${home} is not writable: ${errorMessage(e)}`);
  }

  // --- config file ---------------------------------------------------------
  const configPath = opts.configPath ?? userConfigPath();
  const hasConfig = existsSync(configPath);
  add("config", hasConfig ? "ok" : "info", hasConfig ? configPath : `none (${configPath}); run \`brain setup\``, false);

  // --- model provider + key ------------------------------------------------
  let kind: ProviderKind | null = null;
  try {
    kind = resolveProviderKind(env);
  } catch (e) {
    add("model provider", "fail", errorMessage(e));
  }
  let model = "";
  let keyOk = false;
  if (kind === "openrouter") {
    model = envOr(env, "BRAIN_MODEL", DEFAULT_OPENROUTER_MODEL);
    const key = envOr(env, "OPENROUTER_API_KEY");
    keyOk = key !== "";
    add("model provider", "ok", `openrouter, model ${model}`);
    add("OPENROUTER_API_KEY", keyOk ? "ok" : "fail", keyOk ? maskKey(key) : "missing; run `brain setup --provider openrouter --key <key>`");
  } else if (kind === "anthropic") {
    model = envOr(env, "BRAIN_MODEL", DEFAULT_MODEL);
    const key = envOr(env, "ANTHROPIC_API_KEY");
    const token = envOr(env, "ANTHROPIC_AUTH_TOKEN");
    keyOk = key !== "" || token !== "";
    add("model provider", "ok", `anthropic, model ${model}`);
    add(
      "ANTHROPIC_API_KEY",
      keyOk ? "ok" : "fail",
      key !== "" ? maskKey(key) : token !== "" ? "(ANTHROPIC_AUTH_TOKEN set)" : "missing; run `brain setup --provider anthropic --key <key>`",
    );
  }

  // --- embeddings ------------------------------------------------------------
  let embKind = envOr(env, "BRAIN_EMBEDDINGS");
  if (embKind === "") embKind = kind === "openrouter" ? "openrouter" : "hashing";
  const embModel = envOr(env, "BRAIN_EMBEDDING_MODEL", DEFAULT_OPENROUTER_EMBEDDING_MODEL);
  const embDims = Number(envOr(env, "BRAIN_EMBEDDING_DIMS", String(DEFAULT_OPENROUTER_EMBEDDING_DIMS)));
  const embKey = envOr(env, "OPENROUTER_API_KEY");
  if (embKind === "hashing") {
    add("embeddings", "ok", `hashing (offline; ${kind === "anthropic" ? "Anthropic has no embeddings endpoint — " : ""}for better semantic search: \`brain setup --embeddings openrouter\` with an OpenRouter key)`, false);
  } else if (embKind === "openrouter") {
    if (!Number.isInteger(embDims) || embDims <= 0) add("embeddings", "fail", `BRAIN_EMBEDDING_DIMS must be a positive integer, got ${JSON.stringify(envOr(env, "BRAIN_EMBEDDING_DIMS"))}`);
    else if (embKey === "") add("embeddings", "fail", `openrouter ${embModel} (${embDims} dims) but OPENROUTER_API_KEY is missing`);
    else add("embeddings", "ok", `openrouter ${embModel} (${embDims} dims)`);
  } else {
    add("embeddings", "fail", `unknown BRAIN_EMBEDDINGS ${JSON.stringify(embKind)} (expected hashing | openrouter)`);
  }

  // --- live checks -------------------------------------------------------------
  if (offline) {
    add("live check", "skip", "skipped (--offline)", false);
  } else if (kind === "openrouter" && keyOk) {
    const base = envOr(env, "OPENROUTER_BASE_URL", OPENROUTER_BASE_URL).replace(/\/+$/, "");
    const headers = { Authorization: `Bearer ${envOr(env, "OPENROUTER_API_KEY")}`, "Content-Type": "application/json", "X-Title": "brain" };
    // `/models` is public (200 even with a bad key), so the key itself is validated against `/auth/key`.
    try {
      const res = await doFetch(`${base}/auth/key`, { method: "GET", headers, signal: AbortSignal.timeout(timeoutMs) });
      if (res.status === 401 || res.status === 403) add("openrouter key", "fail", `HTTP ${res.status}: the key was rejected; run \`brain setup --provider openrouter --key <key>\``);
      else if (!res.ok) add("openrouter key", "warn", `GET /auth/key → HTTP ${res.status} (could not verify the key)`, false);
      else {
        const json: any = await res.json().catch(() => null);
        const label = typeof json?.data?.label === "string" ? ` (${json.data.label})` : "";
        add("openrouter key", "ok", `accepted${label}`);
      }
    } catch (e) {
      add("openrouter key", "fail", `GET ${base}/auth/key failed: ${errorMessage(e)}`);
    }
    try {
      const res = await doFetch(`${base}/models`, { method: "GET", headers, signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) add("openrouter model", "fail", `GET ${base}/models → HTTP ${res.status}`);
      else {
        const json: any = await res.json().catch(() => null);
        const ids: string[] = Array.isArray(json?.data) ? json.data.map((m: any) => String(m?.id ?? "")) : [];
        if (ids.length === 0) add("openrouter model", "warn", `${model}: could not verify (empty model list)`, false);
        else if (ids.includes(model)) add("openrouter model", "ok", `${model} is available (${ids.length} models listed)`);
        else add("openrouter model", "fail", `${model} is not in the OpenRouter model list; run \`brain setup --model <id>\``);
      }
    } catch (e) {
      add("openrouter model", "fail", `GET ${base}/models failed: ${errorMessage(e)}`);
    }
    if (embKind === "openrouter" && Number.isInteger(embDims) && embDims > 0) {
      try {
        const res = await doFetch(`${base}/embeddings`, {
          method: "POST",
          headers,
          body: JSON.stringify({ model: embModel, input: ["ping"] }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        const json: any = await res.json().catch(() => null);
        if (!res.ok || json?.error) {
          add("openrouter embeddings", "fail", `POST /embeddings (${embModel}) → HTTP ${res.status}${json?.error?.message ? `: ${json.error.message}` : ""}`);
        } else {
          const vec = json?.data?.[0]?.embedding;
          const actual = Array.isArray(vec) ? vec.length : -1;
          if (actual < 0) add("openrouter embeddings", "fail", `POST /embeddings (${embModel}) returned no embedding`);
          else if (actual === embDims) add("openrouter embeddings", "ok", `${embModel} returns ${actual} dims`);
          else add("openrouter embeddings", "fail", `${embModel} returns ${actual} dims but BRAIN_EMBEDDING_DIMS=${embDims}; fix: \`brain setup --dims ${actual}\``);
        }
      } catch (e) {
        add("openrouter embeddings", "fail", `POST ${base}/embeddings failed: ${errorMessage(e)}`);
      }
    }
  } else if (kind === "anthropic" && keyOk) {
    try {
      await (opts.retrieveModel ?? ((m, e) => defaultRetrieveModel(m, e, timeoutMs, opts.isolatedEnv === true)))(model, env);
      add("anthropic model", "ok", `${model} is available`);
    } catch (e) {
      add("anthropic model", "fail", `${model}: ${describeAnthropicError(e)}`);
    }
  } else {
    add("live check", "skip", "skipped (no credentials)", false);
  }

  // --- knowledge repo (optional) -----------------------------------------------
  if (opts.repoRoot) {
    // Read-only: doctor never opens a coordinator. Opening takes the worktree lock (CR-1), which has no
    // deadline, so doctor would hang behind the very hung holder it is meant to report (design §5.2).
    // Probing the lock first and opening only when it looks free would still race a holder that takes
    // it in between (`brain watch` retakes it every tick), so the heads and the queue are read without
    // the lock: `git rev-parse` and a read-only queue connection. Doctor writes no repo state.
    let lockCheck: DoctorCheck | null = null;
    try {
      const config = loadConfig(opts.repoRoot);
      const paths = repoPaths(opts.repoRoot, config.repoId);
      lockCheck = worktreeLockCheck(paths.runtimeDir);
      if (!isRepoRoot(opts.repoRoot)) throw new Error(NOT_OWN_REPO);
      if (!refExists(opts.repoRoot, MAIN_BRANCH)) throw new Error(`branch ${MAIN_BRANCH} does not exist; run \`brain init\` first`);
      const main = revParse(opts.repoRoot, MAIN_BRANCH);
      const agent = refExists(opts.repoRoot, AGENT_BRANCH) ? revParse(opts.repoRoot, AGENT_BRANCH) : null;
      const queue = queueStateCounts(paths.queueDb)
        .map(([s, n]) => `${s}=${n}`)
        .join(" ");
      add("repo", "ok", `${opts.repoRoot} (repo_id ${config.repoId})`, false);
      const agentDetail = agent === null ? `agent (none yet; created on first use)` : `agent ${agent.slice(0, 12)}${agent === main ? " (integrated)" : ""}`;
      add("heads", "ok", `main ${main.slice(0, 12)}  ${agentDetail}`, false);
      add("queue", "ok", queue || "empty", false);
      checks.push(loopOwnerCheck(paths.runtimeDir, describeInstalledService(config.repoId, defaultServiceEnv(opts.service))));
    } catch (e) {
      add("repo", "fail", `${opts.repoRoot}: ${errorMessage(e)}`, false);
    }
    if (lockCheck) checks.push(lockCheck);
  } else {
    add("repo", "info", "not inside a knowledge repo (pass --repo <dir> or cd into one)", false);
  }

  return { checks, ok: checks.every((c) => !c.required || c.status !== "fail") };
}

const MARK: Record<CheckStatus, string> = { ok: "[ok]  ", fail: "[FAIL]", warn: "[warn]", skip: "[skip]", info: "[--]  " };

export function formatDoctorReport(report: DoctorReport): string {
  const width = Math.max(...report.checks.map((c) => c.name.length));
  const lines = report.checks.map((c) => `${MARK[c.status]} ${c.name.padEnd(width)}  ${c.detail}`);
  lines.push(report.ok ? "all required checks passed" : "some required checks failed");
  return lines.join("\n");
}
