import postgres from 'postgres';
function open(config) {
    if (!config.url)
        return null;
    const max = config.poolMax;
    return postgres(config.url, {
        max: Number.isInteger(max) && max > 0 ? max : 10,
        idle_timeout: config.idleTimeout ?? 30,
        connect_timeout: config.connectTimeout ?? 10,
        onnotice: () => { },
        connection: { statement_timeout: config.statementTimeoutMs ?? 15_000 },
    });
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
export function createDb(config) {
    const cacheKey = config.globalKey;
    const store = globalThis;
    let sql;
    if (!config.url) {
        sql = null;
    }
    else if (cacheKey) {
        sql = store[cacheKey] ?? (store[cacheKey] = open(config));
    }
    else {
        sql = open(config);
    }
    const report = config.reportError;
    async function query(fn) {
        if (!sql)
            return null;
        try {
            return await fn(sql);
        }
        catch (err) {
            report?.(err, {
                component: 'db',
                event: 'db.query_error',
                fields: { err: err.message },
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
    async function tryQuery(fn) {
        if (!sql)
            return { ok: false, reason: 'unavailable' };
        try {
            return { ok: true, rows: await fn(sql) };
        }
        catch (err) {
            return { ok: false, reason: 'error', error: err };
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
    function jsonb(value) {
        if (value === null || value === undefined || !sql)
            return null;
        return sql.json(value);
    }
    return { sql, query, tryQuery, jsonb };
}
//# sourceMappingURL=db.js.map