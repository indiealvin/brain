import { describe, test, expect } from "bun:test";
import { OpenRouterEmbeddingProvider, OpenRouterModelProvider, readSseJson } from "../../src/model/openrouter";
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

/** A 200 text/event-stream Response whose body delivers `chunks` as separate reads. */
function sseResponse(chunks: string[], status = 200): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
  return new Response(body, { status, headers: { "content-type": "text/event-stream" } });
}

const sse = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;
const delta = (content: string | undefined, finish_reason: string | null = null) => ({ id: "gen", choices: [{ index: 0, delta: content === undefined ? { role: "assistant" } : { content }, finish_reason }] });

describe("OpenRouterModelProvider.stream", () => {
  test("sends stream: true and forwards deltas across chunk boundaries, ignoring comments and [DONE]", async () => {
    const events = [
      ": OPENROUTER PROCESSING\n\n",
      sse(delta(undefined)),
      sse(delta("Hel")),
      sse(delta("lo, ")),
      ": OPENROUTER PROCESSING\n\n",
      sse(delta("world")),
      sse({ id: "gen", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
      sse({ id: "gen", choices: [], usage: { prompt_tokens: 1, completion_tokens: 3 } }),
      "data: [DONE]\n\n",
    ].join("");
    // split the byte stream in the middle of a `data:` line (inside "choices")
    const cut = events.indexOf('"cho', events.indexOf("Hel")) + 2;
    const cut2 = events.indexOf("world") + 2;
    const chunks = [events.slice(0, cut), events.slice(cut, cut2), events.slice(cut2)];
    expect(chunks.join("")).toBe(events);

    const f = fakeFetch(() => sseResponse(chunks));
    const p = new OpenRouterModelProvider({ apiKey: "k", model: "m", fetch: f.fn, reasoningEffort: "low" });
    const deltas: string[] = [];
    const out = await p.stream({ system: "SYS", messages: [{ role: "user", content: "hi" }], maxTokens: 99 }, (d) => deltas.push(d));
    expect(deltas).toEqual(["Hel", "lo, ", "world"]);
    expect(out).toBe("Hello, world");
    expect(f.calls.length).toBe(1);
    expect(f.calls[0]!.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(f.calls[0]!.body).toEqual({
      model: "m",
      max_tokens: 99,
      messages: [
        { role: "system", content: "SYS" },
        { role: "user", content: "hi" },
      ],
      reasoning: { effort: "low" },
      stream: true,
    });
  });

  test("complete() never sends stream", async () => {
    const f = fakeFetch(() => jsonResponse({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }));
    await new OpenRouterModelProvider({ apiKey: "k", fetch: f.fn }).complete({ system: "s", messages: [{ role: "user", content: "u" }] });
    expect("stream" in f.calls[0]!.body).toBe(false);
  });

  test("CRLF line endings and a final event without a trailing blank line are handled", async () => {
    const raw = `data: ${JSON.stringify(delta("a"))}\r\n\r\ndata: ${JSON.stringify(delta("b", "stop"))}\r\n`;
    const f = fakeFetch(() => sseResponse([raw]));
    const deltas: string[] = [];
    const out = await new OpenRouterModelProvider({ apiKey: "k", fetch: f.fn }).stream({ system: "", messages: [{ role: "user", content: "u" }] }, (d) => deltas.push(d));
    expect(deltas).toEqual(["a", "b"]);
    expect(out).toBe("ab");
  });

  test("mid-stream error object → ModelProviderError (deltas before it were delivered)", async () => {
    const f = fakeFetch(() => sseResponse([sse(delta("partial")), sse({ error: { message: "provider overloaded", code: 502 } }), "data: [DONE]\n\n"]));
    const deltas: string[] = [];
    const err = await new OpenRouterModelProvider({ apiKey: "k", fetch: f.fn })
      .stream({ system: "s", messages: [{ role: "user", content: "u" }] }, (d) => deltas.push(d))
      .catch((e) => e);
    expect(err).toBeInstanceOf(ModelProviderError);
    expect(err.message).toContain("provider overloaded");
    expect(err.retryable).toBe(true);
    expect(err.status).toBe(502);
    expect(deltas).toEqual(["partial"]);
    expect(f.calls.length).toBe(1); // never retried mid-stream
  });

  test("finish_reason content_filter → ModelRefusalError; length → warn", async () => {
    const f = fakeFetch(() => sseResponse([sse(delta("x")), sse({ choices: [{ index: 0, delta: {}, finish_reason: "content_filter" }] }), "data: [DONE]\n\n"]));
    await expect(new OpenRouterModelProvider({ apiKey: "k", fetch: f.fn }).stream({ system: "s", messages: [{ role: "user", content: "u" }] }, () => {})).rejects.toBeInstanceOf(ModelRefusalError);

    const warnings: string[] = [];
    const g = fakeFetch(() => sseResponse([sse(delta("cut ")), sse(delta("off", "length")), "data: [DONE]\n\n"]));
    const out = await new OpenRouterModelProvider({ apiKey: "k", fetch: g.fn, warn: (m) => warnings.push(m) }).stream({ system: "s", messages: [{ role: "user", content: "u" }] }, () => {});
    expect(out).toBe("cut off");
    expect(warnings.length).toBe(1);
  });

  test("initial HTTP failures are retried, then a JSON error envelope on 200 is raised", async () => {
    let n = 0;
    const f = fakeFetch(() => {
      n += 1;
      if (n === 1) return jsonResponse({ error: { message: "busy" } }, 503);
      return sseResponse([sse(delta("ok", "stop")), "data: [DONE]\n\n"]);
    });
    const p = new OpenRouterModelProvider({ apiKey: "k", fetch: f.fn, sleep: noSleep });
    expect(await p.stream({ system: "s", messages: [{ role: "user", content: "u" }] }, () => {})).toBe("ok");
    expect(f.calls.length).toBe(2);

    const g = fakeFetch(() => jsonResponse({ error: { message: "no credits", code: 402 } }));
    const err = await new OpenRouterModelProvider({ apiKey: "k", fetch: g.fn }).stream({ system: "s", messages: [{ role: "user", content: "u" }] }, () => {}).catch((e) => e);
    expect(err).toBeInstanceOf(ModelProviderError);
    expect(err.message).toContain("no credits");
  });

  test("readSseJson: malformed JSON chunk is a non-retryable ModelProviderError", async () => {
    const body = sseResponse(["data: {not json\n\n"]).body!;
    const err = await readSseJson(body, () => {}).catch((e) => e);
    expect(err).toBeInstanceOf(ModelProviderError);
    expect(err.retryable).toBe(false);
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
