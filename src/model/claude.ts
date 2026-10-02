/**
 * Claude adapter for `ModelProvider` (spec §60: Phases 8–11 sit behind the
 * ModelProvider seam; this is the production adapter).
 *
 * Request shape (Messages API; `complete` is non-streaming, `stream` uses the
 * SDK's `messages.stream()` helper with the identical parameters):
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
 * Credentials (CR-11, design §10): nothing is hardcoded. `apiKey`, `authToken`
 * and `baseURL` may be passed in; `createModelProvider(env)` fills them from
 * the env it is given.
 *   - Default (the CLI): a missing value is passed to the SDK as `undefined`,
 *     so the SDK resolves it as it always has: `ANTHROPIC_API_KEY`,
 *     `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL` from `process.env`, then its
 *     default credential chain (`ANTHROPIC_PROFILE`, an `ant auth login`
 *     profile on disk, OIDC variables).
 *   - `isolated: true` (the app's private env): the options are the only
 *     source. A missing value is passed as `null` (the SDK reads `process.env`
 *     only for `undefined`), `webhookKey` is `null`, and the default credential
 *     chain is switched off, so a keyless provider fails instead of borrowing
 *     another identity.
 * Known SDK reads that isolated mode does not suppress: the client constructor
 * always reads `ANTHROPIC_CUSTOM_HEADERS` from `process.env` and merges it into
 * every request's headers (applied after the auth headers, so an `x-api-key:`
 * line there would win), and reads `ANTHROPIC_LOG` because no `logLevel` is
 * passed. Both are operator knobs that brain never sets.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { ModelCompleteInput, ModelProvider } from "../core/types";

export const DEFAULT_MODEL = "claude-opus-5-5";
export const DEFAULT_MAX_TOKENS = 16000;

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/**
 * The slice of the SDK's `MessageStream` this adapter uses (`lib/MessageStream.d.ts`):
 * `on("text", (delta, snapshot) => …)` fires per `text_delta`, `finalMessage()`
 * resolves with the accumulated message (or rejects with the SDK error).
 */
export interface TextStream {
  on(event: "text", listener: (textDelta: string, textSnapshot: string) => void): unknown;
  finalMessage(): Promise<Anthropic.Message>;
}

/** The slice of the SDK client this adapter uses; tests inject a fake. */
export interface MessagesClient {
  messages: {
    create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message>;
    /** `client.messages.stream(params)`; the SDK sets `stream: true` itself. Optional so minimal fakes still work. */
    stream?(params: Anthropic.MessageCreateParamsNonStreaming): TextStream;
  };
}

export interface ClaudeModelProviderOptions {
  model?: string;
  client?: MessagesClient;
  effort?: Effort;
  /** Receives non-fatal warnings (e.g. output truncated at max_tokens). Default: console.warn. */
  warn?: (message: string) => void;
  /**
   * Credentials for the SDK client (ignored when `client` is injected). A
   * given value is always used; `apiKey` is sent as `x-api-key`, `authToken`
   * as a Bearer token. A missing (or empty) one is resolved by the SDK, unless
   * `isolated` is set; see the header comment.
   */
  apiKey?: string;
  authToken?: string;
  baseURL?: string;
  /**
   * Credentials come only from the options above: no `process.env` fallback,
   * no default credential chain; a missing `baseURL` is https://api.anthropic.com.
   * Default false (CLI behaviour).
   */
  isolated?: boolean;
}

/**
 * Isolated mode's SDK client: its credentials are exactly the ones it is constructed with.
 * With neither `apiKey` nor `authToken`, the stock client lazily resolves its
 * default credential chain from `process.env` and config files on disk; this
 * SDK hook ("subclasses that bring their own auth scheme return false") turns
 * that off, so a keyless client fails with "Could not resolve authentication
 * method" instead of borrowing another identity.
 */
class ExplicitCredentialsAnthropic extends Anthropic {
  protected override _shouldResolveDefaultCredentials(): boolean {
    return false;
  }
}

function sdkClient(opts: ClaudeModelProviderOptions): Anthropic {
  if (opts.isolated) {
    // `null`, never `undefined`: the SDK reads process.env for `undefined`.
    return new ExplicitCredentialsAnthropic({
      apiKey: opts.apiKey || null,
      authToken: opts.authToken || null,
      baseURL: opts.baseURL || null,
      webhookKey: null,
    });
  }
  // `undefined` leaves the SDK's own lookup in place (same as `new Anthropic()`).
  return new Anthropic({
    apiKey: opts.apiKey || undefined,
    authToken: opts.authToken || undefined,
    baseURL: opts.baseURL || undefined,
  });
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
    this.client = opts.client ?? sdkClient(opts);
    this.warn = opts.warn ?? ((m) => console.warn(m));
  }

  private buildParams(input: ModelCompleteInput): Anthropic.MessageCreateParamsNonStreaming {
    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model: this.model,
      max_tokens: input.maxTokens ?? DEFAULT_MAX_TOKENS,
      messages: input.messages.map((m) => ({ role: m.role, content: m.content })),
      output_config: { effort: this.effort },
    };
    if (input.system.trim() !== "") {
      params.system = [{ type: "text", text: input.system, cache_control: { type: "ephemeral" } }];
    }
    return params;
  }

  /** Refusal → throw; max_tokens → warn; otherwise the concatenated text blocks. */
  private textOf(response: Anthropic.Message, maxTokens: number): string {
    if (response.stop_reason === "refusal") {
      throw new ModelRefusalError(response.stop_details?.category, response.stop_details?.explanation);
    }
    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    if (response.stop_reason === "max_tokens") {
      this.warn(`ClaudeModelProvider: output truncated at max_tokens=${maxTokens} (model ${this.model}); the response may be incomplete`);
    }
    return text;
  }

  async complete(input: ModelCompleteInput): Promise<string> {
    const params = this.buildParams(input);
    let response: Anthropic.Message;
    try {
      response = await this.client.messages.create(params);
    } catch (e) {
      throw wrapSdkError(e);
    }
    return this.textOf(response, params.max_tokens);
  }

  /**
   * Streaming variant: forwards each text delta to `onDelta` as it arrives and
   * resolves with the text of the final message (same value `complete` would
   * return). A refusal may arrive after deltas were already forwarded; it is
   * still raised as `ModelRefusalError`. Falls back to `complete` when the
   * injected client has no `stream`.
   */
  async stream(input: ModelCompleteInput, onDelta: (text: string) => void): Promise<string> {
    const messages = this.client.messages;
    if (typeof messages.stream !== "function") return this.complete(input);
    const params = this.buildParams(input);
    let response: Anthropic.Message;
    try {
      // `finalMessage()` is requested in the same tick as `on("text")` so the
      // SDK never sees an error with no catching promise (unhandled rejection).
      const stream = messages.stream(params);
      stream.on("text", (delta) => {
        if (delta !== "") onDelta(delta);
      });
      response = await stream.finalMessage();
    } catch (e) {
      throw wrapSdkError(e);
    }
    return this.textOf(response, params.max_tokens);
  }
}
