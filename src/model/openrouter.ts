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
 */
import type { EmbeddingProvider, ModelProvider } from "../core/types";
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

async function postJson(opts: OpenRouterCommonOptions, path: string, body: unknown): Promise<any> {
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
    if (res.ok) {
      try {
        return await res.json();
      } catch (e) {
        throw new ModelProviderError("openrouter: invalid JSON response", { retryable: false, status: res.status, cause: e });
      }
    }
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

  async complete(input: {
    system: string;
    messages: { role: "user" | "assistant"; content: string }[];
    maxTokens?: number;
  }): Promise<string> {
    const messages: { role: string; content: string }[] = [];
    if (input.system && input.system.trim() !== "") messages.push({ role: "system", content: input.system });
    for (const m of input.messages) messages.push({ role: m.role, content: m.content });
    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: input.maxTokens ?? this.opts.maxTokens ?? 16000,
      messages,
    };
    if (this.opts.reasoningEffort) body.reasoning = { effort: this.opts.reasoningEffort };

    const json = await postJson(this.opts, "/chat/completions", body);
    if (json?.error) {
      throw new ModelProviderError(`openrouter: ${json.error.message ?? JSON.stringify(json.error)}`, {
        retryable: isRetryableStatus(Number(json.error.code) || 0),
        status: Number(json.error.code) || undefined,
      });
    }
    const choice = json?.choices?.[0];
    if (!choice) throw new ModelProviderError("openrouter: response had no choices", { retryable: false });
    if (choice.finish_reason === "content_filter") throw new ModelRefusalError("content_filter");
    const text = contentToText(choice.message?.content);
    if (choice.finish_reason === "length") {
      this.opts.warn?.(`openrouter: response truncated by max_tokens (${body.max_tokens})`);
    }
    return text;
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
