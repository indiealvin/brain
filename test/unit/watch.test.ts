import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { EmbeddingProvider, Mutation } from "../../src/core/types";
import { createWatchEmbedder, EMBED_ERROR_LOG_INTERVAL_MS, resolveWatchProvider, watchTick } from "../../src/cli/watch";
import { openIndex } from "../../src/index/schema";
import { createEmbeddingProvider } from "../../src/model";
import { HashingEmbeddingProvider } from "../../src/retrieval/embeddings";
import { createMutation, seedNote, setupEnv, type Env } from "../harness";

/** Hashing provider that counts `embed` calls, so a skipped embedding step is observable. */
class CountingProvider extends HashingEmbeddingProvider {
  calls = 0;
  override async embed(texts: string[]): Promise<Float32Array[]> {
    this.calls += 1;
    return super.embed(texts);
  }
}

function embeddingRows(indexDb: string, model: string): number {
  // a fresh connection: the count must be visible outside the handle the tick used
  const db = openIndex(indexDb);
  try {
    return (db.query("SELECT COUNT(*) AS n FROM embeddings WHERE model = ?").get(model) as { n: number }).n;
  } finally {
    db.close();
  }
}

describe("watchTick (brain watch loop body)", () => {
  let env: Env;
  beforeEach(async () => {
    env = await setupEnv();
  });
  afterEach(async () => {
    await env.cleanup();
  });

  test("embeds after a human commit is integrated, after a drained execution, at startup, and never when nothing changed", async () => {
    type Coord = Env["coord"] & { drainQueued(): Promise<import("../../src/core/types").ExecutionResult[]>; enqueue(m: Mutation): Promise<void> };
    const coord = env.coord as Coord;
    const log: string[] = [];
    const provider = new CountingProvider();
    const db = openIndex(coord.paths.indexDb);
    try {
      const embedder = createWatchEmbedder({ db, provider, log: (l) => log.push(l) });
      const deps = { coord, embedder, log: (l: string) => log.push(l) };

      // startup with an empty index: forced, but nothing to embed
      const boot = await watchTick(deps, { force: true });
      expect(boot.integration.status).toBe("nothing-to-integrate");
      expect(boot.changed).toBe(false);
      expect(boot.embedded).toBe(0);
      expect(provider.calls).toBe(0);
      expect(log).toEqual([]);

      // a human commit on main: integrate() rebuilds the agent branch (status != nothing-to-integrate) → embeddings refresh
      seedNote(env, "knowledge/first.md", { title: "First note", sections: { Claim: "Watch embeds what the human commits." } });
      const t1 = await watchTick(deps);
      expect(t1.integration.status).toBe("rebuilt-and-integrated");
      expect(t1.changed).toBe(true);
      expect(t1.embedded).toBe(1); // the tick reconciled the index (integrate() does not on the rebuilt-only path) before embedding
      expect(provider.calls).toBe(1);
      expect(log).toContain("watch: embedded 1 notes");
      expect(log.some((l) => l.startsWith("integrate: rebuilt-and-integrated main="))).toBe(true);
      expect(embeddingRows(coord.paths.indexDb, provider.model)).toBe(1);

      // nothing changed: the embedding step is skipped entirely (no provider call, no log)
      const before = log.length;
      const t2 = await watchTick(deps);
      expect(t2.integration.status).toBe("nothing-to-integrate");
      expect(t2.changed).toBe(false);
      expect(t2.embedded).toBe(0);
      expect(provider.calls).toBe(1);
      expect(log.length).toBe(before);

      // a queued automatic mutation: drainQueued() commits + integrates → embeddings refresh
      await coord.enqueue(createMutation("knowledge/second.md", { title: "Second note", sections: { Claim: "Queued mutations are embedded once drained." } }));
      const t3 = await watchTick(deps);
      expect(t3.drained.map((d) => d.state)).toEqual(["COMMITTED"]);
      expect(t3.integration.status).toBe("nothing-to-integrate"); // drainQueued already integrated
      expect(t3.changed).toBe(true);
      expect(t3.embedded).toBe(1);
      expect(provider.calls).toBe(2);
      expect(log.filter((l) => l === "watch: embedded 1 notes")).toHaveLength(2);
      expect(log.some((l) => /^executed mut_\S+: COMMITTED$/.test(l))).toBe(true);
      expect(embeddingRows(coord.paths.indexDb, provider.model)).toBe(2);

      // a forced tick with everything embedded: provider consulted, nothing written, nothing logged
      const before2 = log.length;
      const t4 = await watchTick(deps, { force: true });
      expect(t4.embedded).toBe(0);
      expect(log.length).toBe(before2);

      // embeddings disabled: the loop still drains/integrates, the provider is never touched
      seedNote(env, "knowledge/third.md", { title: "Third note", sections: { Claim: "No embeddings when disabled." } });
      const calls = provider.calls;
      const t5 = await watchTick({ ...deps, embedder: null }, { force: true });
      expect(t5.integration.status).toBe("rebuilt-and-integrated");
      expect(t5.changed).toBe(true);
      expect(t5.embedded).toBe(0);
      expect(provider.calls).toBe(calls);
      expect(embeddingRows(coord.paths.indexDb, provider.model)).toBe(2);
    } finally {
      db.close();
    }
  });

  test("a failing provider is logged at most once per minute and never throws out of the tick", async () => {
    seedNote(env, "knowledge/note.md", { title: "Note", sections: { Claim: "Network is down." } });
    await env.coord.integrate();
    await env.coord.reconcileIndex(); // index the note so ensureEmbeddings has something to embed
    const failing: EmbeddingProvider = {
      model: "flaky-v1",
      dims: 4,
      embed: async () => {
        throw new Error("fetch failed: ECONNREFUSED");
      },
    };
    const log: string[] = [];
    let t = 1_000_000;
    const db = openIndex(env.coord.paths.indexDb);
    try {
      const embedder = createWatchEmbedder({ db, provider: failing, log: (l) => log.push(l), now: () => t });
      expect(await embedder.run()).toBe(0);
      expect(log).toEqual(["watch: embeddings: fetch failed: ECONNREFUSED"]);
      t += EMBED_ERROR_LOG_INTERVAL_MS / 2;
      expect(await embedder.run()).toBe(0);
      expect(log).toHaveLength(1); // throttled
      t += EMBED_ERROR_LOG_INTERVAL_MS / 2;
      expect(await embedder.run()).toBe(0);
      expect(log).toHaveLength(2); // a minute has passed

      // inside a tick the failure is swallowed and the tick still reports its integration result
      const coord = env.coord as Env["coord"] & { drainQueued(): Promise<import("../../src/core/types").ExecutionResult[]> };
      const r = await watchTick({ coord, embedder, log: (l) => log.push(l) }, { force: true });
      expect(r.embedded).toBe(0);
      expect(r.integration.status).toBe("nothing-to-integrate");
    } finally {
      db.close();
    }
  });

  test("resolveWatchProvider: a provider that cannot be created disables embeddings with one warning", () => {
    const log: string[] = [];
    // openrouter embeddings without a key: the real factory throws, the watch keeps running without embeddings
    const p = resolveWatchProvider(() => createEmbeddingProvider({ BRAIN_EMBEDDINGS: "openrouter" }), (l) => log.push(l));
    expect(p).toBeNull();
    expect(log).toEqual(["watch: embeddings disabled: OPENROUTER_API_KEY is required for BRAIN_EMBEDDINGS=openrouter"]);

    const ok = resolveWatchProvider(() => createEmbeddingProvider({ BRAIN_EMBEDDINGS: "hashing" }), (l) => log.push(l));
    expect(ok).toBeInstanceOf(HashingEmbeddingProvider);
    expect(log).toHaveLength(1);
  });
});
