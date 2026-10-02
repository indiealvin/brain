/**
 * `brain watch` loop body, factored out of the CLI so it can be exercised
 * without timers, signals or a pid file.
 *
 * One tick = drain the queue, integrate, and — when either step changed the
 * agent branch (or the caller forces it, e.g. at startup) — reconcile the
 * index and bring the embeddings table up to date for the configured provider.
 *
 * Embedding failures never stop the daemon: provider creation failing (for
 * example `BRAIN_EMBEDDINGS=openrouter` without a key) disables embeddings
 * for the run with a single warning, and a runtime failure (network) is
 * logged at most once per `EMBED_ERROR_LOG_INTERVAL_MS`.
 *
 * Only the holder of the repo's loop-owner lock runs the loop (CR-10;
 * docs/mac-app/design.md §5.3 item 2). `waitForLoopOwner` is how
 * `brain watch` gets it; the RPC server try-locks instead
 * (src/rpc/engine.ts). Both then run the same loop, `createWatchLoop`.
 */
import type { BrainConfig, Clock, EmbeddingProvider, ExecutionResult, IntegrationResult, RepoPaths, SyncResult } from "../core/types";
import type { IndexDb } from "../index/schema";
import { ensureEmbeddings } from "../retrieval/embeddings";
import { startHumanSyncWatcher, type HumanSyncWatcher } from "../sync/humanSync";
import { acquireLock, LOOP_OWNER_LOCK, readLockHolder, type LockHandle, type LockHolderInfo } from "../sync/lock";

export const EMBED_ERROR_LOG_INTERVAL_MS = 60_000;

export interface WatchEmbedder {
  /** Embed stale notes; returns the count written (0 after a swallowed error). Never throws. */
  run(): Promise<number>;
}

export interface WatchEmbedderOptions {
  db: IndexDb;
  provider: EmbeddingProvider;
  log: (line: string) => void;
  now?: () => number;
}

/** Wrap `ensureEmbeddings` with the once-per-minute error throttle and the `watch: embedded N notes` line. */
export function createWatchEmbedder(opts: WatchEmbedderOptions): WatchEmbedder {
  const now = opts.now ?? (() => Date.now());
  let lastErrorLoggedAt = -Infinity;
  return {
    async run() {
      try {
        const n = await ensureEmbeddings(opts.db, opts.provider);
        if (n > 0) opts.log(`watch: embedded ${n} notes`);
        return n;
      } catch (e) {
        const t = now();
        if (t - lastErrorLoggedAt >= EMBED_ERROR_LOG_INTERVAL_MS) {
          lastErrorLoggedAt = t;
          opts.log(`watch: embeddings: ${e instanceof Error ? e.message : String(e)}`);
        }
        return 0;
      }
    },
  };
}

/**
 * Create the embedding provider once at startup. Returns null (and logs one
 * `watch: embeddings disabled: <reason>` line) when creation throws, so the
 * daemon keeps syncing and integrating without embeddings.
 */
export function resolveWatchProvider(create: () => EmbeddingProvider, log: (line: string) => void): EmbeddingProvider | null {
  try {
    return create();
  } catch (e) {
    log(`watch: embeddings disabled: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

export interface WatchTickDeps {
  coord: { drainQueued(): Promise<ExecutionResult[]>; integrate(): Promise<IntegrationResult>; reconcileIndex(): Promise<unknown> };
  /** null → embeddings disabled (`--no-embeddings` or provider creation failed). */
  embedder: WatchEmbedder | null;
  log: (line: string) => void;
}

export interface WatchTickResult {
  drained: ExecutionResult[];
  integration: IntegrationResult;
  /** True when this tick changed the agent branch (a committed execution or a non-trivial integration). */
  changed: boolean;
  /** Notes embedded this tick (0 when skipped or disabled). */
  embedded: number;
}

function short(sha: string): string {
  return sha.slice(0, 12);
}

/** One loop iteration. `force` runs the embedding step even when nothing changed (startup). */
export async function watchTick(deps: WatchTickDeps, opts: { force?: boolean } = {}): Promise<WatchTickResult> {
  const drained = await deps.coord.drainQueued();
  for (const d of drained) deps.log(`executed ${d.mutationId}: ${d.state}`);
  const integration = await deps.coord.integrate();
  if (integration.status !== "nothing-to-integrate") deps.log(`integrate: ${integration.status} main=${short(integration.mainSha)}`);
  // drainQueued() integrates on its own after a COMMITTED execution (the row is INTEGRATED by then).
  const changed = drained.some((d) => d.state === "COMMITTED" || d.state === "INTEGRATED") || integration.status !== "nothing-to-integrate";
  // A fast-forward reconciles the index inside integrate(); the rebuilt-only path
  // (main moved, agent rebuilt onto it, nothing to merge) does not, so do it here.
  // No-op when the index already projects agent HEAD.
  if (changed) await deps.coord.reconcileIndex();
  let embedded = 0;
  if (deps.embedder !== null && (changed || opts.force === true)) embedded = await deps.embedder.run();
  return { drained, integration, changed, embedded };
}

/** What the loop needs from the coordinator: `watchTick`'s calls, plus Human Sync through the coordinator. */
export interface WatchLoopCoord {
  readonly paths: RepoPaths;
  readonly config: BrainConfig;
  drainQueued(): Promise<ExecutionResult[]>;
  integrate(): Promise<IntegrationResult>;
  reconcileIndex(): Promise<unknown>;
  syncOnce(now?: number): Promise<SyncResult>;
}

export interface WatchLoopOptions {
  coord: WatchLoopCoord;
  /** null → embeddings disabled. */
  embedder: WatchEmbedder | null;
  intervalMs: number;
  log: (line: string) => void;
  /** Default: the wall clock. */
  clock?: Clock;
  /** After every tick that completed: scheduled, forced, or requested through `tick()`. */
  onTick?: (result: WatchTickResult) => void;
  /** After a Human Sync pass of the watcher committed (`result.committed`). */
  onHumanSync?: (result: SyncResult) => void;
  /** A scheduled or forced tick threw; the loop goes on. Not called for `tick()`, whose caller gets the error. */
  onError?: (error: unknown) => void;
}

/** The loop a loop owner runs (design §5.3 item 2): the Human Sync watcher and one `watchTick` per interval. */
export interface WatchLoop {
  /**
   * Start the loop: the Human Sync watcher, whose `sync` is `coord.syncOnce`
   * (so it goes through the coordinator and its lock, CR-1), a forced tick at
   * once (design §5.2 continuous recovery: the new loop owner drains, integrates
   * and embeds whatever is stale), then one tick per interval. Resolves once the
   * forced tick has finished. A no-op once started or stopped.
   */
  start(): Promise<void>;
  /**
   * One forced tick outside the schedule (the RPC `engine.tick`). It runs after
   * the tick in flight, never alongside it (the embedder writes the index outside
   * the worktree lock), and scheduled ticks are skipped while it runs. Rejects
   * with the tick's error. Works whether or not the loop is started or stopped.
   */
  tick(): Promise<WatchTickResult>;
  /**
   * Stop scheduling ticks and Human Sync passes, then wait for the tick and the
   * Human Sync pass in flight. Idempotent. Ticks requested through `tick()`
   * afterwards still run.
   */
  stop(): Promise<void>;
}

/**
 * The loop body shared by `brain watch` and the RPC server (src/rpc/engine.ts),
 * so both run the same code. The caller holds the loop-owner lock before
 * calling `start()` and releases it after `stop()` has resolved.
 *
 * Ticks never overlap: a scheduled tick is skipped while another is in flight
 * (the `running` guard of `brain watch`), and a requested one waits for it.
 */
export function createWatchLoop(opts: WatchLoopOptions): WatchLoop {
  const clock = opts.clock ?? { now: () => Date.now() };
  const deps: WatchTickDeps = { coord: opts.coord, embedder: opts.embedder, log: opts.log };
  let started = false;
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let watcher: HumanSyncWatcher | null = null;
  let current: Promise<unknown> | null = null;
  let syncing: Promise<unknown> | null = null;

  const run = (force: boolean): Promise<WatchTickResult> => {
    const p = watchTick(deps, { force }).then((r) => {
      opts.onTick?.(r);
      return r;
    });
    const settled = p.then(
      () => undefined,
      () => undefined,
    );
    current = settled;
    void settled.then(() => {
      if (current === settled) current = null;
    });
    return p;
  };
  const scheduled = async (force: boolean): Promise<void> => {
    try {
      await run(force);
    } catch (e) {
      opts.onError?.(e);
    }
  };

  return {
    async start() {
      if (started || stopped) return;
      started = true;
      watcher = startHumanSyncWatcher(opts.coord.paths, opts.coord.config, clock, opts.intervalMs, (now) => {
        const p = opts.coord.syncOnce(now).then((r) => {
          if (r.committed) opts.onHumanSync?.(r);
          return r;
        });
        const settled = p.then(
          () => undefined,
          () => undefined,
        );
        syncing = settled;
        void settled.then(() => {
          if (syncing === settled) syncing = null;
        });
        return p;
      });
      while (current !== null) await current;
      if (stopped) return;
      await scheduled(true);
      if (stopped) return;
      timer = setInterval(() => {
        if (current === null && !stopped) void scheduled(false);
      }, opts.intervalMs);
    },
    async tick() {
      while (current !== null) await current;
      return run(true);
    },
    async stop() {
      stopped = true;
      if (timer !== null) clearInterval(timer);
      timer = null;
      watcher?.stop();
      watcher = null;
      while (current !== null || syncing !== null) await (current ?? syncing);
    },
  };
}

/**
 * Length of one bounded wait for the loop-owner lock. Between slices the
 * waiter checks whether it was asked to stop, so this bounds how long a
 * SIGINT / SIGTERM takes to end a waiting `brain watch`. Within a slice the
 * lock primitive retries with its own short backoff, so a released lock is
 * taken over within that backoff, not within a slice.
 */
export const LOOP_OWNER_WAIT_SLICE_MS = 250;

export interface LoopOwnerWaitOptions {
  /** Recorded in the lock's side file (`brain doctor`; later the RPC `EngineInfo.owner`). */
  holderKind: string;
  /** Polled between wait slices; once true, the wait gives up and resolves to null. */
  stopped: () => boolean;
  log: (line: string) => void;
  /** Default `LOOP_OWNER_WAIT_SLICE_MS`. */
  sliceMs?: number;
}

/** The one line a waiting `brain watch` logs about the current loop owner, from the informational side file. */
export function describeLoopOwnerWait(holder: LockHolderInfo | null): string {
  if (holder === null) return "watch: the loop for this repo is owned by another process; waiting until it exits";
  const since = new Date(holder.acquiredAtMs).toISOString();
  return `watch: the loop for this repo is owned by ${holder.kind} (pid ${holder.pid}, since ${since}); waiting until it exits`;
}

/**
 * Wait, with no deadline, for the repo's loop-owner lock (CR-10). Resolves to
 * the held handle, or to null once `stopped()` is true. The caller keeps the
 * handle for the life of its loop and releases it when the loop ends; the lock
 * module also keeps every held handle strongly reachable until then (design
 * §5.2, GC note).
 *
 * The wait is asynchronous and cancellable: a sequence of bounded waits of
 * `sliceMs`, checking `stopped()` in between. A plain blocking wait could not
 * be cancelled, and its retry timer would keep a stopped process alive. When
 * the first attempt finds the lock held, the holder named in the side file is
 * logged once. The side file is informational only: whether the lock is free
 * is decided by the lock alone, never by the side file or by `watch.pid`.
 */
export async function waitForLoopOwner(runtimeDir: string, opts: LoopOwnerWaitOptions): Promise<LockHandle | null> {
  const sliceMs = opts.sliceMs ?? LOOP_OWNER_WAIT_SLICE_MS;
  let first = true;
  for (;;) {
    if (opts.stopped()) return null;
    const handle = await acquireLock(runtimeDir, LOOP_OWNER_LOCK, first ? { mode: "try" } : { mode: "bounded", timeoutMs: sliceMs }, { holderKind: opts.holderKind });
    if (handle !== null) {
      if (opts.stopped()) {
        handle.release();
        return null;
      }
      return handle;
    }
    if (first) {
      opts.log(describeLoopOwnerWait(readLockHolder(runtimeDir, LOOP_OWNER_LOCK)));
      first = false;
    }
  }
}
