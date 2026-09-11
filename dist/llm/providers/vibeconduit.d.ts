import type { ChatProvider, ProviderHooks } from '../types.js';
export interface VibeConduitConfig extends ProviderHooks {
    /** Default `http://localhost:8318`. */
    baseUrl?: string;
    apiKey: string;
    model: string;
    /**
     * Second model to try when the first answers 429, or `null` to disable.
     *
     * Quota on one model is not quota on the gateway. A gateway whose upstream
     * meters model families separately can leave one family RESOURCE_EXHAUSTED
     * for days while another answers 200 the whole time — and with no fallback,
     * every call that depends on it simply dies for those days.
     */
    fallbackModel?: string | null;
    /**
     * Refuse to call the gateway without a key.
     *
     * ── Why this is a knob and not a constant ──
     * A gateway that accepts unauthenticated requests makes an empty key look
     * like a valid configuration, and that is exactly the property worth
     * removing: an unauthenticated endpoint to a paid model is an unattributable
     * channel for anything that can reach it — and everything a product sends
     * goes through it. Set this true in production so the app can never silently
     * fall back to the keyless mode once the gateway is locked down; leave it
     * false for local development against a bare gateway.
     */
    requireKey?: boolean;
    fetchImpl?: typeof fetch;
}
/**
 * OpenAI-compatible chat client for a self-hosted gateway (the "gateway"
 * provider). Same wire format as OpenAI; separate provider because its
 * failure modes are a local process's, not a hosted API's — it can be stopped,
 * and its quota is somebody else's upstream.
 */
export declare function createVibeConduitProvider(config: VibeConduitConfig): ChatProvider;
//# sourceMappingURL=vibeconduit.d.ts.map