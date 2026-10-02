/**
 * Transcript replay (docs/mac-app/protocol.md §9; implementation-plan T1.3).
 *
 * Rules:
 * - **Per request id**: the server messages of one request (events, then its
 *   terminal message) match the transcript's lines for that id in order.
 *   Different ids interleave freely, and a request message may arrive in any
 *   window. A message for an id with no unmatched line left fails the replay.
 *   `id: null` (framing errors) is an id like any other.
 * - **Notification windows**: a window runs from one `c2s`/`test` line to the
 *   next; the last (trailing) window runs to the end of the transcript.
 *   Within a window, the expected notifications of the asserted types match
 *   the actual ones as an unordered multiset. An actual notification of an
 *   asserted type that matches none left fails the replay, except for the
 *   polling types (`repo.changed`, `engine.tick`): each expected one needs at
 *   least one matching occurrence, and any number of others are accepted.
 *   Types not in the header are ignored.
 * - **Advancing**: the next `c2s` line is sent, or the next step performed,
 *   only once every earlier `s2c` line has matched. The trailing window ends
 *   when the server exits after a `shutdown` request (exit code 0 required),
 *   or `trailingMs` after the last expected line matched otherwise.
 * - A stdout line that is not a JSON object fails the replay (stdout carries
 *   protocol lines only).
 * - Message matching and substitution: match.ts.
 */
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { matchMessage, Substitutions } from "./match";
import { RpcProcess, type ServerHandle } from "./process";
import { sleep, stepHandler, type StepContext } from "./steps";
import { isRequestMessage, isTerminal, parseTranscript, POLLING_TYPES, type S2cLine, type Transcript, type TranscriptHeader } from "./transcript";

/** Bound on each wait (one window's expected lines, a step's outcome). Generous for loaded CI machines. */
export const DEFAULT_WAIT_MS = Number(process.env["BRAIN_RPC_TRANSCRIPT_TIMEOUT_MS"] ?? 20_000);
/** How long the trailing window of a transcript that does not shut down stays open after its last expected line. */
export const DEFAULT_TRAILING_MS = 500;

export interface ReplayOptions {
  waitMs?: number;
  trailingMs?: number;
}

/** The header's `modelScript` is copied to `<tmp>/<MODEL_SCRIPT_FILE>`: relative `hold` and `repeat` files, and the call log, live in `<tmp>`. */
export const MODEL_SCRIPT_FILE = "model-script.json";

/** One run's temp dirs, server and step state; shared by replay and the recorder. */
export interface Run {
  readonly tmp: string;
  readonly home: string;
  readonly subs: Substitutions;
  readonly server: RpcProcess;
  readonly state: Map<string, unknown>;
  defer(cleanup: () => void | Promise<void>): void;
  /** Kill the server, run deferred cleanups (reverse order), remove the temp dir. */
  dispose(): Promise<void>;
}

/**
 * Temp root (realpath, so macOS's /var → /private/var never splits a path),
 * `BRAIN_HOME=<tmp>/home`, the optional model script, and the server. The
 * header's `tmp` (recorded) is aliased to the real temp root.
 */
export function createRun(header: TranscriptHeader, baseDir: string): Run {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "brain-rpc-")));
  const home = join(tmp, "home");
  mkdirSync(home, { recursive: true });
  const subs = new Substitutions();
  if (header.tmp !== undefined) subs.alias(header.tmp, tmp);
  const env: Record<string, string> = {};
  if (header.modelScript !== undefined) {
    const script = join(tmp, MODEL_SCRIPT_FILE);
    copyFileSync(resolve(baseDir, header.modelScript), script);
    env["BRAIN_MODEL_SCRIPT"] = script;
  }
  const server = RpcProcess.spawn({ home, cwd: tmp, env });
  const cleanups: (() => void | Promise<void>)[] = [];
  return {
    tmp,
    home,
    subs,
    server,
    state: new Map(),
    defer: (c) => void cleanups.push(c),
    dispose: async () => {
      await server.kill("SIGKILL");
      for (const c of cleanups.reverse()) {
        try {
          await c();
        } catch {}
      }
      rmSync(tmp, { recursive: true, force: true });
    },
  };
}

const idKey = (id: unknown): string => JSON.stringify(id ?? null);

export interface ReplayIo {
  server: ServerHandle;
  subs: Substitutions;
  tmp: string;
  home: string;
  state: Map<string, unknown>;
  defer(cleanup: () => void | Promise<void>): void;
}

/** Replay `t` against `io.server` (already started). Throws on the first mismatch, with the recent traffic and stderr. */
export async function replay(t: Transcript, io: ReplayIo, opts: ReplayOptions = {}): Promise<void> {
  const waitMs = opts.waitMs ?? DEFAULT_WAIT_MS;
  const trailingMs = opts.trailingMs ?? DEFAULT_TRAILING_MS;
  const { server, subs } = io;
  const asserted = new Set(t.header.asserts.notifications);

  // Expected request messages, per id, in transcript order; expected notifications, per window.
  const byId = new Map<string, S2cLine[]>();
  const windows: S2cLine[][] = [[]];
  const windowStart: number[] = [0]; // line number that opened each window (0: start of the transcript)
  for (const line of t.lines) {
    if (line.dir !== "s2c") {
      windows.push([]);
      windowStart.push(line.lineNo);
    } else if (isRequestMessage(line.msg)) {
      const k = idKey(line.msg["id"]);
      byId.set(k, [...(byId.get(k) ?? []), line]);
    } else {
      windows[windows.length - 1]!.push(line);
    }
  }

  const matched = new Set<S2cLine>();
  const terminated = new Set<string>();
  const recent: string[] = [];
  let window = 0;
  let failure: Error | null = null;
  let exited = false;
  const waiters = new Set<() => void>();
  const wake = () => {
    for (const w of [...waiters]) w();
  };
  const fail = (message: string): Error => {
    failure ??= new Error(`${t.source}: ${message}\n--- last messages received ---\n${recent.slice(-25).join("\n")}\n--- server stderr ---\n${server.stderrTail()}`);
    wake();
    return failure;
  };

  server.onMessage((msg, raw) => {
    recent.push(raw);
    if (failure) return;
    if (msg === null) {
      fail(`stdout carried a line that is not a JSON object: ${raw}`);
      return;
    }
    if (isRequestMessage(msg)) {
      const k = idKey(msg["id"]);
      const next = byId.get(k)?.find((l) => !matched.has(l));
      if (next === undefined) {
        fail(`unexpected message for id ${k}: ${raw}`);
        return;
      }
      const f = matchMessage(next.msg, msg, next.match, subs);
      if (f) {
        fail(`line ${next.lineNo} (id ${k}) does not match at ${f.pointer || "/"}: ${f.reason}\nactual: ${raw}`);
        return;
      }
      matched.add(next);
      if (isTerminal(msg)) terminated.add(k);
    } else {
      const type = msg["type"];
      if (typeof type !== "string" || !asserted.has(type)) return;
      const hit = windows[window]!.find((l) => !matched.has(l) && l.msg["type"] === type && matchMessage(l.msg, msg, l.match, subs) === null);
      if (hit) matched.add(hit);
      else if (!POLLING_TYPES.has(type)) {
        fail(`unexpected ${type} notification in the window after line ${windowStart[window]}: ${raw}`);
        return;
      }
    }
    wake();
  });
  void server.finished.then(() => {
    exited = true;
    wake();
  });

  const waitUntil = async (cond: () => boolean, what: () => string): Promise<void> => {
    const deadline = Date.now() + waitMs;
    for (;;) {
      if (failure) throw failure;
      if (cond()) return;
      if (exited) throw fail(`the server exited while waiting for ${what()}`);
      const left = deadline - Date.now();
      if (left <= 0) throw fail(`timed out after ${waitMs} ms waiting for ${what()}`);
      await new Promise<void>((r) => {
        const done = () => {
          clearTimeout(timer);
          waiters.delete(done);
          r();
        };
        const timer = setTimeout(done, left);
        waiters.add(done);
      });
    }
  };
  const unmatchedBefore = (index: number) => t.lines.slice(0, index).filter((l): l is S2cLine => l.dir === "s2c" && !matched.has(l));
  const gate = (index: number) =>
    waitUntil(
      () => unmatchedBefore(index).length === 0,
      () => `line(s) ${unmatchedBefore(index).map((l) => l.lineNo).join(", ")}`,
    );

  const ctx: StepContext = {
    tmp: io.tmp,
    home: io.home,
    server,
    subs,
    replaying: true,
    alias: (recorded, actual) => subs.alias(recorded, actual),
    terminated: (id) => terminated.has(idKey(id)),
    defer: io.defer,
    state: io.state,
  };

  let sentShutdown = false;
  for (let i = 0; i < t.lines.length; i++) {
    const line = t.lines[i]!;
    if (line.dir === "s2c") continue;
    await gate(i);
    window++;
    if (line.dir === "c2s") {
      if (line.msg["method"] === "shutdown") sentShutdown = true;
      server.sendRaw(JSON.stringify(subs.applyDeep(line.msg)));
    } else {
      try {
        await stepHandler(line.step.op)(line.step, ctx);
      } catch (e) {
        throw fail(`line ${line.lineNo}: step ${line.step.op} failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (failure) throw failure;
    }
  }
  await gate(t.lines.length);
  if (sentShutdown) {
    await waitUntil(
      () => exited,
      () => "the server to exit after shutdown",
    );
    const code = await server.finished;
    if (code !== 0) throw fail(`the server exited with code ${code} after shutdown`);
  } else {
    await sleep(trailingMs);
  }
  if (failure) throw failure;
}

/** Parse `file`, start a server in a fresh temp dir, replay, and clean up. */
export async function replayTranscript(file: string, opts: ReplayOptions = {}): Promise<void> {
  const t = parseTranscript(readFileSync(file, "utf8"), basename(file));
  const run = createRun(t.header, dirname(file));
  try {
    await replay(t, run, opts);
  } finally {
    await run.dispose();
  }
}
