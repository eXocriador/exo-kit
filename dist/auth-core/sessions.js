import { createHash, randomBytes } from 'node:crypto';
/**
 * Server-side session store (Node runtime only).
 *
 * Authoritative state is in Postgres (`sessions` joined to whatever the product
 * calls a user) so sessions survive a cache flush and stay revocable. The cache
 * holds the resolved principal for fast per-request lookup; an entry is
 * short-lived and re-checked against `expires_at` on every miss.
 *
 * ── The id in the cookie is not the id in the table ──
 * Since v0.9.0 `sessions.id` holds the SHA-256 (hex) of the id the cookie
 * carries, for the reason `auth_tokens` has always stored a hash: a copy of the
 * table — a dump, a replica, a backup someone left readable — used to be a list
 * of live sessions, and now it is a list of values nobody can present. A hash
 * fed back into a cookie is hashed again and matches nothing.
 *
 * The raw id exists in exactly two places: the return value of `createSession`
 * (to be signed into the cookie) and the argument of the two functions that are
 * handed a cookie — `resolveSession` and `revokeSession`. Everything that comes
 * back OUT of the database is the stored form: the id `resolvePrincipal`
 * receives, `SessionInfo.id`, and so whatever a product builds its principal's
 * `sessionId` from. The functions that take such an id — `revokeOwnedSession`
 * and `revokeOtherSessions` — take it as stored. Cache keys are the stored form
 * too, which is what lets a bulk revocation clear them from ids it read out of
 * the table. `test/sessions.test.ts` holds the raw id away from `sql` and the
 * cache on every path.
 *
 * ── A revocation says whether it happened ──
 * Before v0.9.0 the bulk paths answered `void`, and `ids ?? []` turned "the
 * DELETE threw" into "there was nothing to delete" — so a product could tell an
 * administrator `sessionsRevoked: true` about sessions that were still live
 * (netwatch N-11). They now answer {@link RevokeResult}. `query`'s `null` is
 * enough to tell the two apart HERE, and only here: every callback below
 * returns postgres.js's row list, which is an array even when nothing matched,
 * so `null` can only mean the statement threw or there is no database. That is
 * the case `tryQuery` exists for elsewhere; this module does not need the second
 * runner, and taking it would have changed `SessionStoreConfig`.
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
/**
 * The stored form of a raw session id: SHA-256, lowercase hex — 64 characters,
 * the same length as the id itself, so the column does not change.
 *
 * Exported for a product writing its own query against `sessions`, and for the
 * one-off `UPDATE` that moves existing rows (README, "Session ids are stored
 * hashed"): Postgres computes the same string with
 * `encode(sha256(convert_to(id, 'UTF8')), 'hex')`.
 */
export function sessionIdHash(raw) {
    return createHash('sha256').update(raw, 'utf8').digest('hex');
}
export function createSessionStore(config) {
    const query = config.query;
    const { cacheGet, cacheSet, cacheDel } = config.cache;
    const resolvePrincipal = config.resolvePrincipal;
    const ttlSeconds = config.ttlSeconds ?? DEFAULT_SESSION_TTL_SECONDS;
    const cacheTtlSeconds = config.cacheTtlSeconds ?? DEFAULT_CACHE_TTL_SECONDS;
    const prefix = config.cacheKeyPrefix ?? 'session:';
    /** Keys are built from the STORED id only — see the note at the top. */
    function cacheKey(storedId) {
        return `${prefix}${storedId}`;
    }
    async function createSession(userId, meta = {}) {
        const raw = randomBytes(32).toString('hex');
        const storedId = sessionIdHash(raw);
        const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
        const ok = await query(async (sql) => {
            await sql `
        INSERT INTO sessions (id, user_id, expires_at, ip, user_agent)
        VALUES (${storedId}, ${userId}::uuid, ${expiresAt}, ${meta.ip ?? null}, ${meta.userAgent ?? null})
      `;
            return true;
        });
        return ok ? raw : null;
    }
    async function resolveSession(rawSessionId) {
        if (!rawSessionId)
            return null;
        const storedId = sessionIdHash(rawSessionId);
        const cached = await cacheGet(cacheKey(storedId));
        if (cached)
            return cached;
        const principal = await query((sql) => resolvePrincipal(sql, storedId));
        if (!principal)
            return null;
        await cacheSet(cacheKey(storedId), principal, cacheTtlSeconds);
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
    async function revokeOwnedSession(userId, storedId) {
        const rows = await query(async (sql) => {
            return await sql `
        DELETE FROM sessions
        WHERE id = ${storedId} AND user_id = ${userId}::uuid
        RETURNING id
      `;
        });
        await cacheDel(cacheKey(storedId));
        return Boolean(rows && rows[0]);
    }
    /**
     * Clear the cache key of every row a statement returned, and say how many.
     * `null` rows is the database not answering — nothing to clear, because no id
     * was read — and is passed on as `ok: false` rather than as zero.
     */
    async function clearReturned(rows) {
        if (rows === null)
            return null;
        for (const r of rows)
            await cacheDel(cacheKey(r.id));
        return rows.length;
    }
    /**
     * Revoke every session for a user EXCEPT one (used after a password change to
     * keep the current device signed in but log out all others).
     *
     * `keepStoredId` is the stored form — what the product's principal carries
     * when its resolver selects `s.id`. Handing it the raw cookie id instead
     * matches no row, so the current device is signed out with the rest: the
     * mistake fails closed, and it is still a mistake.
     */
    async function revokeOtherSessions(userId, keepStoredId) {
        const ids = await query(async (sql) => {
            return await sql `
        DELETE FROM sessions
        WHERE user_id = ${userId}::uuid AND id <> ${keepStoredId}
        RETURNING id`;
        });
        const revoked = await clearReturned(ids);
        return revoked === null ? { ok: false } : { ok: true, revoked };
    }
    /** Row first, then the cache entry — see `revokeUserSessions` for why the
     *  order is load-bearing. The key is cleared even when the database did not
     *  answer: it is known without reading anything, and a cached principal is
     *  the one part of the session that can still be taken away. */
    async function revokeSession(rawSessionId) {
        const storedId = sessionIdHash(rawSessionId);
        const rows = await query(async (sql) => {
            return await sql `DELETE FROM sessions WHERE id = ${storedId} RETURNING id`;
        });
        await cacheDel(cacheKey(storedId));
        return rows === null ? { ok: false } : { ok: true, revoked: rows.length };
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
     * `{ ok: false }` when the DELETE did not run. The caller must not then say
     * the sessions are gone — that is exactly what the old `void` let it say.
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
        const revoked = await clearReturned(ids);
        return revoked === null ? { ok: false } : { ok: true, revoked };
    }
    /**
     * Drop the cached principal for every live session of a user WITHOUT logging
     * them out. Used when an admin changes a role or a grant: the user stays
     * signed in but their next request re-resolves from Postgres.
     *
     * `{ ok: false }` means the old principals are still cached for up to the
     * cache lifetime — a role just taken away still works for that long.
     */
    async function invalidateUserCache(userId) {
        const ids = await query(async (sql) => {
            return await sql `SELECT id FROM sessions WHERE user_id = ${userId}::uuid`;
        });
        const invalidated = await clearReturned(ids);
        return invalidated === null ? { ok: false } : { ok: true, invalidated };
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
        sessionIdHash,
        ttlSeconds,
    };
}
//# sourceMappingURL=sessions.js.map