/**
 * `@exo/kit/llm` — embeddings, and nothing else since v0.10.0.
 *
 * Chat lived here until the exo-ai service took it over: `@exo/kit/ai` (v0.8.0)
 * asks the service for a tier, and the service owns providers, fallbacks,
 * timeouts and budgets. exointel moved last, on 2026-09-14, and v0.10.0 removed
 * `createLlm` and its four providers. What is left is the one thing the service
 * deliberately does not do.
 */
import { asArray, getPath } from '../json/index.js';

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
export function createEmbedder(config: EmbedderConfig) {
  const base = config.url ?? 'http://localhost:11434';
  const doFetch = config.fetchImpl ?? ((...a: Parameters<typeof fetch>) => globalThis.fetch(...a));

  return async function embed(text: string, model = config.model): Promise<number[] | null> {
    try {
      const res = await doFetch(`${base}/api/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, prompt: text }),
        signal: AbortSignal.timeout(config.timeoutMs ?? 15_000),
      });
      if (!res.ok) return null;
      const data = await res.json();
      const embedding = asArray(getPath(data, 'embedding')).filter(
        (v): v is number => typeof v === 'number',
      );
      return embedding.length ? embedding : null;
    } catch {
      return null;
    }
  };
}
