import { describe, it, expect, vi, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';
import { createConnectorHandler } from '../src/connector-sdk/index.js';

const SECRET = 'shared-with-the-support-installation';

function sign(secret: string, timestamp: number, body: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

function request(
  path: string,
  opts: { secret?: string; body?: unknown; timestamp?: number; method?: string; signature?: string } = {},
): Request {
  const method = opts.method ?? (opts.body === undefined ? 'GET' : 'POST');
  const body = opts.body === undefined ? '' : JSON.stringify(opts.body);
  const timestamp = opts.timestamp ?? Date.now();
  const signature = opts.signature ?? sign(opts.secret ?? SECRET, timestamp, body);
  return new Request(`https://product.example${path}`, {
    method,
    ...(method === 'GET' ? {} : { body }),
    headers: {
      'x-teamself-timestamp': String(timestamp),
      'x-teamself-signature': signature,
    },
  });
}

const handler = (over: Partial<Parameters<typeof createConnectorHandler>[0]> = {}) =>
  createConnectorHandler({
    secret: SECRET,
    facts: () => ({ brandName: 'Alpha' }),
    ...over,
  });

afterEach(() => {
  vi.useRealTimers();
});

describe('authenticity', () => {
  it('answers a correctly signed request', async () => {
    const res = await handler()(request('/api/support-connector/facts'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ brandName: 'Alpha' });
  });

  it('rejects a wrong signature', async () => {
    const res = await handler()(request('/api/support-connector/facts', { secret: 'wrong' }));
    expect(res.status).toBe(401);
  });

  it('rejects a missing signature', async () => {
    const req = new Request('https://product.example/api/support-connector/facts');
    expect((await handler()(req)).status).toBe(401);
  });

  it('rejects a signature of the right length but wrong bytes', async () => {
    const res = await handler()(
      request('/api/support-connector/facts', { signature: '0'.repeat(64) }),
    );
    expect(res.status).toBe(401);
  });

  it('accepts the sha256= prefix the signer may send', async () => {
    const ts = Date.now();
    const res = await handler()(
      request('/api/support-connector/facts', { timestamp: ts, signature: `sha256=${sign(SECRET, ts, '')}` }),
    );
    expect(res.status).toBe(200);
  });

  it('signs over the body, so a tampered body fails', async () => {
    const ts = Date.now();
    const req = new Request('https://product.example/api/support-connector/identity/resolve', {
      method: 'POST',
      body: JSON.stringify({ email: 'attacker@example.com' }),
      headers: {
        'x-teamself-timestamp': String(ts),
        'x-teamself-signature': sign(SECRET, ts, JSON.stringify({ email: 'victim@example.com' })),
      },
    });
    expect((await handler({ resolveIdentity: () => ({ userId: '1' }) })(req)).status).toBe(401);
  });
});

describe('replay window', () => {
  it('rejects a stale timestamp', async () => {
    const res = await handler()(
      request('/api/support-connector/facts', { timestamp: Date.now() - 10 * 60_000 }),
    );
    expect(res.status).toBe(401);
  });

  it('rejects a timestamp from the future by the same margin', async () => {
    const res = await handler()(
      request('/api/support-connector/facts', { timestamp: Date.now() + 10 * 60_000 }),
    );
    expect(res.status).toBe(401);
  });

  it('rejects a non-numeric timestamp instead of treating it as 0', async () => {
    const req = new Request('https://product.example/api/support-connector/facts', {
      headers: {
        'x-teamself-timestamp': 'not-a-number',
        'x-teamself-signature': sign(SECRET, 0, ''),
      },
    });
    expect((await handler()(req)).status).toBe(401);
  });

  it('honours a caller-widened tolerance', async () => {
    const res = await handler({ toleranceMs: 60 * 60_000 })(
      request('/api/support-connector/facts', { timestamp: Date.now() - 10 * 60_000 }),
    );
    expect(res.status).toBe(200);
  });
});

/**
 * The hazard this closes: with no secret configured, the empty string becomes
 * a valid HMAC key and anyone who knows the scheme can sign their own
 * requests. An endpoint that answers "who is this customer and what are they
 * paying for" must fail CLOSED when it is misconfigured — an unsigned
 * connector is an account-enumeration API.
 */
describe('fail-closed on a missing secret', () => {
  it('answers 503 for an empty string', async () => {
    const res = await handler({ secret: '' })(request('/api/support-connector/facts', { secret: '' }));
    expect(res.status).toBe(503);
  });

  it('answers 503 for an empty array', async () => {
    expect((await handler({ secret: [] })(request('/api/support-connector/facts'))).status).toBe(503);
  });

  it('answers 503 for an array of empty strings', async () => {
    expect((await handler({ secret: ['', ''] })(request('/api/support-connector/facts'))).status).toBe(503);
  });

  it('never calls facts when it is not configured', async () => {
    const facts = vi.fn(() => ({}));
    await handler({ secret: '', facts })(request('/api/support-connector/facts', { secret: '' }));
    expect(facts).not.toHaveBeenCalled();
  });
});

describe('rotation', () => {
  it('accepts either secret while two are configured', async () => {
    const h = handler({ secret: ['old-secret', 'new-secret'] });
    expect((await h(request('/api/support-connector/facts', { secret: 'old-secret' }))).status).toBe(200);
    expect((await h(request('/api/support-connector/facts', { secret: 'new-secret' }))).status).toBe(200);
  });

  it('still rejects a third secret', async () => {
    const h = handler({ secret: ['old-secret', 'new-secret'] });
    expect((await h(request('/api/support-connector/facts', { secret: 'other' }))).status).toBe(401);
  });
});

describe('routing', () => {
  it('resolves an identity from the signed body', async () => {
    const resolveIdentity = vi.fn((q: unknown) => ({ userId: (q as { email: string }).email }));
    const res = await handler({ resolveIdentity })(
      request('/api/support-connector/identity/resolve', { body: { email: 'a@b.c' } }),
    );
    expect(await res.json()).toEqual({ userId: 'a@b.c' });
  });

  it('answers null for identity when the product implements none', async () => {
    const res = await handler()(
      request('/api/support-connector/identity/resolve', { body: { email: 'a@b.c' } }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toBeNull();
  });

  it('answers null when the resolver finds nobody', async () => {
    const res = await handler({ resolveIdentity: () => undefined })(
      request('/api/support-connector/identity/resolve', { body: {} }),
    );
    expect(await res.json()).toBeNull();
  });

  it('runs a named tool with the userId from the body', async () => {
    const res = await handler({ tools: { account_status: async (id) => ({ id, plan: 'pro' }) } })(
      request('/api/support-connector/tools/account_status', { body: { userId: 'u-1' } }),
    );
    expect(await res.json()).toEqual({ id: 'u-1', plan: 'pro' });
  });

  it('answers 404 for a tool the product does not implement', async () => {
    const res = await handler({ tools: {} })(
      request('/api/support-connector/tools/nope', { body: { userId: 'u-1' } }),
    );
    expect(res.status).toBe(404);
  });

  it('answers 400 for a tool call with no userId', async () => {
    const res = await handler({ tools: { t: async () => ({}) } })(
      request('/api/support-connector/tools/t', { body: {} }),
    );
    expect(res.status).toBe(400);
  });

  it('answers 404 for an unknown path', async () => {
    expect((await handler()(request('/api/support-connector/whatever'))).status).toBe(404);
  });

  it('works under any mount point', async () => {
    expect((await handler()(request('/deeply/nested/mount/facts'))).status).toBe(200);
  });
});

describe('header names', () => {
  it('can be rebranded by the caller', async () => {
    const ts = Date.now();
    const req = new Request('https://product.example/facts', {
      headers: {
        'x-acme-timestamp': String(ts),
        'x-acme-signature': sign(SECRET, ts, ''),
      },
    });
    const res = await handler({ headers: { timestamp: 'x-acme-timestamp', signature: 'x-acme-signature' } })(req);
    expect(res.status).toBe(200);
  });
});
