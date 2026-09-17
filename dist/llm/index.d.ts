export interface EmbedderConfig {
    /** Default `http://localhost:11434`. */
    url?: string;
    model: string;
    timeoutMs?: number;
    /** Injected for tests. Defaults to global `fetch`. */
    fetchImpl?: typeof fetch;
}
/**
 * Embeddings via Ollama. Not a tier of the model service, on purpose: a stored
 * vector collection is tied to the dimensions of the model that wrote it, so a
 * service free to fall back to another model would silently make every stored
 * vector unsearchable. The model is pinned here, by the product that owns the
 * collection. Returns `null` when unavailable; never throws.
 */
export declare function createEmbedder(config: EmbedderConfig): (text: string, model?: string) => Promise<number[] | null>;
//# sourceMappingURL=index.d.ts.map