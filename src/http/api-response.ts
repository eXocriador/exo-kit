import { createHash } from 'node:crypto';

/**
 * JSON responses for route handlers: one cache/ETag/304 machinery instead of a
 * per-route header matrix, and one sanitisation boundary for error text.
 *
 * ── Why `Response` and not `NextResponse` ──
 * The copies this came from returned `NextResponse`, and nothing they returned
 * it for was ever used: no caller reads `.cookies` off an `apiOk`, and
 * `NextResponse` is a `Response` subclass, so a route handler and every test
 * that reads `.status`, `.headers` or `.json()` cannot tell the difference. A
 * kit module that imported `next` would make a web framework a dependency of
 * the error-sanitiser, so it doesn't.
 */

export interface ApiOkOptions {
  /** Shared-cache (CDN) lifetime in seconds; also drives stale-while-revalidate. */
  cacheSeconds?: number;
  /**
   * Browser cache lifetime in seconds. Default 0 = always revalidate (live feeds
   * stay fresh; revalidation is cheap via the ETag → 304 below). Static/stable
   * feeds set a positive value so the browser serves them from disk cache
   * instantly on reload without a round-trip.
   */
  browserMaxAge?: number;
  /**
   * Pass the incoming request to enable conditional responses: when the client
   * revalidates with `If-None-Match` and the body is unchanged, we return a tiny
   * **304** instead of re-sending the full payload — "always fresh" without the
   * bandwidth/parse cost when nothing changed.
   *
   * Passing it is also the **opt-in to a storable response**: without
   * `cacheSeconds` the default below is `private, no-store`, which forbids the
   * client from keeping a copy at all — and a client with no stored copy never
   * sends `If-None-Match`, so the 304 branch could never fire. So `req` moves
   * the default to `private, no-cache`: store it, but revalidate on every use.
   * Freshness is identical to `no-store` (nothing is ever served without asking
   * the origin); only the re-download of an unchanged body is saved.
   *
   * **Therefore: only pass `req` for non-personal payloads.** Session, billing
   * and admin reads must keep the `no-store` default so nothing lands on disk
   * on a shared machine.
   */
  req?: Request;
  /**
   * Set when the payload is a fallback (empty/partial/cached-because-upstream-
   * failed) rather than a fresh, healthy fetch — the "graceful degradation
   * needs a signal" fix.
   *
   * Surfaced BOTH ways: `degraded: true` in the JSON body (when the payload is
   * a plain object) and as the `X-Data-Degraded` header. The body is what a
   * client actually reads, because a header dies wherever the payload is stored
   * and replayed — a client-side feed cache, a snapshot route, a worker's
   * persisted scope — while the flag has to survive all three. The header stays
   * for anything reading responses at the HTTP level (proxies, probes).
   */
  degraded?: boolean;
  /** ISO timestamp of the data actually being served, when it's older than "now" (e.g. serving a stale cache entry because the live fetch failed). */
  staleAt?: string;
}

export interface ApiResponseConfig {
  /**
   * Whether this process is serving production traffic. Required, and without a
   * default on purpose: the kit does not read `process.env`, and a default here
   * would be a guess about the one thing {@link ApiResponse.safeErrorDetail}
   * exists to decide. Guessing `false` leaks internal detail to clients;
   * guessing `true` hides it from the developer who is debugging locally.
   */
  isProd: boolean;
  /** Text `safeErrorDetail` falls back to when it refuses to forward the real message. */
  fallbackErrorDetail?: string;
}

export interface ApiResponse {
  /** A JSON 200 (or 304) with the cache headers and ETag the options ask for. */
  apiOk<T>(data: T, options?: ApiOkOptions): Response;
  /** A JSON error body at `status`, with any extra fields merged in. */
  apiError(message: string, status?: number, extra?: Record<string, unknown>): Response;
  /** Client-safe text for a caught exception — see {@link createApiResponse}. */
  safeErrorDetail(e: unknown, fallback?: string): string;
}

/** Weak ETag from the serialized body — cheap content fingerprint for revalidation. */
function weakETag(body: string): string {
  const digest = createHash('sha1').update(body).digest('base64').slice(0, 27);
  return `W/"${digest}"`;
}

/** True for a plain JSON object body — the only shape `degraded` can be merged into. */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Build the response helpers from an explicit config.
 *
 *     export const { apiOk, apiError, safeErrorDetail } = createApiResponse({
 *       isProd: process.env.NODE_ENV === 'production',
 *     });
 *
 * Destructuring is the intended spelling: the returned functions are bound to
 * this instance, so a product keeps its flat `apiOk(...)` call sites and gains
 * one wiring file that holds the one decision this module needs made.
 *
 * ── What `safeErrorDetail` is for ──
 * `apiError` does not sanitise; this does, and callers opt in. A failed upstream
 * fetch's `.message` can carry internal hostnames, IPs, ports or DNS detail
 * that has no business reaching a client, so in production the real message is
 * never forwarded. Outside production it passes through, because a developer
 * debugging locally is the other audience for the same string. Log the real
 * error server-side separately — this only decides what goes in a response body.
 */
export function createApiResponse(config: ApiResponseConfig): ApiResponse {
  const isProd = config.isProd;
  const defaultFallback = config.fallbackErrorDetail ?? 'Upstream request failed';

  function apiOk<T>(data: T, options?: ApiOkOptions): Response {
    // Merge the degradation flag into the payload BEFORE serialising, so the
    // ETag covers it: a feed flipping healthy↔degraded changes the body, which
    // changes the ETag, which is what makes the client re-read instead of
    // taking the 304 shortcut. Never clobbers a `degraded` the route already set.
    const payload =
      options?.degraded && isPlainObject(data) && data.degraded === undefined
        ? { ...data, degraded: true }
        : data;
    const body = JSON.stringify(payload);
    const etag = weakETag(body);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ETag: etag,
    };

    if (options?.cacheSeconds) {
      const maxAge = options.browserMaxAge ?? 0;
      headers['Cache-Control'] =
        `public, max-age=${maxAge}, s-maxage=${options.cacheSeconds}, stale-while-revalidate=${options.cacheSeconds * 2}`;
    } else if (options?.req) {
      // Conditional revalidation asked for, but no shared-cache lifetime: the
      // payload isn't for intermediaries, yet the client must be allowed to keep
      // a copy or it can never send `If-None-Match`. `no-cache` is exactly that —
      // storable, never used without revalidating — so this is `no-store`'s
      // freshness at a fraction of the bytes. See `req`'s doc above.
      headers['Cache-Control'] = 'private, no-cache';
    } else {
      // No explicit shared-cache lifetime: assume the payload may be
      // per-caller (session/auth/billing reads, tool results, …) and tell any
      // intermediary not to cache it at all. Routes that DO want public
      // caching opt in via `cacheSeconds`.
      headers['Cache-Control'] = 'private, no-store';
    }

    if (options?.degraded) headers['X-Data-Degraded'] = 'true';
    if (options?.staleAt) headers['X-Stale-At'] = options.staleAt;

    // Conditional revalidation: unchanged body → 304, no payload re-sent.
    const inm = options?.req?.headers.get('if-none-match');
    if (inm && inm === etag) {
      return new Response(null, { status: 304, headers });
    }

    return new Response(body, { headers });
  }

  function apiError(
    message: string,
    status = 500,
    extra?: Record<string, unknown>,
  ): Response {
    return new Response(JSON.stringify({ error: message, ...extra }), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  function safeErrorDetail(e: unknown, fallback = defaultFallback): string {
    if (!isProd && e instanceof Error) return e.message;
    return fallback;
  }

  return { apiOk, apiError, safeErrorDetail };
}
