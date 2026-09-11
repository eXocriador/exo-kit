import { createHash } from 'node:crypto';
/** Weak ETag from the serialized body — cheap content fingerprint for revalidation. */
function weakETag(body) {
    const digest = createHash('sha1').update(body).digest('base64').slice(0, 27);
    return `W/"${digest}"`;
}
/** True for a plain JSON object body — the only shape `degraded` can be merged into. */
function isPlainObject(v) {
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
export function createApiResponse(config) {
    const isProd = config.isProd;
    const defaultFallback = config.fallbackErrorDetail ?? 'Upstream request failed';
    function apiOk(data, options) {
        // Merge the degradation flag into the payload BEFORE serialising, so the
        // ETag covers it: a feed flipping healthy↔degraded changes the body, which
        // changes the ETag, which is what makes the client re-read instead of
        // taking the 304 shortcut. Never clobbers a `degraded` the route already set.
        const payload = options?.degraded && isPlainObject(data) && data.degraded === undefined
            ? { ...data, degraded: true }
            : data;
        const body = JSON.stringify(payload);
        const etag = weakETag(body);
        const headers = {
            'Content-Type': 'application/json',
            ETag: etag,
        };
        if (options?.cacheSeconds) {
            const maxAge = options.browserMaxAge ?? 0;
            headers['Cache-Control'] =
                `public, max-age=${maxAge}, s-maxage=${options.cacheSeconds}, stale-while-revalidate=${options.cacheSeconds * 2}`;
        }
        else if (options?.req) {
            // Conditional revalidation asked for, but no shared-cache lifetime: the
            // payload isn't for intermediaries, yet the client must be allowed to keep
            // a copy or it can never send `If-None-Match`. `no-cache` is exactly that —
            // storable, never used without revalidating — so this is `no-store`'s
            // freshness at a fraction of the bytes. See `req`'s doc above.
            headers['Cache-Control'] = 'private, no-cache';
        }
        else {
            // No explicit shared-cache lifetime: assume the payload may be
            // per-caller (session/auth/billing reads, tool results, …) and tell any
            // intermediary not to cache it at all. Routes that DO want public
            // caching opt in via `cacheSeconds`.
            headers['Cache-Control'] = 'private, no-store';
        }
        if (options?.degraded)
            headers['X-Data-Degraded'] = 'true';
        if (options?.staleAt)
            headers['X-Stale-At'] = options.staleAt;
        // Conditional revalidation: unchanged body → 304, no payload re-sent.
        const inm = options?.req?.headers.get('if-none-match');
        if (inm && inm === etag) {
            return new Response(null, { status: 304, headers });
        }
        return new Response(body, { headers });
    }
    function apiError(message, status = 500, extra) {
        return new Response(JSON.stringify({ error: message, ...extra }), {
            status,
            headers: { 'Content-Type': 'application/json' },
        });
    }
    function safeErrorDetail(e, fallback = defaultFallback) {
        if (!isProd && e instanceof Error)
            return e.message;
        return fallback;
    }
    return { apiOk, apiError, safeErrorDetail };
}
//# sourceMappingURL=api-response.js.map