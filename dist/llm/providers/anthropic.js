import { asArray, asString, isRecord } from '../../infra/json.js';
export function createAnthropicProvider(config) {
    const base = config.baseUrl ?? 'https://api.anthropic.com';
    const doFetch = config.fetchImpl ?? ((...a) => globalThis.fetch(...a));
    async function postChat(messages, opts) {
        if (!config.apiKey) {
            config.reportError?.(new Error('Anthropic API key not set'), {
                component: 'llm',
                event: 'llm.anthropic.no_api_key',
            });
            return null;
        }
        const { model = config.model, temperature = 0.3, maxTokens = 512, timeoutMs = 30_000, } = opts;
        // The Messages API takes `system` as a separate top-level field, not a
        // message with role "system" — split it out so a multi-turn conversation
        // keeps its real role structure instead of being flattened into one prompt.
        const system = messages
            .filter((m) => m.role === 'system')
            .map((m) => m.content)
            .join('\n\n') || undefined;
        const turns = messages
            .filter((m) => m.role !== 'system')
            .map((m) => ({ role: m.role, content: m.content }));
        try {
            const res = await doFetch(`${base}/v1/messages`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': config.apiKey,
                    'anthropic-version': config.apiVersion ?? '2023-06-01',
                },
                body: JSON.stringify({ model, max_tokens: maxTokens, temperature, system, messages: turns }),
                signal: AbortSignal.timeout(timeoutMs),
            });
            if (!res.ok) {
                config.reportError?.(new Error(`Anthropic request failed with status ${res.status}`), { component: 'llm', event: 'llm.anthropic.request_failed', fields: { status: res.status } });
                return null;
            }
            const data = await res.json();
            // content is an array of blocks; the first text block holds the answer.
            const block = asArray(isRecord(data) ? data['content'] : undefined)
                .filter(isRecord)
                .find((b) => b['type'] === 'text');
            return asString(block?.['text']).trim() || null;
        }
        catch (error) {
            config.reportError?.(error, { component: 'llm', event: 'llm.anthropic.request_error' });
            return null;
        }
    }
    return {
        name: 'anthropic',
        defaultModel: config.model,
        generate(prompt, opts = {}) {
            return postChat([{ role: 'user', content: prompt }], opts);
        },
        chat(messages, opts = {}) {
            return postChat(messages, opts);
        },
        // Hosted API: "available" means a key is configured. A live ping would
        // burn tokens on every probe, so a present key counts as reachable.
        async isAvailable() {
            return Boolean(config.apiKey);
        },
    };
}
//# sourceMappingURL=anthropic.js.map