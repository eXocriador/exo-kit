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

const DEFAULTS: RedisOptions = {
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
  lazyConnect: false,
  connectTimeout: 5000,
  commandTimeout: 3000,
};

function open(config: RedisConfig): Redis | null {
  if (!config.url) return null;
  const client = new Redis(config.url, { ...DEFAULTS, ...config.clientOptions });
  client.on('error', (err: Error) => {
    config.reportError?.(err, {
      component: 'redis',
      event: 'redis.connection_error',
      fields: { err: err.message },
    });
  });
  return client;
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
export function createRedis(config: RedisConfig): RedisCache {
  const cacheKey = config.globalKey;
  const store = globalThis as unknown as Record<string, Redis | undefined>;

  let client: Redis | null;
  if (!config.url) {
    client = null;
  } else if (cacheKey) {
    client = store[cacheKey] ?? (store[cacheKey] = open(config)!);
  } else {
    client = open(config);
  }

  const cooldown = config.breakerCooldownMs ?? 5000;
  let downUntil = 0;
  const trip = (): void => {
    downUntil = Date.now() + cooldown;
  };
  const breakerOpen = (): boolean => Date.now() < downUntil;

  async function cacheGet<T>(key: string): Promise<T | null> {
    if (!client || breakerOpen()) return null;
    try {
      const raw = await client.get(key);
      return raw ? (JSON.parse(raw) as T) : null;
    } catch {
      trip();
      return null;
    }
  }

  async function cacheSet(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    if (!client || breakerOpen()) return;
    try {
      await client.set(key, JSON.stringify(value), 'EX', ttlSeconds);
    } catch {
      trip();
    }
  }

  async function cacheDel(key: string): Promise<void> {
    if (!client || breakerOpen()) return;
    try {
      await client.del(key);
    } catch {
      trip();
    }
  }

  /**
   * True if acquired, false if another holder has it. The TTL is a safety net
   * (a crashed holder cannot wedge the lock forever), not a precise expiry —
   * callers should still release explicitly when done.
   *
   * Fails OPEN (returns true, i.e. "proceed unlocked") when Redis is
   * unavailable or errors: a lock is a race-prevention nicety, not something
   * worth 503-ing a whole request over. A caller for whom that is the wrong
   * trade — where two holders corrupt data rather than duplicate work — must
   * not use this function.
   */
  async function acquireLock(key: string, ttlSeconds: number): Promise<boolean> {
    if (!client || breakerOpen()) return true;
    try {
      const ok = await client.set(key, '1', 'EX', ttlSeconds, 'NX');
      return ok === 'OK';
    } catch {
      trip();
      return true;
    }
  }

  const releaseLock = (key: string): Promise<void> => cacheDel(key);

  return {
    client,
    cacheGet,
    cacheSet,
    cacheDel,
    acquireLock,
    releaseLock,
    breakerOpen,
    reportFailure: trip,
  };
}
