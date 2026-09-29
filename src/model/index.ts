/**
 * Provider factories. Environment:
 *   BRAIN_MODEL       Claude model id (default claude-opus-5-5).
 *   BRAIN_EFFORT      low | medium | high | xhigh | max (default high).
 *   BRAIN_EMBEDDINGS  "hashing" (default) | "voyage" (not implemented yet).
 */
import type { EmbeddingProvider, ModelProvider } from "../core/types";
import { HashingEmbeddingProvider } from "../retrieval/embeddings";
import { ClaudeModelProvider, DEFAULT_MODEL, type Effort } from "./claude";

export { ClaudeModelProvider, ModelProviderError, ModelRefusalError, DEFAULT_MODEL } from "./claude";

const EFFORTS: readonly Effort[] = ["low", "medium", "high", "xhigh", "max"];

function envOr(name: string, dflt: string): string {
  const v = process.env[name];
  return v !== undefined && v.trim() !== "" ? v.trim() : dflt;
}

export function createModelProvider(): ModelProvider {
  const model = envOr("BRAIN_MODEL", DEFAULT_MODEL);
  const effortRaw = envOr("BRAIN_EFFORT", "high");
  if (!EFFORTS.includes(effortRaw as Effort)) {
    throw new Error(`BRAIN_EFFORT must be one of ${EFFORTS.join(", ")}; got ${JSON.stringify(effortRaw)}`);
  }
  return new ClaudeModelProvider({ model, effort: effortRaw as Effort });
}

/**
 * Anthropic has no embeddings endpoint, so the default is the deterministic
 * hashing provider (retrieval still works lexically + by graph; semantic
 * signal is weak but stable).
 *
 * TODO(voyage): add a Voyage AI adapter (voyage-3 family) behind
 * `BRAIN_EMBEDDINGS=voyage`, keyed by `VOYAGE_API_KEY`.
 */
export function createEmbeddingProvider(): EmbeddingProvider {
  const kind = envOr("BRAIN_EMBEDDINGS", "hashing");
  if (kind === "hashing") return new HashingEmbeddingProvider();
  if (kind === "voyage") throw new Error("BRAIN_EMBEDDINGS=voyage is not implemented yet (see src/model/index.ts)");
  throw new Error(`unknown BRAIN_EMBEDDINGS ${JSON.stringify(kind)} (expected hashing | voyage)`);
}
