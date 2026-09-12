import { describe, it, expect, vi } from 'vitest';
import { createHealth } from '../src/health/index.js';

/**
 * The probe has to be able to fail. Every product on this VPS writes these two
 * routes by hand, and the way they go wrong is always the same: the route
 * answers 200 without touching the thing it names. exo-vpn served `index.html`
 * for `/health/ready` for months — the monitor was green on a node whose two
 * data planes were both down, because the words "health" and "ready" did not
 * exist in the backend at all.
 *
 * So: a required check that fails must take `ready` to 503, an optional one
 * must not, a hung check must not hang the probe, and `live` must never touch
 * a dependency.
 */
const deferred = () => {
  let resolve!: (v: 'ok' | 'fail' | 'skip') => void;
  const promise = new Promise<'ok' | 'fail' | 'skip'>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

describe('createHealth', () => {
  it('live answers 200 and calls nothing', async () => {
    const db = vi.fn(async () => 'ok' as const);
    const health = createHealth({ version: 'abc1234', checks: { db }, required: ['db'] });

    const res = health.live();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok', version: 'abc1234', checks: {} });
    // Liveness is "the process answers". A compose healthcheck hits this one,
    // and a database outage must not restart a healthy process — restarting it
    // would not fix the database.
    expect(db).not.toHaveBeenCalled();
  });

  it('live hands back a fresh response every time', async () => {
    // A cached Response is a single-use body: the second read throws
    // "Body is unusable", and the second container healthcheck is the one
    // that would find out.
    const health = createHealth({ version: 'v', checks: {}, required: [] });
    expect(await health.live().json()).toEqual({ status: 'ok', version: 'v', checks: {} });
    expect(await health.live().json()).toEqual({ status: 'ok', version: 'v', checks: {} });
  });

  it('ready answers 200 when every check is ok', async () => {
    const health = createHealth({
      version: 'v',
      checks: { db: async () => 'ok' as const, redis: async () => true },
      required: ['db', 'redis'],
    });

    const res = await health.ready();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok', version: 'v', checks: { db: 'ok', redis: 'ok' } });
  });

  it('a required check that fails makes it 503', async () => {
    const health = createHealth({
      version: 'v',
      checks: { db: async () => 'fail' as const, redis: async () => 'ok' as const },
      required: ['db'],
    });

    const res = await health.ready();

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ status: 'fail', version: 'v', checks: { db: 'fail', redis: 'ok' } });
  });

  it('an optional check that fails only informs — still 200', async () => {
    // Qdrant in exointel, qBittorrent in syncwatch: the product works without
    // them, so a monitor that went red would be training the owner to ignore it.
    const health = createHealth({
      version: 'v',
      checks: { db: async () => 'ok' as const, qdrant: async () => 'fail' as const },
      required: ['db'],
    });

    const res = await health.ready();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok', version: 'v', checks: { db: 'ok', qdrant: 'fail' } });
  });

  it('a check that throws is a fail, and is reported once', async () => {
    const reportError = vi.fn();
    const health = createHealth({
      version: 'v',
      checks: {
        db: async () => {
          throw new Error('connection refused');
        },
      },
      required: ['db'],
      reportError,
    });

    const res = await health.ready();

    expect(res.status).toBe(503);
    expect((await res.json()).checks).toEqual({ db: 'fail' });
    expect(reportError).toHaveBeenCalledTimes(1);
    const [err, ctx] = reportError.mock.calls[0]!;
    expect((err as Error).message).toBe('connection refused');
    expect(ctx).toMatchObject({ component: 'health', event: 'health.check_failed', fields: { check: 'db' } });
  });

  it('a check that never settles times out as fail instead of hanging', async () => {
    const reportError = vi.fn();
    const health = createHealth({
      version: 'v',
      // A reconnecting ioredis client waits longer than the monitor's interval:
      // netwatch had to race its own timer against `redis.ping()` by hand.
      checks: { redis: () => new Promise<'ok'>(() => {}), db: async () => 'ok' as const },
      required: ['redis'],
      timeoutMs: 20,
      reportError,
    });

    const res = await health.ready();

    expect(res.status).toBe(503);
    expect((await res.json()).checks).toEqual({ redis: 'fail', db: 'ok' });
    expect(reportError.mock.calls[0]![1]).toMatchObject({ event: 'health.check_timeout', fields: { check: 'redis', timeoutMs: 20 } });
  });

  it('booleans map to ok and fail — the probes products already wrote', async () => {
    const health = createHealth({
      version: 'v',
      checks: { yes: async () => true, no: async () => false },
      required: ['yes', 'no'],
    });

    const res = await health.ready();

    expect(res.status).toBe(503);
    expect((await res.json()).checks).toEqual({ yes: 'ok', no: 'fail' });
  });

  it('skip never fails the probe, even when the check is required', async () => {
    // exo-vpn: no `wg` binary outside production is a configuration, not a
    // fault. `skip` says so in the body without turning the monitor red.
    const health = createHealth({
      version: 'v',
      checks: { wg: async () => 'skip' as const },
      required: ['wg'],
    });

    const res = await health.ready();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok', version: 'v', checks: { wg: 'skip' } });
  });

  it('runs the checks concurrently', async () => {
    const first = deferred();
    const second = deferred();
    const started: string[] = [];
    const health = createHealth({
      version: 'v',
      checks: {
        a: () => {
          started.push('a');
          return first.promise;
        },
        b: () => {
          started.push('b');
          return second.promise;
        },
      },
      required: ['a', 'b'],
    });

    const pending = health.ready();
    // Both are in flight before either answers: serial probes would add up to
    // more than the monitor's timeout as soon as a product has four of them.
    expect(started).toEqual(['a', 'b']);
    first.resolve('ok');
    second.resolve('ok');

    expect((await pending).status).toBe(200);
  });

  it('refuses a required name that is not a check', () => {
    // The typo that would otherwise make a required check optional in silence
    // — and a silently optional check is the green monitor that proves nothing.
    expect(() => createHealth({ version: 'v', checks: { db: async () => 'ok' as const }, required: ['redis'] }))
      .toThrow(/redis/);
  });

  it('no checks at all is a valid product: ready is 200 with an empty map', async () => {
    const health = createHealth({ version: 'v', checks: {}, required: [] });
    const res = await health.ready();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok', version: 'v', checks: {} });
  });

  it('says no-store: a cached readiness answer is a stale one', async () => {
    const health = createHealth({ version: 'v', checks: {}, required: [] });
    expect(health.live().headers.get('cache-control')).toBe('no-store');
    expect((await health.ready()).headers.get('cache-control')).toBe('no-store');
  });
});
