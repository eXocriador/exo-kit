import type { Sql } from 'postgres';
/**
 * The stored form of a raw session id: SHA-256, lowercase hex — 64 characters,
 * the same length as the id itself, so the column does not change.
 *
 * Exported for a product writing its own query against `sessions`, and for the
 * one-off `UPDATE` that moves existing rows (README, "Session ids are stored
 * hashed"): Postgres computes the same string with
 * `encode(sha256(convert_to(id, 'UTF8')), 'hex')`.
 */
export declare function sessionIdHash(raw: string): string;
/**
 * What a revocation did.
 *
 * `{ ok: true, revoked: 0 }` — the database answered and there was nothing to
 * revoke. `{ ok: false }` — the database did not answer (the statement threw,
 * or there is none), and NOTHING was revoked: not the rows, and not the cached
 * principals either, because their ids were never read. A caller that reports
 * "signed out everywhere" on `ok: false` is reporting something false.
 */
export type RevokeResult = {
    ok: true;
    revoked: number;
} | {
    ok: false;
};
/** What {@link SessionStore.invalidateUserCache} did — the same two outcomes. */
export type InvalidateResult = {
    ok: true;
    invalidated: number;
} | {
    ok: false;
};
export interface SessionMeta {
    ip?: string;
    userAgent?: string;
}
export interface SessionInfo {
    /** The stored id (a hash) — an identifier to show and to revoke by, never a credential. */
    id: string;
    ip: string | null;
    userAgent: string | null;
    createdAt: string;
    expiresAt: string;
}
/** The slice of a cache this module uses — `createRedis`'s accessors satisfy it. */
export interface SessionCache {
    cacheGet<T>(key: string): Promise<T | null>;
    cacheSet(key: string, value: unknown, ttlSeconds: number): Promise<void>;
    cacheDel(key: string): Promise<void>;
}
export interface SessionStoreConfig<P> {
    /** The product's query runner — `query` from `createDb`. `null` means it threw or there is no database. */
    query<T>(fn: (sql: Sql) => Promise<T>): Promise<T | null>;
    /** Where resolved principals are cached between database reads. */
    cache: SessionCache;
    /**
     * Build the product's principal for a live session, or `null` to refuse.
     * Runs inside the query runner, so a throw is reported and answered as a
     * refusal rather than escaping into a route handler. See the note above:
     * this function is responsible for the expiry predicate.
     *
     * `storedId` is the value in `sessions.id` — the HASH of the cookie's id,
     * since v0.9.0. A resolver that compares (`WHERE s.id = ${storedId}`) needs
     * no change; one that did anything else with the id does.
     */
    resolvePrincipal(sql: Sql, storedId: string): Promise<P | null>;
    /** How long a new session row lives. Default 7 days. */
    ttlSeconds?: number;
    /** How long a resolved principal is cached. Default 60s. */
    cacheTtlSeconds?: number;
    /** Cache key prefix. Default `session:`. */
    cacheKeyPrefix?: string;
}
export interface SessionStore<P> {
    /** Create a session for a user. Returns the RAW session id (to be signed into a cookie); the table gets its hash. */
    createSession(userId: string, meta?: SessionMeta): Promise<string | null>;
    /** Resolve the raw id from a cookie to its principal, or null. Cached. */
    resolveSession(rawSessionId: string): Promise<P | null>;
    /** A user's live sessions, newest first — for a "signed-in devices" view. Ids are the stored form. */
    listUserSessions(userId: string): Promise<SessionInfo[]>;
    /**
     * Revoke one session that belongs to `userId`, by its STORED id
     * (`SessionInfo.id`). Ownership-scoped. `false` covers both "not yours or
     * not there" and "the database did not answer" — the boolean predates
     * {@link RevokeResult}, and an object in its place would be truthy in every
     * `if (await revokeOwnedSession(…))` a product already has.
     */
    revokeOwnedSession(userId: string, storedId: string): Promise<boolean>;
    /** Revoke every session for a user except one, given by its STORED id (the principal's, the listing's). */
    revokeOtherSessions(userId: string, keepStoredId: string): Promise<RevokeResult>;
    /** Revoke a single session (logout), by the RAW id from the cookie. */
    revokeSession(rawSessionId: string): Promise<RevokeResult>;
    /** Revoke every session for a user. `ok: false` means none were — see {@link RevokeResult}. */
    revokeUserSessions(userId: string): Promise<RevokeResult>;
    /** Drop cached principals for a user WITHOUT logging them out. */
    invalidateUserCache(userId: string): Promise<InvalidateResult>;
    /** The stored form of a raw id — {@link sessionIdHash}, here for symmetry with `AuthTokens.tokenHash`. */
    sessionIdHash(raw: string): string;
    /** The configured session lifetime, for a caller setting a cookie's Max-Age. */
    ttlSeconds: number;
}
export declare function createSessionStore<P>(config: SessionStoreConfig<P>): SessionStore<P>;
//# sourceMappingURL=sessions.d.ts.map