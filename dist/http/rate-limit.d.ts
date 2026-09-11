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
export interface RateLimitRule {
    /** Max requests allowed within the window. */
    limit: number;
    /** Window length in seconds. */
    window: number;
}
/**
 * The slice of a Redis client this module uses, spelled structurally so the
 * module imports no driver — not even for a type. An `ioredis` client satisfies
 * it; `test/rate-limit.test.ts` pins that with the real class.
 */
export interface RateLimitPipeline {
    zremrangebyscore(key: string, min: number, max: number): RateLimitPipeline;
    zadd(key: string, score: number, member: string): RateLimitPipeline;
    zcard(key: string): RateLimitPipeline;
    pexpire(key: string, ms: number): RateLimitPipeline;
    exec(): Promise<[Error | null, unknown][] | null>;
}
export interface RateLimitRedis {
    multi(): RateLimitPipeline;
}
export interface RateLimiterConfig<K extends string> {
    /**
     * The cache to pace against, or `null` when the product has none — then every
     * check falls to the in-process window, which is a real limiter for a
     * single-instance deployment and an admitted weakening for any other.
     */
    redis: RateLimitRedis | null | undefined;
    /** The product's table of ceilings. Its keys become this limiter's key type. */
    policies: Record<K, RateLimitRule>;
    /**
     * Buckets whose limiter failure must DENY rather than fall back to the
     * in-process window. These are the privileged / abusable surfaces: on a
     * multi-instance deploy the fallback multiplies the effective limit by the
     * instance count, so for these a refusal beats silently weakening the only
     * protection they have.
     *
     * `NoInfer` so this list cannot narrow the key type: passing one key here
     * while the table declares twenty would otherwise leave the limiter typed for
     * that one key, and every other call site would stop compiling for a reason
     * that reads like nonsense.
     */
    failClosed?: Iterable<NoInfer<K>>;
    /** Redis key prefix. Default `ratelimit:`. */
    keyPrefix?: string;
}
export interface RateLimiter<K extends string> {
    /** True if the request is allowed, false if it exceeds the limit. */
    checkRateLimit(key: K, ip: string): Promise<boolean>;
    /** Human-readable limit message for a 429 body, e.g. `Rate limit: 10 req/min`. */
    rateLimitMessage(key: K): string;
    /**
     * How a window is written in a limit message — exported because a product
     * that translates its 429s needs the same two words in its own sentence, and
     * two spellings of "per minute" in one app is how they drift.
     */
    rateLimitUnit(window: number): string;
    /** The rule behind a key, for a product building its own message or headers. */
    rule(key: K): RateLimitRule;
}
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
export declare function createRateLimiter<K extends string>(config: RateLimiterConfig<K>): RateLimiter<K>;
//# sourceMappingURL=rate-limit.d.ts.map