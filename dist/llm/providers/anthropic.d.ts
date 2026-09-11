import type { ChatProvider, ProviderHooks } from '../types.js';
export interface AnthropicConfig extends ProviderHooks {
    /** Default `https://api.anthropic.com`. */
    baseUrl?: string;
    apiKey: string;
    /**
     * Pin a dated model id rather than a floating alias, so behaviour and cost
     * stay deterministic across deploys.
     */
    model: string;
    apiVersion?: string;
    fetchImpl?: typeof fetch;
}
export declare function createAnthropicProvider(config: AnthropicConfig): ChatProvider;
//# sourceMappingURL=anthropic.d.ts.map