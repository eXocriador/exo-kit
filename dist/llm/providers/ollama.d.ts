import type { ChatProvider, ProviderHooks } from '../types.js';
export interface OllamaConfig extends ProviderHooks {
    /** Default `http://localhost:11434`. */
    url?: string;
    /** Chat model id. */
    model: string;
    /** Injected for tests. Defaults to global `fetch`. */
    fetchImpl?: typeof fetch;
}
export declare function createOllamaProvider(config: OllamaConfig): ChatProvider;
export interface EmbedderConfig {
    url?: string;
    model: string;
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
}
/**
 * Embeddings via Ollama. Kept out of {@link ChatProvider} on purpose: a stored
 * vector collection is tied to the dimensions of the model that wrote it, so
 * switching the *chat* backend must not silently switch the embedding model
 * and make every stored vector unsearchable. Returns `null` when unavailable.
 */
export declare function createEmbedder(config: EmbedderConfig): (text: string, model?: string) => Promise<number[] | null>;
//# sourceMappingURL=ollama.d.ts.map