/**
 * `brain rpc --stdio` (docs/mac-app/protocol.md §1): the stdio transport for
 * the RPC server.
 *
 * - stdout carries protocol lines only. `claimStdio` runs first, before
 *   anything can log: every `console` method and `process.stdout.write` are
 *   redirected to stderr, so no library can corrupt the stream. Protocol lines
 *   go through the original stdout writer it keeps.
 * - stderr carries human-readable log lines, every one redacted (design §10),
 *   including library output relayed through `console` or `process.stderr.write`.
 * - stdin EOF and SIGTERM start the same drain as `shutdown` (protocol §3).
 *   The process exits 0 once the server is closed and stdout is flushed.
 */
import { Console } from "node:console";
import { Writable } from "node:stream";
import { setLockHolderKind } from "../sync/lock";
import { PROTOCOL_VERSION } from "./dto";
import { createRpcServer } from "./index";
import { forEachLine } from "./lines";
import { Redactor } from "./redact";
import { BRAIN_VERSION } from "./server";

type WriteFn = (chunk: string, cb?: (err?: Error | null) => void) => boolean;
type StreamWrite = (chunk: unknown, encodingOrCb?: unknown, cb?: unknown) => boolean;

export interface ClaimedStdio {
  /** Write one protocol line (no trailing newline) to the real stdout. */
  writeLine(line: string): void;
  /** Write one log line to stderr, redacted. */
  logLine(line: string): void;
  /** Resolves once everything written to stdout so far is flushed (or stdout failed). */
  flush(): Promise<void>;
  /** Undo the redirection (tests only; the server process never restores). */
  restore(): void;
}

/** A `write(chunk, [encoding], [cb])` that redacts and forwards to `target`. */
function redactingWrite(target: WriteFn, redactor: Redactor): StreamWrite {
  return (chunk, encodingOrCb, cb) => {
    const callback = (typeof encodingOrCb === "function" ? encodingOrCb : cb) as ((err?: Error | null) => void) | undefined;
    const text = typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString("utf8");
    return target(redactor.redact(text), callback);
  };
}

/**
 * Take over the process's stdio for the protocol: returns the protocol writer
 * and redirects everything else to stderr, redacted by `redactor`.
 */
export function claimStdio(redactor: Redactor): ClaimedStdio {
  const out = process.stdout;
  const err = process.stderr;
  const originalOutWrite = out.write;
  const originalErrWrite = err.write;
  const realOut: WriteFn = out.write.bind(out) as WriteFn;
  const realErr: WriteFn = err.write.bind(err) as WriteFn;
  const toStderr = redactingWrite(realErr, redactor);

  // A client that went away must not crash the drain: failed writes are dropped.
  const ignore = () => {};
  out.on("error", ignore);
  err.on("error", ignore);

  (out as unknown as { write: StreamWrite }).write = toStderr;
  (err as unknown as { write: StreamWrite }).write = toStderr;

  // Every console method (log, info, warn, debug, dir, table, time*, …) writes to stderr.
  const sink = new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      toStderr(chunk, () => callback());
    },
  });
  const stderrConsole = new Console({ stdout: sink, stderr: sink });
  const saved = new Map<string, unknown>();
  const globalConsole = console as unknown as Record<string, unknown>;
  for (const key of Object.keys(stderrConsole)) {
    const fn = (stderrConsole as unknown as Record<string, unknown>)[key];
    if (typeof fn !== "function") continue;
    saved.set(key, globalConsole[key]);
    globalConsole[key] = (fn as (...a: unknown[]) => unknown).bind(stderrConsole);
  }

  return {
    writeLine: (line) => void realOut(`${line}\n`),
    logLine: (line) => void realErr(`${redactor.redact(line)}\n`),
    flush: () => new Promise<void>((resolve) => void realOut("", () => resolve())),
    restore: () => {
      out.write = originalOutWrite;
      err.write = originalErrWrite;
      out.off("error", ignore);
      err.off("error", ignore);
      for (const [key, fn] of saved) globalConsole[key] = fn;
    },
  };
}

/**
 * Serve the protocol on stdin/stdout until the server closes, then exit 0.
 * Never returns.
 */
export async function runStdioServer(): Promise<never> {
  const redactor = new Redactor();
  const stdio = claimStdio(redactor);
  setLockHolderKind("rpc"); // every lock this process holds names it as `rpc` in the side file
  const server = createRpcServer({ send: stdio.writeLine, log: stdio.logLine, redactor });
  server.log(`rpc: brain ${BRAIN_VERSION}, protocol ${PROTOCOL_VERSION}, on stdio (pid ${process.pid})`);

  // Programmer errors outside a request are logged; the server keeps running (protocol §6).
  process.on("unhandledRejection", (e) => server.log(`rpc: unhandled rejection: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`));
  process.on("SIGTERM", () => void server.shutdown("SIGTERM"));
  void forEachLine(process.stdin, (line) => server.handleLine(line)).then(
    () => void server.shutdown("stdin closed"),
    (e) => {
      server.log(`rpc: reading stdin failed: ${e instanceof Error ? e.message : String(e)}`);
      void server.shutdown("stdin failed");
    },
  );

  await server.closed;
  await stdio.flush();
  process.exit(0);
}
