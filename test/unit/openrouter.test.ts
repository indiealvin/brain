import { describe, test, expect } from "bun:test";
import { OpenRouterEmbeddingProvider, OpenRouterModelProvider } from "../../src/model/openrouter";
import { createEmbeddingProvider, createModelProvider, resolveProviderKind } from "../../src/model/index";
import { ModelProviderError, ModelRefusalError } from "../../src/model/claude";
import { ClaudeModelProvider } from "../../src/model/claude";

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function fakeFetch(handler: (url: string, init: RequestInit, n: number) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit; body: any }[] = [];
  const fn = async (url: string, init: RequestInit) => {
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, init, body });
    return handler(url, init, calls.length);
  };
  return { fn, calls };
}

const noSleep = async () => {};

describe("OpenRouterModelProvider", () => {
  test("sends an OpenAI-compatible chat request and returns the text", async () => {
    const f = fakeFetch(() => jsonResponse({ choices: [{ message: { role: "assistant", content: "hello back" }, finish_reason: "stop" }] }));
    const p = new OpenRouterModelProvider({ apiKey: "k", model: "anthropic/claude-sonnet-4.5", fetch: f.fn, reasoningEffort: "medium", title: "brain" });
    const out = await p.complete({ system: "SYS", messages: [{ role: "user", content: "hi" }], maxTokens: 123 });
    expect(out).toBe("hello back");
    expect(f.calls.length).toBe(1);
    const c = f.calls[0]!;
    expect(c.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect((c.init.headers as Record<string, string>).Authorization).toBe("Bearer k");
    expect((c.init.headers as Record<string, string>)["X-Title"]).toBe("brain");
    expect(c.body).toEqual({
      model: "anthropic/claude-sonnet-4.5",
      max_tokens: 123,
      messages: [
        { role: "system", content: "SYS" },
        { role: "user", content: "hi" },
      ],
      reasoning: { effort: "medium" },
    });
  });

  test("omits the system message when blank and reasoning when unset; flattens array content", async () => {
    const f = fakeFetch(() => jsonResponse({ choices: [{ message: { content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }, finish_reason: "stop" }] }));
    const p = new OpenRouterModelProvider({ apiKey: "k", fetch: f.fn });
    expect(await p.complete({ system: "  ", messages: [{ role: "user", content: "x" }] })).toBe("ab");
    expect(f.calls[0]!.body.messages).toEqual([{ role: "user", content: "x" }]);
    expect("reasoning" in f.calls[0]!.body).toBe(false);
    expect(f.calls[0]!.body.max_tokens).toBe(16000);
  });

  test("retries 429/5xx then succeeds; does not retry 400", async () => {
    let n = 0;
    const f = fakeFetch(() => {
      n += 1;
      if (n === 1) return jsonResponse({ error: { message: "slow down" } }, 429, { "retry-after": "0" });
      if (n === 2) return jsonResponse({ error: { message: "oops" } }, 503);
      return jsonResponse({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] });
    });
    const p = new OpenRouterModelProvider({ apiKey: "k", fetch: f.fn, sleep: noSleep, maxRetries: 2 });
    expect(await p.complete({ system: "s", messages: [{ role: "user", content: "u" }] })).toBe("ok");
    expect(f.calls.length).toBe(3);

    const g = fakeFetch(() => jsonResponse({ error: { message: "bad model" } }, 400));
    const q = new OpenRouterModelProvider({ apiKey: "k", fetch: g.fn, sleep: noSleep });
    const err = await q.complete({ system: "s", messages: [{ role: "user", content: "u" }] }).catch((e) => e);
    expect(err).toBeInstanceOf(ModelProviderError);
    expect(err.retryable).toBe(false);
    expect(err.status).toBe(400);
    expect(err.message).toContain("bad model");
    expect(g.calls.length).toBe(1);
  });

  test("exhausted retries surface as retryable ModelProviderError", async () => {
    const f = fakeFetch(() => jsonResponse({ error: { message: "down" } }, 500));
    const p = new OpenRouterModelProvider({ apiKey: "k", fetch: f.fn, sleep: noSleep, maxRetries: 1 });
    const err = await p.complete({ system: "s", messages: [{ role: "user", content: "u" }] }).catch((e) => e);
    expect(err).toBeInstanceOf(ModelProviderError);
    expect(err.retryable).toBe(true);
    expect(f.calls.length).toBe(2);
  });

  test("content_filter → ModelRefusalError; length → warn callback", async () => {
    const f = fakeFetch(() => jsonResponse({ choices: [{ message: { content: "" }, finish_reason: "content_filter" }] }));
    const p = new OpenRouterModelProvider({ apiKey: "k", fetch: f.fn });
    await expect(p.complete({ system: "s", messages: [{ role: "user", content: "u" }] })).rejects.toBeInstanceOf(ModelRefusalError);

    const warnings: string[] = [];
    const g = fakeFetch(() => jsonResponse({ choices: [{ message: { content: "partial" }, finish_reason: "length" }] }));
    const q = new OpenRouterModelProvider({ apiKey: "k", fetch: g.fn, warn: (m) => warnings.push(m) });
    expect(await q.complete({ system: "s", messages: [{ role: "user", content: "u" }] })).toBe("partial");
    expect(warnings.length).toBe(1);
  });

  test("200 with an error envelope is raised", async () => {
    const f = fakeFetch(() => jsonResponse({ error: { message: "no credits", code: 402 } }));
    const p = new OpenRouterModelProvider({ apiKey: "k", fetch: f.fn });
    const err = await p.complete({ system: "s", messages: [{ role: "user", content: "u" }] }).catch((e) => e);
    expect(err).toBeInstanceOf(ModelProviderError);
    expect(err.message).toContain("no credits");
  });
});

describe("OpenRouterEmbeddingProvider", () => {
  test("batches inputs, orders by index, validates dims", async () => {
    const f = fakeFetch((_u, _i, n) => {
      const body = JSON.parse(String(_i.body));
      const data = (body.input as string[]).map((t, i) => ({ index: i, embedding: [t.length, n, 0] })).reverse();
      return jsonResponse({ data, model: body.model });
    });
    const p = new OpenRouterEmbeddingProvider({ apiKey: "k", model: "m", dims: 3, batchSize: 2, fetch: f.fn });
    const vecs = await p.embed(["a", "bb", "ccc"]);
    expect(f.calls.length).toBe(2);
    expect(f.calls[0]!.url).toBe("https://openrouter.ai/api/v1/embeddings");
    expect(f.calls[0]!.body).toEqual({ model: "m", input: ["a", "bb"] });
    expect(Array.from(vecs[0]!)).toEqual([1, 1, 0]);
    expect(Array.from(vecs[1]!)).toEqual([2, 1, 0]);
    expect(Array.from(vecs[2]!)).toEqual([3, 2, 0]);
    expect(vecs[0]).toBeInstanceOf(Float32Array);
  });

  test("dims mismatch is a clear error naming the env var", async () => {
    const f = fakeFetch(() => jsonResponse({ data: [{ index: 0, embedding: [1, 2, 3, 4] }] }));
    const p = new OpenRouterEmbeddingProvider({ apiKey: "k", dims: 3, fetch: f.fn });
    const err = await p.embed(["x"]).catch((e) => e);
    expect(err).toBeInstanceOf(ModelProviderError);
    expect(err.message).toContain("BRAIN_EMBEDDING_DIMS=4");
  });
});

describe("provider factories", () => {
  test("resolveProviderKind: explicit wins, else openrouter only when it is the only key", () => {
    expect(resolveProviderKind({})).toBe("anthropic");
    expect(resolveProviderKind({ OPENROUTER_API_KEY: "o" })).toBe("openrouter");
    expect(resolveProviderKind({ OPENROUTER_API_KEY: "o", ANTHROPIC_API_KEY: "a" })).toBe("anthropic");
    expect(resolveProviderKind({ OPENROUTER_API_KEY: "o", BRAIN_MODEL_PROVIDER: "anthropic" })).toBe("anthropic");
    expect(resolveProviderKind({ BRAIN_MODEL_PROVIDER: "openrouter", OPENROUTER_API_KEY: "o" })).toBe("openrouter");
    expect(() => resolveProviderKind({ BRAIN_MODEL_PROVIDER: "gpt" })).toThrow();
  });

  test("createModelProvider builds the right adapter from env", () => {
    const or = createModelProvider({ OPENROUTER_API_KEY: "o", BRAIN_MODEL: "x/y", BRAIN_EFFORT: "low" });
    expect(or).toBeInstanceOf(OpenRouterModelProvider);
    expect((or as OpenRouterModelProvider).model).toBe("x/y");
    expect(() => createModelProvider({ OPENROUTER_API_KEY: "o", BRAIN_EFFORT: "xhigh" })).toThrow();
    expect(() => createModelProvider({ BRAIN_MODEL_PROVIDER: "openrouter" })).toThrow("OPENROUTER_API_KEY");
    expect(createModelProvider({ ANTHROPIC_API_KEY: "a" })).toBeInstanceOf(ClaudeModelProvider);
  });

  test("createEmbeddingProvider", () => {
    const e = createEmbeddingProvider({ BRAIN_EMBEDDINGS: "openrouter", OPENROUTER_API_KEY: "o", BRAIN_EMBEDDING_DIMS: "8", BRAIN_EMBEDDING_MODEL: "m" });
    expect(e).toBeInstanceOf(OpenRouterEmbeddingProvider);
    expect(e.dims).toBe(8);
    expect(e.model).toBe("m");
    expect(() => createEmbeddingProvider({ BRAIN_EMBEDDINGS: "openrouter" })).toThrow("OPENROUTER_API_KEY");
    expect(() => createEmbeddingProvider({ BRAIN_EMBEDDINGS: "voyage" })).toThrow();
    expect(createEmbeddingProvider({}).model).toBe("hashing-v1");
  });
});
