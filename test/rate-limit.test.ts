import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Redis } from 'ioredis';
import { createRateLimiter } from '../src/http/rate-limit.js';
import type { RateLimitRedis, RateLimitRule } from '../src/http/rate-limit.js';

/**
 * The mechanism, and the proof that the table is not part of it.
 *
 * These two things are tested together on purpose: the file exists because two
 * products had the identical sliding window wrapped around two completely
 * different route tables, and a limiter that quietly shipped one product's
 * ceilings to the other would be worse than no limiter at all — it would look
 * configured.
 */

/** A stand-in for the four commands the limiter pipelines, over a real Map. */
function fakeRedis(): RateLimitRedis & { zsets: Map<string, number[]>; fail: () => void } {
  const zsets = new Map<string, number[]>();
  let broken = false;
  const client = {
    zsets,
    fail: () => {
      broken = true;
    },
    multi() {
      const ops: (() => void)[] = [];
      let card = 0;
      const chain = {
        zremrangebyscore(key: string, _min: number, max: number) {
          ops.push(() => zsets.set(key, (zsets.get(key) ?? []).filter((t) => t > max)));
          return chain;
        },
        zadd(key: string, score: number, _member: string) {
          ops.push(() => zsets.set(key, [...(zsets.get(key) ?? []), score]));
          return chain;
        },
        zcard(key: string) {
          ops.push(() => {
            card = (zsets.get(key) ?? []).length;
          });
          return chain;
        },
        pexpire(_key: string, _ms: number) {
          ops.push(() => {});
          return chain;
        },
        async exec(): Promise<[Error | null, unknown][] | null> {
          if (broken) throw new Error('redis is down');
          for (const op of ops) op();
          return [
            [null, 0],
            [null, 1],
            [null, card],
            [null, 1],
          ];
        },
      };
      return chain;
    },
  };
  return client;
}

const POLICIES = {
  login: { limit: 3, window: 60 },
  feed: { limit: 2, window: 120 },
} as const satisfies Record<string, RateLimitRule>;

describe('the ceiling is real', () => {
  it('allows up to the limit and refuses the next request, per identity', async () => {
    const { checkRateLimit } = createRateLimiter({ redis: fakeRedis(), policies: POLICIES });
    expect(await checkRateLimit('login', '1.2.3.4')).toBe(true);
    expect(await checkRateLimit('login', '1.2.3.4')).toBe(true);
    expect(await checkRateLimit('login', '1.2.3.4')).toBe(true);
    expect(await checkRateLimit('login', '1.2.3.4')).toBe(false);
    // A different caller has its own bucket and is unaffected.
    expect(await checkRateLimit('login', '5.6.7.8')).toBe(true);
    // So does a different key for the same caller.
    expect(await checkRateLimit('feed', '1.2.3.4')).toBe(true);
  });

  it('lets the caller through again once the window has slid past', async () => {
    vi.useFakeTimers();
    try {
      const { checkRateLimit } = createRateLimiter({ redis: fakeRedis(), policies: POLICIES });
      vi.setSystemTime(new Date('2026-09-11T12:00:00Z'));
      for (let i = 0; i < 3; i++) expect(await checkRateLimit('login', '1.2.3.4')).toBe(true);
      expect(await checkRateLimit('login', '1.2.3.4')).toBe(false);

      // Still refused just inside the window…
      vi.setSystemTime(new Date('2026-09-11T12:00:59Z'));
      expect(await checkRateLimit('login', '1.2.3.4')).toBe(false);

      // …and allowed once every hit has aged out of it. A limiter that only
      // ever refuses is indistinguishable from an outage.
      vi.setSystemTime(new Date('2026-09-11T12:01:01Z'));
      expect(await checkRateLimit('login', '1.2.3.4')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('paces the same way with no cache at all, in this process', async () => {
    vi.useFakeTimers();
    try {
      const { checkRateLimit } = createRateLimiter({ redis: null, policies: POLICIES });
      vi.setSystemTime(new Date('2026-09-11T12:00:00Z'));
      for (let i = 0; i < 3; i++) expect(await checkRateLimit('login', '1.2.3.4')).toBe(true);
      expect(await checkRateLimit('login', '1.2.3.4')).toBe(false);
      vi.setSystemTime(new Date('2026-09-11T12:01:01Z'));
      expect(await checkRateLimit('login', '1.2.3.4')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps two limiters' windows apart, so a test cannot pace the app", async () => {
    const a = createRateLimiter({ redis: null, policies: POLICIES });
    const b = createRateLimiter({ redis: null, policies: POLICIES });
    for (let i = 0; i < 3; i++) await a.checkRateLimit('login', '1.2.3.4');
    expect(await a.checkRateLimit('login', '1.2.3.4')).toBe(false);
    expect(await b.checkRateLimit('login', '1.2.3.4')).toBe(true);
  });
});

describe('a failing cache', () => {
  it('falls back to the in-process window for an ordinary bucket', async () => {
    const redis = fakeRedis();
    redis.fail();
    const { checkRateLimit } = createRateLimiter({ redis, policies: POLICIES });
    expect(await checkRateLimit('feed', '1.2.3.4')).toBe(true);
    expect(await checkRateLimit('feed', '1.2.3.4')).toBe(true);
    expect(await checkRateLimit('feed', '1.2.3.4')).toBe(false);
  });

  it('refuses outright for a fail-closed bucket', async () => {
    const redis = fakeRedis();
    redis.fail();
    const { checkRateLimit } = createRateLimiter({
      redis,
      policies: POLICIES,
      failClosed: ['login'],
    });
    // First call, nothing spent: a fail-open limiter would say yes here.
    expect(await checkRateLimit('login', '1.2.3.4')).toBe(false);
    expect(await checkRateLimit('feed', '1.2.3.4')).toBe(true);
  });
});

describe('the table is an argument', () => {
  it('infers its key type from the policies it was handed', async () => {
    const { checkRateLimit, rule } = createRateLimiter({ redis: null, policies: POLICIES });
    expect(rule('login')).toEqual({ limit: 3, window: 60 });
    // @ts-expect-error — 'spider' belongs to another product's table, not this one.
    await expect(checkRateLimit('spider', '1.2.3.4')).rejects.toThrow(/no policy/);
  });

  it('throws rather than silently allowing a key with no rule', async () => {
    const limiter = createRateLimiter({
      redis: null,
      policies: POLICIES as Record<string, RateLimitRule>,
    });
    await expect(limiter.checkRateLimit('nope', '1.2.3.4')).rejects.toThrow(/no policy/);
  });

  it('carries no route names of its own — the module code names none', async () => {
    // The registry that used to live in this file listed ~100 routes of one
    // product. If anything like it comes back, it will be visible here.
    // Comments come out first: the doc block names four of those routes on
    // purpose, to say what was taken out and why, and a rule that forbade
    // explaining itself would be a worse rule.
    const source = await import('node:fs')
      .then((fs) => fs.readFileSync(new URL('../src/http/rate-limit.ts', import.meta.url), 'utf8'))
      .then((text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''));
    for (const leaked of ['authLogin', 'publicFeed', 'billingWebhook', 'telegramLogin']) {
      expect(source).not.toContain(leaked);
    }
  });

  it('names buckets under a prefix a product can choose', async () => {
    const redis = fakeRedis();
    const { checkRateLimit } = createRateLimiter({
      redis,
      policies: POLICIES,
      keyPrefix: 'pace:',
    });
    await checkRateLimit('login', '1.2.3.4');
    expect([...redis.zsets.keys()]).toEqual(['pace:login:1.2.3.4']);
  });

  it('defaults that prefix to the one both products already used', async () => {
    const redis = fakeRedis();
    const { checkRateLimit } = createRateLimiter({ redis, policies: POLICIES });
    await checkRateLimit('login', '1.2.3.4');
    expect([...redis.zsets.keys()]).toEqual(['ratelimit:login:1.2.3.4']);
  });
});

describe('messages', () => {
  it('writes a minute as "min" and anything else in seconds', () => {
    const { rateLimitMessage } = createRateLimiter({ redis: null, policies: POLICIES });
    expect(rateLimitMessage('login')).toBe('Rate limit: 3 req/min');
    expect(rateLimitMessage('feed')).toBe('Rate limit: 2 req/120s');
  });
});

describe('an ioredis client satisfies the structural type', () => {
  /**
   * The module imports no driver, not even for a type — so the claim that a
   * real client fits has to be made somewhere. It is made here, at compile
   * time: this file would not typecheck if the shape had drifted.
   */
  it('accepts a Redis instance without connecting to anything', () => {
    const client = new Redis({ lazyConnect: true });
    const limiter = createRateLimiter({ redis: client, policies: POLICIES });
    expect(typeof limiter.checkRateLimit).toBe('function');
    void client.disconnect();
  });
});
