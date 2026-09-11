import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Sql } from 'postgres';
import { createSessionStore } from '../src/auth-core/sessions.js';

/**
 * `resolveSession` is the principal-resolution hot path — every gated route
 * calls it. Its whole point is the short cache in front of Postgres: a hit must
 * skip the database entirely, a miss must populate the cache, and a resolver
 * that refuses must never be cached as a principal.
 *
 * The revocation block below is the one that actually protects someone. The
 * ordering it pins — row first, cache key second — is the difference between
 * "signed out everywhere" being true and being true in a minute.
 */
interface TestPrincipal {
  sessionId: string;
  userId: string;
}

const cacheGet = vi.fn();
const cacheSet = vi.fn();
const cacheDel = vi.fn();
const query = vi.fn();
const resolvePrincipal = vi.fn();

function store() {
  return createSessionStore<TestPrincipal>({
    query,
    cache: { cacheGet, cacheSet, cacheDel },
    resolvePrincipal,
  });
}

beforeEach(() => {
  cacheGet.mockReset();
  cacheSet.mockReset();
  cacheDel.mockReset();
  query.mockReset();
  resolvePrincipal.mockReset();
});

/** dbQuery's callback receives a tagged-template `sql`; a plain function
 *  returning `rows` for any invocation is a faithful enough stand-in. */
function tagAsRows<T>(rows: T[]) {
  return () => Promise.resolve(rows);
}

function dbReturns<T>(rows: T[]) {
  query.mockImplementationOnce(async (fn: (sql: unknown) => unknown) => fn(tagAsRows(rows)));
}

describe('resolveSession', () => {
  it('returns null without touching the cache or the database for an empty id', async () => {
    expect(await store().resolveSession('')).toBeNull();
    expect(cacheGet).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it('serves a cached principal without hitting Postgres', async () => {
    const cached = { sessionId: 's1', userId: 'u1' };
    cacheGet.mockResolvedValueOnce(cached);
    expect(await store().resolveSession('s1')).toEqual(cached);
    expect(query).not.toHaveBeenCalled();
    expect(resolvePrincipal).not.toHaveBeenCalled();
  });

  it('on a miss, asks the resolver and caches what it returns', async () => {
    cacheGet.mockResolvedValueOnce(null);
    const principal = { sessionId: 's1', userId: 'u1' };
    resolvePrincipal.mockResolvedValueOnce(principal);
    query.mockImplementationOnce(async (fn: (sql: unknown) => unknown) => fn({}));

    expect(await store().resolveSession('s1')).toEqual(principal);
    expect(resolvePrincipal).toHaveBeenCalledWith({}, 's1');
    expect(cacheSet).toHaveBeenCalledWith('session:s1', principal, 60);
  });

  it('caches nothing when the resolver refuses', async () => {
    cacheGet.mockResolvedValueOnce(null);
    resolvePrincipal.mockResolvedValueOnce(null);
    query.mockImplementationOnce(async (fn: (sql: unknown) => unknown) => fn({}));
    expect(await store().resolveSession('s1')).toBeNull();
    expect(cacheSet).not.toHaveBeenCalled();
  });

  it('caches nothing when the database is unavailable', async () => {
    cacheGet.mockResolvedValueOnce(null);
    query.mockResolvedValueOnce(null);
    expect(await store().resolveSession('s1')).toBeNull();
    expect(cacheSet).not.toHaveBeenCalled();
  });

  it('answers a refusal rather than throwing when the resolver throws', async () => {
    // The resolver runs INSIDE the query runner, which reports and swallows.
    // A principal resolver that threw into a route handler would turn a refused
    // request into a 500 on every gated route at once.
    cacheGet.mockResolvedValueOnce(null);
    query.mockImplementationOnce(async (fn: (sql: unknown) => unknown) => {
      try {
        return await fn({});
      } catch {
        return null;
      }
    });
    resolvePrincipal.mockRejectedValueOnce(new Error('column does not exist'));
    expect(await store().resolveSession('s1')).toBeNull();
  });

  it('lets a product set its own cache lifetime and key prefix', async () => {
    const custom = createSessionStore<TestPrincipal>({
      query,
      cache: { cacheGet, cacheSet, cacheDel },
      resolvePrincipal,
      cacheTtlSeconds: 5,
      cacheKeyPrefix: 'principal:',
    });
    cacheGet.mockResolvedValueOnce(null);
    resolvePrincipal.mockResolvedValueOnce({ sessionId: 's1', userId: 'u1' });
    query.mockImplementationOnce(async (fn: (sql: unknown) => unknown) => fn({}));
    await custom.resolveSession('s1');
    expect(cacheGet).toHaveBeenCalledWith('principal:s1');
    expect(cacheSet).toHaveBeenCalledWith('principal:s1', expect.anything(), 5);
  });
});

describe('createSession', () => {
  it('mints a 64-hex id and answers null when the database will not take it', async () => {
    dbReturns([]);
    const id = await store().createSession('u1', { ip: '1.2.3.4', userAgent: 'curl' });
    expect(id).toMatch(/^[0-9a-f]{64}$/);

    query.mockResolvedValueOnce(null);
    expect(await store().createSession('u1')).toBeNull();
  });

  it('uses the configured lifetime', async () => {
    let bound: unknown[] = [];
    query.mockImplementationOnce(async (fn: (sql: unknown) => unknown) =>
      fn((_s: TemplateStringsArray, ...values: unknown[]) => {
        bound = values;
        return Promise.resolve([]);
      }),
    );
    const custom = createSessionStore<TestPrincipal>({
      query,
      cache: { cacheGet, cacheSet, cacheDel },
      resolvePrincipal,
      ttlSeconds: 120,
    });
    const before = Date.now();
    await custom.createSession('u1');
    const expiresAt = bound.find((v) => v instanceof Date) as Date;
    expect(expiresAt.getTime() - before).toBeGreaterThan(110_000);
    expect(expiresAt.getTime() - before).toBeLessThan(130_000);
    expect(custom.ttlSeconds).toBe(120);
  });
});

describe('listUserSessions', () => {
  it('normalises a row into the shape a cabinet renders', async () => {
    dbReturns([
      {
        id: 's1',
        ip: null,
        user_agent: 'Firefox',
        created_at: '2026-09-01T10:00:00Z',
        expires_at: '2026-09-08T10:00:00Z',
      },
    ]);
    expect(await store().listUserSessions('u1')).toEqual([
      {
        id: 's1',
        ip: null,
        userAgent: 'Firefox',
        createdAt: '2026-09-01T10:00:00.000Z',
        expiresAt: '2026-09-08T10:00:00.000Z',
      },
    ]);
  });

  it('answers an empty list, not null, when the database is unavailable', async () => {
    query.mockResolvedValueOnce(null);
    expect(await store().listUserSessions('u1')).toEqual([]);
  });
});

/**
 * Every revocation path used to clear the cached principal BEFORE deleting the
 * row. That leaves a window where a concurrent request misses the cache, still
 * finds the live row in Postgres, and re-caches the principal for another cache
 * lifetime — so "you have been signed out of all devices" could be false for a
 * minute after the reset email said it, and permanently false if the DELETE
 * itself failed.
 */
describe('session revocation — the row dies before the cache key', () => {
  let order: string[] = [];

  beforeEach(() => {
    order = [];
    cacheDel.mockImplementation(async (key: string) => {
      order.push(`cacheDel:${key}`);
    });
  });

  /** Records the SQL the path ran, then answers with `rows`. */
  function recorded<T>(rows: T[]) {
    query.mockImplementationOnce(async (fn: (sql: unknown) => unknown) =>
      fn((strings: TemplateStringsArray) => {
        order.push(`db:${/^\s*DELETE/i.test(strings[0] ?? '') ? 'DELETE' : 'OTHER'}`);
        return Promise.resolve(rows);
      }),
    );
  }

  it('revokeSession deletes the row before clearing the cache', async () => {
    recorded([]);
    await store().revokeSession('s1');
    expect(order).toEqual(['db:DELETE', 'cacheDel:session:s1']);
  });

  it('revokeOwnedSession deletes the row before clearing the cache', async () => {
    recorded([{ id: 's1' }]);
    expect(await store().revokeOwnedSession('u1', 's1')).toBe(true);
    expect(order).toEqual(['db:DELETE', 'cacheDel:session:s1']);
  });

  it("revokeOwnedSession answers false when nothing of the user's matched", async () => {
    recorded([]);
    expect(await store().revokeOwnedSession('u1', 'someone-elses')).toBe(false);
  });

  it('revokeUserSessions deletes every row before clearing any cache key', async () => {
    recorded([{ id: 's1' }, { id: 's2' }]);
    await store().revokeUserSessions('u1');
    expect(order).toEqual(['db:DELETE', 'cacheDel:session:s1', 'cacheDel:session:s2']);
  });

  it('revokeOtherSessions deletes every row before clearing any cache key', async () => {
    recorded([{ id: 's2' }, { id: 's3' }]);
    await store().revokeOtherSessions('u1', 's1');
    expect(order).toEqual(['db:DELETE', 'cacheDel:session:s2', 'cacheDel:session:s3']);
  });

  it('the bulk paths delete and collect ids in ONE statement (no SELECT-then-DELETE gap)', async () => {
    recorded([{ id: 's2' }]);
    await store().revokeUserSessions('u1');
    expect(query).toHaveBeenCalledTimes(1);
    expect(order.filter((o) => o.startsWith('db:'))).toHaveLength(1);
  });

  it('still clears the key of a session Postgres had already lost', async () => {
    recorded([]);
    await store().revokeSession('s-already-gone');
    expect(cacheDel).toHaveBeenCalledWith('session:s-already-gone');
  });

  it('invalidateUserCache clears the keys without deleting anything', async () => {
    recorded([{ id: 's1' }, { id: 's2' }]);
    await store().invalidateUserCache('u1');
    expect(order).toEqual(['db:OTHER', 'cacheDel:session:s1', 'cacheDel:session:s2']);
  });
});

describe('the authorization model belongs to the product', () => {
  it('names no column beyond the session table it owns', async () => {
    const source = await import('node:fs')
      .then((fs) =>
        fs.readFileSync(new URL('../src/auth-core/sessions.ts', import.meta.url), 'utf8'),
      )
      .then((text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''));
    for (const leaked of ['user_permissions', 'planCapabilities', 'u.plan', 'status']) {
      expect(source).not.toContain(leaked);
    }
  });
});
