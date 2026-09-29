import { describe, test, expect } from "bun:test";
import Anthropic from "@anthropic-ai/sdk";
import { ClaudeModelProvider, DEFAULT_MODEL, ModelProviderError, ModelRefusalError, type MessagesClient, type TextStream } from "../../src/model/claude";
import { createEmbeddingProvider, createModelProvider } from "../../src/model";

type CreateParams = Anthropic.MessageCreateParamsNonStreaming;

function fakeClient(
  respond: (params: CreateParams) => Partial<Anthropic.Message> | Promise<Partial<Anthropic.Message>>,
): { client: MessagesClient; calls: CreateParams[] } {
  const calls: CreateParams[] = [];
  const client = {
    messages: {
      create: async (params: CreateParams) => {
        calls.push(params);
        return (await respond(params)) as Anthropic.Message;
      },
    },
  };
  return { client, calls };
}

const textResponse = (text: string, stop_reason: Anthropic.Message["stop_reason"] = "end_turn"): Partial<Anthropic.Message> => ({
  content: [{ type: "text", text, citations: null }],
  stop_reason,
  stop_details: null,
});

describe("ClaudeModelProvider request shape", () => {
  test("sends model, max_tokens, cached system block, messages, output_config.effort and nothing else", async () => {
    const { client, calls } = fakeClient(() => textResponse("hello"));
    const p = new ClaudeModelProvider({ client, effort: "high" });
    const out = await p.complete({ system: "You are the extractor.", messages: [{ role: "user", content: "turn 1" }] });
    expect(out).toBe("hello");
    expect(calls).toHaveLength(1);
    const req = calls[0]!;
    expect(req.model).toBe("claude-opus-5-5");
    expect(DEFAULT_MODEL).toBe("claude-opus-5-5");
    expect(req.max_tokens).toBe(16000);
    expect(req.system).toEqual([{ type: "text", text: "You are the extractor.", cache_control: { type: "ephemeral" } }]);
    expect(req.messages).toEqual([{ role: "user", content: "turn 1" }]);
    expect(req.output_config).toEqual({ effort: "high" });
    expect("thinking" in req).toBe(false);
    expect("temperature" in req).toBe(false);
    expect("top_p" in req).toBe(false);
    expect("tool_choice" in req).toBe(false);
    expect("tools" in req).toBe(false);
    expect(Object.keys(req).sort()).toEqual(["max_tokens", "messages", "model", "output_config", "system"]);
  });

  test("model, effort and maxTokens are configurable; empty system prompt is omitted", async () => {
    const { client, calls } = fakeClient(() => textResponse("x"));
    const p = new ClaudeModelProvider({ client, model: "claude-sonnet-5-5", effort: "low" });
    await p.complete({ system: "   ", messages: [{ role: "user", content: "hi" }], maxTokens: 512 });
    const req = calls[0]!;
    expect(req.model).toBe("claude-sonnet-5-5");
    expect(req.max_tokens).toBe(512);
    expect(req.output_config).toEqual({ effort: "low" });
    expect("system" in req).toBe(false);
  });

  test("concatenates text blocks only; last assistant turn is never a prefill (messages passed through verbatim)", async () => {
    const { client, calls } = fakeClient(() => ({
      content: [
        { type: "thinking", thinking: "", signature: "" },
        { type: "text", text: "a", citations: null },
        { type: "text", text: "b", citations: null },
      ],
      stop_reason: "end_turn",
      stop_details: null,
    }));
    const p = new ClaudeModelProvider({ client });
    const out = await p.complete({
      system: "s",
      messages: [
        { role: "user", content: "u1" },
        { role: "assistant", content: "a1" },
        { role: "user", content: "u2" },
      ],
    });
    expect(out).toBe("ab");
    expect(calls[0]!.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
  });
});

describe("ClaudeModelProvider stop reasons and errors", () => {
  test("refusal → ModelRefusalError carrying stop_details.category", async () => {
    const { client } = fakeClient(() => ({
      content: [],
      stop_reason: "refusal",
      stop_details: { type: "refusal", category: "cyber", explanation: "declined" },
    }));
    const p = new ClaudeModelProvider({ client });
    const err = await p.complete({ system: "s", messages: [{ role: "user", content: "x" }] }).catch((e) => e);
    expect(err).toBeInstanceOf(ModelRefusalError);
    expect((err as ModelRefusalError).category).toBe("cyber");
    expect((err as ModelRefusalError).explanation).toBe("declined");
  });

  test("max_tokens → returns the partial text and emits a warning", async () => {
    const { client } = fakeClient(() => textResponse("partial", "max_tokens"));
    const warnings: string[] = [];
    const p = new ClaudeModelProvider({ client, warn: (m) => warnings.push(m) });
    expect(await p.complete({ system: "s", messages: [{ role: "user", content: "x" }] })).toBe("partial");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("max_tokens");
  });

  test("SDK errors are wrapped into ModelProviderError with the retryable flag", async () => {
    const headers = new Headers();
    const cases: { err: Error; retryable: boolean; status?: number }[] = [
      { err: new Anthropic.RateLimitError(429, { type: "rate_limit_error" }, "slow down", headers), retryable: true, status: 429 },
      { err: new Anthropic.AuthenticationError(401, { type: "authentication_error" }, "bad key", headers), retryable: false, status: 401 },
      { err: new Anthropic.BadRequestError(400, { type: "invalid_request_error" }, "bad", headers), retryable: false, status: 400 },
      { err: new Anthropic.InternalServerError(503, { type: "overloaded_error" }, "overloaded", headers), retryable: true, status: 503 },
      { err: new Anthropic.APIConnectionError({ message: "ECONNRESET" }), retryable: true },
      { err: new Anthropic.NotFoundError(404, { type: "not_found_error" }, "nope", headers), retryable: false, status: 404 },
    ];
    for (const c of cases) {
      const { client } = fakeClient(() => {
        throw c.err;
      });
      const p = new ClaudeModelProvider({ client });
      const got = await p.complete({ system: "s", messages: [{ role: "user", content: "x" }] }).catch((e) => e);
      expect(got).toBeInstanceOf(ModelProviderError);
      expect((got as ModelProviderError).retryable).toBe(c.retryable);
      expect((got as ModelProviderError).status).toBe(c.status);
      expect((got as ModelProviderError).cause).toBe(c.err);
    }
  });
});

/**
 * Fake `client.messages.stream(params)`: a MessageStream-shaped object whose
 * `finalMessage()` first fires the registered `text` listeners with each delta
 * (after `on("text")` was attached, as the real stream does) then resolves.
 */
function fakeStreamingClient(
  script: (params: CreateParams) => { deltas: string[]; final: Partial<Anthropic.Message> } | { reject: Error },
): { client: MessagesClient; calls: CreateParams[]; createCalls: number } {
  const calls: CreateParams[] = [];
  const state = { createCalls: 0 };
  const client: MessagesClient = {
    messages: {
      create: async () => {
        state.createCalls += 1;
        throw new Error("create must not be used when streaming");
      },
      stream: (params: CreateParams): TextStream => {
        calls.push(params);
        const listeners: ((d: string, snap: string) => void)[] = [];
        return {
          on: (event, listener) => {
            if (event === "text") listeners.push(listener);
          },
          finalMessage: async () => {
            const r = script(params);
            if ("reject" in r) throw r.reject;
            let snapshot = "";
            for (const d of r.deltas) {
              snapshot += d;
              for (const l of listeners) l(d, snapshot);
            }
            return r.final as Anthropic.Message;
          },
        };
      },
    },
  };
  return {
    client,
    calls,
    get createCalls() {
      return state.createCalls;
    },
  };
}

describe("ClaudeModelProvider stream", () => {
  test("forwards each text delta in order and resolves with the final message text; request params match complete()", async () => {
    const f = fakeStreamingClient(() => ({ deltas: ["Hel", "lo, ", "world"], final: textResponse("Hello, world") }));
    const p = new ClaudeModelProvider({ client: f.client, effort: "medium" });
    const deltas: string[] = [];
    const out = await p.stream({ system: "You are the chat.", messages: [{ role: "user", content: "hi" }], maxTokens: 2048 }, (d) => deltas.push(d));
    expect(deltas).toEqual(["Hel", "lo, ", "world"]);
    expect(out).toBe("Hello, world");
    expect(f.createCalls).toBe(0);
    expect(f.calls).toHaveLength(1);
    const req = f.calls[0]!;
    // identical shape to complete(): the SDK helper adds `stream: true` itself
    expect(Object.keys(req).sort()).toEqual(["max_tokens", "messages", "model", "output_config", "system"]);
    expect(req.max_tokens).toBe(2048);
    expect(req.output_config).toEqual({ effort: "medium" });
    expect(req.system).toEqual([{ type: "text", text: "You are the chat.", cache_control: { type: "ephemeral" } }]);
    expect("stream" in req).toBe(false);
  });

  test("final text comes from finalMessage() (text blocks concatenated), not from the deltas", async () => {
    const f = fakeStreamingClient(() => ({
      deltas: ["a", "b"],
      final: {
        content: [
          { type: "thinking", thinking: "", signature: "" },
          { type: "text", text: "a", citations: null },
          { type: "text", text: "b", citations: null },
        ],
        stop_reason: "end_turn",
        stop_details: null,
      },
    }));
    const p = new ClaudeModelProvider({ client: f.client });
    expect(await p.stream({ system: "s", messages: [{ role: "user", content: "x" }] }, () => {})).toBe("ab");
  });

  test("refusal (possibly after deltas) → ModelRefusalError with stop_details", async () => {
    const f = fakeStreamingClient(() => ({
      deltas: ["I was starting to"],
      final: { content: [{ type: "text", text: "I was starting to", citations: null }], stop_reason: "refusal", stop_details: { type: "refusal", category: "cyber", explanation: "declined" } },
    }));
    const p = new ClaudeModelProvider({ client: f.client });
    const deltas: string[] = [];
    const err = await p.stream({ system: "s", messages: [{ role: "user", content: "x" }] }, (d) => deltas.push(d)).catch((e) => e);
    expect(err).toBeInstanceOf(ModelRefusalError);
    expect((err as ModelRefusalError).category).toBe("cyber");
    expect((err as ModelRefusalError).explanation).toBe("declined");
    expect(deltas).toEqual(["I was starting to"]);
  });

  test("max_tokens → partial text returned and a warning emitted", async () => {
    const f = fakeStreamingClient(() => ({ deltas: ["part", "ial"], final: textResponse("partial", "max_tokens") }));
    const warnings: string[] = [];
    const p = new ClaudeModelProvider({ client: f.client, warn: (m) => warnings.push(m) });
    expect(await p.stream({ system: "s", messages: [{ role: "user", content: "x" }] }, () => {})).toBe("partial");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("max_tokens");
  });

  test("SDK errors from the stream are wrapped into ModelProviderError", async () => {
    const headers = new Headers();
    const cases: { err: Error; retryable: boolean; status?: number }[] = [
      { err: new Anthropic.RateLimitError(429, { type: "rate_limit_error" }, "slow down", headers), retryable: true, status: 429 },
      { err: new Anthropic.AuthenticationError(401, { type: "authentication_error" }, "bad key", headers), retryable: false, status: 401 },
      { err: new Anthropic.APIConnectionError({ message: "ECONNRESET" }), retryable: true },
    ];
    for (const c of cases) {
      const f = fakeStreamingClient(() => ({ reject: c.err }));
      const p = new ClaudeModelProvider({ client: f.client });
      const got = await p.stream({ system: "s", messages: [{ role: "user", content: "x" }] }, () => {}).catch((e) => e);
      expect(got).toBeInstanceOf(ModelProviderError);
      expect((got as ModelProviderError).retryable).toBe(c.retryable);
      expect((got as ModelProviderError).status).toBe(c.status);
      expect((got as ModelProviderError).cause).toBe(c.err);
    }
    // an error thrown synchronously by stream() itself is wrapped too
    const sync: MessagesClient = {
      messages: {
        create: async () => textResponse("x") as Anthropic.Message,
        stream: () => {
          throw new Anthropic.BadRequestError(400, { type: "invalid_request_error" }, "bad", headers);
        },
      },
    };
    const got = await new ClaudeModelProvider({ client: sync }).stream({ system: "s", messages: [{ role: "user", content: "x" }] }, () => {}).catch((e) => e);
    expect(got).toBeInstanceOf(ModelProviderError);
    expect((got as ModelProviderError).status).toBe(400);
  });

  test("a client without stream() falls back to complete()", async () => {
    const { client, calls } = fakeClient(() => textResponse("plain"));
    const deltas: string[] = [];
    expect(await new ClaudeModelProvider({ client }).stream({ system: "s", messages: [{ role: "user", content: "x" }] }, (d) => deltas.push(d))).toBe("plain");
    expect(calls).toHaveLength(1);
    expect(deltas).toEqual([]);
  });
});

describe("provider factories", () => {
  test("createModelProvider honors BRAIN_MODEL and BRAIN_EFFORT; defaults otherwise", () => {
    const prevModel = process.env.BRAIN_MODEL;
    const prevEffort = process.env.BRAIN_EFFORT;
    const prevKind = process.env.BRAIN_MODEL_PROVIDER;
    try {
      delete process.env.BRAIN_MODEL;
      delete process.env.BRAIN_EFFORT;
      // bun auto-loads .env; an OPENROUTER_API_KEY there would flip auto-detection.
      process.env.BRAIN_MODEL_PROVIDER = "anthropic";
      const d = createModelProvider() as ClaudeModelProvider;
      expect(d).toBeInstanceOf(ClaudeModelProvider);
      expect(d.model).toBe("claude-opus-5-5");
      expect(d.effort).toBe("high");
      process.env.BRAIN_MODEL = "claude-sonnet-5-5";
      process.env.BRAIN_EFFORT = "medium";
      const c = createModelProvider() as ClaudeModelProvider;
      expect(c.model).toBe("claude-sonnet-5-5");
      expect(c.effort).toBe("medium");
      process.env.BRAIN_EFFORT = "bogus";
      expect(() => createModelProvider()).toThrow(/BRAIN_EFFORT/);
    } finally {
      if (prevModel === undefined) delete process.env.BRAIN_MODEL;
      else process.env.BRAIN_MODEL = prevModel;
      if (prevKind === undefined) delete process.env.BRAIN_MODEL_PROVIDER;
      else process.env.BRAIN_MODEL_PROVIDER = prevKind;
      if (prevEffort === undefined) delete process.env.BRAIN_EFFORT;
      else process.env.BRAIN_EFFORT = prevEffort;
    }
  });

  test("createEmbeddingProvider returns the hashing provider by default and rejects unknown kinds", () => {
    const prev = process.env.BRAIN_EMBEDDINGS;
    const prevKind = process.env.BRAIN_MODEL_PROVIDER;
    try {
      delete process.env.BRAIN_EMBEDDINGS;
      // the default follows the model provider (openrouter → openrouter embeddings); an
      // OPENROUTER_API_KEY in .env would otherwise flip it, so pin anthropic here.
      process.env.BRAIN_MODEL_PROVIDER = "anthropic";
      const e = createEmbeddingProvider();
      expect(e.model).toBe("hashing-v1");
      expect(e.dims).toBe(256);
      process.env.BRAIN_EMBEDDINGS = "voyage";
      expect(() => createEmbeddingProvider()).toThrow(/unknown BRAIN_EMBEDDINGS/);
    } finally {
      if (prev === undefined) delete process.env.BRAIN_EMBEDDINGS;
      else process.env.BRAIN_EMBEDDINGS = prev;
      if (prevKind === undefined) delete process.env.BRAIN_MODEL_PROVIDER;
      else process.env.BRAIN_MODEL_PROVIDER = prevKind;
    }
  });
});
