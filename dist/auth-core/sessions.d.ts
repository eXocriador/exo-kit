import type { Sql } from 'postgres';
export interface SessionMeta {
    ip?: string;
    userAgent?: string;
}
export interface SessionInfo {
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
    /** The product's query runner — `query` from `createDb`. */
    query<T>(fn: (sql: Sql) => Promise<T>): Promise<T | null>;
    /** Where resolved principals are cached between database reads. */
    cache: SessionCache;
    /**
     * Build the product's principal for a live session, or `null` to refuse.
     * Runs inside the query runner, so a throw is reported and answered as a
     * refusal rather than escaping into a route handler. See the note above:
     * this function is responsible for the expiry predicate.
     */
    resolvePrincipal(sql: Sql, sessionId: string): Promise<P | null>;
    /** How long a new session row lives. Default 7 days. */
    ttlSeconds?: number;
    /** How long a resolved principal is cached. Default 60s. */
    cacheTtlSeconds?: number;
    /** Cache key prefix. Default `session:`. */
    cacheKeyPrefix?: string;
}
export interface SessionStore<P> {
    /** Create a session for a user. Returns the raw session id (to be signed into a cookie). */
    createSession(userId: string, meta?: SessionMeta): Promise<string | null>;
    /** Resolve a session id to its principal, or null. Cached. */
    resolveSession(sessionId: string): Promise<P | null>;
    /** A user's live sessions, newest first — for a "signed-in devices" view. */
    listUserSessions(userId: string): Promise<SessionInfo[]>;
    /** Revoke one session that belongs to `userId`. Ownership-scoped. */
    revokeOwnedSession(userId: string, sessionId: string): Promise<boolean>;
    /** Revoke every session for a user except one. */
    revokeOtherSessions(userId: string, keepSessionId: string): Promise<void>;
    /** Revoke a single session (logout). */
    revokeSession(sessionId: string): Promise<void>;
    /** Revoke every session for a user. */
    revokeUserSessions(userId: string): Promise<void>;
    /** Drop cached principals for a user WITHOUT logging them out. */
    invalidateUserCache(userId: string): Promise<void>;
    /** The configured session lifetime, for a caller setting a cookie's Max-Age. */
    ttlSeconds: number;
}
export declare function createSessionStore<P>(config: SessionStoreConfig<P>): SessionStore<P>;
//# sourceMappingURL=sessions.d.ts.map