import type { ChatProvider, ProviderHooks } from '../types.js';
export interface OpenAiConfig extends ProviderHooks {
    /** Default `https://api.openai.com`. */
    baseUrl?: string;
    apiKey: string;
    model: string;
    fetchImpl?: typeof fetch;
}
export declare function createOpenAiProvider(config: OpenAiConfig): ChatProvider;
//# sourceMappingURL=openai.d.ts.map