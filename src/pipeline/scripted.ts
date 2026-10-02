/**
 * Scripted model provider for deterministic knowledge runs (CR-6, test only).
 *
 * `BRAIN_MODEL_SCRIPT=<file>` makes `brain chat` (and later `brain rpc`)
 * answer every model call from a JSON script instead of a real model. It is
 * built on `MockModelProvider` via `StreamingMockModelProvider`, so chat
 * replies stream in ~5-word chunks exactly like `BRAIN_MODEL_MOCK=1`, but
 * extractor and planner calls return scripted output, so knowledge runs
 * produce real mutations and proposals. Each process reads its own script
 * file; a cross-process test gives each writer its own call sequence.
 *
 * Precedence: when both `BRAIN_MODEL_SCRIPT` and `BRAIN_MODEL_MOCK` are set,
 * the script wins (it is the more specific request).
 *
 * ## Script format
 *
 * ```jsonc
 * {
 *   "version": 1,                 // optional; only 1 is accepted
 *   "callLog": "calls.jsonl",     // optional; see "Call log"
 *   "chunkDelayMs": 10,           // optional; delay between streamed chat chunks
 *   "chat":      [ <entry>, … ],  // chat replies, in call order
 *   "extractor": [ <entry>, … ],  // extractor calls, in call order
 *   "planner":   [ <entry>, … ]   // planner calls, in call order
 * }
 *
 * <entry> = {
 *   "response": "text" | <any JSON value>,  // a string is returned verbatim; any other
 *                                           // value is returned as JSON.stringify(value)
 *   "fail": { "message": "…", "retryable": true, "status": 503 },  // instead of "response":
 *                                           // throw ModelProviderError (status optional)
 *   "hold": "<release file>",               // optional: wait until this file exists
 *   "repeat": true | "<release file>"       // optional: see "Consumption"
 * }
 * ```
 *
 * Example: a reply held until a harness releases it, then one grounded
 * candidate, then a plan that creates a note and proposes an archive.
 *
 * ```json
 * {
 *   "chat": [{ "response": "Cheap undo moves approval to review.", "hold": "release-reply" }],
 *   "extractor": [{ "response": { "candidates": [{ "kind": "idea",
 *     "claim": "Reversible actions let an agent act with less pre-approval",
 *     "groundedSources": ["{{lastUser}}"], "inferences": [] }] } }],
 *   "planner": [{ "response": { "operations": [
 *     { "op": "CREATE", "path": "knowledge/undo-replaces-approval.md",
 *       "content": "---\nid: NEW\ncreated: 2026-10-02\ntype: idea\nstatus: active\n---\n# Undo replaces approval\n\n## Claim\nCheap undo lets an agent act first.\nGrounded-in: {{lastUser}}\n" },
 *     { "op": "ARCHIVE", "noteIds": ["01K…"], "writes": [{ "path": "knowledge/x.md", "content": "…" }] } ] } }]
 * }
 * ```
 *
 * Roles are told apart by system prompt, as `createMockModelProvider` does:
 * the extractor and planner prompts match exactly, the chat prompt by prefix
 * (retrieved context is appended to it). Any other system prompt is an error.
 *
 * ## One call
 *
 * 1. The role's next entry is selected (see "Consumption").
 * 2. One line is appended to the call log, before anything else happens, so
 *    a harness can see that a call arrived even while it is held.
 * 3. Placeholders in a `response` are resolved (see "Placeholders").
 * 4. `hold`: the call waits, polling asynchronously, until the release file
 *    exists. A held chat reply is a pending stream with no deltas. One file
 *    releases every hold that names it, now and later; use distinct names for
 *    holds that must be released one at a time. The file is never deleted.
 * 5. `fail` throws `ModelProviderError(message, {retryable, status})`;
 *    otherwise the response is returned (streamed in chunks for a chat reply).
 *
 * ## Consumption
 *
 * Each role has its own cursor. An entry without `repeat` answers exactly one
 * call. `"repeat": true` answers every later call of its role, so it must be
 * the role's last entry. `"repeat": "<file>"` answers every call until that
 * file exists; the first call after that skips it and takes the next entry.
 * When a role's entries run out, the call throws a plain `Error` (not
 * retryable: the run completes with an error instead of being deferred), so a
 * script that is too short fails loudly. That call is still logged, with
 * `"entry": null`.
 *
 * ## Placeholders
 *
 * Strings inside a `response` (every string leaf of a JSON value, or the whole
 * string response) may contain:
 * - `{{session}}`: the session id of the conversation turns in the call's
 *   input (the extractor transcript, or the planner's cited turns);
 * - `{{lastUser}}`: `conversation://<session>/<turn>` of the last user turn
 *   in the call's input.
 * A chat call has no turn ids, so these fail there. Any other `{{name}}` is an
 * error, so a typo is not silently written into a note.
 *
 * ## Paths
 *
 * `hold`, `repeat` and `callLog` are resolved against the script file's
 * directory. `BRAIN_MODEL_SCRIPT` and `BRAIN_MODEL_SCRIPT_LOG` are resolved
 * against the working directory.
 *
 * ## Call log
 *
 * JSONL, appended to `$BRAIN_MODEL_SCRIPT_LOG` if set, else to the script's
 * `callLog`, else to `<script dir>/<script name>.calls.jsonl`. One line per
 * call: `{seq, pid, at, role, entry, hold?, fail?, system, messages,
 * maxTokens?}`. `seq` counts calls in this process from 1; `role` is `chat`,
 * `extractor`, `planner` or `unknown`; `entry` is the index of the entry that
 * answered within its role, or `null` when the role ran out; `hold` is the
 * absolute release path; `fail` is true for a failing entry.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import type { ModelCompleteInput } from "../core/types";
import { EXTRACTOR_SYSTEM_PROMPT } from "../extract/prompts";
import { ModelProviderError } from "../model/claude";
import { PLANNER_SYSTEM_PROMPT } from "../plan/prompts";
import { CHAT_SYSTEM_PROMPT } from "./chat";
import { MOCK_STREAM_DELAY_MS, StreamingMockModelProvider } from "./mock";

export const MODEL_SCRIPT_ENV = "BRAIN_MODEL_SCRIPT";
export const MODEL_SCRIPT_LOG_ENV = "BRAIN_MODEL_SCRIPT_LOG";
export const DEFAULT_HOLD_POLL_MS = 20;

export type ScriptRole = "chat" | "extractor" | "planner";
export const SCRIPT_ROLES: readonly ScriptRole[] = ["chat", "extractor", "planner"];

export interface ScriptFailure {
  message: string;
  retryable: boolean;
  status?: number;
}

export interface ModelScriptEntry {
  /** A string is returned verbatim; any other JSON value is stringified. */
  response?: unknown;
  fail?: ScriptFailure;
  /** Release file: the call waits until it exists. */
  hold?: string;
  /** `true`: answer every later call. A string: answer every call until that file exists. */
  repeat?: true | string;
}

export interface ModelScript {
  version?: 1;
  callLog?: string;
  chunkDelayMs?: number;
  chat?: ModelScriptEntry[];
  extractor?: ModelScriptEntry[];
  planner?: ModelScriptEntry[];
}

/** One line of the call log. */
export interface ScriptCallLogLine {
  seq: number;
  pid: number;
  at: string;
  role: ScriptRole | "unknown";
  entry: number | null;
  hold?: string;
  fail?: true;
  system: string;
  messages: ModelCompleteInput["messages"];
  maxTokens?: number;
}

// ---------------------------------------------------------------------------
// Parsing and validation
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const TOP_KEYS = new Set(["version", "callLog", "chunkDelayMs", ...SCRIPT_ROLES]);
const ENTRY_KEYS = new Set(["response", "fail", "hold", "repeat"]);
const FAIL_KEYS = new Set(["message", "retryable", "status"]);

function nonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim() !== "";
}

/** Validate a parsed script. Throws an `Error` naming the first problem. */
export function parseModelScript(raw: unknown, source = "model script"): ModelScript {
  const bad = (msg: string): never => {
    throw new Error(`${source}: ${msg}`);
  };
  if (!isRecord(raw)) bad("must be a JSON object");
  const obj = raw as Record<string, unknown>;
  for (const k of Object.keys(obj)) if (!TOP_KEYS.has(k)) bad(`unknown key ${JSON.stringify(k)} (allowed: ${[...TOP_KEYS].join(", ")})`);
  if (obj.version !== undefined && obj.version !== 1) bad(`unsupported version ${JSON.stringify(obj.version)}`);
  if (obj.callLog !== undefined && !nonEmptyString(obj.callLog)) bad('"callLog" must be a non-empty string');
  if (obj.chunkDelayMs !== undefined && !(typeof obj.chunkDelayMs === "number" && Number.isFinite(obj.chunkDelayMs) && obj.chunkDelayMs >= 0)) {
    bad('"chunkDelayMs" must be a number ≥ 0');
  }
  const script: ModelScript = {};
  if (obj.version === 1) script.version = 1;
  if (obj.callLog !== undefined) script.callLog = obj.callLog as string;
  if (obj.chunkDelayMs !== undefined) script.chunkDelayMs = obj.chunkDelayMs as number;

  for (const role of SCRIPT_ROLES) {
    const list = obj[role];
    if (list === undefined) continue;
    if (!Array.isArray(list)) bad(`"${role}" must be an array of entries`);
    const entries: ModelScriptEntry[] = [];
    (list as unknown[]).forEach((e, i) => {
      const where = `${role}[${i}]`;
      if (!isRecord(e)) bad(`${where} must be an object`);
      const rec = e as Record<string, unknown>;
      for (const k of Object.keys(rec)) if (!ENTRY_KEYS.has(k)) bad(`${where}: unknown key ${JSON.stringify(k)} (allowed: ${[...ENTRY_KEYS].join(", ")})`);
      const hasResponse = "response" in rec;
      const hasFail = "fail" in rec;
      if (hasResponse === hasFail) bad(`${where}: exactly one of "response" and "fail" is required`);
      const entry: ModelScriptEntry = {};
      if (hasResponse) {
        if (rec.response === undefined || rec.response === null) bad(`${where}: "response" must not be null`);
        entry.response = rec.response;
      } else {
        const f = rec.fail;
        if (!isRecord(f)) bad(`${where}: "fail" must be an object`);
        const fr = f as Record<string, unknown>;
        for (const k of Object.keys(fr)) if (!FAIL_KEYS.has(k)) bad(`${where}.fail: unknown key ${JSON.stringify(k)}`);
        if (typeof fr.message !== "string") bad(`${where}.fail.message must be a string`);
        if (typeof fr.retryable !== "boolean") bad(`${where}.fail.retryable must be a boolean`);
        if (fr.status !== undefined && !(typeof fr.status === "number" && Number.isInteger(fr.status))) bad(`${where}.fail.status must be an integer`);
        const failure: ScriptFailure = { message: fr.message as string, retryable: fr.retryable as boolean };
        if (fr.status !== undefined) failure.status = fr.status as number;
        entry.fail = failure;
      }
      if (rec.hold !== undefined) {
        if (!nonEmptyString(rec.hold)) bad(`${where}: "hold" must be a non-empty string (a release file path)`);
        entry.hold = rec.hold as string;
      }
      if (rec.repeat !== undefined) {
        if (rec.repeat === true) {
          if (i !== (list as unknown[]).length - 1) bad(`${where}: "repeat": true answers every later call, so it must be the last ${role} entry`);
          entry.repeat = true;
        } else if (nonEmptyString(rec.repeat)) {
          entry.repeat = rec.repeat;
        } else {
          bad(`${where}: "repeat" must be true or a release file path`);
        }
      }
      entries.push(entry);
    });
    script[role] = entries;
  }
  return script;
}

/** Read and validate a script file. */
export function loadModelScript(path: string): ModelScript {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    throw new Error(`model script ${path}: cannot read: ${e instanceof Error ? e.message : String(e)}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`model script ${path}: invalid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  return parseModelScript(raw, `model script ${path}`);
}

// ---------------------------------------------------------------------------
// Dispatch and placeholders
// ---------------------------------------------------------------------------

/** The role of a model call, by system prompt; null for an unknown prompt. */
export function scriptRoleOf(system: string): ScriptRole | null {
  if (system === EXTRACTOR_SYSTEM_PROMPT) return "extractor";
  if (system === PLANNER_SYSTEM_PROMPT) return "planner";
  if (system.startsWith(CHAT_SYSTEM_PROMPT)) return "chat";
  return null;
}

interface TurnRef {
  sessionId: string;
  turnId: string;
  role: "user" | "assistant";
}

/** `N. [conversation://<s>/<t>] <role>:` lines of `buildExtractorUserMessage`. */
const EXTRACTOR_TURN_RE = /^\d+\. \[conversation:\/\/([^/\s\]]+)\/([^\s\]]+)\] (user|assistant):/gm;
/** `- [<role>] conversation://<s>/<t>: ` lines of `buildPlannerUserMessage` (cited turns). */
const PLANNER_TURN_RE = /^- \[(user|assistant)\] conversation:\/\/([^/\s]+)\/([^\s:]+): /gm;

function between(text: string, start: string, end: string | null): string {
  const i = text.indexOf(start);
  if (i < 0) return "";
  const from = i + start.length;
  const j = end === null ? -1 : text.indexOf(end, from);
  return j < 0 ? text.slice(from) : text.slice(from, j);
}

/** Conversation turns named in a call's input, in order. */
export function turnsInCall(role: ScriptRole, input: ModelCompleteInput): TurnRef[] {
  const content = input.messages.map((m) => m.content).join("\n");
  const out: TurnRef[] = [];
  if (role === "extractor") {
    for (const m of between(content, "## Transcript\n", null).matchAll(EXTRACTOR_TURN_RE)) {
      out.push({ sessionId: m[1]!, turnId: m[2]!, role: m[3] as TurnRef["role"] });
    }
  } else if (role === "planner") {
    for (const m of between(content, "# Transcript (cited turns)", "\n# Retrieved notes").matchAll(PLANNER_TURN_RE)) {
      out.push({ sessionId: m[2]!, turnId: m[3]!, role: m[1] as TurnRef["role"] });
    }
  }
  return out;
}

const PLACEHOLDER_RE = /\{\{\s*([A-Za-z][A-Za-z0-9_-]*)\s*\}\}/g;

function placeholderResolver(role: ScriptRole, input: ModelCompleteInput): (s: string) => string {
  let turns: TurnRef[] | null = null;
  const lookup = (name: string): string => {
    turns ??= turnsInCall(role, input);
    if (name === "session") {
      const t = turns[0];
      if (!t) throw new Error(`model script: {{session}} cannot be resolved for a ${role} call (its input names no conversation turn)`);
      return t.sessionId;
    }
    if (name === "lastUser") {
      const t = [...turns].reverse().find((x) => x.role === "user");
      if (!t) throw new Error(`model script: {{lastUser}} cannot be resolved for a ${role} call (its input names no user turn)`);
      return `conversation://${t.sessionId}/${t.turnId}`;
    }
    throw new Error(`model script: unknown placeholder {{${name}}} (known: {{session}}, {{lastUser}})`);
  };
  return (s) => s.replace(PLACEHOLDER_RE, (_, name: string) => lookup(name));
}

function mapStrings(v: unknown, f: (s: string) => string): unknown {
  if (typeof v === "string") return f(v);
  if (Array.isArray(v)) return v.map((x) => mapStrings(x, f));
  if (isRecord(v)) {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = mapStrings(x, f);
    return out;
  }
  return v;
}

/** The text a `response` entry returns for one call. */
export function renderResponse(response: unknown, role: ScriptRole, input: ModelCompleteInput): string {
  const sub = placeholderResolver(role, input);
  return typeof response === "string" ? sub(response) : JSON.stringify(mapStrings(response, sub));
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export interface ModelScriptProviderOptions {
  /** Directory that relative `hold`, `repeat` and `callLog` paths resolve against. Default: cwd. */
  baseDir?: string;
  /** Call log path; overrides the script's `callLog`. Relative paths resolve against the cwd. Null disables logging. */
  callLog?: string | null;
  /** Poll interval while a call is held. Default 20 ms. */
  pollMs?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

class ScriptRunner {
  private readonly cursor: Record<ScriptRole, number> = { chat: 0, extractor: 0, planner: 0 };
  private seq = 0;
  private logDirReady = false;

  constructor(
    readonly script: ModelScript,
    readonly baseDir: string,
    readonly callLogPath: string | null,
    readonly pollMs: number,
  ) {}

  path(p: string): string {
    return resolve(this.baseDir, p);
  }

  /** Select the role's next entry, honoring `repeat`; null when the role ran out. */
  private next(role: ScriptRole): { entry: ModelScriptEntry; index: number } | null {
    const entries = this.script[role] ?? [];
    while (this.cursor[role] < entries.length) {
      const index = this.cursor[role];
      const entry = entries[index]!;
      if (typeof entry.repeat === "string" && existsSync(this.path(entry.repeat))) {
        this.cursor[role] += 1; // released: skip it for good
        continue;
      }
      if (entry.repeat === undefined) this.cursor[role] += 1;
      return { entry, index };
    }
    return null;
  }

  private log(line: ScriptCallLogLine): void {
    if (this.callLogPath === null) return;
    if (!this.logDirReady) {
      mkdirSync(dirname(this.callLogPath), { recursive: true });
      this.logDirReady = true;
    }
    appendFileSync(this.callLogPath, JSON.stringify(line) + "\n");
  }

  async answer(input: ModelCompleteInput): Promise<string> {
    this.seq += 1;
    const role = scriptRoleOf(input.system);
    const picked = role === null ? null : this.next(role);
    const line: ScriptCallLogLine = {
      seq: this.seq,
      pid: process.pid,
      at: new Date().toISOString(),
      role: role ?? "unknown",
      entry: picked?.index ?? null,
      system: input.system,
      messages: input.messages,
    };
    const hold = picked?.entry.hold !== undefined ? this.path(picked.entry.hold) : undefined;
    if (hold !== undefined) line.hold = hold;
    if (picked?.entry.fail) line.fail = true;
    if (input.maxTokens !== undefined) line.maxTokens = input.maxTokens;
    this.log(line);

    if (role === null) throw new Error(`model script: unknown system prompt (call #${this.seq}): ${JSON.stringify(input.system.slice(0, 80))}`);
    if (picked === null) throw new Error(`model script: no ${role} entry left (call #${this.seq}, ${role} entries: ${(this.script[role] ?? []).length})`);

    const { entry } = picked;
    const text = entry.fail ? null : renderResponse(entry.response, role, input);
    if (hold !== undefined) while (!existsSync(hold)) await sleep(this.pollMs);
    if (entry.fail) {
      const f = entry.fail;
      throw new ModelProviderError(f.message, f.status !== undefined ? { retryable: f.retryable, status: f.status } : { retryable: f.retryable });
    }
    return text!;
  }
}

/**
 * `StreamingMockModelProvider` whose responder plays a `ModelScript`.
 * `complete` answers extractor/planner calls; `stream` (chat) goes through
 * `complete`, so a held reply streams nothing until it is released.
 */
export class ModelScriptProvider extends StreamingMockModelProvider {
  private readonly runner: ScriptRunner;

  constructor(script: ModelScript, opts: ModelScriptProviderOptions = {}) {
    const baseDir = resolve(opts.baseDir ?? process.cwd());
    const logOpt = opts.callLog !== undefined ? opts.callLog : script.callLog !== undefined ? resolve(baseDir, script.callLog) : null;
    const runner = new ScriptRunner(script, baseDir, logOpt === null ? null : resolve(logOpt), opts.pollMs ?? DEFAULT_HOLD_POLL_MS);
    super((input) => runner.answer(input), script.chunkDelayMs ?? MOCK_STREAM_DELAY_MS);
    this.runner = runner;
  }

  get script(): ModelScript {
    return this.runner.script;
  }

  /** Absolute call log path, or null when logging is off. */
  get callLogPath(): string | null {
    return this.runner.callLogPath;
  }
}

/** The script path requested by the environment, or null. */
export function modelScriptPath(env: NodeJS.ProcessEnv = process.env): string | null {
  const v = (env[MODEL_SCRIPT_ENV] ?? "").trim();
  return v === "" ? null : resolve(v);
}

/** Default call log next to the script: `<dir>/<name without .json>.calls.jsonl`. */
export function defaultCallLogPath(scriptPath: string): string {
  const ext = extname(scriptPath);
  const name = basename(scriptPath, ext === ".json" ? ext : "");
  return join(dirname(scriptPath), `${name}.calls.jsonl`);
}

/**
 * Load `scriptPath` and build its provider. The call log goes to
 * `$BRAIN_MODEL_SCRIPT_LOG`, else the script's `callLog`, else
 * `defaultCallLogPath(scriptPath)`.
 */
export function createModelScriptProvider(scriptPath: string, env: NodeJS.ProcessEnv = process.env): ModelScriptProvider {
  const abs = resolve(scriptPath);
  const script = loadModelScript(abs);
  const baseDir = dirname(abs);
  const envLog = (env[MODEL_SCRIPT_LOG_ENV] ?? "").trim();
  const callLog = envLog !== "" ? resolve(envLog) : script.callLog !== undefined ? resolve(baseDir, script.callLog) : defaultCallLogPath(abs);
  return new ModelScriptProvider(script, { baseDir, callLog });
}
