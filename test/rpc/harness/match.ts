/**
 * Matching one recorded server message against an actual one
 * (docs/mac-app/protocol.md §9, implementation-plan T1.3).
 *
 * - **Subset**: every field of an expected object must be present and match;
 *   extra fields in the actual object are ignored. This holds at every depth,
 *   including objects inside arrays.
 * - **Arrays** match exactly: same length, element by element (each element
 *   by these same rules), unless a `$contains` matcher applies.
 * - **Scalars** match exactly (`===`), after substitution (below).
 * - **Matchers** live in the line's sibling `match` field, keyed by a JSON
 *   Pointer into `msg` (RFC 6901; "" is the whole message). They replace the
 *   comparison at that pointer:
 *   - `"<ulid>"`, `"<sha>"`, `"<iso>"`: the actual value is a string of that form;
 *   - `"<any>"`: any value at all, including an object or an array;
 *   - `{"$contains": [x, …]}`: the actual value is an array, and each listed
 *     element matches a distinct actual element (by the rules above, without
 *     matchers); other elements may be present.
 *
 * ## Substitution
 *
 * A transcript is recorded concretely, so values that differ from run to run
 * (temp paths, ids, commit shas, a stub server's URL) are replayed through a
 * substitution map from recorded to actual strings:
 * - the transcript header's `tmp` maps to this run's temp root;
 * - a step may add aliases (`StepContext.alias`);
 * - a `<ulid>` or `<sha>` matcher **binds** the recorded value to the actual
 *   one the first time it matches. Later, the same recorded value must meet
 *   the same actual value (at a `<ulid>`/`<sha>` pointer), and two recorded
 *   values must not meet one actual value: relationships between ids and
 *   shas in the recording hold in the replay. `<iso>` never binds.
 * Every string in an expected message and in a client message is rewritten
 * through the map (substring replacement, longest first) before it is
 * compared or sent.
 */

export type FormMatcher = "<ulid>" | "<sha>" | "<iso>" | "<any>";
export type Matcher = FormMatcher | { $contains: unknown[] };
export type MatchSpec = Record<string, Matcher>;

export const ULID_RE = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
export const SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
export const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

const FORMS: Record<Exclude<FormMatcher, "<any>">, RegExp> = { "<ulid>": ULID_RE, "<sha>": SHA_RE, "<iso>": ISO_RE };

export function isMatcher(v: unknown): v is Matcher {
  if (v === "<ulid>" || v === "<sha>" || v === "<iso>" || v === "<any>") return true;
  return typeof v === "object" && v !== null && !Array.isArray(v) && Object.keys(v).length === 1 && Array.isArray((v as { $contains?: unknown }).$contains);
}

/** RFC 6901 reference token. */
export function escapePointerToken(token: string): string {
  return token.replace(/~/g, "~0").replace(/\//g, "~1");
}

export function unescapePointerToken(token: string): string {
  return token.replace(/~1/g, "/").replace(/~0/g, "~");
}

/** The value at `pointer` in `doc`, or `undefined` when there is none. */
export function resolvePointer(doc: unknown, pointer: string): unknown {
  if (pointer === "") return doc;
  if (!pointer.startsWith("/")) return undefined;
  let cur: unknown = doc;
  for (const raw of pointer.slice(1).split("/")) {
    const token = unescapePointerToken(raw);
    if (Array.isArray(cur)) {
      if (!/^(0|[1-9]\d*)$/.test(token)) return undefined;
      cur = cur[Number(token)];
    } else if (typeof cur === "object" && cur !== null && Object.prototype.hasOwnProperty.call(cur, token)) {
      cur = (cur as Record<string, unknown>)[token];
    } else {
      return undefined;
    }
    if (cur === undefined) return undefined;
  }
  return cur;
}

/** Recorded → actual string substitutions, shared by one replay. */
export class Substitutions {
  private readonly map = new Map<string, string>();
  /** Actual value → the recorded value bound to it (by a matcher or an alias). */
  private readonly reverse = new Map<string, string>();
  private ordered: [string, string][] = [];

  /** Add `recorded → actual`. Throws when `recorded` is already mapped to something else. */
  alias(recorded: string, actual: string): void {
    const prev = this.map.get(recorded);
    if (prev !== undefined) {
      if (prev !== actual) throw new Error(`${JSON.stringify(recorded)} is already mapped to ${JSON.stringify(prev)}, not ${JSON.stringify(actual)}`);
      return;
    }
    this.map.set(recorded, actual);
    this.reverse.set(actual, recorded);
    this.ordered = [...this.map].filter(([r, a]) => r !== a).sort((x, y) => y[0].length - x[0].length);
  }

  get(recorded: string): string | undefined {
    return this.map.get(recorded);
  }

  recordedFor(actual: string): string | undefined {
    return this.reverse.get(actual);
  }

  /** Rewrite every mapped recorded value inside `s`. */
  apply(s: string): string {
    let out = s;
    for (const [recorded, actual] of this.ordered) if (out.includes(recorded)) out = out.split(recorded).join(actual);
    return out;
  }

  /** `apply` on every string (keys untouched) of a JSON value. */
  applyDeep<T>(v: T): T {
    if (typeof v === "string") return this.apply(v) as T;
    if (Array.isArray(v)) return v.map((x) => this.applyDeep(x)) as T;
    if (typeof v === "object" && v !== null) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, this.applyDeep(x)])) as T;
    return v;
  }

  entries(): [string, string][] {
    return [...this.map];
  }
}

export interface MatchFailure {
  pointer: string;
  reason: string;
}

function show(v: unknown): string {
  const s = JSON.stringify(v);
  return s === undefined ? String(v) : s.length > 200 ? `${s.slice(0, 200)}…` : s;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

class Walk {
  /** Bindings made during this match; committed only when the whole message matches. */
  readonly pending = new Map<string, string>();
  constructor(
    readonly match: MatchSpec,
    readonly subs: Substitutions,
  ) {}

  /** `subs.apply`, plus the bindings made so far in this message. */
  private substitute(s: string): string {
    let out = this.subs.apply(s);
    for (const [recorded, actual] of [...this.pending].sort((x, y) => y[0].length - x[0].length)) if (out.includes(recorded)) out = out.split(recorded).join(actual);
    return out;
  }

  /** Pass 1: every matcher, so the bindings it makes apply to the whole message whatever the key order. */
  matchers(expected: unknown, actual: unknown): MatchFailure | null {
    for (const [ptr, m] of Object.entries(this.match)) {
      const got = resolvePointer(actual, ptr);
      if (got === undefined) return { pointer: ptr, reason: `missing (expected ${typeof m === "string" ? m : show(m)})` };
      const f = this.matcher(m, resolvePointer(expected, ptr), got, ptr);
      if (f) return f;
    }
    return null;
  }

  /** Pass 2: the structural comparison; pointers with a matcher were settled in pass 1. */
  run(expected: unknown, actual: unknown, ptr: string): MatchFailure | null {
    if (this.match[ptr] !== undefined) return null;
    if (typeof expected === "string") {
      const want = this.substitute(expected);
      return want === actual ? null : { pointer: ptr, reason: `expected ${show(want)}, got ${show(actual)}` };
    }
    if (expected === null || typeof expected !== "object") {
      return expected === actual ? null : { pointer: ptr, reason: `expected ${show(expected)}, got ${show(actual)}` };
    }
    if (Array.isArray(expected)) {
      if (!Array.isArray(actual)) return { pointer: ptr, reason: `expected an array, got ${show(actual)}` };
      if (actual.length !== expected.length) return { pointer: ptr, reason: `expected ${expected.length} elements, got ${actual.length}: ${show(actual)}` };
      for (let i = 0; i < expected.length; i++) {
        const f = this.run(expected[i], actual[i], `${ptr}/${i}`);
        if (f) return f;
      }
      return null;
    }
    if (!isObject(actual)) return { pointer: ptr, reason: `expected an object, got ${show(actual)}` };
    for (const [key, value] of Object.entries(expected)) {
      const child = `${ptr}/${escapePointerToken(key)}`;
      if (!Object.prototype.hasOwnProperty.call(actual, key)) return { pointer: child, reason: `missing (expected ${show(this.subs.applyDeep(value))})` };
      const f = this.run(value, actual[key], child);
      if (f) return f;
    }
    return null;
  }

  private matcher(m: Matcher, expected: unknown, actual: unknown, ptr: string): MatchFailure | null {
    if (m === "<any>") return null;
    if (typeof m === "object") return this.contains(m.$contains, actual, ptr);
    if (typeof actual !== "string" || !FORMS[m].test(actual)) return { pointer: ptr, reason: `expected ${m}, got ${show(actual)}` };
    if (m === "<iso>" || typeof expected !== "string") return null;
    return this.bind(expected, actual, ptr);
  }

  private bind(recorded: string, actual: string, ptr: string): MatchFailure | null {
    const bound = this.pending.get(recorded) ?? this.subs.get(recorded);
    if (bound !== undefined) return bound === actual ? null : { pointer: ptr, reason: `${show(recorded)} was bound to ${show(bound)} earlier, got ${show(actual)}` };
    const other = this.subs.recordedFor(actual) ?? [...this.pending].find(([, a]) => a === actual)?.[0];
    if (other !== undefined && other !== recorded) return { pointer: ptr, reason: `${show(actual)} is already bound to recorded ${show(other)}, not ${show(recorded)}` };
    this.pending.set(recorded, actual);
    return null;
  }

  /** Each listed element matches a distinct actual element (backtracking; lists are short). */
  private contains(listed: unknown[], actual: unknown, ptr: string): MatchFailure | null {
    if (!Array.isArray(actual)) return { pointer: ptr, reason: `expected an array containing ${show(listed)}, got ${show(actual)}` };
    const plain = new Walk({}, this.subs);
    for (const [recorded, value] of this.pending) plain.pending.set(recorded, value);
    const fits = listed.map((want) => actual.map((got) => plain.run(want, got, ptr) === null));
    const used = new Array<boolean>(actual.length).fill(false);
    const assign = (i: number): boolean => {
      if (i === listed.length) return true;
      for (let j = 0; j < actual.length; j++) {
        if (used[j] || !fits[i]![j]) continue;
        used[j] = true;
        if (assign(i + 1)) return true;
        used[j] = false;
      }
      return false;
    };
    if (assign(0)) return null;
    const missing = listed.filter((_, i) => !fits[i]!.some(Boolean));
    return { pointer: ptr, reason: `expected an array containing ${show(missing.length > 0 ? missing : listed)}, got ${show(actual)}` };
  }
}

/**
 * Match `actual` against the recorded `expected` message under `match`.
 * Returns null on success, after committing any new `<ulid>`/`<sha>`
 * bindings to `subs`; on failure nothing is committed.
 */
export function matchMessage(expected: unknown, actual: unknown, match: MatchSpec | undefined, subs: Substitutions): MatchFailure | null {
  const walk = new Walk(match ?? {}, subs);
  const failure = walk.matchers(expected, actual) ?? walk.run(expected, actual, "");
  if (failure) return failure;
  for (const [recorded, value] of walk.pending) subs.alias(recorded, value);
  return null;
}

/**
 * Check a `match` spec against its own recorded message: every key is a
 * matcher, every pointer resolves inside `msg`, and the recorded message
 * satisfies it. Returns a problem description, or null.
 */
export function lintMatch(msg: unknown, match: unknown): string | null {
  if (match === undefined) return null;
  if (!isObject(match)) return "match must be an object of JSON Pointer → matcher";
  for (const [ptr, m] of Object.entries(match)) {
    if (!isMatcher(m)) return `match[${JSON.stringify(ptr)}] is not a matcher: ${show(m)}`;
    if (resolvePointer(msg, ptr) === undefined) return `match pointer ${JSON.stringify(ptr)} does not resolve inside msg`;
  }
  const self = matchMessage(msg, msg, match as MatchSpec, new Substitutions());
  return self === null ? null : `the recorded msg does not satisfy its own match at ${self.pointer || "/"}: ${self.reason}`;
}
