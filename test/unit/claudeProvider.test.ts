import { describe, test, expect } from "bun:test";
import Anthropic from "@anthropic-ai/sdk";
import { ClaudeModelProvider, DEFAULT_MODEL, ModelProviderError, ModelRefusalError, type MessagesClient } from "../../src/model/claude";
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
