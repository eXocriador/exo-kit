import type { ChatMessage, ChatProvider, GenerateOptions, ProviderHooks } from '../types.js';
import { asArray, asString, getPath } from '../../json/index.js';

export interface OllamaConfig extends ProviderHooks {
  /** Default `http://localhost:11434`. */
  url?: string;
  /** Chat model id. */
  model: string;
  /** Injected for tests. Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
}

export function createOllamaProvider(config: OllamaConfig): ChatProvider {
  const base = config.url ?? 'http://localhost:11434';
  const doFetch = config.fetchImpl ?? ((...a: Parameters<typeof fetch>) => globalThis.fetch(...a));

  async function postChat(
    messages: ChatMessage[],
    opts: GenerateOptions,
  ): Promise<string | null> {
    const {
      model = config.model,
      temperature = 0.3,
      maxTokens = 512,
      timeoutMs = 30_000,
    } = opts;

    try {
      const res = await doFetch(`${base}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages,
          stream: false,
          think: false,
          options: { temperature, num_predict: maxTokens },
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!res.ok) {
        const err = new Error(`Ollama request failed with status ${res.status}`);
        config.reportError?.(err, {
          component: 'llm',
          event: 'llm.ollama.request_failed',
          fields: { status: res.status },
        });
        return null;
      }
      const data = await res.json();
      return asString(getPath(data, 'message.content')).trim() || null;
    } catch (error) {
      config.reportError?.(error, { component: 'llm', event: 'llm.ollama.request_error' });
      return null;
    }
  }

  return {
    name: 'ollama',
    defaultModel: config.model,
    generate(prompt, opts: GenerateOptions = {}) {
      return postChat([{ role: 'user', content: prompt }], opts);
    },
    // /api/chat natively takes the full role-tagged message list, so a
    // multi-turn conversation keeps real system/user/assistant structure
    // instead of being flattened into one prompt string.
    chat(messages, opts: GenerateOptions = {}) {
      return postChat(messages, opts);
    },
    async isAvailable(): Promise<boolean> {
      // /api/tags is a cheap, model-free liveness check. A short timeout keeps
      // a dead tunnel (a sleeping laptop at the other end) from stalling the
      // request path.
      try {
        const res = await doFetch(`${base}/api/tags`, { signal: AbortSignal.timeout(3_000) });
        return res.ok;
      } catch {
        return false;
      }
    },
  };
}

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
