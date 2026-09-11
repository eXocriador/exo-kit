import { asString, getPath } from '../../infra/json.js';
/**
 * OpenAI-compatible chat client for a self-hosted gateway (the "gateway"
 * provider). Same wire format as OpenAI; separate provider because its
 * failure modes are a local process's, not a hosted API's — it can be stopped,
 * and its quota is somebody else's upstream.
 */
export function createVibeConduitProvider(config) {
    const base = config.baseUrl ?? 'http://localhost:8318';
    const fallbackModel = config.fallbackModel ?? null;
    const requireKey = config.requireKey ?? false;
    const doFetch = config.fetchImpl ?? ((...a) => globalThis.fetch(...a));
    async function postChat(messages, opts) {
        if (!config.apiKey && requireKey) {
            config.reportError?.(new Error('LLM gateway API key is not set — refusing to call it unauthenticated'), { component: 'llm', event: 'llm.vibeconduit.no_api_key' });
            return null;
        }
        const { model = config.model, temperature = 0.3, maxTokens = 512, timeoutMs = 30_000, } = opts;
        try {
            const request = (m) => doFetch(`${base}/v1/chat/completions`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${config.apiKey}`,
                },
                body: JSON.stringify({ model: m, max_tokens: maxTokens, temperature, messages }),
                signal: AbortSignal.timeout(timeoutMs),
            });
            let usedModel = model;
            let res = await request(model);
            // A warn, not an error — the call may still succeed, and an exhausted
            // primary is a known state rather than a fault.
            if (res.status === 429 && fallbackModel && fallbackModel !== model) {
                config.logWarn?.('llm.vibeconduit.primary_exhausted', { model, fallback: fallbackModel });
                usedModel = fallbackModel;
                res = await request(fallbackModel);
            }
            if (!res.ok) {
                config.reportError?.(new Error(`VibeConduit request failed with status ${res.status}`), {
                    component: 'llm',
                    event: 'llm.vibeconduit.request_failed',
                    fields: { status: res.status, model: usedModel },
                });
                return null;
            }
            const data = await res.json();
            return asString(getPath(data, 'choices.0.message.content')).trim() || null;
        }
        catch (error) {
            config.reportError?.(error, { component: 'llm', event: 'llm.vibeconduit.request_error' });
            return null;
        }
    }
    return {
        name: 'vibeconduit',
        defaultModel: config.model,
        generate(prompt, opts = {}) {
            return postChat([{ role: 'user', content: prompt }], opts);
        },
        chat(messages, opts = {}) {
            return postChat(messages, opts);
        },
        // Live probe — the gateway is a local process that can be stopped, unlike
        // a hosted API. A missing key under `requireKey` reports "offline" rather
        // than probing: `postChat` will refuse the call anyway, and a probe that
        // said "available" would send every caller down the healthy path to get a
        // silent null. Callers distinguish "AI offline" from "AI failed", so this
        // has to be the honest answer.
        async isAvailable() {
            if (!config.apiKey && requireKey)
                return false;
            try {
                const res = await doFetch(`${base}/v1/models`, {
                    headers: { Authorization: `Bearer ${config.apiKey}` },
                    signal: AbortSignal.timeout(3_000),
                });
                return res.ok;
            }
            catch {
                return false;
            }
        },
    };
}
//# sourceMappingURL=vibeconduit.js.map