/**
 * Provider factories. Environment (`brain setup` writes `$BRAIN_HOME/config.toml`,
 * which the CLI projects onto unset variables at startup; see src/config/userConfig.ts):
 *   BRAIN_MODEL_PROVIDER  anthropic | openrouter. Default: anthropic, unless only
 *                         OPENROUTER_API_KEY is set (then openrouter).
 *   BRAIN_MODEL           model id. Default claude-opus-5-5 (anthropic) or
 *                         anthropic/claude-sonnet-4.5 (openrouter).
 *   BRAIN_EFFORT          anthropic: low | medium | high | xhigh | max (default high)
 *                         openrouter: low | medium | high → `reasoning.effort`; unset = omit.
 *   ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, ANTHROPIC_BASE_URL (optional override):
 *                         taken from `env`. When unset there, the Anthropic SDK
 *                         falls back to process.env and its credential chain,
 *                         unless `{ isolatedEnv: true }` (src/model/claude.ts).
 *   OPENROUTER_API_KEY, OPENROUTER_BASE_URL (optional override)
 *   BRAIN_EMBEDDINGS      hashing | openrouter. Default: openrouter when the model
 *                         provider resolves to openrouter, hashing otherwise
 *                         (Anthropic has no embeddings endpoint).
 *   BRAIN_EMBEDDING_MODEL openrouter embedding model (default openai/text-embedding-3-small)
 *   BRAIN_EMBEDDING_DIMS  its output size (default 1536)
 */
import type { EmbeddingProvider, ModelProvider } from "../core/types";
import { HashingEmbeddingProvider } from "../retrieval/embeddings";
import { ClaudeModelProvider, DEFAULT_MODEL, type Effort } from "./claude";
import {
  DEFAULT_OPENROUTER_EMBEDDING_DIMS,
  DEFAULT_OPENROUTER_EMBEDDING_MODEL,
  DEFAULT_OPENROUTER_MODEL,
  OpenRouterEmbeddingProvider,
  OpenRouterModelProvider,
  type ReasoningEffort,
} from "./openrouter";

export { ClaudeModelProvider, ModelProviderError, ModelRefusalError, DEFAULT_MODEL } from "./claude";
export { OpenRouterModelProvider, OpenRouterEmbeddingProvider } from "./openrouter";

const EFFORTS: readonly Effort[] = ["low", "medium", "high", "xhigh", "max"];
const REASONING_EFFORTS: readonly ReasoningEffort[] = ["low", "medium", "high"];

function envOr(name: string, dflt: string, env: NodeJS.ProcessEnv = process.env): string {
  const v = env[name];
  return v !== undefined && v.trim() !== "" ? v.trim() : dflt;
}

export type ProviderKind = "anthropic" | "openrouter";

export function resolveProviderKind(env: NodeJS.ProcessEnv = process.env): ProviderKind {
  const explicit = envOr("BRAIN_MODEL_PROVIDER", "", env).toLowerCase();
  if (explicit === "anthropic" || explicit === "openrouter") return explicit;
  if (explicit !== "") throw new Error(`BRAIN_MODEL_PROVIDER must be anthropic | openrouter; got ${JSON.stringify(explicit)}`);
  const hasAnthropic = envOr("ANTHROPIC_API_KEY", "", env) !== "" || envOr("ANTHROPIC_AUTH_TOKEN", "", env) !== "";
  const hasOpenRouter = envOr("OPENROUTER_API_KEY", "", env) !== "";
  return hasOpenRouter && !hasAnthropic ? "openrouter" : "anthropic";
}

export interface CreateModelProviderOptions {
  /**
   * `env` is the only credential source: unset Anthropic credentials stay
   * unset (no process.env fallback, no SDK credential chain). For a private
   * env such as the app's `initialize.env` (design §10). Default false: the
   * CLI passes process.env and keeps the SDK's own lookup.
   */
  isolatedEnv?: boolean;
}

export function createModelProvider(env: NodeJS.ProcessEnv = process.env, opts: CreateModelProviderOptions = {}): ModelProvider {
  const kind = resolveProviderKind(env);
  if (kind === "openrouter") {
    const apiKey = envOr("OPENROUTER_API_KEY", "", env);
    if (!apiKey) throw new Error("OPENROUTER_API_KEY is required for BRAIN_MODEL_PROVIDER=openrouter");
    const effortRaw = envOr("BRAIN_EFFORT", "", env);
    if (effortRaw !== "" && !REASONING_EFFORTS.includes(effortRaw as ReasoningEffort)) {
      throw new Error(`BRAIN_EFFORT for openrouter must be one of ${REASONING_EFFORTS.join(", ")}; got ${JSON.stringify(effortRaw)}`);
    }
    return new OpenRouterModelProvider({
      apiKey,
      model: envOr("BRAIN_MODEL", DEFAULT_OPENROUTER_MODEL, env),
      baseUrl: envOr("OPENROUTER_BASE_URL", "", env) || undefined,
      reasoningEffort: (effortRaw || undefined) as ReasoningEffort | undefined,
      title: "brain",
      warn: (m) => console.warn(m),
    });
  }
  const model = envOr("BRAIN_MODEL", DEFAULT_MODEL, env);
  const effortRaw = envOr("BRAIN_EFFORT", "high", env);
  if (!EFFORTS.includes(effortRaw as Effort)) {
    throw new Error(`BRAIN_EFFORT must be one of ${EFFORTS.join(", ")}; got ${JSON.stringify(effortRaw)}`);
  }
  return new ClaudeModelProvider({
    model,
    effort: effortRaw as Effort,
    // CR-11: credentials from `env`; unset ones are resolved by the SDK unless isolated.
    apiKey: envOr("ANTHROPIC_API_KEY", "", env) || undefined,
    authToken: envOr("ANTHROPIC_AUTH_TOKEN", "", env) || undefined,
    baseURL: envOr("ANTHROPIC_BASE_URL", "", env) || undefined,
    isolated: opts.isolatedEnv === true,
  });
}

/**
 * Embeddings. When `BRAIN_EMBEDDINGS` is unset the default follows the model
 * provider: `openrouter` (its /embeddings endpoint) when the model provider
 * resolves to openrouter, otherwise the deterministic hashing provider
 * (offline; semantic signal weak but stable) — Anthropic has no embeddings
 * endpoint.
 */
export function defaultEmbeddingsKind(env: NodeJS.ProcessEnv = process.env): "hashing" | "openrouter" {
  try {
    return resolveProviderKind(env) === "openrouter" ? "openrouter" : "hashing";
  } catch {
    return "hashing"; // a bad BRAIN_MODEL_PROVIDER is reported where the model is created, not here
  }
}

export function createEmbeddingProvider(env: NodeJS.ProcessEnv = process.env): EmbeddingProvider {
  const kind = envOr("BRAIN_EMBEDDINGS", defaultEmbeddingsKind(env), env);
  if (kind === "hashing") return new HashingEmbeddingProvider();
  if (kind === "openrouter") {
    const apiKey = envOr("OPENROUTER_API_KEY", "", env);
    if (!apiKey) throw new Error("OPENROUTER_API_KEY is required for BRAIN_EMBEDDINGS=openrouter");
    const dims = Number(envOr("BRAIN_EMBEDDING_DIMS", String(DEFAULT_OPENROUTER_EMBEDDING_DIMS), env));
    if (!Number.isInteger(dims) || dims <= 0) throw new Error("BRAIN_EMBEDDING_DIMS must be a positive integer");
    return new OpenRouterEmbeddingProvider({
      apiKey,
      model: envOr("BRAIN_EMBEDDING_MODEL", DEFAULT_OPENROUTER_EMBEDDING_MODEL, env),
      dims,
      baseUrl: envOr("OPENROUTER_BASE_URL", "", env) || undefined,
      title: "brain",
    });
  }
  throw new Error(`unknown BRAIN_EMBEDDINGS ${JSON.stringify(kind)} (expected hashing | openrouter)`);
}
