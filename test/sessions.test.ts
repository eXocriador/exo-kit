import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Sql } from 'postgres';
import { createHash } from 'node:crypto';
import { createSessionStore, sessionIdHash } from '../src/auth-core/sessions.js';

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

/** The stored form of the raw id `s1` — what the table and the cache see. */
const S1 = sessionIdHash('s1');

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

describe('sessionIdHash', () => {
  it('is SHA-256 hex of the raw id — the same string Postgres computes in the one-off UPDATE', () => {
    // README gives `encode(sha256(convert_to(id, 'UTF8')), 'hex')` for moving
    // existing rows. If this ever stopped being plain sha256-hex, that UPDATE
    // would sign every live session out instead of carrying it over.
    const raw = 'a'.repeat(64);
    expect(sessionIdHash(raw)).toBe(createHash('sha256').update(raw).digest('hex'));
    expect(sessionIdHash(raw)).toMatch(/^[0-9a-f]{64}$/);
    expect(store().sessionIdHash(raw)).toBe(sessionIdHash(raw));
  });
});

describe('resolveSession', () => {
  it('returns null without touching the cache or the database for an empty id', async () => {
    expect(await store().resolveSession('')).toBeNull();
    expect(cacheGet).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it('serves a cached principal without hitting Postgres', async () => {
    const cached = { sessionId: S1, userId: 'u1' };
    cacheGet.mockResolvedValueOnce(cached);
    expect(await store().resolveSession('s1')).toEqual(cached);
    expect(cacheGet).toHaveBeenCalledWith(`session:${S1}`);
    expect(query).not.toHaveBeenCalled();
    expect(resolvePrincipal).not.toHaveBeenCalled();
  });

  it('on a miss, asks the resolver with the STORED id and caches what it returns', async () => {
    cacheGet.mockResolvedValueOnce(null);
    const principal = { sessionId: S1, userId: 'u1' };
    resolvePrincipal.mockResolvedValueOnce(principal);
    query.mockImplementationOnce(async (fn: (sql: unknown) => unknown) => fn({}));

    expect(await store().resolveSession('s1')).toEqual(principal);
    expect(resolvePrincipal).toHaveBeenCalledWith({}, S1);
    expect(cacheSet).toHaveBeenCalledWith(`session:${S1}`, principal, 60);
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
    resolvePrincipal.mockResolvedValueOnce({ sessionId: S1, userId: 'u1' });
    query.mockImplementationOnce(async (fn: (sql: unknown) => unknown) => fn({}));
    await custom.resolveSession('s1');
    expect(cacheGet).toHaveBeenCalledWith(`principal:${S1}`);
    expect(cacheSet).toHaveBeenCalledWith(`principal:${S1}`, expect.anything(), 5);
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

/**
 * N-24 (netwatch audit): `sessions.id` used to be the cookie's id as issued, so
 * a copy of the table was a list of live sessions. The table now holds the
 * hash, and these tests are the ones that fail if the raw value leaks back into
 * a bound parameter or a cache key on any path.
 */
describe('the raw session id never reaches the table or the cache', () => {
  /** A fake `sql` that remembers every bound value — i.e. everything the database is sent. */
  function recordingDb(rows: unknown[] = []) {
    const bound: unknown[] = [];
    query.mockImplementation(async (fn: (sql: unknown) => unknown) =>
      fn((_s: TemplateStringsArray, ...values: unknown[]) => {
        bound.push(...values);
        return Promise.resolve(rows);
      }),
    );
    return bound;
  }

  /** Every cache key any accessor was asked about. */
  function cacheKeys(): string[] {
    return [...cacheGet.mock.calls, ...cacheSet.mock.calls, ...cacheDel.mock.calls].map((c) => c[0] as string);
  }

  it('after createSession, nothing written is the value handed back to the caller', async () => {
    const bound = recordingDb();
    const raw = await store().createSession('u1', { ip: '1.2.3.4', userAgent: 'curl' });

    expect(raw).toMatch(/^[0-9a-f]{64}$/);
    expect(bound).not.toContain(raw);
    // …and what WAS written for the id is its hash, so the cookie still finds it.
    expect(bound[0]).toBe(sessionIdHash(raw!));
    expect(bound.some((v) => typeof v === 'string' && v.includes(raw!))).toBe(false);
  });

  it('a session created and then resolved round-trips through the hash only', async () => {
    // The whole flow over one fake table: the id the cookie gets back resolves,
    // and neither the resolver, the database nor the cache ever sees it.
    const table = new Map<string, string>();
    query.mockImplementation(async (fn: (sql: unknown) => unknown) =>
      fn((strings: TemplateStringsArray, ...values: unknown[]) => {
        if (/INSERT INTO sessions/.test(strings.join('?'))) table.set(values[0] as string, values[1] as string);
        return Promise.resolve([]);
      }),
    );
    const raw = (await store().createSession('u1'))!;
    expect([...table.keys()]).toEqual([sessionIdHash(raw)]);

    cacheGet.mockResolvedValueOnce(null);
    resolvePrincipal.mockImplementationOnce(async (_sql: Sql, storedId: string) =>
      table.has(storedId) ? { sessionId: storedId, userId: table.get(storedId)! } : null,
    );
    expect(await store().resolveSession(raw)).toEqual({ sessionId: sessionIdHash(raw), userId: 'u1' });
    expect(resolvePrincipal.mock.calls[0]![1]).not.toBe(raw);
    expect(cacheKeys().some((key) => key.includes(raw))).toBe(false);
  });

  it('logout binds and clears by the hash, never the raw id', async () => {
    const raw = 'f'.repeat(64);
    const bound = recordingDb();
    await store().revokeSession(raw);
    expect(bound).toEqual([sessionIdHash(raw)]);
    expect(cacheDel).toHaveBeenCalledWith(`session:${sessionIdHash(raw)}`);
    expect(cacheKeys().some((key) => key.includes(raw))).toBe(false);
  });

  it('a stored id fed back in as a cookie matches nothing', async () => {
    // What a leaked table is worth now: presenting a row's id hashes it again.
    const stored = sessionIdHash('the-real-cookie-id');
    cacheGet.mockResolvedValueOnce(null);
    query.mockImplementationOnce(async (fn: (sql: unknown) => unknown) => fn({}));
    resolvePrincipal.mockImplementationOnce(async (_sql: Sql, storedId: string) =>
      storedId === stored ? { sessionId: stored, userId: 'u1' } : null,
    );
    expect(await store().resolveSession(stored)).toBeNull();
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
    expect(order).toEqual(['db:DELETE', `cacheDel:session:${S1}`]);
  });

  it('revokeOwnedSession deletes the row before clearing the cache', async () => {
    // Takes the STORED id — the one the cabinet listed — so no hashing here.
    recorded([{ id: S1 }]);
    expect(await store().revokeOwnedSession('u1', S1)).toBe(true);
    expect(order).toEqual(['db:DELETE', `cacheDel:session:${S1}`]);
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
    expect(cacheDel).toHaveBeenCalledWith(`session:${sessionIdHash('s-already-gone')}`);
  });

  it('invalidateUserCache clears the keys without deleting anything', async () => {
    recorded([{ id: 's1' }, { id: 's2' }]);
    await store().invalidateUserCache('u1');
    expect(order).toEqual(['db:OTHER', 'cacheDel:session:s1', 'cacheDel:session:s2']);
  });
});

/**
 * netwatch N-11: `revokeUserSessions` answered `void`, and `ids ?? []` read a
 * DELETE that threw as "nothing to delete" — so an admin route said
 * `sessionsRevoked: true` about sessions that were still live. Every path that
 * can fail silently now says which of the two happened, and these tests hold
 * both branches apart: zero rows is an answer, a dead database is not.
 */
describe('a revocation says whether it happened', () => {
  /** The runner as `createDb` builds it: the callback's throw becomes `null`. */
  function dbThrows() {
    query.mockImplementationOnce(async (fn: (sql: unknown) => unknown) => {
      try {
        return await fn(() => Promise.reject(new Error('connection terminated')));
      } catch {
        return null;
      }
    });
  }

  it('revokeUserSessions counts what it revoked', async () => {
    dbReturns([{ id: 'a' }, { id: 'b' }]);
    expect(await store().revokeUserSessions('u1')).toEqual({ ok: true, revoked: 2 });
  });

  it('revokeUserSessions: nothing to revoke is ok, with zero', async () => {
    dbReturns([]);
    expect(await store().revokeUserSessions('u1')).toEqual({ ok: true, revoked: 0 });
  });

  it('revokeUserSessions: a DELETE that threw is NOT ok — and clears no cache key it never read', async () => {
    dbThrows();
    expect(await store().revokeUserSessions('u1')).toEqual({ ok: false });
    expect(cacheDel).not.toHaveBeenCalled();
  });

  it('revokeUserSessions: no database at all is not ok either', async () => {
    query.mockResolvedValueOnce(null);
    expect(await store().revokeUserSessions('u1')).toEqual({ ok: false });
  });

  it('revokeOtherSessions: both branches', async () => {
    dbReturns([{ id: 'b' }]);
    expect(await store().revokeOtherSessions('u1', 'a')).toEqual({ ok: true, revoked: 1 });
    dbThrows();
    expect(await store().revokeOtherSessions('u1', 'a')).toEqual({ ok: false });
  });

  it('revokeSession: both branches, and the key is cleared on either', async () => {
    dbReturns([{ id: S1 }]);
    expect(await store().revokeSession('s1')).toEqual({ ok: true, revoked: 1 });
    dbReturns([]);
    expect(await store().revokeSession('s1')).toEqual({ ok: true, revoked: 0 });
    cacheDel.mockClear();
    dbThrows();
    expect(await store().revokeSession('s1')).toEqual({ ok: false });
    expect(cacheDel).toHaveBeenCalledWith(`session:${S1}`);
  });

  it('invalidateUserCache: both branches', async () => {
    dbReturns([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
    expect(await store().invalidateUserCache('u1')).toEqual({ ok: true, invalidated: 3 });
    dbThrows();
    expect(await store().invalidateUserCache('u1')).toEqual({ ok: false });
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
