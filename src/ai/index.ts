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
  | {
      ok: false;
      error: 'budget_exhausted';
      degrade: 'human_handoff' | (string & {});
      /** Which ceiling: the product's, or the subject's. */
      scope: 'product' | 'subject' | null;
      used: number | null;
      cap: number | null;
    }
  /** Every rung was tried and none answered. Take the product's fail-safe path. */
  | { ok: false; error: 'all_rungs_failed'; tier: string; attempts: AiAttempt[]; totalLatencyMs: number | null }
  /** The tier is not in the service's catalogue. An integration mistake, not an outage. */
  | { ok: false; error: 'unknown_tier'; tier: string; tiers: string[]; detail: string }
  /** No address or no key. Nothing was sent. */
  | { ok: false; error: 'not_configured' }
  /** The key was refused. */
  | { ok: false; error: 'unauthorized' }
  /** The request was malformed — refused here before sending, or by the service. */
  | { ok: false; error: 'bad_request'; detail: string }
  /** The call outlived its ceiling. The service may still finish, and count, that call. */
  | { ok: false; error: 'timeout'; timeoutMs: number }
  /** Unreachable, an unexpected status, or a body that is not the contract. */
  | { ok: false; error: 'unavailable'; status: number | null; detail: string };

export type CompleteResult = AiAnswer | AiRefusal;

export type UsageResult =
  | { ok: true; product: string; usedToday: number | null; cap: number }
  | Extract<AiRefusal, { error: 'not_configured' | 'unauthorized' | 'timeout' | 'unavailable' }>;

export interface AiClient {
  /** `POST /v1/complete`. Never throws. */
  complete(request: CompleteRequest): Promise<CompleteResult>;
  /**
   * `GET /v1/usage` — what this product has been charged today, and its
   * ceiling. `usedToday` is `null` when the service could not read its
   * counter. Default timeout 5 s: this is a read for a screen, not a turn.
   */
  usage(opts?: { timeoutMs?: number }): Promise<UsageResult>;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const USAGE_TIMEOUT_MS = 5_000;
const MAX_SUBJECT = 200;

export function createAiClient(config: AiClientConfig): AiClient {
  const base = (config.baseUrl ?? '').trim().replace(/\/+$/, '');
  const key = (config.key ?? '').trim();
  const configured = base !== '' && key !== '';
  const doFetch = config.fetch ?? ((...a: Parameters<typeof fetch>) => globalThis.fetch(...a));
  const defaultTimeout = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const report = (err: unknown, event: string, fields?: Record<string, unknown>) =>
    config.reportError?.(err, { component: 'ai', event, ...(fields ? { fields } : {}) });

  type Http = { status: number; body: unknown } | { failed: AiRefusal };

  async function request(path: string, init: RequestInit, timeoutMs: number, event: string): Promise<Http> {
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
      let body: unknown = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = null;
      }
      return { status: res.status, body };
    } catch (err) {
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
  function common(status: number, body: unknown, event: string): AiRefusal {
    if (status === 401) {
      report(new Error('exo-ai refused the product key'), `${event}.unauthorized`, { status });
      return { ok: false, error: 'unauthorized' };
    }
    const detail = asString(isRecord(body) ? body.error : undefined) || `HTTP ${status}`;
    report(new Error(`exo-ai answered ${status}: ${detail}`), `${event}.unavailable`, { status });
    return { ok: false, error: 'unavailable', status, detail };
  }

  async function complete(req: CompleteRequest): Promise<CompleteResult> {
    if (!configured) return { ok: false, error: 'not_configured' };

    const hasMessages = Array.isArray(req.messages) && req.messages.length > 0;
    const hasPrompt = typeof req.prompt === 'string' && req.prompt.trim() !== '';
    if (!hasMessages && !hasPrompt) {
      return refuseLocally('messages[] or prompt is required', req.tier);
    }
    if (req.subject && req.subject.length > MAX_SUBJECT) {
      return refuseLocally(`subject is ${req.subject.length} characters; the service keeps ${MAX_SUBJECT}`, req.tier);
    }

    const timeoutMs = req.timeoutMs ?? defaultTimeout;
    const http = await request(
      '/v1/complete',
      {
        method: 'POST',
        body: JSON.stringify({
          tier: req.tier,
          ...(hasMessages ? { messages: req.messages } : { prompt: req.prompt }),
          ...(req.maxTokens === undefined ? {} : { max_tokens: req.maxTokens }),
          ...(req.temperature === undefined ? {} : { temperature: req.temperature }),
          ...(req.subject ? { subject: req.subject } : {}),
          ...(req.requestId ? { request_id: req.requestId } : {}),
        }),
      },
      timeoutMs,
      'ai.complete',
    );
    if ('failed' in http) return http.failed;

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
      const refusal: AiRefusal = {
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

  function refuseLocally(detail: string, tier: string): AiRefusal {
    report(new Error(`exo-ai request refused before sending: ${detail}`), 'ai.complete.bad_request', { tier });
    return { ok: false, error: 'bad_request', detail };
  }

  async function usage(opts: { timeoutMs?: number } = {}): Promise<UsageResult> {
    if (!configured) return { ok: false, error: 'not_configured' };
    const http = await request('/v1/usage', { method: 'GET' }, opts.timeoutMs ?? USAGE_TIMEOUT_MS, 'ai.usage');
    if ('failed' in http) return http.failed as UsageResult;

    const { status, body } = http;
    if (status === 200) {
      if (isRecord(body) && typeof body.cap === 'number') {
        return { ok: true, product: asString(body.product), usedToday: nullableNumber(body.usedToday), cap: body.cap };
      }
      report(new Error('exo-ai answered 200 without the contract'), 'ai.usage.malformed_response');
      return { ok: false, error: 'unavailable', status, detail: 'malformed response' };
    }
    return common(status, body, 'ai.usage') as UsageResult;
  }

  return { complete, usage };
}

function readAttempts(raw: unknown): AiAttempt[] {
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

function nullableNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * By name, not `instanceof Error`: `AbortSignal.timeout` rejects with a
 * `DOMException`, and whether that is an `Error` depends on the runtime.
 */
function isTimeout(err: unknown): boolean {
  const name = typeof err === 'object' && err !== null ? (err as { name?: unknown }).name : undefined;
  return name === 'TimeoutError' || name === 'AbortError';
}
