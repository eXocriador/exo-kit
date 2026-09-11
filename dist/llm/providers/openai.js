import { asString, getPath } from '../../infra/json.js';
export function createOpenAiProvider(config) {
    const base = config.baseUrl ?? 'https://api.openai.com';
    const doFetch = config.fetchImpl ?? ((...a) => globalThis.fetch(...a));
    async function postChat(messages, opts) {
        if (!config.apiKey) {
            config.reportError?.(new Error('OpenAI API key not set'), {
                component: 'llm',
                event: 'llm.openai.no_api_key',
            });
            return null;
        }
        const { model = config.model, temperature = 0.3, maxTokens = 512, timeoutMs = 30_000, } = opts;
        try {
            const res = await doFetch(`${base}/v1/chat/completions`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${config.apiKey}`,
                },
                body: JSON.stringify({ model, max_tokens: maxTokens, temperature, messages }),
                signal: AbortSignal.timeout(timeoutMs),
            });
            if (!res.ok) {
                config.reportError?.(new Error(`OpenAI request failed with status ${res.status}`), { component: 'llm', event: 'llm.openai.request_failed', fields: { status: res.status } });
                return null;
            }
            const data = await res.json();
            return asString(getPath(data, 'choices.0.message.content')).trim() || null;
        }
        catch (error) {
            config.reportError?.(error, { component: 'llm', event: 'llm.openai.request_error' });
            return null;
        }
    }
    return {
        name: 'openai',
        defaultModel: config.model,
        generate(prompt, opts = {}) {
            return postChat([{ role: 'user', content: prompt }], opts);
        },
        // chat/completions natively takes the full role-tagged message list, so a
        // multi-turn conversation keeps real system/user/assistant structure.
        chat(messages, opts = {}) {
            return postChat(messages, opts);
        },
        async isAvailable() {
            return Boolean(config.apiKey);
        },
    };
}
//# sourceMappingURL=openai.js.map