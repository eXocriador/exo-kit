import { createHash, randomBytes } from 'node:crypto';
import type { Sql } from 'postgres';

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
export function sessionIdHash(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

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
  /** The product's query runner — `query` from `createDb`. */
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
  /** Revoke one session that belongs to `userId`, by its STORED id (`SessionInfo.id`). Ownership-scoped. */
  revokeOwnedSession(userId: string, storedId: string): Promise<boolean>;
  /** Revoke every session for a user except one, given by its STORED id (the principal's, the listing's). */
  revokeOtherSessions(userId: string, keepStoredId: string): Promise<void>;
  /** Revoke a single session (logout), by the RAW id from the cookie. */
  revokeSession(rawSessionId: string): Promise<void>;
  /** Revoke every session for a user. */
  revokeUserSessions(userId: string): Promise<void>;
  /** Drop cached principals for a user WITHOUT logging them out. */
  invalidateUserCache(userId: string): Promise<void>;
  /** The stored form of a raw id — {@link sessionIdHash}, here for symmetry with `AuthTokens.tokenHash`. */
  sessionIdHash(raw: string): string;
  /** The configured session lifetime, for a caller setting a cookie's Max-Age. */
  ttlSeconds: number;
}

export function createSessionStore<P>(config: SessionStoreConfig<P>): SessionStore<P> {
  const query = config.query;
  const { cacheGet, cacheSet, cacheDel } = config.cache;
  const resolvePrincipal = config.resolvePrincipal;
  const ttlSeconds = config.ttlSeconds ?? DEFAULT_SESSION_TTL_SECONDS;
  const cacheTtlSeconds = config.cacheTtlSeconds ?? DEFAULT_CACHE_TTL_SECONDS;
  const prefix = config.cacheKeyPrefix ?? 'session:';

  /** Keys are built from the STORED id only — see the note at the top. */
  function cacheKey(storedId: string): string {
    return `${prefix}${storedId}`;
  }

  async function createSession(userId: string, meta: SessionMeta = {}): Promise<string | null> {
    const raw = randomBytes(32).toString('hex');
    const storedId = sessionIdHash(raw);
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
    const ok = await query(async (sql) => {
      await sql`
        INSERT INTO sessions (id, user_id, expires_at, ip, user_agent)
        VALUES (${storedId}, ${userId}::uuid, ${expiresAt}, ${meta.ip ?? null}, ${meta.userAgent ?? null})
      `;
      return true;
    });
    return ok ? raw : null;
  }

  async function resolveSession(rawSessionId: string): Promise<P | null> {
    if (!rawSessionId) return null;
    const storedId = sessionIdHash(rawSessionId);

    const cached = await cacheGet<P>(cacheKey(storedId));
    if (cached) return cached;

    const principal = await query((sql) => resolvePrincipal(sql, storedId));
    if (!principal) return null;

    await cacheSet(cacheKey(storedId), principal, cacheTtlSeconds);
    return principal;
  }

  async function listUserSessions(userId: string): Promise<SessionInfo[]> {
    const rows = await query(async (sql) => {
      return await sql`
        SELECT id, ip, user_agent, created_at, expires_at
        FROM sessions
        WHERE user_id = ${userId}::uuid AND expires_at > NOW()
        ORDER BY created_at DESC
        LIMIT 50
      `;
    });
    if (!rows) return [];
    return rows.map((r) => ({
      id: r.id as string,
      ip: (r.ip as string | null) ?? null,
      userAgent: (r.user_agent as string | null) ?? null,
      createdAt: new Date(r.created_at as string).toISOString(),
      expiresAt: new Date(r.expires_at as string).toISOString(),
    }));
  }

  async function revokeOwnedSession(userId: string, storedId: string): Promise<boolean> {
    const rows = await query(async (sql) => {
      return await sql`
        DELETE FROM sessions
        WHERE id = ${storedId} AND user_id = ${userId}::uuid
        RETURNING id
      `;
    });
    await cacheDel(cacheKey(storedId));
    return Boolean(rows && rows[0]);
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
  async function revokeOtherSessions(userId: string, keepStoredId: string): Promise<void> {
    const ids = await query(async (sql) => {
      return await sql`
        DELETE FROM sessions
        WHERE user_id = ${userId}::uuid AND id <> ${keepStoredId}
        RETURNING id`;
    });
    for (const r of ids ?? []) await cacheDel(cacheKey(r.id as string));
  }

  /** Row first, then the cache entry — see `revokeUserSessions` for why the
   *  order is load-bearing. */
  async function revokeSession(rawSessionId: string): Promise<void> {
    const storedId = sessionIdHash(rawSessionId);
    await query(async (sql) => {
      await sql`DELETE FROM sessions WHERE id = ${storedId}`;
      return true;
    });
    await cacheDel(cacheKey(storedId));
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
  async function revokeUserSessions(userId: string): Promise<void> {
    const ids = await query(async (sql) => {
      return await sql`DELETE FROM sessions WHERE user_id = ${userId}::uuid RETURNING id`;
    });
    for (const r of ids ?? []) await cacheDel(cacheKey(r.id as string));
  }

  /**
   * Drop the cached principal for every live session of a user WITHOUT logging
   * them out. Used when an admin changes a role or a grant: the user stays
   * signed in but their next request re-resolves from Postgres.
   */
  async function invalidateUserCache(userId: string): Promise<void> {
    const ids = await query(async (sql) => {
      return await sql`SELECT id FROM sessions WHERE user_id = ${userId}::uuid`;
    });
    for (const r of ids ?? []) await cacheDel(cacheKey(r.id as string));
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
