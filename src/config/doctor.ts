/**
 * `brain doctor`: environment and configuration checklist.
 *
 * `runDoctor` is a pure-ish function over an injected environment, `fetch`
 * and Anthropic model lookup so unit tests never touch the network. The CLI
 * formats the returned checks; the exit code is 0 iff every *required*
 * check passed. Live checks (OpenRouter `/models`, `/embeddings`; Anthropic
 * `models.retrieve`) are skipped with `offline`.
 */
import Anthropic from "@anthropic-ai/sdk";
import { accessSync, constants, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { defaultServiceEnv, describeInstalledService, type ServiceEnv } from "../cli/service";
import { repoPaths, resolveBrainHome } from "../core/brainHome";
import { openCoordinator } from "../core/coordinator";
import { loadConfig } from "../markdown/repo";
import { DEFAULT_MODEL } from "../model/claude";
import { resolveProviderKind, type ProviderKind } from "../model/index";
import {
  DEFAULT_OPENROUTER_EMBEDDING_DIMS,
  DEFAULT_OPENROUTER_EMBEDDING_MODEL,
  DEFAULT_OPENROUTER_MODEL,
  OPENROUTER_BASE_URL,
  type FetchLike,
} from "../model/openrouter";
import { isLockHeld, readLockHolder, WORKTREE_LOCK } from "../sync/lock";
import { maskKey, userConfigPath } from "./userConfig";

export const MIN_GIT_VERSION: readonly [number, number] = [2, 40];
/** Written by `brain watch` under `<runtimeDir>/`; read here to tell whether a daemon is running. */
export const WATCH_PID_FILE = "watch.pid";
/** A live holder of the worktree lock for longer than this is reported (design §5.2: the lock has no deadline). */
export const LONG_HELD_LOCK_MS = 10 * 60_000;

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
  /** Knowledge repo root (already resolved by the caller), or null when not inside one. */
  repoRoot?: string | null;
  offline?: boolean;
  /** Injected for tests; default global fetch. */
  fetch?: FetchLike;
  /** Injected for tests; default `new Anthropic(...).models.retrieve(model)`. Must throw on auth / not-found. */
  retrieveModel?: (model: string, env: NodeJS.ProcessEnv) => Promise<void>;
  /** Injected for tests; default runs `git --version`. */
  gitVersion?: () => string | null;
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

async function defaultRetrieveModel(model: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<void> {
  const client = new Anthropic({
    apiKey: envOr(env, "ANTHROPIC_API_KEY") || undefined,
    authToken: envOr(env, "ANTHROPIC_AUTH_TOKEN") || undefined,
    baseURL: envOr(env, "ANTHROPIC_BASE_URL") || undefined,
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
  if (!parsed) add("git", "fail", "git not found on PATH (need ≥ 2.40)");
  else {
    const [maj, min] = parsed;
    const okVersion = maj > MIN_GIT_VERSION[0] || (maj === MIN_GIT_VERSION[0] && min >= MIN_GIT_VERSION[1]);
    add("git", okVersion ? "ok" : "fail", okVersion ? gv! : `${gv} is older than ${MIN_GIT_VERSION.join(".")}`);
  }

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
      await (opts.retrieveModel ?? ((m, e) => defaultRetrieveModel(m, e, timeoutMs)))(model, env);
      add("anthropic model", "ok", `${model} is available`);
    } catch (e) {
      add("anthropic model", "fail", `${model}: ${describeAnthropicError(e)}`);
    }
  } else {
    add("live check", "skip", "skipped (no credentials)", false);
  }

  // --- knowledge repo (optional) -----------------------------------------------
  if (opts.repoRoot) {
    // Probed before opening the coordinator, which may itself wait for this lock.
    let lockCheck: DoctorCheck | null = null;
    try {
      lockCheck = worktreeLockCheck(repoPaths(opts.repoRoot, loadConfig(opts.repoRoot).repoId).runtimeDir);
    } catch {
      // not a loadable repo: the coordinator open below reports it
    }
    try {
      const coord = await openCoordinator(opts.repoRoot);
      try {
        const [main, agent, rows] = await Promise.all([coord.mainHead(), coord.agentHead(), coord.listMutations()]);
        const counts: Record<string, number> = {};
        for (const r of rows) counts[r.state] = (counts[r.state] ?? 0) + 1;
        const queue = Object.entries(counts)
          .map(([s, n]) => `${s}=${n}`)
          .join(" ");
        add("repo", "ok", `${opts.repoRoot} (repo_id ${coord.config.repoId})`, false);
        add("heads", "ok", `main ${main.slice(0, 12)}  agent ${agent.slice(0, 12)}${agent === main ? " (integrated)" : ""}`, false);
        add("queue", "ok", queue || "empty", false);
        const pidFile = join(coord.paths.runtimeDir, WATCH_PID_FILE);
        const service = describeInstalledService(coord.config.repoId, defaultServiceEnv(opts.service));
        if (!existsSync(pidFile)) add("watch", "info", `unknown (no ${pidFile}); ${service}`, false);
        else {
          const pid = Number(readFileSync(pidFile, "utf8").trim());
          if (Number.isInteger(pid) && pid > 0 && pidAlive(pid)) add("watch", "ok", `running (pid ${pid}); ${service}`, false);
          else add("watch", "warn", `not running (stale ${pidFile}); ${service}`, false);
        }
      } finally {
        await coord.close();
      }
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
