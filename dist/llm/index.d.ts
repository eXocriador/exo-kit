/**
 * `@exo/kit/llm` — one chat interface over four backends, chosen by config.
 *
 * What is here is the mechanism: talking to a provider, degrading to `null`
 * when it is unavailable, and telling "offline" apart from "answered with
 * nothing". What is NOT here is any prompt. A prompt is product policy — it
 * encodes what a particular product wants said about its own domain — and the
 * kit does not know product names, let alone their domains. Products keep
 * their prompts and call `generate`/`chat`.
 */
import type { ChatMessage, ChatProvider, GenerateOptions, ProviderName } from './types.js';
import { createOllamaProvider, createEmbedder } from './providers/ollama.js';
import { createAnthropicProvider } from './providers/anthropic.js';
import { createOpenAiProvider } from './providers/openai.js';
import { createVibeConduitProvider } from './providers/vibeconduit.js';
import type { OllamaConfig, EmbedderConfig } from './providers/ollama.js';
import type { AnthropicConfig } from './providers/anthropic.js';
import type { OpenAiConfig } from './providers/openai.js';
import type { VibeConduitConfig } from './providers/vibeconduit.js';
export type { ChatMessage, ChatProvider, GenerateOptions, ProviderName, ProviderHooks } from './types.js';
export type { OllamaConfig, EmbedderConfig, AnthropicConfig, OpenAiConfig, VibeConduitConfig };
export { createOllamaProvider, createEmbedder, createAnthropicProvider, createOpenAiProvider, createVibeConduitProvider, };
export type LlmConfig = ({
    provider: 'ollama';
} & OllamaConfig) | ({
    provider: 'anthropic';
} & AnthropicConfig) | ({
    provider: 'openai';
} & OpenAiConfig) | ({
    provider: 'vibeconduit';
} & VibeConduitConfig);
export interface Llm {
    readonly provider: ChatProvider;
    readonly providerName: ProviderName;
    /** The model id the active provider uses when a request names none. */
    readonly activeModel: string;
    generate(prompt: string, opts?: GenerateOptions): Promise<string | null>;
    chat(messages: ChatMessage[], opts?: GenerateOptions): Promise<string | null>;
    isAvailable(): Promise<boolean>;
}
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
export declare function resolveProviderName(raw: string | null | undefined, opts?: {
    fallback?: ProviderName;
    aliases?: Record<string, ProviderName>;
}): ProviderName;
/**
 * Collapse a conversation into one labelled prompt, for a provider that has no
 * native multi-turn call. Exported because it is the fallback that keeps a
 * third-party provider usable at all, and a fallback nothing exercises is a
 * fallback nobody knows is broken.
 *
 * System turns keep no label: they are instructions, not a speaker's line, and
 * prefixing them with a name makes the model treat them as dialogue.
 */
export declare function flattenConversation(messages: ChatMessage[]): string;
export declare function createLlm(config: LlmConfig): Llm;
//# sourceMappingURL=index.d.ts.map