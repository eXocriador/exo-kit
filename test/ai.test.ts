import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAiClient, type AiClientConfig } from '../src/ai/index.js';

type FetchArgs = Parameters<typeof fetch>;

const replying = (status: number, body?: unknown) =>
  vi.fn(async (..._args: FetchArgs) =>
    new Response(body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body), { status }),
  );

function client(fetchImpl: ReturnType<typeof vi.fn>, extra: Partial<AiClientConfig> = {}) {
  const reportError = vi.fn();
  const logWarn = vi.fn();
  const ai = createAiClient({
    baseUrl: 'http://exo-ai.test:3000/',
    key: 'exoai-alpha-0123456789abcdef',
    fetch: fetchImpl as unknown as typeof fetch,
    reportError,
    logWarn,
    ...extra,
  });
  return { ai, reportError, logWarn };
}

const MESSAGES = [
  { role: 'system' as const, content: 'be brief' },
  { role: 'user' as const, content: 'hi' },
];

/** The service's own 200 body, as `products/exo-ai/repo/src/http/server.ts` writes it. */
const ANSWER = {
  content: 'hello',
  model: 'gemini-3.1-flash-lite',
  pool: 'gemini-lite',
  rung: 1,
  tier: 'fast',
  attempts: [
    {
      rung: 0, model: 'gemini-3-flash-preview', pool: 'gemini-premium', outcome: 'skipped',
      httpStatus: null, latencyMs: 0, tries: 0, promptTokens: null, completionTokens: null,
      totalTokens: null, detail: 'пул відомо вичерпаний',
    },
    {
      rung: 1, model: 'gemini-3.1-flash-lite', pool: 'gemini-lite', outcome: 'ok',
      httpStatus: 200, latencyMs: 640, tries: 1, promptTokens: 12, completionTokens: 3,
      totalTokens: 15, detail: null,
    },
  ],
  totalLatencyMs: 641,
};

function sent(fetchImpl: ReturnType<typeof vi.fn>, call = 0) {
  const [url, init] = fetchImpl.mock.calls[call] as [string, RequestInit];
  return {
    url,
    headers: init.headers as Record<string, string>,
    body: init.body ? JSON.parse(String(init.body)) : null,
    method: init.method,
  };
}

describe('createAiClient — not configured', () => {
  /**
   * The same rule `createDb({ url: null })` follows: a development console
   * with no service must boot, and learn by checking. Nothing is sent and
   * nothing is reported — a missing address is a configuration, not a fault.
   */
  it('answers not_configured without a request when the address or the key is missing', async () => {
    for (const cfg of [{ baseUrl: null }, { baseUrl: '' }, { key: undefined }, { key: '  ' }]) {
      const fetchImpl = replying(200, ANSWER);
      const { ai, reportError } = client(fetchImpl, cfg);
      expect(await ai.complete({ tier: 'fast', messages: MESSAGES })).toEqual({ ok: false, error: 'not_configured' });
      expect(await ai.usage()).toEqual({ ok: false, error: 'not_configured' });
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(reportError).not.toHaveBeenCalled();
    }
  });

  it('never reads process.env — the address arrives as an argument', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(resolve(here, '../src/ai/index.ts'), 'utf8');
    expect(source).not.toMatch(/process\.env\s*[.[]/);
  });
});

describe('createAiClient — the request', () => {
  it('posts the tier, the conversation and the charge to /v1/complete under the product key', async () => {
    const fetchImpl = replying(200, ANSWER);
    const { ai } = client(fetchImpl);

    await ai.complete({
      tier: 'capable',
      messages: MESSAGES,
      maxTokens: 600,
      temperature: 0.2,
      subject: 'acme:user:42',
      requestId: 'acme:turn:7',
    });

    const req = sent(fetchImpl);
    // The trailing slash in the configured address does not double up.
    expect(req.url).toBe('http://exo-ai.test:3000/v1/complete');
    expect(req.method).toBe('POST');
    expect(req.headers.Authorization).toBe('Bearer exoai-alpha-0123456789abcdef');
    expect(req.body).toEqual({
      tier: 'capable',
      messages: MESSAGES,
      max_tokens: 600,
      temperature: 0.2,
      subject: 'acme:user:42',
      request_id: 'acme:turn:7',
    });
  });

  it('sends a prompt as a prompt, and leaves unset options to the service', async () => {
    const fetchImpl = replying(200, ANSWER);
    const { ai } = client(fetchImpl);

    await ai.complete({ tier: 'fast', prompt: 'ping', subject: null });

    // No `max_tokens: undefined`, no `subject: null` — the service's defaults
    // are the defaults, and a null subject charges the product ceiling only.
    expect(sent(fetchImpl).body).toEqual({ tier: 'fast', prompt: 'ping' });
  });

  it('refuses a request with neither messages nor a prompt, before sending it', async () => {
    const fetchImpl = replying(200, ANSWER);
    const { ai } = client(fetchImpl);

    const out = await ai.complete({ tier: 'fast', messages: [] });

    expect(out).toMatchObject({ ok: false, error: 'bad_request' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  /**
   * The service cuts a subject to 200 characters. Two subjects sharing that
   * prefix would then share a counter, and one customer could spend another
   * out of a ceiling they never touched — so a long one is refused here,
   * where a test sees it, instead of being truncated there, where nobody does.
   */
  it('refuses a subject the service would truncate, rather than merging two counters', async () => {
    const fetchImpl = replying(200, ANSWER);
    const { ai, reportError } = client(fetchImpl);

    const out = await ai.complete({ tier: 'fast', messages: MESSAGES, subject: 'x'.repeat(201) });

    expect(out).toMatchObject({ ok: false, error: 'bad_request' });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledWith(expect.any(Error), expect.objectContaining({ component: 'ai' }));
  });
});

describe('createAiClient — the answer', () => {
  it('returns the content with the model, pool and rung that produced it', async () => {
    const { ai, reportError, logWarn } = client(replying(200, ANSWER));

    const out = await ai.complete({ tier: 'fast', messages: MESSAGES });

    expect(out).toEqual({ ok: true, ...ANSWER });
    expect(reportError).not.toHaveBeenCalled();
    expect(logWarn).not.toHaveBeenCalled();
  });

  it('keeps an empty completion as an answer — the model ran and said nothing', async () => {
    const { ai } = client(replying(200, { ...ANSWER, content: null }));
    expect(await ai.complete({ tier: 'fast', messages: MESSAGES })).toMatchObject({ ok: true, content: '' });
  });

  it('calls a 200 without a model id unavailable, not an answer', async () => {
    // The service's fake-200 detector exists because a status code alone
    // proves nothing. The client holds the same line one hop later.
    const { ai, reportError } = client(replying(200, { content: 'Gemini 3.5 Flash is no longer available' }));

    const out = await ai.complete({ tier: 'fast', messages: MESSAGES });

    expect(out).toEqual({ ok: false, error: 'unavailable', status: 200, detail: 'malformed response' });
    expect(reportError).toHaveBeenCalledOnce();
  });
});

describe('createAiClient — the two refusals a product must tell apart', () => {
  it('budget_exhausted: a ceiling closed, degrade to a person, report nothing as a fault', async () => {
    const fetchImpl = replying(429, {
      error: 'budget_exhausted', scope: 'subject', used: 301, cap: 300, degrade: 'human_handoff',
    });
    const { ai, reportError, logWarn } = client(fetchImpl);

    const out = await ai.complete({ tier: 'capable', messages: MESSAGES, subject: 'acme:user:42' });

    expect(out).toEqual({
      ok: false, error: 'budget_exhausted', degrade: 'human_handoff', scope: 'subject', used: 301, cap: 300,
    });
    expect(reportError).not.toHaveBeenCalled();
    expect(logWarn).toHaveBeenCalledWith('ai.budget_exhausted', expect.objectContaining({ scope: 'subject' }));
  });

  it('all_rungs_failed: an outage, with the attempts that prove it', async () => {
    const attempts = ANSWER.attempts.map((a) => ({ ...a, outcome: 'exhausted', httpStatus: 429 }));
    const { ai, reportError, logWarn } = client(
      replying(503, { error: 'all_rungs_failed', tier: 'capable', attempts, totalLatencyMs: 90 }),
    );

    const out = await ai.complete({ tier: 'capable', messages: MESSAGES });

    expect(out).toEqual({ ok: false, error: 'all_rungs_failed', tier: 'capable', attempts, totalLatencyMs: 90 });
    expect(reportError).not.toHaveBeenCalled();
    expect(logWarn).toHaveBeenCalledWith('ai.all_rungs_failed', expect.objectContaining({ tier: 'capable' }));
  });

  it('does not retry either of them — the service already climbed the ladder', async () => {
    for (const [status, body] of [
      [503, { error: 'all_rungs_failed', tier: 'fast', attempts: [] }],
      [429, { error: 'budget_exhausted', degrade: 'human_handoff' }],
    ] as const) {
      const fetchImpl = replying(status, body);
      await client(fetchImpl).ai.complete({ tier: 'fast', messages: MESSAGES });
      expect(fetchImpl).toHaveBeenCalledOnce();
    }
  });

  /**
   * A 429 or a 503 WITHOUT the service's body is some other hop talking — a
   * proxy, a container that is still starting. Reading it as "the ceiling
   * closed" would send a customer to a person on a guess, and reading it as
   * "every rung failed" would claim the ladder ran when it never did.
   */
  it('reads a bare 429 or 503 as unavailable, not as either refusal', async () => {
    const tooMany = await client(replying(429, 'Too Many Requests')).ai.complete({ tier: 'fast', messages: MESSAGES });
    expect(tooMany).toMatchObject({ ok: false, error: 'unavailable', status: 429 });

    const starting = await client(replying(503)).ai.complete({ tier: 'fast', messages: MESSAGES });
    expect(starting).toMatchObject({ ok: false, error: 'unavailable', status: 503 });
  });
});

describe('createAiClient — integration mistakes and outages', () => {
  it('unknown_tier names the tiers the service does have, and is reported', async () => {
    const { ai, reportError } = client(
      replying(400, { error: 'unknown_tier', detail: 'тир "smart" не оголошений', tiers: ['fast', 'capable', 'agent'] }),
    );

    const out = await ai.complete({ tier: 'smart', messages: MESSAGES });

    expect(out).toEqual({
      ok: false, error: 'unknown_tier', tier: 'smart', tiers: ['fast', 'capable', 'agent'], detail: 'тир "smart" не оголошений',
    });
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ component: 'ai', event: 'ai.complete.unknown_tier' }),
    );
  });

  it('a refused key is unauthorized', async () => {
    const { ai, reportError } = client(replying(401, { error: 'unauthorized' }));
    expect(await ai.complete({ tier: 'fast', messages: MESSAGES })).toEqual({ ok: false, error: 'unauthorized' });
    expect(reportError).toHaveBeenCalledOnce();
  });

  it('another 400 is a bad_request with the service detail', async () => {
    const { ai } = client(replying(400, { error: 'bad_request', detail: 'потрібен tier' }));
    expect(await ai.complete({ tier: 'fast', messages: MESSAGES })).toEqual({
      ok: false, error: 'bad_request', detail: 'потрібен tier',
    });
  });

  it('a dropped connection is unavailable, and never a throw', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    const { ai, reportError } = client(fetchImpl);

    const out = await ai.complete({ tier: 'fast', messages: MESSAGES });

    expect(out).toEqual({ ok: false, error: 'unavailable', status: null, detail: 'fetch failed' });
    expect(reportError).toHaveBeenCalledWith(
      expect.any(TypeError),
      expect.objectContaining({ event: 'ai.complete.request_error' }),
    );
  });
});

describe('createAiClient — the timeout is per call', () => {
  /** A fetch that answers only when its signal gives up, as a hung service would. */
  const hanging = () =>
    vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        }),
    );

  it('uses the call’s own ceiling over the client default', async () => {
    const { ai, reportError } = client(hanging(), { timeoutMs: 60_000 });

    const started = Date.now();
    const out = await ai.complete({ tier: 'agent', messages: MESSAGES, timeoutMs: 30 });

    expect(out).toEqual({ ok: false, error: 'timeout', timeoutMs: 30 });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(reportError).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ event: 'ai.complete.timeout' }),
    );
  });

  it('falls back to the client default when the call names none', async () => {
    const { ai } = client(hanging(), { timeoutMs: 25 });
    expect(await ai.complete({ tier: 'fast', messages: MESSAGES })).toEqual({ ok: false, error: 'timeout', timeoutMs: 25 });
  });
});

describe('createAiClient — usage', () => {
  it('reads what the product was charged today', async () => {
    const fetchImpl = replying(200, { product: 'alpha', usedToday: 17, cap: 2000 });
    const { ai } = client(fetchImpl);

    expect(await ai.usage()).toEqual({ ok: true, product: 'alpha', usedToday: 17, cap: 2000 });
    expect(sent(fetchImpl).url).toBe('http://exo-ai.test:3000/v1/usage');
    expect(sent(fetchImpl).method).toBe('GET');
  });

  it('keeps an unreadable counter as null, not zero', async () => {
    const { ai } = client(replying(200, { product: 'alpha', usedToday: null, cap: 2000 }));
    expect(await ai.usage()).toEqual({ ok: true, product: 'alpha', usedToday: null, cap: 2000 });
  });

  it('a refused key is unauthorized here too', async () => {
    const { ai } = client(replying(401, { error: 'unauthorized' }));
    expect(await ai.usage()).toEqual({ ok: false, error: 'unauthorized' });
  });
});
