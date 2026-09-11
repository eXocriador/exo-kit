/**
 * Session cookie format + signature.
 *
 * The cookie value is `<sessionId>.<hmac>` where hmac = HMAC-SHA256(sessionId)
 * keyed by the product's session secret. An edge proxy verifies the signature
 * for a cheap "is this a cookie we issued" gate; the authoritative
 * not-revoked / still-permitted check happens server-side against the session
 * store.
 *
 * ── This is its own entry, and that is the point ──
 * `@exo/kit/auth-core/cookie` imports NOTHING: it uses Web Crypto
 * (`globalThis.crypto.subtle`), not `node:crypto`, so the one piece of the auth
 * module an edge runtime needs can be reached without dragging scrypt, TOTP and
 * a Postgres type in behind it. Importing `@exo/kit/auth-core` from an edge
 * proxy would be a broken build; `test/entry-graph.test.ts` pins both halves.
 *
 * ── What the factory takes, and why ──
 * A cookie name and a secret, both required. The copies this came from differed
 * by exactly fourteen lines and every one of them was one of those two: a
 * cookie named for the product that issued it, and a development fallback
 * secret. One of those copies was, for a while, named after the OTHER product —
 * it arrived by copying, and a cookie named for an application that did not
 * issue it is a false claim about provenance that no test can see.
 */
export interface SessionCookieConfig {
    /**
     * The cookie's name. Required and undefaulted: a default would be the value
     * that gets copied into the next product.
     */
    cookieName: string;
    /**
     * The HMAC key, read at call time rather than taken as a string, so a build
     * that never signs anything never needs the secret to exist — and so a
     * product can decide for itself what "missing in production" means. Ours
     * throw; that decision needs `NODE_ENV`, which the kit does not read.
     */
    secret: () => string;
}
export interface SessionCookie {
    /** The cookie name this instance signs for. */
    readonly SESSION_COOKIE: string;
    /** Build the signed cookie value for a session id. */
    signSession(sessionId: string): Promise<string>;
    /** Verify a signed cookie value, returning the session id or null. */
    verifySignedSession(value: string | undefined | null): Promise<string | null>;
}
export declare function createSessionCookie(config: SessionCookieConfig): SessionCookie;
//# sourceMappingURL=cookie.d.ts.map