/**
 * The transcript format (docs/mac-app/protocol.md §9; implementation-plan
 * T1.3). One JSON value per line:
 *
 * 1. A header: `{"asserts": {"notifications": [<type>, …]}, "tmp"?, "modelScript"?}`.
 *    - `asserts.notifications`: the notification types this transcript
 *      asserts ([] asserts none). Every other type is ignored on replay.
 *    - `tmp` (harness extension): the temp root as recorded. On replay it is
 *      replaced by this run's temp root wherever it occurs, so recorded
 *      paths stay concrete. The server runs with `BRAIN_HOME=<tmp>/home` and
 *      cwd `<tmp>`.
 *    - `modelScript` (harness extension): a model script file, relative to the
 *      transcript, copied to `<tmp>/model-script.json` and passed to the
 *      server as `BRAIN_MODEL_SCRIPT` (CR-6). Without it the server has no
 *      model or key (the provider variables are removed from its env).
 * 2. Then any number of:
 *    - `{"dir": "c2s", "msg": {…}}`: a client message, sent as is (after substitution);
 *    - `{"dir": "s2c", "msg": {…}, "match"?: {…}}`: a server message, as
 *      recorded; `match` maps JSON Pointers in `msg` to matchers (match.ts);
 *    - `{"dir": "test", "step": {"op": "<name>", …}}`: an out-of-band step the
 *      Bun harness performs (steps.ts); the Swift replay skips it.
 */
import { lintMatch, type MatchSpec } from "./match";

/** Notification types matched "at least once" rather than by exact count (protocol §9). */
export const POLLING_TYPES: ReadonlySet<string> = new Set(["repo.changed", "engine.tick"]);

export interface TranscriptHeader {
  asserts: { notifications: string[] };
  tmp?: string;
  modelScript?: string;
}

export interface Step {
  op: string;
  [key: string]: unknown;
}

export interface C2sLine {
  dir: "c2s";
  msg: Record<string, unknown>;
  lineNo: number;
}

export interface S2cLine {
  dir: "s2c";
  msg: Record<string, unknown>;
  match?: MatchSpec;
  lineNo: number;
}

export interface TestLine {
  dir: "test";
  step: Step;
  lineNo: number;
}

export type TranscriptLine = C2sLine | S2cLine | TestLine;

export interface Transcript {
  source: string;
  header: TranscriptHeader;
  lines: TranscriptLine[];
}

export class TranscriptError extends Error {
  constructor(source: string, lineNo: number, message: string) {
    super(`${source}:${lineNo}: ${message}`);
    this.name = "TranscriptError";
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A server message with an `id` key (string or null) belongs to a request; one without is a notification. */
export function isRequestMessage(msg: Record<string, unknown>): boolean {
  return Object.prototype.hasOwnProperty.call(msg, "id");
}

export function isTerminal(msg: Record<string, unknown>): boolean {
  return isRequestMessage(msg) && (msg["type"] === "result" || msg["type"] === "error");
}

export function parseHeader(value: unknown, source: string, lineNo: number): TranscriptHeader {
  if (!isObject(value) || !isObject(value["asserts"])) throw new TranscriptError(source, lineNo, 'the first line must be a header {"asserts": {"notifications": [...]}}');
  const types = value["asserts"]["notifications"];
  if (!Array.isArray(types) || !types.every((t) => typeof t === "string")) throw new TranscriptError(source, lineNo, "asserts.notifications must be an array of notification types");
  const header: TranscriptHeader = { asserts: { notifications: types as string[] } };
  for (const key of ["tmp", "modelScript"] as const) {
    const v = value[key];
    if (v === undefined) continue;
    if (typeof v !== "string" || v === "") throw new TranscriptError(source, lineNo, `header.${key} must be a non-empty string`);
    header[key] = v;
  }
  return header;
}

/**
 * Parse and lint a transcript. With `clientOnly`, `s2c` lines are dropped
 * unchecked (the recorder's input).
 */
export function parseTranscript(text: string, source = "transcript", opts: { clientOnly?: boolean } = {}): Transcript {
  let header: TranscriptHeader | null = null;
  const lines: TranscriptLine[] = [];
  const raw = text.split("\n");
  for (let i = 0; i < raw.length; i++) {
    const lineNo = i + 1;
    const t = raw[i]!.trim();
    if (t === "") continue;
    let value: unknown;
    try {
      value = JSON.parse(t);
    } catch (e) {
      throw new TranscriptError(source, lineNo, `not JSON: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (header === null) {
      header = parseHeader(value, source, lineNo);
      continue;
    }
    if (!isObject(value)) throw new TranscriptError(source, lineNo, "a line must be a JSON object");
    const dir = value["dir"];
    if (dir === "c2s") {
      if (!isObject(value["msg"])) throw new TranscriptError(source, lineNo, "c2s.msg must be an object (send malformed input with a sendRaw step)");
      lines.push({ dir, msg: value["msg"], lineNo });
    } else if (dir === "s2c") {
      if (opts.clientOnly) continue;
      const msg = value["msg"];
      if (!isObject(msg) || typeof msg["type"] !== "string") throw new TranscriptError(source, lineNo, "s2c.msg must be an object with a string type");
      if (!isRequestMessage(msg) && !header.asserts.notifications.includes(msg["type"])) {
        throw new TranscriptError(source, lineNo, `notification type ${JSON.stringify(msg["type"])} is not listed in the header's asserts.notifications`);
      }
      const problem = lintMatch(msg, value["match"]);
      if (problem !== null) throw new TranscriptError(source, lineNo, problem);
      lines.push(value["match"] === undefined ? { dir, msg, lineNo } : { dir, msg, match: value["match"] as MatchSpec, lineNo });
    } else if (dir === "test") {
      const step = value["step"];
      if (!isObject(step) || typeof step["op"] !== "string") throw new TranscriptError(source, lineNo, 'test.step must be an object with a string "op"');
      lines.push({ dir, step: step as Step, lineNo });
    } else {
      throw new TranscriptError(source, lineNo, `dir must be "c2s", "s2c" or "test", got ${JSON.stringify(dir)}`);
    }
  }
  if (header === null) throw new TranscriptError(source, 1, "empty transcript (no header)");
  return { source, header, lines };
}

/** Serialize transcript lines back to JSONL (one compact object per line). */
export function formatTranscript(header: TranscriptHeader, lines: TranscriptLine[]): string {
  const out = [JSON.stringify(header)];
  for (const l of lines) {
    if (l.dir === "c2s") out.push(JSON.stringify({ dir: l.dir, msg: l.msg }));
    else if (l.dir === "s2c") out.push(JSON.stringify(l.match === undefined || Object.keys(l.match).length === 0 ? { dir: l.dir, msg: l.msg } : { dir: l.dir, msg: l.msg, match: l.match }));
    else out.push(JSON.stringify({ dir: l.dir, step: l.step }));
  }
  return out.join("\n") + "\n";
}
