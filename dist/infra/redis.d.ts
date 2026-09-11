import { Redis } from 'ioredis';
import type { RedisOptions } from 'ioredis';
import type { ReportError } from './types.js';
export interface RedisConfig {
    /**
     * Connection string, already resolved by the caller. `null` / `undefined`
     * means "not configured", and that is a supported state: every accessor
     * below then takes its graceful branch (a cache miss, a lock that is
     * granted) instead of throwing. A product with no Redis still boots and
     * still serves.
     */
    url: string | null | undefined;
    /** Merged over the defaults below. */
    clientOptions?: RedisOptions;
    /**
     * How long the breaker stays open after a failure. Default 5s.
     * See the breaker note below for why this exists at all.
     */
    breakerCooldownMs?: number;
    /**
     * Called on a connection-level error. Note this fires only when a URL IS
     * configured, so it always means configured infrastructure is actually down
     * — never "unconfigured". Products that want silence in tests decide that
     * here, which is why the kit has no `NODE_ENV` branch of its own.
     */
    reportError?: ReportError;
    /** Reuse one client across hot reloads by caching it on `globalThis` under this key. */
    globalKey?: string;
}
export interface RedisCache {
    /** The ioredis client, or `null` when not configured. */
    readonly client: Redis | null;
    /** Get a cached value. `null` on miss, on error, or when unavailable. */
    cacheGet<T>(key: string): Promise<T | null>;
    /** Set a cached value with a TTL in seconds. No-op when unavailable. */
    cacheSet(key: string, value: unknown, ttlSeconds: number): Promise<void>;
    /** Delete a cached key. No-op when unavailable. */
    cacheDel(key: string): Promise<void>;
    /** Best-effort distributed lock — see the note on {@link RedisCache.acquireLock}. */
    acquireLock(key: string, ttlSeconds: number): Promise<boolean>;
    releaseLock(key: string): Promise<void>;
    /** True while the breaker is tripped. */
    breakerOpen(): boolean;
    /** Record a raw (non-cacheGet/cacheSet) failure so the breaker trips. */
    reportFailure(): void;
}
/**
 * Build a Redis cache accessor from an explicit config.
 *
 * ── Why there is a circuit breaker ──
 * "Configured but unreachable" (container down, network partition) is a
 * different failure mode from "not configured": every operation still pays the
 * full connect/command timeout — seconds — before falling back. On a hot path
 * that adds up fast enough to take the whole route down with it, even though
 * every individual call "degraded gracefully". So any error trips a breaker
 * and real calls are skipped for a short cooldown instead of re-paying the
 * timeout on every request.
 */
export declare function createRedis(config: RedisConfig): RedisCache;
//# sourceMappingURL=redis.d.ts.map