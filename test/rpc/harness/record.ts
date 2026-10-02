#!/usr/bin/env bun
/**
 * Record a transcript from a live session, so a test author edits matchers
 * instead of hand-writing server messages.
 *
 *     bun test/rpc/harness/record.ts <input.jsonl> [<output.jsonl>]
 *
 * The input is a transcript without server lines (any `s2c` lines are
 * ignored): a header, then `c2s` and `test` lines, written with the recorded
 * temp root (`header.tmp`, default `/tmp/brain-transcript`) where paths go.
 * A client message or a step may reuse a value from an earlier result with a
 * string that is exactly `{{ref:<id><JSON Pointer into its result data>}}`,
 * e.g. `"sessionId": "{{ref:c1/sessionId}}"`; the recorded line holds the
 * value.
 *
 * The recorder starts a server exactly as a replay does, sends each line or
 * performs each step, then collects server messages until none has arrived
 * for `settleMs` and every request sent so far has its terminal message (or,
 * for a request held open on purpose, until nothing has arrived for
 * `PENDING_QUIET_MS`); after `shutdown`, until the server exits. It writes them
 * as `s2c` lines in arrival order, dropping notification types the header
 * does not assert, with matchers proposed by `autoMatch`. Review the matchers
 * (and add `$contains` where an exact array is too strict) before committing
 * the transcript, then replay it.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { ISO_RE, PREFIXED_ID_RE, resolvePointer, SHA_RE, Substitutions, ULID_RE, escapePointerToken, type MatchSpec } from "./match";
import type { ServerMessage } from "./process";
import { createRun } from "./replay";
import { stepHandler, type StepContext } from "./steps";
import { formatTranscript, isRequestMessage, isTerminal, parseTranscript, type Step, type TranscriptLine } from "./transcript";
import "./index";

export const DEFAULT_RECORDED_TMP = "/tmp/brain-transcript";
export const DEFAULT_SETTLE_MS = 400;
/** A request still pending after this much silence is taken to be held open on purpose. */
export const PENDING_QUIET_MS = 1500;

export interface RecordOptions {
  /** Directory the header's `modelScript` is relative to. */
  baseDir: string;
  settleMs?: number;
  /** Bound on waiting for the server to exit after `shutdown`. */
  timeoutMs?: number;
}

/**
 * Proposed matchers for one recorded message: `<ulid>`, `<sha>` and `<iso>`
 * for strings of those forms, `<id:PREFIX>` for a prefixed id such as
 * `mut_<ULID>` or `prop_<ULID>` (binding like `<ulid>`, so a later request
 * can name it), and the T1.3 staging and machine-specific
 * values as `<any>` (`initialize`'s `/data/engine` and `/data/brainVersion`,
 * `doctor.run`'s `/data/checks`), and every error's `/error/message` (codes
 * are the contract, messages are for logs). `repo.changed` domains get
 * `$contains`.
 */
export function autoMatch(msg: ServerMessage, method: string | undefined): MatchSpec {
  const match: MatchSpec = {};
  const any = new Set<string>();
  if (msg["type"] === "result" && method === "initialize") any.add("/data/engine").add("/data/brainVersion");
  if (msg["type"] === "result" && method === "doctor.run") any.add("/data/checks");
  if (msg["type"] === "result" && method === "engine.status") any.add("/data");
  // Error codes are the contract; messages are English for logs (protocol §6).
  if (msg["type"] === "error") any.add("/error/message");
  for (const p of any) if (resolvePointer(msg, p) !== undefined) match[p] = "<any>";
  if (msg["type"] === "repo.changed") {
    const domains = resolvePointer(msg, "/data/domains");
    if (Array.isArray(domains)) match["/data/domains"] = { $contains: domains };
  }
  const walk = (v: unknown, ptr: string) => {
    if (match[ptr] !== undefined) return;
    if (typeof v === "string") {
      const prefix = PREFIXED_ID_RE.exec(v)?.[1];
      if (ULID_RE.test(v)) match[ptr] = "<ulid>";
      else if (prefix !== undefined) match[ptr] = `<id:${prefix}>`;
      else if (SHA_RE.test(v)) match[ptr] = "<sha>";
      else if (ISO_RE.test(v)) match[ptr] = "<iso>";
    } else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${ptr}/${i}`));
    else if (typeof v === "object" && v !== null) for (const [k, x] of Object.entries(v)) walk(x, `${ptr}/${escapePointerToken(k)}`);
  };
  walk(msg, "");
  return match;
}

const REF_RE = /^\{\{ref:([^/}]+)(\/[^}]*)?\}\}$/;

/** Record the session described by `inputText`; resolves to the transcript text. */
export async function recordTranscript(inputText: string, opts: RecordOptions): Promise<string> {
  const settleMs = opts.settleMs ?? DEFAULT_SETTLE_MS;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const input = parseTranscript(inputText, "record input", { clientOnly: true });
  const header = { ...input.header, tmp: input.header.tmp ?? DEFAULT_RECORDED_TMP };
  const run = createRun(header, opts.baseDir);
  try {
    const { server, subs } = run;
    const received: ServerMessage[] = [];
    const bad: string[] = [];
    const methods = new Map<string, string>();
    const results = new Map<string, unknown>();
    const terminated = new Set<string>();
    let lastArrival = Date.now();
    server.onMessage((msg, raw) => {
      lastArrival = Date.now();
      if (msg === null) {
        bad.push(raw);
        return;
      }
      received.push(msg);
      if (typeof msg["id"] === "string" && isTerminal(msg)) {
        terminated.add(msg["id"]);
        if (msg["type"] === "result") results.set(msg["id"], msg["data"]);
      }
    });
    // Output is written in recorded form: actual temp paths and step aliases map back.
    const canonical = () => {
      const back = new Substitutions();
      for (const [recorded, actual] of subs.entries()) back.alias(actual, recorded);
      return back;
    };
    const out: TranscriptLine[] = [];
    let flushed = 0;
    const flush = () => {
      if (bad.length > 0) throw new Error(`stdout carried a line that is not a JSON object: ${bad[0]}`);
      const back = canonical();
      for (const msg of received.slice(flushed)) {
        if (!isRequestMessage(msg) && !header.asserts.notifications.includes(String(msg["type"]))) continue;
        const recorded = back.applyDeep(msg);
        const method = typeof msg["id"] === "string" ? methods.get(msg["id"]) : undefined;
        const match = autoMatch(recorded, method);
        out.push(Object.keys(match).length > 0 ? { dir: "s2c", msg: recorded, match, lineNo: 0 } : { dir: "s2c", msg: recorded, lineNo: 0 });
      }
      flushed = received.length;
    };
    // Settled: nothing arrived for `settleMs`, and every request sent so far has its terminal
    // message, unless nothing arrived for PENDING_QUIET_MS (a request the script holds open).
    // `received` is filled by the server's stdout reader between these awaits.
    const settle = async () => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const quiet = Date.now() - lastArrival;
        const pending = [...methods.keys()].some((id) => !terminated.has(id));
        if (server.exited || Date.now() > deadline || (quiet >= settleMs && (!pending || quiet >= PENDING_QUIET_MS))) break;
        await new Promise((r) => setTimeout(r, 25));
      }
      flush();
    };
    const refsIn = (v: unknown): string[] => {
      if (typeof v === "string") {
        const id = REF_RE.exec(v)?.[1];
        return id === undefined ? [] : [id];
      }
      if (Array.isArray(v)) return v.flatMap(refsIn);
      if (typeof v === "object" && v !== null) return Object.values(v).flatMap(refsIn);
      return [];
    };
    const resolveRefs = (v: unknown): unknown => {
      if (typeof v === "string") {
        const m = REF_RE.exec(v);
        if (m === null) return v;
        if (!results.has(m[1]!)) throw new Error(`${v}: request ${m[1]} has no result`);
        const value = resolvePointer(results.get(m[1]!), m[2] ?? "");
        if (value === undefined) throw new Error(`${v}: no value at ${m[2]} in the result of ${m[1]}`);
        return value;
      }
      if (Array.isArray(v)) return v.map(resolveRefs);
      if (typeof v === "object" && v !== null) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolveRefs(x)]));
      return v;
    };
    const ctx: StepContext = {
      tmp: run.tmp,
      home: run.home,
      server,
      subs,
      replaying: false,
      alias: (recorded, actual) => subs.alias(recorded, actual),
      terminated: (id) => terminated.has(id),
      defer: run.defer,
      state: run.state,
    };

    // A referenced result may still be on its way.
    const awaitRefs = async (v: unknown) => {
      const deadline = Date.now() + timeoutMs;
      while (refsIn(v).some((id) => !terminated.has(id)) && !server.exited && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
    };

    let sentShutdown = false;
    for (const line of input.lines) {
      lastArrival = Date.now();
      if (line.dir === "c2s") {
        await awaitRefs(line.msg);
        const msg = canonical().applyDeep(resolveRefs(line.msg) as Record<string, unknown>);
        if (typeof msg["id"] === "string" && typeof msg["method"] === "string") methods.set(msg["id"], msg["method"]);
        if (msg["method"] === "shutdown") sentShutdown = true;
        out.push({ dir: "c2s", msg, lineNo: 0 });
        server.sendRaw(JSON.stringify(subs.applyDeep(msg)));
      } else if (line.dir === "test") {
        await awaitRefs(line.step);
        const step = canonical().applyDeep(resolveRefs(line.step) as Step);
        out.push({ dir: "test", step, lineNo: 0 });
        await stepHandler(step.op)(step, ctx);
      }
      await settle();
    }
    if (sentShutdown) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`the server did not exit within ${timeoutMs} ms of shutdown`)), timeoutMs);
      });
      const code = await Promise.race([server.finished, timeout]).finally(() => clearTimeout(timer));
      flush();
      if (code !== 0) throw new Error(`the server exited with code ${code} after shutdown; stderr:\n${server.stderrTail()}`);
    } else {
      await settle();
    }
    return formatTranscript(header, out);
  } finally {
    await run.dispose();
  }
}

if (import.meta.main) {
  const [inputPath, outputPath] = process.argv.slice(2);
  if (inputPath === undefined) {
    process.stderr.write("usage: bun test/rpc/harness/record.ts <input.jsonl> [<output.jsonl>]\n");
    process.exit(2);
  }
  const text = await recordTranscript(readFileSync(inputPath, "utf8"), { baseDir: dirname(resolve(inputPath)) });
  if (outputPath === undefined) process.stdout.write(text);
  else writeFileSync(outputPath, text);
}
