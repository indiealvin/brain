/** Phase 7 retrieval surface (spec §44–48). */
export { lexicalSearch, ftsQuery, queryTokens, type LexicalHit } from "./lexical";
export {
  HashingEmbeddingProvider,
  ensureEmbeddings,
  cosine,
  hashingEmbed,
  retrievalTextFromIndex,
  retrievalTextFromFtsBody,
  encodeVector,
  decodeVector,
} from "./embeddings";
export { semanticSearch, type SemanticHit } from "./semantic";
export { graphExpand } from "./graph";
export {
  hybridSearch,
  retrieveForPlanner,
  DEFAULT_WEIGHTS,
  type HybridHit,
  type HybridOptions,
  type HybridSignals,
  type HybridWeights,
} from "./hybrid";
