/**
 * Provider-agnostic LLM contracts.
 *
 * Chat is multi-provider. Embeddings are deliberately NOT part of this
 * abstraction: vector dimensions differ per model, and a stored collection
 * outlives the choice of chat backend — see `createEmbedder`.
 */
export {};
//# sourceMappingURL=types.js.map