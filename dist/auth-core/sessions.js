import { randomBytes } from 'node:crypto';
/**
 * Server-side session store (Node runtime only).
 *
 * Authoritative state is in Postgres (`sessions` joined to whatever the product
 * calls a user) so sessions survive a cache flush and stay revocable. The cache
 * holds the resolved principal for fast per-request lookup; an entry is
 * short-lived and re-checked against `expires_at` on every miss.
 *
 * ── Why the principal arrives as a resolver ──
 * This is the one place the two copies genuinely disagreed, and not
 * cosmetically. One resolves a principal carrying a subscription plan and a
 * permission set unioned from `user_permissions` and the plan's capabilities;
 * the other resolves an account status and nothing else, because an admitted
 * account there holds every tool in the product and there is no second field to
 * consult. That is an authorization model, not a spelling, and a kit that
 * shipped either one would be shipping a product's idea of who a caller is.
 *
 * So everything that is the same — the key scheme, the two lifetimes, the
 * cache-around-resolve, the listing, and the revocation ordering below, which is
 * load-bearing — lives here, and the SELECT that builds a principal is supplied
 * by the product.
 *
 * **The resolver owns liveness.** `resolveSession` does not re-check expiry
 * after the resolver returns: the query is a single round trip on the hot path
 * of every gated route, and splitting it in two to let the kit hold the
 * predicate would double it. A resolver must therefore filter on
 * `s.expires_at > NOW()` itself, and refuse an account that is not permitted to
 * act. Pin that with a test in the product — both of ours do.
 */
const DEFAULT_SESSION_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days
const DEFAULT_CACHE_TTL_SECONDS = 60; // re-validate against PG at least once a minute
export function createSessionStore(config) {
    const query = config.query;
    const { cacheGet, cacheSet, cacheDel } = config.cache;
    const resolvePrincipal = config.resolvePrincipal;
    const ttlSeconds = config.ttlSeconds ?? DEFAULT_SESSION_TTL_SECONDS;
    const cacheTtlSeconds = config.cacheTtlSeconds ?? DEFAULT_CACHE_TTL_SECONDS;
    const prefix = config.cacheKeyPrefix ?? 'session:';
    function cacheKey(sessionId) {
        return `${prefix}${sessionId}`;
    }
    async function createSession(userId, meta = {}) {
        const id = randomBytes(32).toString('hex');
        const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
        const ok = await query(async (sql) => {
            await sql `
        INSERT INTO sessions (id, user_id, expires_at, ip, user_agent)
        VALUES (${id}, ${userId}::uuid, ${expiresAt}, ${meta.ip ?? null}, ${meta.userAgent ?? null})
      `;
            return true;
        });
        return ok ? id : null;
    }
    async function resolveSession(sessionId) {
        if (!sessionId)
            return null;
        const cached = await cacheGet(cacheKey(sessionId));
        if (cached)
            return cached;
        const principal = await query((sql) => resolvePrincipal(sql, sessionId));
        if (!principal)
            return null;
        await cacheSet(cacheKey(sessionId), principal, cacheTtlSeconds);
        return principal;
    }
    async function listUserSessions(userId) {
        const rows = await query(async (sql) => {
            return await sql `
        SELECT id, ip, user_agent, created_at, expires_at
        FROM sessions
        WHERE user_id = ${userId}::uuid AND expires_at > NOW()
        ORDER BY created_at DESC
        LIMIT 50
      `;
        });
        if (!rows)
            return [];
        return rows.map((r) => ({
            id: r.id,
            ip: r.ip ?? null,
            userAgent: r.user_agent ?? null,
            createdAt: new Date(r.created_at).toISOString(),
            expiresAt: new Date(r.expires_at).toISOString(),
        }));
    }
    async function revokeOwnedSession(userId, sessionId) {
        const rows = await query(async (sql) => {
            return await sql `
        DELETE FROM sessions
        WHERE id = ${sessionId} AND user_id = ${userId}::uuid
        RETURNING id
      `;
        });
        await cacheDel(cacheKey(sessionId));
        return Boolean(rows && rows[0]);
    }
    /**
     * Revoke every session for a user EXCEPT one (used after a password change to
     * keep the current device signed in but log out all others).
     */
    async function revokeOtherSessions(userId, keepSessionId) {
        const ids = await query(async (sql) => {
            return await sql `
        DELETE FROM sessions
        WHERE user_id = ${userId}::uuid AND id <> ${keepSessionId}
        RETURNING id`;
        });
        for (const r of ids ?? [])
            await cacheDel(cacheKey(r.id));
    }
    /** Row first, then the cache entry — see `revokeUserSessions` for why the
     *  order is load-bearing. */
    async function revokeSession(sessionId) {
        await query(async (sql) => {
            await sql `DELETE FROM sessions WHERE id = ${sessionId}`;
            return true;
        });
        await cacheDel(cacheKey(sessionId));
    }
    /**
     * Revoke every session for a user (an admin disables an account, a password
     * reset).
     *
     * ORDER IS LOAD-BEARING: the row dies first, the cache key second. Clearing
     * the cache first opens a window in which a concurrent request misses the
     * cache, still finds the row in Postgres, and re-caches the principal for a
     * further cache lifetime — so a "signed out everywhere" reset email could
     * leave a stolen session live for a minute after it promised otherwise.
     * Deleting first makes that impossible: once the row is gone nothing can
     * repopulate the key.
     *
     * `RETURNING id` is what keeps this to one statement — the ids are needed for
     * the cache keys, and a separate SELECT-then-DELETE would reopen the gap it
     * closes.
     *
     * Residual, deliberately accepted: while a cache breaker is open, `cacheDel`
     * no-ops and an already-cached principal outlives revocation until its TTL.
     * That is bounded and only during an outage, whereas the ordering bug applied
     * on every healthy call.
     */
    async function revokeUserSessions(userId) {
        const ids = await query(async (sql) => {
            return await sql `DELETE FROM sessions WHERE user_id = ${userId}::uuid RETURNING id`;
        });
        for (const r of ids ?? [])
            await cacheDel(cacheKey(r.id));
    }
    /**
     * Drop the cached principal for every live session of a user WITHOUT logging
     * them out. Used when an admin changes a role or a grant: the user stays
     * signed in but their next request re-resolves from Postgres.
     */
    async function invalidateUserCache(userId) {
        const ids = await query(async (sql) => {
            return await sql `SELECT id FROM sessions WHERE user_id = ${userId}::uuid`;
        });
        for (const r of ids ?? [])
            await cacheDel(cacheKey(r.id));
    }
    return {
        createSession,
        resolveSession,
        listUserSessions,
        revokeOwnedSession,
        revokeOtherSessions,
        revokeSession,
        revokeUserSessions,
        invalidateUserCache,
        ttlSeconds,
    };
}
//# sourceMappingURL=sessions.js.map