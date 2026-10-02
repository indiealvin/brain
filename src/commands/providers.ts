/**
 * Service layer, model and embedding provider selection for conversations
 * (CR-2). Every function reads the `env` it is given, so an adapter can pass
 * a private env instead of `process.env` (the RPC server's `initialize.env`,
 * protocol.md §3), with `isolatedEnv` (CR-11) keeping the Anthropic provider
 * from falling back to `process.env`.
 */
import type { EmbeddingProvider, ModelProvider } from "../core/types";
import { createEmbeddingProvider, createModelProvider } from "../model";
import { createMockModelProvider, mockModelRequested } from "../pipeline/mock";
import { createModelScriptProvider, MODEL_SCRIPT_ENV, modelScriptPath } from "../pipeline/scripted";
import { HashingEmbeddingProvider } from "../retrieval/embeddings";
import { NoModelError } from "./errors";

export interface ProviderSelection {
  /** Default `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Credentials come from `env` only (CR-11, `CreateModelProviderOptions.isolatedEnv`). Default false. */
  isolatedEnv?: boolean;
  /** One line per notable choice (script or mock model in use). */
  log?: (line: string) => void;
}

export function hasModelCredentials(env: NodeJS.ProcessEnv = process.env): boolean {
  return ["OPENROUTER_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"].some((k) => (env[k] ?? "").trim() !== "");
}

/** A scripted or mock model never touches the network, so it is paired with offline embeddings. */
export function offlineModelRequested(env: NodeJS.ProcessEnv = process.env): boolean {
  return modelScriptPath(env) !== null || mockModelRequested(env);
}

/**
 * The chat model. `BRAIN_MODEL_SCRIPT` wins over `BRAIN_MODEL_MOCK`; either
 * needs no credentials. Throws `NoModelError` when no model can be used.
 */
export function chatModelProvider(opts: ProviderSelection = {}): ModelProvider {
  const env = opts.env ?? process.env;
  const log = opts.log ?? (() => {});
  const script = modelScriptPath(env);
  if (script !== null) {
    log(`${MODEL_SCRIPT_ENV} is set: answering model calls from ${script}`);
    try {
      return createModelScriptProvider(script, env);
    } catch (e) {
      throw new NoModelError(e instanceof Error ? e.message : String(e));
    }
  }
  if (mockModelRequested(env)) {
    log("BRAIN_MODEL_MOCK is set: using the mock model (canned reply, no knowledge extraction)");
    return createMockModelProvider();
  }
  if (!hasModelCredentials(env)) throw new NoModelError("no model configured; run `brain setup`");
  try {
    return createModelProvider(env, { isolatedEnv: opts.isolatedEnv === true });
  } catch (e) {
    throw new NoModelError(`${e instanceof Error ? e.message : String(e)}; run \`brain setup\` or \`brain doctor\``);
  }
}

/** Embeddings for a conversation: mock and script modes must never touch the network, so they get the offline hashing provider. */
export function chatEmbeddingProvider(env: NodeJS.ProcessEnv = process.env): EmbeddingProvider {
  return offlineModelRequested(env) ? new HashingEmbeddingProvider() : createEmbeddingProvider(env);
}
