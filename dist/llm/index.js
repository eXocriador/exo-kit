import { createOllamaProvider, createEmbedder } from './providers/ollama.js';
import { createAnthropicProvider } from './providers/anthropic.js';
import { createOpenAiProvider } from './providers/openai.js';
import { createVibeConduitProvider } from './providers/vibeconduit.js';
export { createOllamaProvider, createEmbedder, createAnthropicProvider, createOpenAiProvider, createVibeConduitProvider, };
/**
 * Resolve a provider name that arrived as free text (an environment variable,
 * a config file) — throwing on anything unrecognised.
 *
 * Failing loud at boot beats falling back to a default: a misconfigured name
 * would otherwise have `isAvailable()` report some *other* backend's liveness,
 * so callers never take the graceful AI-offline path even though the intended
 * provider is down. `aliases` exists for deployments carrying a legacy value
 * they cannot rename in one step.
 */
export function resolveProviderName(raw, opts = {}) {
    const value = raw?.trim().toLowerCase();
    if (!value) {
        if (opts.fallback)
            return opts.fallback;
        throw new Error('[llm] no provider name given and no fallback configured');
    }
    const alias = opts.aliases?.[value];
    if (alias)
        return alias;
    if (value === 'ollama' || value === 'anthropic' || value === 'openai' || value === 'vibeconduit') {
        return value;
    }
    throw new Error(`[llm] unrecognized provider "${value}" — must be one of: ollama, anthropic, openai, vibeconduit`);
}
/**
 * Collapse a conversation into one labelled prompt, for a provider that has no
 * native multi-turn call. Exported because it is the fallback that keeps a
 * third-party provider usable at all, and a fallback nothing exercises is a
 * fallback nobody knows is broken.
 *
 * System turns keep no label: they are instructions, not a speaker's line, and
 * prefixing them with a name makes the model treat them as dialogue.
 */
export function flattenConversation(messages) {
    return messages
        .map((m) => m.role === 'system'
        ? m.content
        : `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
        .join('\n\n');
}
function build(config) {
    switch (config.provider) {
        case 'ollama':
            return createOllamaProvider(config);
        case 'anthropic':
            return createAnthropicProvider(config);
        case 'openai':
            return createOpenAiProvider(config);
        case 'vibeconduit':
            return createVibeConduitProvider(config);
    }
}
export function createLlm(config) {
    const provider = build(config);
    return {
        provider,
        providerName: provider.name,
        activeModel: provider.defaultModel,
        generate(prompt, opts) {
            return provider.generate(prompt, opts);
        },
        /**
         * Uses the provider's native `chat` when it has one (real conversational
         * context), otherwise flattens the conversation into a single labelled
         * prompt for `generate` so every provider still works.
         */
        chat(messages, opts) {
            if (provider.chat)
                return provider.chat(messages, opts);
            return provider.generate(flattenConversation(messages), opts);
        },
        isAvailable() {
            return provider.isAvailable();
        },
    };
}
//# sourceMappingURL=index.js.map