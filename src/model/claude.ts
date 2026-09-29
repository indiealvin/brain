/**
 * Claude adapter for `ModelProvider` (spec §60: Phases 8–11 sit behind the
 * ModelProvider seam; this is the production adapter).
 *
 * Request shape (Messages API, non-streaming):
 *   - `model` defaults to `claude-opus-5-5`, overridable via the constructor
 *     or `BRAIN_MODEL` (see src/model/index.ts).
 *   - `system` is sent as a single text block with `cache_control: ephemeral`
 *     because the extractor/planner system prompts are stable across calls
 *     and sit first in the cached prefix. An empty system prompt is omitted
 *     entirely (the API rejects empty text blocks).
 *   - `output_config.effort` controls thinking depth. No `thinking` parameter
 *     is sent (adaptive thinking is always on for this model family), no
 *     sampling parameters, no assistant prefill, no forced tool_choice.
 *
 * Credentials are resolved by the SDK from the environment
 * (`ANTHROPIC_API_KEY` or an `ant auth login` profile); nothing is hardcoded.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { ModelProvider } from "../core/types";

export const DEFAULT_MODEL = "claude-opus-5-5";
export const DEFAULT_MAX_TOKENS = 16000;

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/** The slice of the SDK client this adapter uses; tests inject a fake. */
export interface MessagesClient {
  messages: {
    create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message>;
  };
}

export interface ClaudeModelProviderOptions {
  model?: string;
  client?: MessagesClient;
  effort?: Effort;
  /** Receives non-fatal warnings (e.g. output truncated at max_tokens). Default: console.warn. */
  warn?: (message: string) => void;
}

/** Transport / API failure. `retryable` is true for 429, 5xx and connection errors. */
export class ModelProviderError extends Error {
  readonly retryable: boolean;
  readonly status: number | undefined;
  constructor(message: string, opts: { retryable: boolean; status?: number; cause?: unknown }) {
    super(message, { cause: opts.cause });
    this.name = "ModelProviderError";
    this.retryable = opts.retryable;
    this.status = opts.status;
  }
}

/** The model declined the request (`stop_reason: "refusal"`). Never retryable. */
export class ModelRefusalError extends Error {
  readonly category: string | null;
  readonly explanation: string | null;
  constructor(category: string | null | undefined, explanation?: string | null) {
    super(`model refused the request${category ? ` (category: ${category})` : ""}`);
    this.name = "ModelRefusalError";
    this.category = category ?? null;
    this.explanation = explanation ?? null;
  }
}

function wrapSdkError(e: unknown): ModelProviderError {
  const msg = e instanceof Error ? e.message : String(e);
  if (e instanceof Anthropic.RateLimitError) return new ModelProviderError(`rate limited: ${msg}`, { retryable: true, status: 429, cause: e });
  if (e instanceof Anthropic.AuthenticationError) return new ModelProviderError(`authentication failed: ${msg}`, { retryable: false, status: 401, cause: e });
  if (e instanceof Anthropic.BadRequestError) return new ModelProviderError(`bad request: ${msg}`, { retryable: false, status: 400, cause: e });
  if (e instanceof Anthropic.APIConnectionError) return new ModelProviderError(`connection error: ${msg}`, { retryable: true, cause: e });
  if (e instanceof Anthropic.InternalServerError) return new ModelProviderError(`server error: ${msg}`, { retryable: true, status: e.status, cause: e });
  if (e instanceof Anthropic.APIError) {
    const status = typeof e.status === "number" ? e.status : undefined;
    return new ModelProviderError(`api error${status ? ` ${status}` : ""}: ${msg}`, { retryable: status !== undefined && status >= 500, status, cause: e });
  }
  return new ModelProviderError(`model call failed: ${msg}`, { retryable: false, cause: e });
}

export class ClaudeModelProvider implements ModelProvider {
  readonly model: string;
  readonly effort: Effort;
  private readonly client: MessagesClient;
  private readonly warn: (message: string) => void;

  constructor(opts: ClaudeModelProviderOptions = {}) {
    this.model = opts.model ?? DEFAULT_MODEL;
    this.effort = opts.effort ?? "high";
    this.client = opts.client ?? new Anthropic();
    this.warn = opts.warn ?? ((m) => console.warn(m));
  }

  async complete(input: {
    system: string;
    messages: { role: "user" | "assistant"; content: string }[];
    maxTokens?: number;
  }): Promise<string> {
    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model: this.model,
      max_tokens: input.maxTokens ?? DEFAULT_MAX_TOKENS,
      messages: input.messages.map((m) => ({ role: m.role, content: m.content })),
      output_config: { effort: this.effort },
    };
    if (input.system.trim() !== "") {
      params.system = [{ type: "text", text: input.system, cache_control: { type: "ephemeral" } }];
    }

    let response: Anthropic.Message;
    try {
      response = await this.client.messages.create(params);
    } catch (e) {
      throw wrapSdkError(e);
    }

    if (response.stop_reason === "refusal") {
      throw new ModelRefusalError(response.stop_details?.category, response.stop_details?.explanation);
    }
    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    if (response.stop_reason === "max_tokens") {
      this.warn(`ClaudeModelProvider: output truncated at max_tokens=${params.max_tokens} (model ${this.model}); the response may be incomplete`);
    }
    return text;
  }
}
