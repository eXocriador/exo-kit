import { createHash, randomBytes } from 'node:crypto';
import type { Sql, TransactionSql } from 'postgres';

/**
 * Single-use auth tokens (email verification, password reset, a pending 2FA
 * step). Node runtime only. The raw token goes into the emailed link; only its
 * SHA-256 lands in Postgres, so a leak of the table yields nothing clickable.
 *
 * Expects a table shaped like:
 *
 *     auth_tokens(token_hash text primary key, user_id uuid, purpose text,
 *                 expires_at timestamptz, used_at timestamptz null)
 *
 * ── Purposes and lifetimes are the product's ──
 * `Purpose` is a type parameter and there are no TTL constants here. The two
 * copies this came from were byte-identical, and that identity was itself the
 * bug: one of them carried a `support_link` purpose and its 15-minute lifetime
 * for a flow it does not have, because the file arrived by copying. A purpose
 * list is a claim about which flows exist in an application; the kit has no
 * standing to make it.
 */

export interface AuthTokensConfig {
  /**
   * The product's query runner — `query` from `createDb`. Returns `null` when
   * the database is unavailable or the statement threw, and every function here
   * passes that `null` straight through, so "no database" stays distinguishable
   * from "no such token" ({@link AuthTokens.consumeAuthToken} answers `null` for
   * the first and `null` for the second — see the note on `consumeAuthTokenWith`
   * for the one caller that must tell them apart).
   */
  query<T>(fn: (sql: Sql) => Promise<T>): Promise<T | null>;
  /** Longest raw token accepted before a lookup is refused outright. Default 200. */
  maxTokenLength?: number;
}

export interface AuthTokens<Purpose extends string> {
  createAuthToken(userId: string, purpose: Purpose, ttlSeconds: number): Promise<string | null>;
  peekAuthToken(raw: string, purpose: Purpose): Promise<{ userId: string } | null>;
  consumeAuthToken(raw: string, purpose: Purpose): Promise<{ userId: string } | null>;
  consumeAuthTokenWith<T>(
    raw: string,
    purpose: Purpose,
    onConsumed: (tx: TransactionSql, userId: string) => Promise<T>,
  ): Promise<{ ok: true; userId: string; result: T } | { ok: false } | null>;
  /** The stored form of a raw token — exported for a product writing its own query. */
  tokenHash(raw: string): string;
}

export function createAuthTokens<Purpose extends string = string>(
  config: AuthTokensConfig,
): AuthTokens<Purpose> {
  const query = config.query;
  const maxLength = config.maxTokenLength ?? 200;

  function tokenHash(raw: string): string {
    return createHash('sha256').update(raw).digest('hex');
  }

  /**
   * Mint a token for a user+purpose and return the raw value (for the email
   * link), or null when the DB is unavailable. Unused older tokens of the same
   * purpose are dropped so only the most recent link works.
   */
  async function createAuthToken(
    userId: string,
    purpose: Purpose,
    ttlSeconds: number,
  ): Promise<string | null> {
    const raw = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
    const ok = await query(async (sql) => {
      await sql`
        DELETE FROM auth_tokens
        WHERE user_id = ${userId}::uuid AND purpose = ${purpose} AND used_at IS NULL
      `;
      await sql`
        INSERT INTO auth_tokens (token_hash, user_id, purpose, expires_at)
        VALUES (${tokenHash(raw)}, ${userId}::uuid, ${purpose}, ${expiresAt})
      `;
      return true;
    });
    return ok ? raw : null;
  }

  /**
   * Check a token's validity WITHOUT consuming it — used by a login-2FA step,
   * where a wrong code shouldn't burn the pending token (the user needs to be
   * able to retry within the TTL, not restart the whole login).
   */
  async function peekAuthToken(
    raw: string,
    purpose: Purpose,
  ): Promise<{ userId: string } | null> {
    if (!raw || raw.length > maxLength) return null;
    const rows = await query(async (sql) => {
      return await sql`
        SELECT user_id::text AS user_id
        FROM auth_tokens
        WHERE token_hash = ${tokenHash(raw)}
          AND purpose = ${purpose}
          AND used_at IS NULL
          AND expires_at > NOW()
        LIMIT 1
      `;
    });
    const row = rows?.[0];
    return row ? { userId: row.user_id as string } : null;
  }

  /**
   * Atomically consume a token: valid + unexpired + unused → marks it used and
   * returns the owning user id; anything else → null. Single UPDATE, so a link
   * can never be redeemed twice even under concurrent requests.
   */
  async function consumeAuthToken(
    raw: string,
    purpose: Purpose,
  ): Promise<{ userId: string } | null> {
    if (!raw || raw.length > maxLength) return null;
    const rows = await query(async (sql) => {
      return await sql`
        UPDATE auth_tokens
        SET used_at = NOW()
        WHERE token_hash = ${tokenHash(raw)}
          AND purpose = ${purpose}
          AND used_at IS NULL
          AND expires_at > NOW()
        RETURNING user_id::text AS user_id
      `;
    });
    const row = rows?.[0];
    return row ? { userId: row.user_id as string } : null;
  }

  /**
   * Same as consumeAuthToken, but runs the consume and a caller-supplied
   * follow-up write in ONE transaction. Without this, a token consumed via a
   * separate query stays consumed even if the follow-up write (setting the new
   * password, marking the email verified) then fails — permanently dead-ending
   * the link. Here, a failure in `onConsumed` rolls back the consume too.
   * `ok:false` (invalid/expired/already-used token) is distinguished from a
   * `null` return (DB unavailable/error) so callers can give the right message.
   */
  async function consumeAuthTokenWith<T>(
    raw: string,
    purpose: Purpose,
    onConsumed: (tx: TransactionSql, userId: string) => Promise<T>,
  ): Promise<{ ok: true; userId: string; result: T } | { ok: false } | null> {
    if (!raw || raw.length > maxLength) return { ok: false };
    return query(async (sql) => {
      return await sql.begin(async (tx) => {
        const rows = await tx`
          UPDATE auth_tokens
          SET used_at = NOW()
          WHERE token_hash = ${tokenHash(raw)}
            AND purpose = ${purpose}
            AND used_at IS NULL
            AND expires_at > NOW()
          RETURNING user_id::text AS user_id
        `;
        const row = rows[0];
        if (!row) return { ok: false as const };
        const result = await onConsumed(tx, row.user_id as string);
        return { ok: true as const, userId: row.user_id as string, result };
      });
    });
  }

  return {
    createAuthToken,
    peekAuthToken,
    consumeAuthToken,
    consumeAuthTokenWith,
    tokenHash,
  };
}
