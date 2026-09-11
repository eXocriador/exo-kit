import { asArray, asString, getPath } from '../../infra/json.js';
export function createOllamaProvider(config) {
    const base = config.url ?? 'http://localhost:11434';
    const doFetch = config.fetchImpl ?? ((...a) => globalThis.fetch(...a));
    async function postChat(messages, opts) {
        const { model = config.model, temperature = 0.3, maxTokens = 512, timeoutMs = 30_000, } = opts;
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
        }
        catch (error) {
            config.reportError?.(error, { component: 'llm', event: 'llm.ollama.request_error' });
            return null;
        }
    }
    return {
        name: 'ollama',
        defaultModel: config.model,
        generate(prompt, opts = {}) {
            return postChat([{ role: 'user', content: prompt }], opts);
        },
        // /api/chat natively takes the full role-tagged message list, so a
        // multi-turn conversation keeps real system/user/assistant structure
        // instead of being flattened into one prompt string.
        chat(messages, opts = {}) {
            return postChat(messages, opts);
        },
        async isAvailable() {
            // /api/tags is a cheap, model-free liveness check. A short timeout keeps
            // a dead tunnel (a sleeping laptop at the other end) from stalling the
            // request path.
            try {
                const res = await doFetch(`${base}/api/tags`, { signal: AbortSignal.timeout(3_000) });
                return res.ok;
            }
            catch {
                return false;
            }
        },
    };
}
/**
 * Embeddings via Ollama. Kept out of {@link ChatProvider} on purpose: a stored
 * vector collection is tied to the dimensions of the model that wrote it, so
 * switching the *chat* backend must not silently switch the embedding model
 * and make every stored vector unsearchable. Returns `null` when unavailable.
 */
export function createEmbedder(config) {
    const base = config.url ?? 'http://localhost:11434';
    const doFetch = config.fetchImpl ?? ((...a) => globalThis.fetch(...a));
    return async function embed(text, model = config.model) {
        try {
            const res = await doFetch(`${base}/api/embeddings`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ model, prompt: text }),
                signal: AbortSignal.timeout(config.timeoutMs ?? 15_000),
            });
            if (!res.ok)
                return null;
            const data = await res.json();
            const embedding = asArray(getPath(data, 'embedding')).filter((v) => typeof v === 'number');
            return embedding.length ? embedding : null;
        }
        catch {
            return null;
        }
    };
}
//# sourceMappingURL=ollama.js.map