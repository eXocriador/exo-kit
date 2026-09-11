import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * ioredis is faked at the module boundary. The behaviour under test is the
 * part a live Redis would hide: what happens when it is absent, and what
 * happens when it is present but broken — which are different failure modes
 * with different costs.
 */
const { RedisMock, instances } = vi.hoisted(() => {
  const instances: FakeRedis[] = [];
  class FakeRedis {
    url: string;
    options: Record<string, unknown>;
    handlers: Record<string, ((err: Error) => void)[]> = {};
    get = vi.fn(async (_k: string): Promise<string | null> => null);
    set = vi.fn(async (..._a: unknown[]): Promise<string | null> => 'OK');
    del = vi.fn(async (_k: string): Promise<number> => 1);
    constructor(url: string, options: Record<string, unknown>) {
      this.url = url;
      this.options = options;
      instances.push(this);
    }
    on(event: string, fn: (err: Error) => void): this {
      (this.handlers[event] ??= []).push(fn);
      return this;
    }
    emit(event: string, err: Error): void {
      for (const fn of this.handlers[event] ?? []) fn(err);
    }
  }
  return { RedisMock: FakeRedis, instances };
});

vi.mock('ioredis', () => ({ default: RedisMock, Redis: RedisMock }));

const { createRedis } = await import('../src/infra/redis.js');

beforeEach(() => {
  instances.length = 0;
  vi.useRealTimers();
});

describe('not configured', () => {
  it('opens no client and still answers every call', async () => {
    const r = createRedis({ url: null });
    expect(r.client).toBeNull();
    expect(instances).toHaveLength(0);
    expect(await r.cacheGet('k')).toBeNull();
    await expect(r.cacheSet('k', 1, 60)).resolves.toBeUndefined();
    await expect(r.cacheDel('k')).resolves.toBeUndefined();
  });

  /**
   * Fails OPEN. A lock is race prevention, not correctness insurance: refusing
   * to proceed because the cache is missing would turn an optional dependency
   * into a required one.
   */
  it('grants a lock when there is no Redis to take it in', async () => {
    expect(await createRedis({ url: null }).acquireLock('k', 30)).toBe(true);
  });
});

describe('configured', () => {
  it('passes the caller’s URL through and applies the documented defaults', () => {
    createRedis({ url: 'redis://host:6379/2' });
    expect(instances[0]!.url).toBe('redis://host:6379/2');
    expect(instances[0]!.options).toMatchObject({
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
      connectTimeout: 5000,
      commandTimeout: 3000,
    });
  });

  it('lets clientOptions override a default', () => {
    createRedis({ url: 'redis://x', clientOptions: { commandTimeout: 100 } });
    expect(instances[0]!.options).toMatchObject({ commandTimeout: 100, connectTimeout: 5000 });
  });

  it('round-trips a cached value as JSON', async () => {
    const r = createRedis({ url: 'redis://x' });
    await r.cacheSet('k', { a: 1 }, 60);
    expect(instances[0]!.set).toHaveBeenCalledWith('k', '{"a":1}', 'EX', 60);
    instances[0]!.get.mockResolvedValueOnce('{"a":1}');
    expect(await r.cacheGet('k')).toEqual({ a: 1 });
  });

  it('a miss is null, not an error', async () => {
    const r = createRedis({ url: 'redis://x' });
    expect(await r.cacheGet('k')).toBeNull();
  });

  it('reports a connection error — configured infra being down is worth a signal', () => {
    const reportError = vi.fn();
    createRedis({ url: 'redis://x', reportError });
    instances[0]!.emit('error', new Error('ECONNREFUSED'));
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError.mock.calls[0]![1]).toMatchObject({
      component: 'redis',
      event: 'redis.connection_error',
    });
  });

  it('acquireLock is false when another holder has the key', async () => {
    const r = createRedis({ url: 'redis://x' });
    instances[0]!.set.mockResolvedValueOnce(null);
    expect(await r.acquireLock('k', 30)).toBe(false);
  });

  it('acquireLock uses NX and a TTL, not a bare SET', async () => {
    const r = createRedis({ url: 'redis://x' });
    await r.acquireLock('k', 30);
    expect(instances[0]!.set).toHaveBeenCalledWith('k', '1', 'EX', 30, 'NX');
  });
});

describe('circuit breaker', () => {
  it('starts closed', () => {
    expect(createRedis({ url: 'redis://x' }).breakerOpen()).toBe(false);
  });

  /**
   * The cost this guards against: "configured but unreachable" pays the full
   * command timeout on EVERY call before degrading. Each call still "degrades
   * gracefully" while the route as a whole dies of latency.
   */
  it('trips on a failed read and then skips the client entirely', async () => {
    const r = createRedis({ url: 'redis://x' });
    instances[0]!.get.mockRejectedValueOnce(new Error('timeout'));
    expect(await r.cacheGet('k')).toBeNull();
    expect(r.breakerOpen()).toBe(true);

    instances[0]!.get.mockClear();
    expect(await r.cacheGet('k')).toBeNull();
    expect(instances[0]!.get).not.toHaveBeenCalled();
  });

  it('closes again once the cooldown elapses — a trip must not be permanent', async () => {
    vi.useFakeTimers();
    const r = createRedis({ url: 'redis://x', breakerCooldownMs: 5000 });
    instances[0]!.get.mockRejectedValueOnce(new Error('timeout'));
    await r.cacheGet('k');
    expect(r.breakerOpen()).toBe(true);
    vi.advanceTimersByTime(5001);
    expect(r.breakerOpen()).toBe(false);
    vi.useRealTimers();
  });

  it('reportFailure trips it for callers doing raw client calls', () => {
    const r = createRedis({ url: 'redis://x' });
    r.reportFailure();
    expect(r.breakerOpen()).toBe(true);
  });

  it('grants locks while open rather than blocking the request path', async () => {
    const r = createRedis({ url: 'redis://x' });
    r.reportFailure();
    expect(await r.acquireLock('k', 30)).toBe(true);
  });
});

describe('globalKey', () => {
  it('reuses one client across instances', () => {
    const key = '__kit_test_redis__';
    delete (globalThis as Record<string, unknown>)[key];
    const a = createRedis({ url: 'redis://x', globalKey: key });
    const b = createRedis({ url: 'redis://x', globalKey: key });
    expect(instances).toHaveLength(1);
    expect(a.client).toBe(b.client);
    delete (globalThis as Record<string, unknown>)[key];
  });
});
