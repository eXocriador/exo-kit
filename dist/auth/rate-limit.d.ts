/**
 * Two ceilings, and they count different things. That is the whole content of
 * this file, and the reason the kit keeps it rather than letting Better Auth's
 * built-in limiter stand alone.
 *
 * **Better Auth counts IP + path.** Its storage interface is `consume(key,
 * rule)`, the key is built from the caller's address and the route, and
 * `createAuthRateLimitStorage` below serves exactly that over Redis — the same
 * sliding window as `@exo/kit/http`'s limiter, so a restart does not hand
 * anyone a fresh budget and two instances share one bucket.
 *
 * **The address ceiling counts the recipient of the letter.** It is not the
 * same guard and it does not follow from the first: behind Traefik the socket
 * address is identical for everyone, `X-Forwarded-For` only proves somebody
 * set it, and an IP ceiling does not protect a stranger's mailbox from whoever
 * is willing to change IP. `createAddressLimit` is that guard, and
 * `createAuth` wires it in front of every route that sends mail.
 *
 * (The modularity plan §4.5 says the product's own `LoginLimits` disappears
 * into the library. It does not — only half of it does. Sandbox report §3.7.)
 */
/** The rule Better Auth hands its storage: `max` requests per `window` seconds. */
export interface AuthRateLimitRule {
    window: number;
    max: number;
}
export interface AuthRateLimitDecision {
    allowed: boolean;
    /** Seconds until the caller may retry. `null` when allowed. */
    retryAfter: number | null;
}
/** What `rateLimit.customStorage` must be. Structural, so nothing imports a driver. */
export interface AuthRateLimitStorage {
    consume(key: string, rule: AuthRateLimitRule): Promise<AuthRateLimitDecision>;
}
/** The slice of a Redis client used here — an `ioredis` client satisfies it. */
export interface AuthRateLimitPipeline {
    zremrangebyscore(key: string, min: number, max: number): AuthRateLimitPipeline;
    zadd(key: string, score: number, member: string): AuthRateLimitPipeline;
    zcard(key: string): AuthRateLimitPipeline;
    pexpire(key: string, ms: number): AuthRateLimitPipeline;
    exec(): Promise<[Error | null, unknown][] | null>;
}
export interface AuthRateLimitRedis {
    multi(): AuthRateLimitPipeline;
}
export interface AuthRateLimitStorageConfig {
    /** The cache to pace against, or `null`/`undefined` for an in-process window. */
    redis: AuthRateLimitRedis | null | undefined;
    /** Redis key prefix. Default `authlimit:`. */
    keyPrefix?: string;
}
/**
 * Better Auth's rate-limit storage over our Redis.
 *
 *     rateLimitStorage: createAuthRateLimitStorage({ redis: redis.client })
 *
 * A Redis hiccup falls back to the in-process window rather than refusing:
 * these are login routes, and a cache blip that locks everybody out of the
 * product is worse than a ceiling that counts per instance for a minute. The
 * privileged surfaces that must fail closed are the product's own, paced by
 * `@exo/kit/http`, where `failClosed` says so explicitly.
 */
export declare function createAuthRateLimitStorage(config: AuthRateLimitStorageConfig): AuthRateLimitStorage;
export interface AddressLimitConfig {
    /** How many letters one address may receive per window. */
    max: number;
    /** Window length in milliseconds. */
    windowMs: number;
    /** Optional shared storage, so the ceiling survives a restart. */
    storage?: AuthRateLimitStorage | null;
}
export interface AddressLimit {
    /** `true` — a letter to this address is allowed. */
    allow(email: string): Promise<boolean>;
}
/**
 * The ceiling on letters to one address.
 *
 * Given a storage it shares the bucket with every instance and outlives a
 * restart; without one it counts in this process, which is what the products
 * did before and is still a real guard for a single-instance deployment.
 */
export declare function createAddressLimit(config: AddressLimitConfig): AddressLimit;
//# sourceMappingURL=rate-limit.d.ts.map