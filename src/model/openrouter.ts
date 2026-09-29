/**
 * OpenRouter adapters (OpenAI-compatible HTTP API, zero dependencies).
 *
 *   - `OpenRouterModelProvider`     → POST {baseUrl}/chat/completions
 *   - `OpenRouterEmbeddingProvider` → POST {baseUrl}/embeddings
 *
 * Both take an injectable `fetch` so tests never touch the network. Errors
 * are mapped onto the same `ModelProviderError` the Claude adapter uses
 * (retryable for 408/429/5xx and transport failures). There is no
 * `stop_reason: "refusal"` on this API; a content filter surfaces as
 * `finish_reason: "content_filter"` and is raised as `ModelRefusalError`.
 *
 * `OpenRouterModelProvider.stream` sends `stream: true` and parses the SSE
 * body itself (`data: {...}` lines, `[DONE]` terminator, `: OPENROUTER
 * PROCESSING` keep-alive comments). Retries apply to the initial HTTP
 * response only; a failure mid-stream is raised, never retried.
 */
import type { EmbeddingProvider, ModelCompleteInput, ModelProvider } from "../core/types";
import { ModelProviderError, ModelRefusalError } from "./claude";

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
export const DEFAULT_OPENROUTER_MODEL = "anthropic/claude-sonnet-4.5";
export const DEFAULT_OPENROUTER_EMBEDDING_MODEL = "openai/text-embedding-3-small";
export const DEFAULT_OPENROUTER_EMBEDDING_DIMS = 1536;

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export type ReasoningEffort = "low" | "medium" | "high";

export interface OpenRouterCommonOptions {
  apiKey: string;
  baseUrl?: string;
  fetch?: FetchLike;
  /** Optional attribution headers OpenRouter recommends. */
  referer?: string;
  title?: string;
  /** Retries for retryable failures (default 2, exponential backoff from 500 ms). */
  maxRetries?: number;
  /** Injected for tests; default real sleep. */
  sleep?: (ms: number) => Promise<void>;
}

export interface OpenRouterModelOptions extends OpenRouterCommonOptions {
  model?: string;
  maxTokens?: number;
  /** Sent as `reasoning: { effort }` for models that support it; omitted when undefined. */
  reasoningEffort?: ReasoningEffort;
  /** Called when the response was cut off by max_tokens. */
  warn?: (message: string) => void;
}

function headersFor(opts: OpenRouterCommonOptions): Record<string, string> {
  const h: Record<string, string> = {
    Authorization: `Bearer ${opts.apiKey}`,
    "Content-Type": "application/json",
  };
  if (opts.referer) h["HTTP-Referer"] = opts.referer;
  if (opts.title) h["X-Title"] = opts.title;
  return h;
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/**
 * POST `body` as JSON with retries (retryable status or transport failure)
 * and resolve with the successful `Response`; a non-retryable or exhausted
 * failure is raised as `ModelProviderError`.
 */
async function post(opts: OpenRouterCommonOptions, path: string, body: unknown): Promise<Response> {
  const doFetch = opts.fetch ?? ((input, init) => fetch(input, init));
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const maxRetries = opts.maxRetries ?? 2;
  const url = `${(opts.baseUrl ?? OPENROUTER_BASE_URL).replace(/\/+$/, "")}${path}`;
  let attempt = 0;
  for (;;) {
    let res: Response;
    try {
      res = await doFetch(url, { method: "POST", headers: headersFor(opts), body: JSON.stringify(body) });
    } catch (e) {
      if (attempt < maxRetries) {
        await sleep(500 * 2 ** attempt);
        attempt += 1;
        continue;
      }
      throw new ModelProviderError(`openrouter: request failed: ${(e as Error).message}`, { retryable: true, cause: e });
    }
    if (res.ok) return res;
    const text = await res.text().catch(() => "");
    const retryable = isRetryableStatus(res.status);
    if (retryable && attempt < maxRetries) {
      const retryAfter = Number(res.headers.get("retry-after"));
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 500 * 2 ** attempt);
      attempt += 1;
      continue;
    }
    let detail = text;
    try {
      const j = JSON.parse(text);
      detail = j?.error?.message ?? text;
    } catch {}
    throw new ModelProviderError(`openrouter: HTTP ${res.status}: ${detail}`.trim(), { retryable, status: res.status });
  }
}

async function postJson(opts: OpenRouterCommonOptions, path: string, body: unknown): Promise<any> {
  const res = await post(opts, path, body);
  try {
    return await res.json();
  } catch (e) {
    throw new ModelProviderError("openrouter: invalid JSON response", { retryable: false, status: res.status, cause: e });
  }
}

/** A 200 response can still carry `{ error: {...} }` (e.g. out of credits). */
function errorEnvelope(json: any, prefix = "openrouter"): ModelProviderError | null {
  if (!json?.error) return null;
  const code = Number(json.error.code) || 0;
  return new ModelProviderError(`${prefix}: ${json.error.message ?? JSON.stringify(json.error)}`, {
    retryable: isRetryableStatus(code),
    status: code || undefined,
  });
}

/**
 * Parse an OpenAI-style SSE body: events are separated by a blank line; each
 * `data:` line carries one JSON chunk; `: ...` lines are comments (OpenRouter
 * sends `: OPENROUTER PROCESSING` keep-alives); `data: [DONE]` terminates.
 * `onChunk` receives each parsed JSON object in order.
 */
export async function readSseJson(body: ReadableStream<Uint8Array>, onChunk: (chunk: any) => void): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let done = false;
  const handleEvent = (raw: string): void => {
    if (done) return;
    const data: string[] = [];
    for (const line of raw.split("\n")) {
      if (line.startsWith(":")) continue; // comment / keep-alive
      if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    }
    if (data.length === 0) return;
    const payload = data.join("\n");
    if (payload.trim() === "[DONE]") {
      done = true;
      return;
    }
    let json: unknown;
    try {
      json = JSON.parse(payload);
    } catch (e) {
      throw new ModelProviderError(`openrouter: malformed stream chunk: ${payload.slice(0, 200)}`, { retryable: false, cause: e });
    }
    onChunk(json);
  };
  try {
    for (;;) {
      const { value, done: eof } = await reader.read();
      buffer += eof ? decoder.decode() : decoder.decode(value, { stream: true });
      buffer = buffer.replace(/\r\n/g, "\n");
      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        handleEvent(buffer.slice(0, sep));
        buffer = buffer.slice(sep + 2);
        if (done) return;
      }
      if (eof) break;
    }
    // A final event without a trailing blank line.
    if (buffer.trim() !== "") handleEvent(buffer);
  } finally {
    reader.cancel().catch(() => {});
  }
}

/** Flatten OpenAI-style message content (string or array of text parts). */
function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (typeof p === "string" ? p : typeof p?.text === "string" ? p.text : ""))
      .join("");
  }
  return "";
}

export class OpenRouterModelProvider implements ModelProvider {
  readonly model: string;
  private readonly opts: OpenRouterModelOptions;

  constructor(opts: OpenRouterModelOptions) {
    if (!opts.apiKey) throw new Error("OpenRouterModelProvider: apiKey is required");
    this.opts = opts;
    this.model = opts.model ?? DEFAULT_OPENROUTER_MODEL;
  }

  private buildBody(input: ModelCompleteInput): Record<string, unknown> {
    const messages: { role: string; content: string }[] = [];
    if (input.system && input.system.trim() !== "") messages.push({ role: "system", content: input.system });
    for (const m of input.messages) messages.push({ role: m.role, content: m.content });
    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: input.maxTokens ?? this.opts.maxTokens ?? 16000,
      messages,
    };
    if (this.opts.reasoningEffort) body.reasoning = { effort: this.opts.reasoningEffort };
    return body;
  }

  private finish(finishReason: unknown, text: string, maxTokens: unknown): string {
    if (finishReason === "content_filter") throw new ModelRefusalError("content_filter");
    if (finishReason === "length") this.opts.warn?.(`openrouter: response truncated by max_tokens (${maxTokens})`);
    return text;
  }

  async complete(input: ModelCompleteInput): Promise<string> {
    const body = this.buildBody(input);
    const json = await postJson(this.opts, "/chat/completions", body);
    const envelope = errorEnvelope(json);
    if (envelope) throw envelope;
    const choice = json?.choices?.[0];
    if (!choice) throw new ModelProviderError("openrouter: response had no choices", { retryable: false });
    return this.finish(choice.finish_reason, contentToText(choice.message?.content), body.max_tokens);
  }

  /**
   * Streaming variant (`stream: true`): forwards `choices[0].delta.content`
   * of each chunk to `onDelta` and resolves with the concatenation. Content
   * filter / length are read from the last chunk's `finish_reason`; an
   * `error` object in any chunk is raised as `ModelProviderError`.
   */
  async stream(input: ModelCompleteInput, onDelta: (text: string) => void): Promise<string> {
    const body: Record<string, unknown> = { ...this.buildBody(input), stream: true };
    const res = await post(this.opts, "/chat/completions", body);
    if ((res.headers.get("content-type") ?? "").includes("application/json")) {
      // Not an event stream: an error envelope (or a non-streaming reply) came back as JSON.
      let json: any;
      try {
        json = await res.json();
      } catch (e) {
        throw new ModelProviderError("openrouter: invalid JSON response", { retryable: false, status: res.status, cause: e });
      }
      const envelope = errorEnvelope(json);
      if (envelope) throw envelope;
      const choice = json?.choices?.[0];
      if (!choice) throw new ModelProviderError("openrouter: response had no choices", { retryable: false });
      const text = contentToText(choice.message?.content);
      if (text !== "") onDelta(text);
      return this.finish(choice.finish_reason, text, body.max_tokens);
    }
    if (!res.body) throw new ModelProviderError("openrouter: empty response body", { retryable: false, status: res.status });
    let text = "";
    let finishReason: unknown;
    let sawChoice = false;
    await readSseJson(res.body, (chunk) => {
      const envelope = errorEnvelope(chunk);
      if (envelope) throw envelope;
      const choice = chunk?.choices?.[0];
      if (!choice) return; // e.g. the trailing usage-only chunk
      sawChoice = true;
      const envelopeInChoice = errorEnvelope(choice);
      if (envelopeInChoice) throw envelopeInChoice;
      const delta = choice.delta?.content;
      if (typeof delta === "string" && delta !== "") {
        text += delta;
        onDelta(delta);
      }
      if (choice.finish_reason != null) finishReason = choice.finish_reason;
    });
    if (!sawChoice) throw new ModelProviderError("openrouter: stream had no choices", { retryable: false });
    return this.finish(finishReason, text, body.max_tokens);
  }
}

export interface OpenRouterEmbeddingOptions extends OpenRouterCommonOptions {
  model?: string;
  /** Must match the model's output size; verified on the first response. */
  dims?: number;
  /** Texts per request (default 64). */
  batchSize?: number;
}

export class OpenRouterEmbeddingProvider implements EmbeddingProvider {
  readonly model: string;
  readonly dims: number;
  private readonly opts: OpenRouterEmbeddingOptions;

  constructor(opts: OpenRouterEmbeddingOptions) {
    if (!opts.apiKey) throw new Error("OpenRouterEmbeddingProvider: apiKey is required");
    this.opts = opts;
    this.model = opts.model ?? DEFAULT_OPENROUTER_EMBEDDING_MODEL;
    this.dims = opts.dims ?? DEFAULT_OPENROUTER_EMBEDDING_DIMS;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    const out: Float32Array[] = new Array(texts.length);
    const batch = Math.max(1, this.opts.batchSize ?? 64);
    for (let start = 0; start < texts.length; start += batch) {
      const slice = texts.slice(start, start + batch);
      const json = await postJson(this.opts, "/embeddings", { model: this.model, input: slice });
      if (json?.error) {
        throw new ModelProviderError(`openrouter embeddings: ${json.error.message ?? JSON.stringify(json.error)}`, { retryable: false });
      }
      const data: any[] = Array.isArray(json?.data) ? json.data : [];
      if (data.length !== slice.length) {
        throw new ModelProviderError(`openrouter embeddings: expected ${slice.length} vectors, got ${data.length}`, { retryable: false });
      }
      for (let i = 0; i < data.length; i += 1) {
        const d = data[i];
        const idx = typeof d?.index === "number" ? d.index : i;
        const vec = d?.embedding;
        if (!Array.isArray(vec)) throw new ModelProviderError("openrouter embeddings: missing embedding array", { retryable: false });
        if (vec.length !== this.dims) {
          throw new ModelProviderError(
            `openrouter embeddings: model ${this.model} returned ${vec.length} dims but provider is configured for ${this.dims}; set BRAIN_EMBEDDING_DIMS=${vec.length}`,
            { retryable: false },
          );
        }
        out[start + idx] = Float32Array.from(vec as number[]);
      }
    }
    return out;
  }
}
