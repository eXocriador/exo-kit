/**
 * Provider-agnostic LLM contracts.
 *
 * Chat is multi-provider. Embeddings are deliberately NOT part of this
 * abstraction: vector dimensions differ per model, and a stored collection
 * outlives the choice of chat backend — see `createEmbedder`.
 */
export type ProviderName = 'ollama' | 'anthropic' | 'openai' | 'vibeconduit';
export interface GenerateOptions {
    model?: string;
    temperature?: number;
    maxTokens?: number;
    timeoutMs?: number;
}
/** A single turn in a multi-turn conversation. */
export interface ChatMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
}
/**
 * A chat completion backend. Every implementation returns `null` when the
 * service is unavailable so callers can degrade gracefully — do not throw.
 */
export interface ChatProvider {
    readonly name: ProviderName;
    /** The model id this provider uses for a request with no explicit override. */
    readonly defaultModel: string;
    generate(prompt: string, opts?: GenerateOptions): Promise<string | null>;
    /**
     * Multi-turn completion from a message list (system + alternating
     * user/assistant). Optional — when a provider doesn't implement it, callers
     * flatten the conversation into a single `generate` prompt. Returns `null`
     * when unavailable; never throws.
     */
    chat?(messages: ChatMessage[], opts?: GenerateOptions): Promise<string | null>;
    /**
     * Cheap reachability probe — true if the backend is up and able to serve a
     * request right now. Lets callers tell "AI is offline" apart from "the model
     * ran but produced nothing", so a UI can show a status instead of a cryptic
     * error. Never throws; returns false on any failure.
     */
    isAvailable(): Promise<boolean>;
}
/** Shared by every provider config: where errors go, and what to log. */
export interface ProviderHooks {
    reportError?: (err: unknown, ctx: {
        component: 'llm';
        event: string;
        fields?: Record<string, unknown>;
    }) => void;
    logWarn?: (event: string, fields?: Record<string, unknown>) => void;
}
//# sourceMappingURL=types.d.ts.map