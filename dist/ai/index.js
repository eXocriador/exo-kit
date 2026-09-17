/**
 * `@exo/kit/ai` — the client for exo-ai, the model service.
 *
 * A product asks for a TIER (`fast`, `capable`, `agent`), not a model. Which
 * model answers, which pool it is metered in, how many rungs the ladder has
 * to climb to find a live one, and how many calls a product or one of its
 * customers may make today are the service's business — they live in one
 * place, shared by every product, instead of in a copy per process. This
 * module is the wire to that place and nothing else.
 *
 * ── Why the refusals are typed ──
 * Two failures a product used to receive as the same `null` mean opposite
 * things and call for opposite actions:
 *
 *   * `budget_exhausted` — the daily ceiling closed. The service is healthy
 *     and chose not to call a model. The product degrades to a PERSON
 *     (`degrade: 'human_handoff'`), shows no error, and bills nobody.
 *   * `all_rungs_failed` — every rung of the ladder was tried and none
 *     answered. That is an outage, and the product takes its fail-safe path.
 *
 * The chat in `@exo/kit/llm` (removed in v0.10.0) answered both with `null`,
 * so a product could only ever do one of the two. Here the difference is the discriminant of the result.
 *
 * ── What is NOT here ──
 *   * Retries. The service retries, per model, with its own backoff, and steps
 *     down the ladder across pools. A client retry on top would run that whole
 *     ladder again and charge the daily ceiling twice for one question.
 *   * A default model, a fallback model, a provider switch. Those are the
 *     things the service exists to take away from products.
 *   * Embeddings. The service does not compute them; `createEmbedder` in
 *     `@exo/kit/llm` still does.
 *   * `process.env`. The address and the key arrive as arguments, like every
 *     other factory in the kit.
 *
 * ── It never throws ──
 * Every outcome, a dropped connection included, is a value of
 * {@link CompleteResult}. A support turn that throws costs a customer their
 * answer; a support turn that receives `{ ok: false }` can still hand over.
 */
import { asArray, asNumber, asString, isRecord } from '../json/index.js';
const DEFAULT_TIMEOUT_MS = 60_000;
const USAGE_TIMEOUT_MS = 5_000;
const MAX_SUBJECT = 200;
export function createAiClient(config) {
    const base = (config.baseUrl ?? '').trim().replace(/\/+$/, '');
    const key = (config.key ?? '').trim();
    const configured = base !== '' && key !== '';
    const doFetch = config.fetch ?? ((...a) => globalThis.fetch(...a));
    const defaultTimeout = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const report = (err, event, fields) => config.reportError?.(err, { component: 'ai', event, ...(fields ? { fields } : {}) });
    async function request(path, init, timeoutMs, event) {
        try {
            const res = await doFetch(`${base}${path}`, {
                ...init,
                headers: {
                    ...(init.body ? { 'Content-Type': 'application/json' } : {}),
                    Authorization: `Bearer ${key}`,
                },
                signal: AbortSignal.timeout(timeoutMs),
            });
            const text = await res.text();
            let body = null;
            try {
                body = text ? JSON.parse(text) : null;
            }
            catch {
                body = null;
            }
            return { status: res.status, body };
        }
        catch (err) {
            if (isTimeout(err)) {
                report(err, `${event}.timeout`, { timeoutMs });
                return { failed: { ok: false, error: 'timeout', timeoutMs } };
            }
            report(err, `${event}.request_error`);
            return {
                failed: { ok: false, error: 'unavailable', status: null, detail: err instanceof Error ? err.message : String(err) },
            };
        }
    }
    /** The statuses every route shares: a refused key, and anything that is not the contract. */
    function common(status, body, event) {
        if (status === 401) {
            report(new Error('exo-ai refused the product key'), `${event}.unauthorized`, { status });
            return { ok: false, error: 'unauthorized' };
        }
        const detail = asString(isRecord(body) ? body.error : undefined) || `HTTP ${status}`;
        report(new Error(`exo-ai answered ${status}: ${detail}`), `${event}.unavailable`, { status });
        return { ok: false, error: 'unavailable', status, detail };
    }
    async function complete(req) {
        if (!configured)
            return { ok: false, error: 'not_configured' };
        const hasMessages = Array.isArray(req.messages) && req.messages.length > 0;
        const hasPrompt = typeof req.prompt === 'string' && req.prompt.trim() !== '';
        if (!hasMessages && !hasPrompt) {
            return refuseLocally('messages[] or prompt is required', req.tier);
        }
        if (req.subject && req.subject.length > MAX_SUBJECT) {
            return refuseLocally(`subject is ${req.subject.length} characters; the service keeps ${MAX_SUBJECT}`, req.tier);
        }
        const timeoutMs = req.timeoutMs ?? defaultTimeout;
        const http = await request('/v1/complete', {
            method: 'POST',
            body: JSON.stringify({
                tier: req.tier,
                ...(hasMessages ? { messages: req.messages } : { prompt: req.prompt }),
                ...(req.maxTokens === undefined ? {} : { max_tokens: req.maxTokens }),
                ...(req.temperature === undefined ? {} : { temperature: req.temperature }),
                ...(req.subject ? { subject: req.subject } : {}),
                ...(req.requestId ? { request_id: req.requestId } : {}),
            }),
        }, timeoutMs, 'ai.complete');
        if ('failed' in http)
            return http.failed;
        const { status, body } = http;
        const rec = isRecord(body) ? body : {};
        const error = asString(rec.error);
        if (status === 200) {
            const model = asString(rec.model);
            if (!model || !isRecord(body)) {
                report(new Error('exo-ai answered 200 without the contract'), 'ai.complete.malformed_response', { tier: req.tier });
                return { ok: false, error: 'unavailable', status, detail: 'malformed response' };
            }
            return {
                ok: true,
                content: asString(rec.content),
                model,
                pool: asString(rec.pool),
                rung: asNumber(rec.rung),
                tier: asString(rec.tier, req.tier),
                attempts: readAttempts(rec.attempts),
                totalLatencyMs: asNumber(rec.totalLatencyMs),
            };
        }
        if (status === 429 && error === 'budget_exhausted') {
            const rawScope = rec.scope;
            const scope = rawScope === 'product' || rawScope === 'subject' ? rawScope : null;
            const refusal = {
                ok: false,
                error: 'budget_exhausted',
                degrade: asString(rec.degrade, 'human_handoff'),
                scope,
                used: nullableNumber(rec.used),
                cap: nullableNumber(rec.cap),
            };
            config.logWarn?.('ai.budget_exhausted', { tier: req.tier, scope, used: refusal.used, cap: refusal.cap });
            return refusal;
        }
        if (status === 503 && error === 'all_rungs_failed') {
            const attempts = readAttempts(rec.attempts);
            config.logWarn?.('ai.all_rungs_failed', {
                tier: req.tier,
                attempts: attempts.map((a) => `${a.model}:${a.outcome}`).join(','),
            });
            return {
                ok: false,
                error: 'all_rungs_failed',
                tier: asString(rec.tier, req.tier),
                attempts,
                totalLatencyMs: nullableNumber(rec.totalLatencyMs),
            };
        }
        if (status === 400 && error === 'unknown_tier') {
            const detail = asString(rec.detail);
            report(new Error(`exo-ai does not know tier "${req.tier}"`), 'ai.complete.unknown_tier', { tier: req.tier });
            return {
                ok: false,
                error: 'unknown_tier',
                tier: req.tier,
                tiers: asArray(rec.tiers).map((t) => asString(t)).filter(Boolean),
                detail,
            };
        }
        if (status === 400) {
            const detail = asString(rec.detail) || error || 'bad request';
            report(new Error(`exo-ai refused the request: ${detail}`), 'ai.complete.bad_request', { tier: req.tier });
            return { ok: false, error: 'bad_request', detail };
        }
        return common(status, body, 'ai.complete');
    }
    function refuseLocally(detail, tier) {
        report(new Error(`exo-ai request refused before sending: ${detail}`), 'ai.complete.bad_request', { tier });
        return { ok: false, error: 'bad_request', detail };
    }
    async function usage(opts = {}) {
        if (!configured)
            return { ok: false, error: 'not_configured' };
        const http = await request('/v1/usage', { method: 'GET' }, opts.timeoutMs ?? USAGE_TIMEOUT_MS, 'ai.usage');
        if ('failed' in http)
            return http.failed;
        const { status, body } = http;
        if (status === 200) {
            if (isRecord(body) && typeof body.cap === 'number') {
                return { ok: true, product: asString(body.product), usedToday: nullableNumber(body.usedToday), cap: body.cap };
            }
            report(new Error('exo-ai answered 200 without the contract'), 'ai.usage.malformed_response');
            return { ok: false, error: 'unavailable', status, detail: 'malformed response' };
        }
        return common(status, body, 'ai.usage');
    }
    return { complete, usage };
}
function readAttempts(raw) {
    return asArray(raw)
        .filter(isRecord)
        .map((a) => ({
        rung: asNumber(a.rung),
        model: asString(a.model),
        pool: asString(a.pool),
        outcome: asString(a.outcome),
        httpStatus: nullableNumber(a.httpStatus),
        latencyMs: asNumber(a.latencyMs),
        tries: asNumber(a.tries),
        promptTokens: nullableNumber(a.promptTokens),
        completionTokens: nullableNumber(a.completionTokens),
        totalTokens: nullableNumber(a.totalTokens),
        detail: typeof a.detail === 'string' ? a.detail : null,
    }));
}
function nullableNumber(v) {
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
/**
 * By name, not `instanceof Error`: `AbortSignal.timeout` rejects with a
 * `DOMException`, and whether that is an `Error` depends on the runtime.
 */
function isTimeout(err) {
    const name = typeof err === 'object' && err !== null ? err.name : undefined;
    return name === 'TimeoutError' || name === 'AbortError';
}
//# sourceMappingURL=index.js.map