import type { Sql } from 'postgres';
import type { ReportError } from './types.js';
export interface DbConfig {
    /**
     * The connection string, already resolved by the caller. The kit never reads
     * `process.env`, and this is the field where that rule earns its keep: one
     * product spells the variable `POSTGRES_URL`, another `DATABASE_URL`, and a
     * third accepts both because an engine once read one name while the
     * installation set the other and the whole package degraded to a silent
     * no-op. Which name is right is a question about a deployment, not about a
     * pool.
     *
     * `null` / `undefined` means "not configured", which is a supported state:
     * every accessor below then answers the not-available branch instead of
     * throwing. A product with no database still boots.
     */
    url: string | null | undefined;
    /** Pool size. Default 10 — right for a single host; raise when the deployment grows. */
    poolMax?: number;
    /**
     * Caps any single query. Default 15s, so a pathological query cannot pin a
     * pool connection indefinitely and starve every other route.
     */
    statementTimeoutMs?: number;
    idleTimeout?: number;
    connectTimeout?: number;
    /** Called when a `query()` call throws. Optional; see {@link ReportError}. */
    reportError?: ReportError;
    /**
     * Reuse one pool across hot reloads by caching it on `globalThis` under this
     * key. Dev-server reloads re-evaluate modules, and without this each reload
     * opens a fresh pool while the old one keeps its connections. Leave unset in
     * tests and short-lived scripts so each instance is independent.
     */
    globalKey?: string;
}
export type DbOutcome<T> = {
    ok: true;
    rows: T;
} | {
    ok: false;
    reason: 'unavailable' | 'error';
    error?: Error;
};
export interface Db {
    /** The postgres.js tagged-template client, or `null` when not configured. */
    readonly sql: Sql | null;
    /** Run a query, returning `null` on error or when the database is unavailable. */
    query<T>(fn: (sql: Sql) => Promise<T>): Promise<T | null>;
    /** Like {@link query}, but keeps infrastructure failure distinguishable from an empty result. */
    tryQuery<T>(fn: (sql: Sql) => Promise<T>): Promise<DbOutcome<T>>;
    /** The only correct way to send a value into a `jsonb` column — see below. */
    jsonb(value: unknown): ReturnType<Sql['json']> | null;
}
/**
 * Build a Postgres accessor from an explicit config.
 *
 *     const { sql, query, tryQuery, jsonb } = createDb({
 *       url: process.env.POSTGRES_URL,
 *       reportError: (err, ctx) => { log.warn(ctx.event); captureException(err); },
 *     });
 *
 * Destructuring is the intended spelling: the returned functions are bound to
 * this instance, so a product keeps the flat `query(...)` call sites it already
 * has and gains one wiring file that holds its configuration.
 */
export declare function createDb(config: DbConfig): Db;
//# sourceMappingURL=db.d.ts.map