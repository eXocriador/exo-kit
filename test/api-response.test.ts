import { describe, it, expect } from 'vitest';
import { createApiResponse } from '../src/http/api-response.js';

/**
 * `apiOk`'s cache/ETag/304 machinery is shared by every route of every product
 * that mounts it. Pins the header matrix and the 304 revalidation path, so a
 * change here cannot silently break every route in an application at once.
 */
const { apiOk, apiError, safeErrorDetail } = createApiResponse({ isProd: false });
describe('apiOk', () => {
  it('defaults to a private, no-store payload with a Content-Type and ETag', () => {
    const res = apiOk({ a: 1 });
    expect(res.headers.get('Content-Type')).toBe('application/json');
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(res.headers.get('ETag')).toMatch(/^W\/"/);
    expect(res.status).toBe(200);
  });

  it('sets a public shared-cache Cache-Control when cacheSeconds is given, with browserMaxAge defaulting to 0', () => {
    const res = apiOk({ a: 1 }, { cacheSeconds: 300 });
    expect(res.headers.get('Cache-Control')).toBe(
      'public, max-age=0, s-maxage=300, stale-while-revalidate=600',
    );
  });

  it('honours an explicit browserMaxAge alongside cacheSeconds', () => {
    const res = apiOk({ a: 1 }, { cacheSeconds: 60, browserMaxAge: 30 });
    expect(res.headers.get('Cache-Control')).toBe(
      'public, max-age=30, s-maxage=60, stale-while-revalidate=120',
    );
  });

  it('surfaces degraded in the BODY as well as the header', async () => {
    // The header alone had no consumer and dies wherever the payload is stored
    // and replayed (client feed cache, /api/snapshot). The body is what the
    // client reads; the header stays for HTTP-level consumers.
    const res = apiOk({ a: 1 }, { degraded: true, staleAt: '2026-01-01T00:00:00Z' });
    expect(res.headers.get('X-Data-Degraded')).toBe('true');
    expect(res.headers.get('X-Stale-At')).toBe('2026-01-01T00:00:00Z');
    expect(await res.json()).toEqual({ a: 1, degraded: true });
  });

  it('leaves the body alone when the payload cannot carry the flag', async () => {
    // An array body has nowhere to put a field — header only, never a wrapper
    // object (that would change the route's JSON shape for every consumer).
    const arr = apiOk([1, 2], { degraded: true });
    expect(arr.headers.get('X-Data-Degraded')).toBe('true');
    expect(await arr.json()).toEqual([1, 2]);
    // A route that already reports its own degradation stays authoritative.
    const own = apiOk({ a: 1, degraded: false }, { degraded: true });
    expect(await own.json()).toEqual({ a: 1, degraded: false });
  });

  it('covers degraded in the ETag, so the flag flipping breaks the 304 shortcut', () => {
    // The client skips re-reading the body on an unchanged ETag — a degradation
    // that did not change the ETag would never be seen.
    const healthy = apiOk({ a: 1 }).headers.get('ETag');
    const degraded = apiOk({ a: 1 }, { degraded: true }).headers.get('ETag');
    expect(healthy).not.toBe(degraded);
  });

  it('omits degraded/staleAt headers when not passed', () => {
    const res = apiOk({ a: 1 });
    expect(res.headers.has('X-Data-Degraded')).toBe(false);
    expect(res.headers.has('X-Stale-At')).toBe(false);
  });

  it('produces the same ETag for identical data and a different one for different data', () => {
    const a = apiOk({ x: 1, y: 2 }).headers.get('ETag');
    const b = apiOk({ x: 1, y: 2 }).headers.get('ETag');
    const c = apiOk({ x: 1, y: 3 }).headers.get('ETag');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('returns a bodyless 304 when If-None-Match matches the computed ETag', async () => {
    const data = { x: 1 };
    const etag = apiOk(data).headers.get('ETag')!;
    const req = new Request('https://x/y', { headers: { 'if-none-match': etag } });
    const res = apiOk(data, { req });
    expect(res.status).toBe(304);
    expect(await res.text()).toBe('');
    // 304 still carries the cache headers so the client can re-validate its stored copy.
    expect(res.headers.get('ETag')).toBe(etag);
  });

  it('returns the full 200 body when If-None-Match does not match', async () => {
    const req = new Request('https://x/y', { headers: { 'if-none-match': 'W/"stale"' } });
    const res = apiOk({ x: 1 }, { req });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ x: 1 });
  });

  it('returns 200 (not 304) when no req is passed, even with a matching-looking client', () => {
    // No req => no conditional path at all, regardless of what a caller might send elsewhere.
    expect(apiOk({ x: 1 }).status).toBe(200);
  });

  // ── `req` as the opt-in to a storable response (Wave 5.2) ──
  // `private, no-store` forbids the client from keeping a copy, and a client with
  // no copy never sends `If-None-Match` — so pairing the default with the 304
  // branch above made that branch unreachable in production. These pin the fix.
  it('upgrades no-store to no-cache when req is passed without cacheSeconds', () => {
    const req = new Request('https://x/y');
    expect(apiOk({ a: 1 }, { req }).headers.get('Cache-Control')).toBe('private, no-cache');
  });

  it('keeps private, no-store for personal payloads — the ones that never pass req', () => {
    // Session/billing/admin reads must stay unstorable even on a shared machine.
    expect(apiOk({ a: 1 }).headers.get('Cache-Control')).toBe('private, no-store');
    expect(apiOk({ a: 1 }, { degraded: true }).headers.get('Cache-Control')).toBe(
      'private, no-store',
    );
  });

  it('lets cacheSeconds win over the req-implied no-cache', () => {
    const req = new Request('https://x/y');
    expect(apiOk({ a: 1 }, { req, cacheSeconds: 60 }).headers.get('Cache-Control')).toBe(
      'public, max-age=0, s-maxage=60, stale-while-revalidate=120',
    );
  });

  it('serves a 304 whose headers still permit the client to keep its stored copy', async () => {
    // A 304 carrying `no-store` would tell the client to discard the very copy it
    // just revalidated — the round-trip would save nothing.
    const data = { x: 1 };
    const etag = apiOk(data).headers.get('ETag')!;
    const req = new Request('https://x/y', { headers: { 'if-none-match': etag } });
    const res = apiOk(data, { req });
    expect(res.status).toBe(304);
    expect(res.headers.get('Cache-Control')).toBe('private, no-cache');
  });
});

describe('apiError', () => {
  it('wraps the message in an {error} JSON body at the given status', async () => {
    const res = apiError('nope', 403);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'nope' });
  });

  it('defaults to 500 and merges extra fields alongside error', async () => {
    const res = apiError('boom', undefined, { code: 'X' });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'boom', code: 'X' });
  });
});

describe('safeErrorDetail', () => {
  /**
   * `isProd` is a constructor argument rather than a read of `NODE_ENV`, so the
   * production branch is exercised by building a second instance — no module
   * reset, no stubbed environment, and no variable name the kit invented.
   */
  const prod = createApiResponse({ isProd: true });

  it('outside production, passes the real Error message through', () => {
    expect(safeErrorDetail(new Error('connect ECONNREFUSED 10.0.0.5:5432'))).toBe(
      'connect ECONNREFUSED 10.0.0.5:5432',
    );
  });

  it('outside production, falls back for a non-Error throw', () => {
    expect(safeErrorDetail('a string throw')).toBe('Upstream request failed');
    expect(safeErrorDetail('a string throw', 'custom fallback')).toBe('custom fallback');
  });

  it('in production, never forwards the real message — internal detail must not leak', () => {
    expect(prod.safeErrorDetail(new Error('leaks an internal hostname'))).toBe(
      'Upstream request failed',
    );
    expect(prod.safeErrorDetail(new Error('leaks'), 'custom fallback')).toBe('custom fallback');
  });

  it('honours a configured fallback so a product can word its own refusal', () => {
    const worded = createApiResponse({ isProd: true, fallbackErrorDetail: 'Upstream unavailable' });
    expect(worded.safeErrorDetail(new Error('leaks'))).toBe('Upstream unavailable');
  });
});
