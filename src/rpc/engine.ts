/**
 * The RPC server's engine (docs/mac-app/protocol.md §3–§5; design.md §5.3
 * items 2 and 4): loop ownership, the loop itself, `engine.tick`, and the
 * `repo.changed` poller.
 *
 * ## Loop ownership (CR-10)
 *
 * The server never blocks on the loop-owner lock. It try-locks it at
 * `initialize`, and while another process (`brain watch`, another server)
 * holds it, again every `intervalMs`.
 * - **Held** (`loopOwner: "self"`): the server runs the loop `brain watch`
 *   runs (`createWatchLoop`, src/cli/watch.ts): the Human Sync watcher through
 *   `coord.syncOnce`, a forced tick at once (design §5.2, continuous
 *   recovery), then one tick per interval. It never gives the lock up while
 *   running: there is no hand-over. The handle lives on this object until
 *   shutdown step 5 releases it (design §5.2, GC note).
 * - **Not held** (`loopOwner: "other"`): no loop. `EngineInfo.owner` names the
 *   holder from the lock's informational side file. When a later try-lock
 *   succeeds (the owner exited or was killed; the kernel freed the lock), the
 *   server emits `engine.loopOwner` and starts the loop as above.
 *   Acquisition at `initialize` is reported by the `initialize` result itself,
 *   not by a notification.
 * - `watch.pid` is never read: whether the loop is owned is decided by the
 *   lock alone.
 *
 * Lock order (design §5.2): the loop owner holds only this lock while each
 * tick takes the worktree lock inside the coordinator.
 *
 * ## Notifications
 *
 * - `engine.loopOwner {EngineInfo}`: the other → self transition.
 * - `engine.tick {EngineTick}`: while the loop is this server's, after a tick
 *   that changed the agent branch or drained a result other than `INTEGRATED`.
 * - `engine.humanSync {sha}`: the loop's Human Sync watcher committed.
 * - `engine.error {message}`: the loop caught an error (redacted).
 * - `repo.changed {RepoChanged}`: every `intervalMs`, whoever owns the loop
 *   (src/rpc/poller.ts). The baseline is taken at `initialize`, without a
 *   notification.
 *
 * ## Shutdown (protocol §3)
 *
 * Step 2 (`stopLoop`): no more ticks, Human Sync passes, try-locks or polls;
 * waits for the tick in flight. Step 5 (`close`): the poll connections, the
 * embedder's index connection, then the loop-owner lock, released last.
 */
import { createWatchEmbedder, createWatchLoop, resolveWatchProvider, type WatchEmbedder, type WatchLoop } from "../cli/watch";
import type { Coord } from "../commands/repo";
import { openIndex, type IndexDb } from "../index/schema";
import { acquireLock, LOOP_OWNER_LOCK, readLockHolder, type LockHandle } from "../sync/lock";
import type { EngineError, EngineHumanSync, EngineInfo, EngineStatus, EngineTick } from "./dto";
import { RepoChangePoller } from "./poller";
import type { RpcServer } from "./server";

/** The holder kind this server records in the loop-owner lock's side file (`EngineInfo.owner.kind`, `brain doctor`). */
export const RPC_HOLDER_KIND = "rpc";

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** The holder named by the lock's side file, when it is one of the kinds the protocol names. Informational only. */
function ownerFromSideFile(runtimeDir: string): EngineInfo["owner"] {
  const h = readLockHolder(runtimeDir, LOOP_OWNER_LOCK);
  if (h === null || (h.kind !== "watch" && h.kind !== "rpc")) return undefined;
  return { kind: h.kind, pid: h.pid };
}

export interface RpcEngineOptions {
  server: RpcServer;
  coord: Coord;
  intervalMs: number;
}

export class RpcEngine {
  readonly intervalMs: number;
  private readonly server: RpcServer;
  private readonly coord: Coord;
  private readonly poller: RepoChangePoller;
  private readonly loop: WatchLoop;
  /** Held for the life of the loop; strongly reachable from here until `close()` releases it. */
  private ownerLock: LockHandle | null = null;
  private lastTick: EngineTick | undefined;
  private timer: ReturnType<typeof setInterval> | null = null;
  private started = false;
  private stopping = false;
  private closed = false;
  private acquiring = false;
  /** The embedder: undefined until first used, null when embeddings are disabled. */
  private embedderValue: WatchEmbedder | null | undefined;
  private embedderDb: IndexDb | null = null;

  private constructor(opts: RpcEngineOptions) {
    this.server = opts.server;
    this.coord = opts.coord;
    this.intervalMs = opts.intervalMs;
    this.poller = new RepoChangePoller(opts.coord.paths);
    const log = (line: string) => this.server.log(line);
    // Resolved on the first tick, after `initialize` completed, from the session's own provider.
    const embedder: WatchEmbedder = { run: async () => (await this.embedder()?.run()) ?? 0 };
    this.loop = createWatchLoop({
      coord: opts.coord,
      embedder,
      intervalMs: opts.intervalMs,
      log,
      onTick: (r) => this.onTick(r),
      onHumanSync: (r) => {
        if (r.sha !== undefined) this.server.notify("engine.humanSync", { sha: r.sha } satisfies EngineHumanSync);
      },
      onError: (e) => {
        const message = this.server.redactor.redact(errorText(e));
        log(`watch loop error: ${message}`);
        this.server.notify("engine.error", { message } satisfies EngineError);
      },
    });
  }

  /**
   * At `initialize`, after the open sequence: take the `repo.changed` baseline
   * and try-lock the loop-owner lock once. Nothing runs until `start()`.
   */
  static async open(opts: RpcEngineOptions): Promise<RpcEngine> {
    const engine = new RpcEngine(opts);
    try {
      engine.poller.baseline();
      engine.ownerLock = await acquireLock(opts.coord.paths.runtimeDir, LOOP_OWNER_LOCK, { mode: "try" }, { holderKind: RPC_HOLDER_KIND });
    } catch (e) {
      engine.close();
      throw e;
    }
    return engine;
  }

  get loopOwner(): EngineInfo["loopOwner"] {
    return this.ownerLock !== null ? "self" : "other";
  }

  /** `EngineInfo` now. With `"other"`, `owner` comes from the lock's side file when it names a `watch` or `rpc` holder. */
  info(): EngineInfo {
    if (this.ownerLock !== null) return { loopOwner: "self", intervalMs: this.intervalMs };
    const owner = ownerFromSideFile(this.coord.paths.runtimeDir);
    return owner === undefined ? { loopOwner: "other", intervalMs: this.intervalMs } : { loopOwner: "other", owner, intervalMs: this.intervalMs };
  }

  /** `engine.status`: `EngineInfo` plus the last tick this server ran, if any. */
  status(): EngineStatus {
    return this.lastTick === undefined ? this.info() : { ...this.info(), lastTick: this.lastTick };
  }

  /**
   * `engine.tick`: one forced tick, whoever owns the loop (safe under CR-1:
   * every write in it takes the worktree lock). It runs after the tick in
   * flight, never alongside it. Rejects with the tick's error.
   */
  tick(): Promise<EngineTick> {
    return this.loop.tick();
  }

  /**
   * Begin: the loop when the lock is held (its forced tick at once), and the
   * interval timer that polls for `repo.changed` and, while the loop is
   * another process's, try-locks again. Called once the `initialize` result is
   * sent, so no notification precedes it. A no-op after `stopLoop()`.
   */
  start(): void {
    // A shutdown that arrived while `initialize` was still opening has passed step 2 already.
    if (this.started || this.stopping || this.server.shuttingDown) return;
    this.started = true;
    if (this.ownerLock !== null) void this.loop.start();
    this.timer = setInterval(() => this.onInterval(), this.intervalMs);
  }

  /** Shutdown step 2: stop the timer and the loop, and wait for the tick and Human Sync pass in flight. */
  async stopLoop(): Promise<void> {
    this.stopping = true;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    await this.loop.stop();
  }

  /** Shutdown step 5: close the poll connections and the embedder's index connection, then release the loop-owner lock. Idempotent. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stopping = true;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    void this.loop.stop(); // normally a no-op: step 2 stopped it; never schedules anything again
    this.poller.close();
    try {
      this.embedderDb?.close();
    } catch {}
    this.embedderDb = null;
    this.ownerLock?.release();
  }

  private onInterval(): void {
    if (this.stopping) return;
    if (this.ownerLock === null) void this.tryAcquire();
    try {
      const changed = this.poller.poll();
      if (changed !== null) this.server.notify("repo.changed", changed);
    } catch (e) {
      this.server.log(`rpc: engine: change check failed: ${errorText(e)}`);
    }
  }

  /** One try-lock; on success: `engine.loopOwner`, then the loop with its forced tick. */
  private async tryAcquire(): Promise<void> {
    if (this.acquiring || this.ownerLock !== null) return;
    this.acquiring = true;
    try {
      const handle = await acquireLock(this.coord.paths.runtimeDir, LOOP_OWNER_LOCK, { mode: "try" }, { holderKind: RPC_HOLDER_KIND });
      if (handle === null) return;
      if (this.stopping) {
        handle.release();
        return;
      }
      this.ownerLock = handle;
      this.server.log(`rpc: acquired the loop-owner lock (pid ${process.pid}); running the loop`);
      this.server.notify("engine.loopOwner", this.info());
      void this.loop.start();
    } catch (e) {
      this.server.log(`rpc: engine: loop-owner try-lock failed: ${errorText(e)}`);
    } finally {
      this.acquiring = false;
    }
  }

  private onTick(r: EngineTick): void {
    const tick = this.server.redactor.redactDeep(r);
    this.lastTick = tick;
    if (this.ownerLock !== null && (r.changed || r.drained.some((d) => d.state !== "INTEGRATED"))) this.server.notify("engine.tick", tick);
  }

  /**
   * The loop's embedder, built on first use from the session's embedding
   * provider (the one its conversations use) and its own index connection,
   * which `close()` closes. A provider that cannot be built disables
   * embeddings with one log line, as for `brain watch`.
   */
  private embedder(): WatchEmbedder | null {
    if (this.embedderValue !== undefined) return this.embedderValue;
    const log = (line: string) => this.server.log(line);
    const provider = resolveWatchProvider(() => this.server.embeddingProvider(), log);
    if (provider === null || this.closed) {
      this.embedderValue = null;
      return null;
    }
    this.embedderDb = openIndex(this.coord.paths.indexDb);
    this.embedderValue = createWatchEmbedder({ db: this.embedderDb, provider, log });
    return this.embedderValue;
  }
}
