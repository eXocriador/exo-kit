import type { ReportError } from '../infra/types.js';
/**
 * The tiers the service declares today. The list is the service's DATA — a
 * tier can be added to its catalogue without a kit release — so any string is
 * accepted, and the three known names are there for the editor.
 */
export type AiTier = 'fast' | 'capable' | 'agent' | (string & {});
export interface AiMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
}
export interface AiClientConfig {
    /**
     * Where the service listens, e.g. `http://exo-ai-web:3000`. `null`,
     * `undefined` or empty means NOT CONFIGURED, which is a supported state:
     * every call answers `{ ok: false, error: 'not_configured' }` without a
     * request and without a report. A development console with no service
     * boots and finds out by checking.
     */
    baseUrl: string | null | undefined;
    /** The product's key. It also NAMES the product in the service's ledger. Same not-configured rule. */
    key: string | null | undefined;
    /** Injected for tests; defaults to the global `fetch`. */
    fetch?: typeof fetch;
    /**
     * Ceiling on one `complete()` when the call names none. Default 60 s.
     *
     * This is the bound on the WHOLE ladder, not on one model — the service has
     * its own timeout per model and may try several. The old `@exo/kit/llm` chat
     * fixed one 30 s for every call, which made a long reasoning call indistinguishable
     * from a dead one; so set it per call, from what is waiting on the answer.
     */
    timeoutMs?: number;
    /** A fault the product should see: unreachable, unauthorised, a malformed answer, an integration mistake. */
    reportError?: ReportError;
    /** A known state rather than a fault: the ceiling closed, or no rung answered. */
    logWarn?: (event: string, fields?: Record<string, unknown>) => void;
}
export interface CompleteRequest {
    tier: AiTier;
    /** The conversation. One of `messages` (non-empty) or `prompt` is required. */
    messages?: readonly AiMessage[];
    /** A single user turn, for callers with no conversation. */
    prompt?: string;
    maxTokens?: number;
    temperature?: number;
    /**
     * Who the call is charged to within the product, e.g. `acme:user:42`. The
     * service keys a per-subject daily ceiling on it; `null` charges the product
     * ceiling only.
     *
     * At most 200 characters, and a longer one is REFUSED here rather than sent:
     * the service would cut it to 200, and two subjects sharing a 200-character
     * prefix would then share one counter — one customer spending another out of
     * a ceiling they never touched.
     */
    subject?: string | null;
    /** Echoed into the ledger for correlation. The service keeps 100 characters. */
    requestId?: string | null;
    /** Overrides the client's default for this call. */
    timeoutMs?: number;
}
/** One rung the service tried, as it reports it. */
export interface AiAttempt {
    rung: number;
    model: string;
    pool: string;
    /** `ok`, `exhausted`, `rejected`, `retired`, `unauthorized`, `timeout`, `error`, `skipped`. */
    outcome: string;
    httpStatus: number | null;
    latencyMs: number;
    tries: number;
    promptTokens: number | null;
    completionTokens: number | null;
    totalTokens: number | null;
    detail: string | null;
}
export interface AiAnswer {
    ok: true;
    /** The completion. Empty is an answer — the model ran and said nothing. */
    content: string;
    model: string;
    pool: string;
    /**
     * 0 is the tier's primary. Anything above it means the ladder had to step
     * down, and the service reports it precisely so that degradation stays
     * visible to the product instead of becoming silent again.
     */
    rung: number;
    tier: string;
    attempts: AiAttempt[];
    totalLatencyMs: number;
}
export type AiRefusal = 
/** The daily ceiling closed. Hand the conversation to a person; do not show an error, do not bill. */
{
    ok: false;
    error: 'budget_exhausted';
    degrade: 'human_handoff' | (string & {});
    /** Which ceiling: the product's, or the subject's. */
    scope: 'product' | 'subject' | null;
    used: number | null;
    cap: number | null;
}
/** Every rung was tried and none answered. Take the product's fail-safe path. */
 | {
    ok: false;
    error: 'all_rungs_failed';
    tier: string;
    attempts: AiAttempt[];
    totalLatencyMs: number | null;
}
/** The tier is not in the service's catalogue. An integration mistake, not an outage. */
 | {
    ok: false;
    error: 'unknown_tier';
    tier: string;
    tiers: string[];
    detail: string;
}
/** No address or no key. Nothing was sent. */
 | {
    ok: false;
    error: 'not_configured';
}
/** The key was refused. */
 | {
    ok: false;
    error: 'unauthorized';
}
/** The request was malformed — refused here before sending, or by the service. */
 | {
    ok: false;
    error: 'bad_request';
    detail: string;
}
/** The call outlived its ceiling. The service may still finish, and count, that call. */
 | {
    ok: false;
    error: 'timeout';
    timeoutMs: number;
}
/** Unreachable, an unexpected status, or a body that is not the contract. */
 | {
    ok: false;
    error: 'unavailable';
    status: number | null;
    detail: string;
};
export type CompleteResult = AiAnswer | AiRefusal;
export type UsageResult = {
    ok: true;
    product: string;
    usedToday: number | null;
    cap: number;
} | Extract<AiRefusal, {
    error: 'not_configured' | 'unauthorized' | 'timeout' | 'unavailable';
}>;
export interface AiClient {
    /** `POST /v1/complete`. Never throws. */
    complete(request: CompleteRequest): Promise<CompleteResult>;
    /**
     * `GET /v1/usage` — what this product has been charged today, and its
     * ceiling. `usedToday` is `null` when the service could not read its
     * counter. Default timeout 5 s: this is a read for a screen, not a turn.
     */
    usage(opts?: {
        timeoutMs?: number;
    }): Promise<UsageResult>;
}
export declare function createAiClient(config: AiClientConfig): AiClient;
//# sourceMappingURL=index.d.ts.map