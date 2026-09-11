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
    peekAuthToken(raw: string, purpose: Purpose): Promise<{
        userId: string;
    } | null>;
    consumeAuthToken(raw: string, purpose: Purpose): Promise<{
        userId: string;
    } | null>;
    consumeAuthTokenWith<T>(raw: string, purpose: Purpose, onConsumed: (tx: TransactionSql, userId: string) => Promise<T>): Promise<{
        ok: true;
        userId: string;
        result: T;
    } | {
        ok: false;
    } | null>;
    /** The stored form of a raw token — exported for a product writing its own query. */
    tokenHash(raw: string): string;
}
export declare function createAuthTokens<Purpose extends string = string>(config: AuthTokensConfig): AuthTokens<Purpose>;
//# sourceMappingURL=tokens.d.ts.map