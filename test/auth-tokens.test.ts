import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Sql } from 'postgres';
import { createAuthTokens } from '../src/auth-core/tokens.js';

/**
 * Single-use links. Two properties carry the weight: only the SHA-256 of a
 * token is ever stored, and a consume is one atomic statement so a link cannot
 * be redeemed twice under concurrency.
 *
 * The database is a stand-in — these tests are about which statement runs, what
 * is bound into it, and how each answer is interpreted. A real Postgres would
 * only re-test Postgres.
 */
type Row = Record<string, unknown>;

/** Records every statement the module runs and answers each with `rows`. */
function fakeDb(answers: Row[][]) {
  const statements: { text: string; values: unknown[] }[] = [];
  let next = 0;
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    statements.push({ text: strings.join('?'), values });
    return Promise.resolve(answers[next++] ?? []);
  }) as unknown as Sql;
  const query = async <T,>(fn: (s: Sql) => Promise<T>): Promise<T | null> => fn(sql);
  return { query, statements, sql };
}

type Purpose = 'verify_email' | 'reset_password';

describe('createAuthToken', () => {
  it('stores only the hash, never the raw token', async () => {
    const db = fakeDb([[], []]);
    const { createAuthToken, tokenHash } = createAuthTokens<Purpose>({ query: db.query });
    const raw = await createAuthToken('user-1', 'verify_email', 3600);
    expect(raw).toBeTruthy();

    const bound = db.statements.flatMap((s) => s.values);
    expect(bound).toContain(tokenHash(raw as string));
    expect(bound).not.toContain(raw);
  });

  it("drops the user's older unused tokens of the same purpose first", async () => {
    const db = fakeDb([[], []]);
    const { createAuthToken } = createAuthTokens<Purpose>({ query: db.query });
    await createAuthToken('user-1', 'reset_password', 3600);
    expect(db.statements).toHaveLength(2);
    expect(db.statements[0]?.text).toMatch(/DELETE FROM auth_tokens/);
    expect(db.statements[1]?.text).toMatch(/INSERT INTO auth_tokens/);
  });

  it('answers null when the database is unavailable', async () => {
    const { createAuthToken } = createAuthTokens<Purpose>({ query: async () => null });
    expect(await createAuthToken('user-1', 'verify_email', 3600)).toBeNull();
  });
});

describe('peek and consume', () => {
  it('peek reads without marking anything used', async () => {
    const db = fakeDb([[{ user_id: 'user-1' }]]);
    const { peekAuthToken } = createAuthTokens<Purpose>({ query: db.query });
    expect(await peekAuthToken('raw-token', 'verify_email')).toEqual({ userId: 'user-1' });
    expect(db.statements[0]?.text).toMatch(/SELECT/);
    expect(db.statements[0]?.text).not.toMatch(/UPDATE/);
  });

  it('consume marks it used in the same statement that reads it', async () => {
    const db = fakeDb([[{ user_id: 'user-1' }]]);
    const { consumeAuthToken } = createAuthTokens<Purpose>({ query: db.query });
    expect(await consumeAuthToken('raw-token', 'reset_password')).toEqual({ userId: 'user-1' });
    expect(db.statements).toHaveLength(1);
    expect(db.statements[0]?.text).toMatch(/UPDATE auth_tokens[\s\S]*RETURNING/);
    // The predicate is what makes a second redemption impossible.
    expect(db.statements[0]?.text).toMatch(/used_at IS NULL/);
    expect(db.statements[0]?.text).toMatch(/expires_at > NOW\(\)/);
  });

  it('answers null for a token no row matched', async () => {
    const db = fakeDb([[]]);
    const { consumeAuthToken } = createAuthTokens<Purpose>({ query: db.query });
    expect(await consumeAuthToken('raw-token', 'reset_password')).toBeNull();
  });

  it('refuses an absurdly long token without asking the database', async () => {
    const db = fakeDb([[{ user_id: 'user-1' }]]);
    const { consumeAuthToken, peekAuthToken } = createAuthTokens<Purpose>({ query: db.query });
    const huge = 'x'.repeat(201);
    expect(await consumeAuthToken(huge, 'reset_password')).toBeNull();
    expect(await peekAuthToken(huge, 'reset_password')).toBeNull();
    expect(await consumeAuthToken('', 'reset_password')).toBeNull();
    expect(db.statements).toHaveLength(0);
  });

  it('honours a configured maximum length', async () => {
    const db = fakeDb([[{ user_id: 'user-1' }]]);
    const { consumeAuthToken } = createAuthTokens<Purpose>({
      query: db.query,
      maxTokenLength: 8,
    });
    expect(await consumeAuthToken('123456789', 'reset_password')).toBeNull();
    expect(db.statements).toHaveLength(0);
  });
});

describe('consumeAuthTokenWith', () => {
  function txDb(rows: Row[]) {
    const calls: string[] = [];
    const tx = ((strings: TemplateStringsArray) => {
      calls.push(strings.join('?'));
      return Promise.resolve(rows);
    }) as unknown as Sql;
    const sql = { begin: (fn: (t: Sql) => Promise<unknown>) => fn(tx) } as unknown as Sql;
    const query = async <T,>(fn: (s: Sql) => Promise<T>): Promise<T | null> => fn(sql);
    return { query, calls };
  }

  it('runs the follow-up write inside the same transaction as the consume', async () => {
    const db = txDb([{ user_id: 'user-1' }]);
    const { consumeAuthTokenWith } = createAuthTokens<Purpose>({ query: db.query });
    const result = await consumeAuthTokenWith('raw', 'reset_password', async (tx, userId) => {
      await tx`UPDATE users SET password_hash = 'x' WHERE id = ${userId}::uuid`;
      return 'written';
    });
    expect(result).toEqual({ ok: true, userId: 'user-1', result: 'written' });
    expect(db.calls[0]).toMatch(/UPDATE auth_tokens/);
    expect(db.calls[1]).toMatch(/UPDATE users/);
  });

  it('distinguishes a dead token from a dead database', async () => {
    const dead = txDb([]);
    const { consumeAuthTokenWith } = createAuthTokens<Purpose>({ query: dead.query });
    // A token that matched nothing: a definite answer the caller can word.
    expect(await consumeAuthTokenWith('raw', 'reset_password', async () => 1)).toEqual({
      ok: false,
    });

    const offline = createAuthTokens<Purpose>({ query: async () => null });
    // No answer at all — a different message, and not "your link expired".
    expect(await offline.consumeAuthTokenWith('raw', 'reset_password', async () => 1)).toBeNull();
  });

  it('never reaches the follow-up when the token did not consume', async () => {
    const db = txDb([]);
    const { consumeAuthTokenWith } = createAuthTokens<Purpose>({ query: db.query });
    const onConsumed = vi.fn(async () => 'should not run');
    await consumeAuthTokenWith('raw', 'reset_password', onConsumed);
    expect(onConsumed).not.toHaveBeenCalled();
  });
});

describe('purposes belong to the product', () => {
  it('takes its purpose union from the caller', async () => {
    const db = fakeDb([[]]);
    const { peekAuthToken } = createAuthTokens<Purpose>({ query: db.query });
    // @ts-expect-error — 'support_link' is a flow this product does not have.
    await peekAuthToken('raw', 'support_link');
  });

  it('names no purpose and no lifetime of its own', async () => {
    const source = await import('node:fs')
      .then((fs) => fs.readFileSync(new URL('../src/auth-core/tokens.ts', import.meta.url), 'utf8'))
      .then((text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''));
    for (const leaked of ['verify_email', 'reset_password', 'login_2fa', 'support_link', '_TTL']) {
      expect(source).not.toContain(leaked);
    }
  });
});
