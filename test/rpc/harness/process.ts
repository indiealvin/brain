/**
 * `brain rpc --stdio` as a child process for tests: line-framed stdout,
 * accumulated stderr, and a registry so every child is killed in teardown
 * (`killAllServers`, called from `afterEach`).
 */
import type { Subprocess } from "bun";
import { resolve } from "node:path";
import { forEachLine } from "../../../src/rpc/lines";
import { isTerminal } from "./transcript";

export const CLI = resolve(import.meta.dir, "../../../src/cli.ts");

/**
 * Removed from every child env: `bun test` auto-loads the developer's `.env`,
 * and servers under test must be hermetic (no real key, no network), seeing
 * only what a test passes explicitly.
 */
export const PROVIDER_VARS = [
  "OPENROUTER_API_KEY",
  "OPENROUTER_BASE_URL",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_PROFILE",
  "BRAIN_MODEL_PROVIDER",
  "BRAIN_MODEL",
  "BRAIN_EFFORT",
  "BRAIN_EMBEDDINGS",
  "BRAIN_EMBEDDING_MODEL",
  "BRAIN_EMBEDDING_DIMS",
  "BRAIN_MODEL_MOCK",
  "BRAIN_MODEL_SCRIPT",
  "BRAIN_MODEL_SCRIPT_LOG",
];

/** The env of a server under test: this process's env minus `PROVIDER_VARS`, plus `BRAIN_HOME` and `extra`. */
export function serverEnv(brainHome: string, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !PROVIDER_VARS.includes(k)) env[k] = v;
  return { ...env, BRAIN_HOME: brainHome, ...extra };
}

export type ServerMessage = Record<string, unknown>;

/** What the replay engine needs from a server (a real child, or a fake in the harness's own tests). */
export interface ServerHandle {
  sendRaw(line: string): void;
  /** Every protocol message, in arrival order; `bad` for a stdout line that is not a JSON object. */
  onMessage(listener: (msg: ServerMessage | null, raw: string) => void): void;
  /** Resolves with the exit code once the process has exited and its stdout is fully read. */
  readonly finished: Promise<number>;
  /** The last part of stderr, for failure messages. */
  stderrTail(chars?: number): string;
}

const live = new Set<RpcProcess>();

/** SIGKILL every server still running and wait for it. Call from `afterEach`. */
export async function killAllServers(): Promise<void> {
  const all = [...live];
  live.clear();
  await Promise.all(all.map((p) => p.kill("SIGKILL")));
}

export interface SpawnOptions {
  /** BRAIN_HOME for the child. */
  home: string;
  cwd: string;
  /** Extra env on top of `serverEnv`. */
  env?: Record<string, string>;
}

export class RpcProcess implements ServerHandle {
  readonly proc: Subprocess<"pipe", "pipe", "pipe">;
  /** Every protocol message so far, in arrival order. */
  readonly messages: ServerMessage[] = [];
  /** stdout lines that were not a JSON object (a protocol violation). */
  readonly badLines: string[] = [];
  readonly finished: Promise<number>;
  private readonly listeners: ((msg: ServerMessage | null, raw: string) => void)[] = [];
  private readonly wakers = new Set<() => void>();
  private stderrText = "";
  private exitCode: number | null = null;

  constructor(opts: SpawnOptions) {
    const proc = Bun.spawn([process.execPath, CLI, "rpc", "--stdio"], {
      cwd: opts.cwd,
      env: serverEnv(opts.home, opts.env),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    this.proc = proc;
    live.add(this);
    const stdoutDone = forEachLine(proc.stdout, (line) => this.onLine(line));
    const stderrDone = (async () => {
      const decoder = new TextDecoder();
      for await (const chunk of proc.stderr) this.stderrText += decoder.decode(chunk, { stream: true });
    })();
    this.finished = Promise.all([proc.exited, stdoutDone, stderrDone]).then(([code]) => {
      this.exitCode = code;
      live.delete(this);
      this.wake();
      return code;
    });
  }

  static spawn(opts: SpawnOptions): RpcProcess {
    return new RpcProcess(opts);
  }

  get pid(): number {
    return this.proc.pid;
  }

  get exited(): boolean {
    return this.exitCode !== null;
  }

  private onLine(line: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      msg = null;
    }
    const ok = typeof msg === "object" && msg !== null && !Array.isArray(msg);
    if (ok) this.messages.push(msg as ServerMessage);
    else this.badLines.push(line);
    for (const l of this.listeners) l(ok ? (msg as ServerMessage) : null, line);
    this.wake();
  }

  private wake(): void {
    for (const w of [...this.wakers]) w();
  }

  onMessage(listener: (msg: ServerMessage | null, raw: string) => void): void {
    this.listeners.push(listener);
  }

  sendRaw(line: string): void {
    this.proc.stdin.write(`${line}\n`);
    void this.proc.stdin.flush();
  }

  send(msg: unknown): void {
    this.sendRaw(JSON.stringify(msg));
  }

  closeStdin(): void {
    void this.proc.stdin.end();
  }

  stderr(): string {
    return this.stderrText;
  }

  stderrTail(chars = 4000): string {
    return this.stderrText.length > chars ? `…${this.stderrText.slice(-chars)}` : this.stderrText;
  }

  async kill(signal: NodeJS.Signals = "SIGKILL"): Promise<void> {
    try {
      this.proc.kill(signal);
    } catch {}
    await this.finished;
  }

  /** The first message (from index `from`) satisfying `pred`; rejects on timeout or when the server exits without one. */
  async waitFor(pred: (msg: ServerMessage) => boolean, opts: { timeoutMs?: number; from?: number } = {}): Promise<ServerMessage> {
    const timeoutMs = opts.timeoutMs ?? 20_000;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.messages.slice(opts.from ?? 0).find(pred);
      if (found !== undefined) return found;
      if (this.exitCode !== null) throw new Error(`server exited (${this.exitCode}) without the awaited message; stderr:\n${this.stderrTail()}`);
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`timed out after ${timeoutMs} ms; messages:\n${this.messages.map((m) => JSON.stringify(m)).join("\n")}\nstderr:\n${this.stderrTail()}`);
      await new Promise<void>((r) => {
        const done = () => {
          clearTimeout(timer);
          this.wakers.delete(done);
          r();
        };
        const timer = setTimeout(done, left);
        this.wakers.add(done);
      });
    }
  }

  /** Send a request and resolve with its terminal message (`result` or `error`). */
  async request(id: string, method: string, params: Record<string, unknown> = {}, opts: { timeoutMs?: number } = {}): Promise<ServerMessage> {
    const from = this.messages.length;
    this.send({ id, method, params });
    return this.waitFor((m) => m["id"] === id && isTerminal(m), { from, timeoutMs: opts.timeoutMs });
  }
}
