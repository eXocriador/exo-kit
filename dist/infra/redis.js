import { Redis } from 'ioredis';
const DEFAULTS = {
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    lazyConnect: false,
    connectTimeout: 5000,
    commandTimeout: 3000,
};
function open(config) {
    if (!config.url)
        return null;
    const client = new Redis(config.url, { ...DEFAULTS, ...config.clientOptions });
    client.on('error', (err) => {
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
export function createRedis(config) {
    const cacheKey = config.globalKey;
    const store = globalThis;
    let client;
    if (!config.url) {
        client = null;
    }
    else if (cacheKey) {
        client = store[cacheKey] ?? (store[cacheKey] = open(config));
    }
    else {
        client = open(config);
    }
    const cooldown = config.breakerCooldownMs ?? 5000;
    let downUntil = 0;
    const trip = () => {
        downUntil = Date.now() + cooldown;
    };
    const breakerOpen = () => Date.now() < downUntil;
    async function cacheGet(key) {
        if (!client || breakerOpen())
            return null;
        try {
            const raw = await client.get(key);
            return raw ? JSON.parse(raw) : null;
        }
        catch {
            trip();
            return null;
        }
    }
    async function cacheSet(key, value, ttlSeconds) {
        if (!client || breakerOpen())
            return;
        try {
            await client.set(key, JSON.stringify(value), 'EX', ttlSeconds);
        }
        catch {
            trip();
        }
    }
    async function cacheDel(key) {
        if (!client || breakerOpen())
            return;
        try {
            await client.del(key);
        }
        catch {
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
    async function acquireLock(key, ttlSeconds) {
        if (!client || breakerOpen())
            return true;
        try {
            const ok = await client.set(key, '1', 'EX', ttlSeconds, 'NX');
            return ok === 'OK';
        }
        catch {
            trip();
            return true;
        }
    }
    const releaseLock = (key) => cacheDel(key);
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
//# sourceMappingURL=redis.js.map