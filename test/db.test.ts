import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The pool is faked at the module boundary, so nothing here opens a socket.
 * What is worth pinning is not "postgres works" but the three decisions this
 * wrapper makes on a caller's behalf — not-configured is a state, a thrown
 * query is reported and swallowed, and `tryQuery` keeps "did not answer"
 * distinguishable from "answered with nothing". All three are invisible in a
 * passing integration test and expensive when wrong.
 */
const { postgresMock, lastOptions } = vi.hoisted(() => {
  const lastOptions: Record<string, unknown>[] = [];
  const postgresMock = vi.fn((url: string, options: Record<string, unknown>) => {
    lastOptions.push(options);
    const sql = Object.assign(() => {}, {
      __url: url,
      json: (v: unknown) => ({ __json: v }),
    });
    return sql;
  });
  return { postgresMock, lastOptions };
});

vi.mock('postgres', () => ({ default: postgresMock }));

const { createDb } = await import('../src/infra/db.js');

beforeEach(() => {
  postgresMock.mockClear();
  lastOptions.length = 0;
});

describe('not configured', () => {
  it('gives a usable accessor rather than throwing, and opens no pool', () => {
    const db = createDb({ url: null });
    expect(db.sql).toBeNull();
    expect(postgresMock).not.toHaveBeenCalled();
  });

  it('query answers null and never runs the callback', async () => {
    const fn = vi.fn();
    expect(await createDb({ url: undefined }).query(fn)).toBeNull();
    expect(fn).not.toHaveBeenCalled();
  });

  it('tryQuery says "unavailable" rather than an empty result', async () => {
    expect(await createDb({ url: '' }).tryQuery(async () => [])).toEqual({
      ok: false,
      reason: 'unavailable',
    });
  });

  it('reports nothing: "no database" is a state, not a fault', async () => {
    const reportError = vi.fn();
    await createDb({ url: null, reportError }).query(async () => 1);
    expect(reportError).not.toHaveBeenCalled();
  });

  it('jsonb is null when there is no client to encode with', () => {
    expect(createDb({ url: null }).jsonb({ a: 1 })).toBeNull();
  });
});

describe('configured', () => {
  it('passes the caller’s URL through untouched and applies the documented defaults', () => {
    createDb({ url: 'postgres://user@host/db' });
    expect(postgresMock).toHaveBeenCalledWith('postgres://user@host/db', expect.any(Object));
    expect(lastOptions[0]).toMatchObject({
      max: 10,
      idle_timeout: 30,
      connect_timeout: 10,
      connection: { statement_timeout: 15_000 },
    });
  });

  it('honours an explicit pool size and statement timeout', () => {
    createDb({ url: 'postgres://x', poolMax: 4, statementTimeoutMs: 2_000 });
    expect(lastOptions[0]).toMatchObject({ max: 4, connection: { statement_timeout: 2_000 } });
  });

  it('falls back to 10 for a nonsense pool size instead of passing it on', () => {
    createDb({ url: 'postgres://x', poolMax: 0 });
    createDb({ url: 'postgres://x', poolMax: Number.NaN });
    expect(lastOptions[0]).toMatchObject({ max: 10 });
    expect(lastOptions[1]).toMatchObject({ max: 10 });
  });

  it('query returns what the callback returned', async () => {
    const db = createDb({ url: 'postgres://x' });
    expect(await db.query(async () => [{ id: 1 }])).toEqual([{ id: 1 }]);
  });

  it('query reports a thrown error and answers null', async () => {
    const reportError = vi.fn();
    const db = createDb({ url: 'postgres://x', reportError });
    expect(await db.query(async () => { throw new Error('boom'); })).toBeNull();
    expect(reportError).toHaveBeenCalledTimes(1);
    const [err, ctx] = reportError.mock.calls[0]!;
    expect((err as Error).message).toBe('boom');
    expect(ctx).toMatchObject({ component: 'db', event: 'db.query_error' });
  });

  it('query swallows the error even with no reporter wired', async () => {
    const db = createDb({ url: 'postgres://x' });
    await expect(db.query(async () => { throw new Error('boom'); })).resolves.toBeNull();
  });

  it('tryQuery hands the error back instead of swallowing it', async () => {
    const db = createDb({ url: 'postgres://x' });
    const out = await db.tryQuery(async () => { throw new Error('boom'); });
    expect(out).toMatchObject({ ok: false, reason: 'error' });
    expect((out as { error: Error }).error.message).toBe('boom');
  });

  it('tryQuery reports an empty answer as success — the whole point of it', async () => {
    const db = createDb({ url: 'postgres://x' });
    expect(await db.tryQuery(async () => [])).toEqual({ ok: true, rows: [] });
  });

  it('jsonb hands the value to the driver, and maps null/undefined to SQL NULL', () => {
    const db = createDb({ url: 'postgres://x' });
    expect(db.jsonb({ a: 1 })).toEqual({ __json: { a: 1 } });
    expect(db.jsonb([1, 2])).toEqual({ __json: [1, 2] });
    expect(db.jsonb(null)).toBeNull();
    expect(db.jsonb(undefined)).toBeNull();
  });
});

describe('globalKey', () => {
  it('reuses one pool across instances, so a dev reload does not leak connections', () => {
    const key = '__kit_test_db__';
    delete (globalThis as Record<string, unknown>)[key];
    const a = createDb({ url: 'postgres://x', globalKey: key });
    const b = createDb({ url: 'postgres://x', globalKey: key });
    expect(postgresMock).toHaveBeenCalledTimes(1);
    expect(a.sql).toBe(b.sql);
    delete (globalThis as Record<string, unknown>)[key];
  });

  it('opens a separate pool per instance when no key is given', () => {
    createDb({ url: 'postgres://x' });
    createDb({ url: 'postgres://x' });
    expect(postgresMock).toHaveBeenCalledTimes(2);
  });
});
