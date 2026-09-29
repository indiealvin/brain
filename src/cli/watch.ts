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
 */
import type { EmbeddingProvider, ExecutionResult, IntegrationResult } from "../core/types";
import type { IndexDb } from "../index/schema";
import { ensureEmbeddings } from "../retrieval/embeddings";

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
