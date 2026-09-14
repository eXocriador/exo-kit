import postgres from 'postgres';
import type { Sql } from 'postgres';
import type { ReportError } from './types.js';

export interface DbConfig {
  /**
   * The connection string, already resolved by the caller. The kit never reads
   * `process.env`, and this is the field where that rule earns its keep: the
   * portfolio spelled the variable `POSTGRES_URL` in some products and
   * `DATABASE_URL` in others, and one accepted both because an engine once read
   * one name while the installation set the other and the whole package
   * degraded to a silent no-op. The canonical name is `DATABASE_URL` now (plan
   * §5 C3 — dbmate reads nothing else), but which name a product uses is still
   * a question about a deployment, not about a pool.
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

export type DbOutcome<T> =
  | { ok: true; rows: T }
  | { ok: false; reason: 'unavailable' | 'error'; error?: Error };

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

function open(config: DbConfig): Sql | null {
  if (!config.url) return null;
  const max = config.poolMax;
  return postgres(config.url, {
    max: Number.isInteger(max) && (max as number) > 0 ? (max as number) : 10,
    idle_timeout: config.idleTimeout ?? 30,
    connect_timeout: config.connectTimeout ?? 10,
    onnotice: () => {},
    connection: { statement_timeout: config.statementTimeoutMs ?? 15_000 },
  });
}

/**
 * Build a Postgres accessor from an explicit config.
 *
 *     const { sql, query, tryQuery, jsonb } = createDb({
 *       url: env.DATABASE_URL,
 *       reportError: (err, ctx) => { log.warn(ctx.event); captureException(err); },
 *     });
 *
 * Destructuring is the intended spelling: the returned functions are bound to
 * this instance, so a product keeps the flat `query(...)` call sites it already
 * has and gains one wiring file that holds its configuration.
 */
export function createDb(config: DbConfig): Db {
  const cacheKey = config.globalKey;
  const store = globalThis as unknown as Record<string, Sql | undefined>;

  let sql: Sql | null;
  if (!config.url) {
    sql = null;
  } else if (cacheKey) {
    sql = store[cacheKey] ?? (store[cacheKey] = open(config)!);
  } else {
    sql = open(config);
  }

  const report = config.reportError;

  async function query<T>(fn: (s: Sql) => Promise<T>): Promise<T | null> {
    if (!sql) return null;
    try {
      return await fn(sql);
    } catch (err) {
      report?.(err, {
        component: 'db',
        event: 'db.query_error',
        fields: { err: (err as Error).message },
      });
      return null;
    }
  }

  /**
   * `query`'s `null` conflates three different things — no database
   * configured, the query threw, and (for a caller that returns rows) nothing
   * matched. That is fine for read paths that degrade to empty, and dangerous
   * for any caller whose empty result *means* something: an exactly-once
   * ledger reads a swallowed error as "already handled" and silently drops the
   * work it was guarding.
   *
   * Use this wherever "the database didn't answer" must produce a different
   * outcome from "the database answered, with nothing".
   */
  async function tryQuery<T>(fn: (s: Sql) => Promise<T>): Promise<DbOutcome<T>> {
    if (!sql) return { ok: false, reason: 'unavailable' };
    try {
      return { ok: true, rows: await fn(sql) };
    } catch (err) {
      return { ok: false, reason: 'error', error: err as Error };
    }
  }

  /**
   * The ONLY correct way to send a value into a `jsonb` column. Pass the
   * object or array itself — never a string.
   *
   *     SET brief = COALESCE(${jsonb(patch.brief)}::jsonb, brief)
   *
   * WHY THIS EXISTS AS A FUNCTION. The obvious spelling,
   * `${JSON.stringify(value)}::jsonb`, is wrong, and it is wrong SILENTLY —
   * postgres.js sees a JS string bound to a json-ish cast and JSON-encodes it
   * a second time, so the column ends up holding a jsonb *string* whose
   * contents happen to be JSON text. Nothing errors. `INSERT` succeeds,
   * `SELECT` returns something, and the corruption only surfaces at the
   * reader:
   *
   *   * `jsonb_typeof(col)` says `string`, not `object`/`array`
   *   * `col->>'field'` is NULL for every field
   *   * `col @> '["x"]'::jsonb` never matches
   *   * an app-side `isRecord(row.col)` is false, so revivers return null
   *
   * One idiom, every reader of that column dead, zero errors in any log.
   *
   * Null and undefined map to SQL NULL rather than JSON `null`, which matters
   * wherever a partial patch relies on `COALESCE(${...}, column)`: a JSON
   * `null` is a value, satisfies COALESCE, and would overwrite the stored
   * object with nothing.
   */
  function jsonb(value: unknown): ReturnType<Sql['json']> | null {
    if (value === null || value === undefined || !sql) return null;
    return sql.json(value as Parameters<Sql['json']>[0]);
  }

  return { sql, query, tryQuery, jsonb };
}
