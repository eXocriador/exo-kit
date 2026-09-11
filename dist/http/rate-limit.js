/**
 * Per-route request pacing over a Redis sorted set, with an in-process sliding
 * window behind it.
 *
 * ── The registry is an argument, and that is the whole point of this file ──
 * The two copies this came from had drifted by 223 lines, and every one of them
 * was in the table: one product paces ~100 routes with a plan-shaped vocabulary
 * (`billingCheckout`, `supportBackfill`, `telegramLoginStart`), the other paces
 * eleven and deliberately has no `authRegister` at all, because accounts there
 * are created by an administrator and a limit on a route that must not exist
 * reads as permission for it. The MECHANISM under both — sliding window, atomic
 * pipeline, fail-closed set, message wording — was identical to the character.
 *
 * So the table arrives as `policies` and the keys are inferred from it: a
 * product keeps its own `RateLimitKey` union, its own comments explaining why
 * each ceiling is where it is, and its own decision about which buckets must
 * refuse rather than degrade. Nothing here knows a route name.
 */
/**
 * Build a limiter from an explicit config.
 *
 *     export const { checkRateLimit, rateLimitMessage } = createRateLimiter({
 *       redis,
 *       policies: RATE_LIMITS,
 *       failClosed: FAIL_CLOSED_KEYS,
 *     });
 *
 * The in-process buckets live in this closure rather than in module scope, so
 * two limiters (a test and the app, or two products in one process) cannot
 * share a window by accident.
 */
export function createRateLimiter(config) {
    const redis = config.redis ?? null;
    const policies = config.policies;
    const failClosedKeys = new Set(config.failClosed ?? []);
    const prefix = config.keyPrefix ?? 'ratelimit:';
    // ── In-memory fallback (used only when Redis is unavailable) ──────────────
    // Sliding window of hit timestamps per bucket. Pruned on every check, so it
    // can't grow unbounded.
    const memoryBuckets = new Map();
    function checkMemory(bucketKey, rule) {
        const now = Date.now();
        const windowMs = rule.window * 1000;
        const hits = (memoryBuckets.get(bucketKey) || []).filter((t) => now - t < windowMs);
        if (hits.length >= rule.limit) {
            // Persist the pruned list so stale timestamps still get cleaned up.
            memoryBuckets.set(bucketKey, hits);
            return false;
        }
        hits.push(now);
        memoryBuckets.set(bucketKey, hits);
        return true;
    }
    async function checkRedis(client, bucketKey, rule, failClosed) {
        // Sliding window via a sorted set of hit timestamps — matches the semantics
        // of the in-memory fallback exactly (a fixed-window INCR counter would let a
        // caller burst 2x the limit across a window boundary). One atomic pipeline:
        //   1. drop hits older than the window
        //   2. record this hit (score+member = now, unique per request)
        //   3. count hits now in the window
        //   4. (re)set a TTL so idle keys evict themselves
        try {
            const now = Date.now();
            const windowMs = rule.window * 1000;
            const member = `${now}-${Math.random().toString(36).slice(2)}`;
            const results = await client
                .multi()
                .zremrangebyscore(bucketKey, 0, now - windowMs)
                .zadd(bucketKey, now, member)
                .zcard(bucketKey)
                .pexpire(bucketKey, windowMs)
                .exec();
            // exec() returns [[err, reply], ...] in command order; ZCARD is index 2.
            const count = Number(results?.[2]?.[1] ?? 0);
            return count <= rule.limit;
        }
        catch {
            // Redis hiccup. For privileged surfaces, fail CLOSED (deny) — the in-memory
            // fallback is per-process and would multiply the limit across instances,
            // weakening the only guard on abusable tools. For read feeds, fail open to
            // the in-memory limiter so a Redis blip doesn't take the product down.
            if (failClosed)
                return false;
            return checkMemory(bucketKey, rule);
        }
    }
    function rule(key) {
        const found = policies[key];
        if (!found) {
            // A key with no rule is a caller asking for a ceiling that does not
            // exist. Answering "allowed" would silently leave the route unpaced, so
            // this throws: an unknown key is a wiring mistake, and the product's own
            // `satisfies Record<string, RateLimitRule>` normally makes it unreachable.
            throw new Error(`rate limit: no policy for key "${key}"`);
        }
        return found;
    }
    /**
     * @param key  Which configured limit to apply.
     * @param ip   Caller identity — usually the client IP, but any stable key
     *             works (e.g. the normalized account email for per-account guards).
     */
    async function checkRateLimit(key, ip) {
        const found = rule(key);
        const bucketKey = `${prefix}${key}:${ip}`;
        const failClosed = failClosedKeys.has(key);
        return redis
            ? checkRedis(redis, bucketKey, found, failClosed)
            : checkMemory(bucketKey, found);
    }
    function rateLimitUnit(window) {
        return window === 60 ? 'min' : `${window}s`;
    }
    function rateLimitMessage(key) {
        const { limit, window } = rule(key);
        return `Rate limit: ${limit} req/${rateLimitUnit(window)}`;
    }
    return { checkRateLimit, rateLimitMessage, rateLimitUnit, rule };
}
//# sourceMappingURL=rate-limit.js.map