import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { readFileSync } from 'node:fs';
import { authMigrations, createAuth } from '../src/auth/index.js';
import { hashPassword } from '../src/auth-core/password.js';

/**
 * The one claim the memory adapter cannot make: that the SQL is real.
 *
 * Everything next door tests policy, and policy lives above the adapter. Three
 * things live below it and are therefore invisible there — that `modelName` and
 * `fields` actually produce OUR table and column names, that `uuid` ids go into
 * `uuid` columns, and that the migration this module ships is what the library
 * then queries. Those are exactly the three things that break silently: a
 * mis-mapped column is a 500 on the first login and nothing before it.
 *
 * Opt-in, because the kit's suite must run with no infrastructure:
 *
 *     KIT_TEST_POSTGRES_URL=postgres://…/scratch npx vitest run test/auth-postgres.test.ts
 *
 * It creates nothing outside the database it is given and drops its own five
 * tables on the way in, so point it at a scratch database and never at a
 * product's.
 */

const URL_ = process.env.KIT_TEST_POSTGRES_URL;
const suite = URL_ ? describe : describe.skip;

/**
 * The `migrate:up` half of a dbmate file, which is the half a runner applies.
 *
 * Reading the file whole used to be good enough and stopped being so in
 * v0.6.x, when every kit migration grew the `migrate:down` block dbmate
 * requires — and ours refuse to roll back by raising, so `beforeAll` died on
 * `no rollback: 20200101000001_kit_auth` before a single assertion ran. This
 * suite is opt-in and nothing noticed for two releases. Found while proving
 * the v0.7.1 legacy-password bridge against a real Postgres.
 */
function up(file: string): string {
  const body = readFileSync(file, 'utf8');
  const start = body.indexOf('-- migrate:up');
  const end = body.indexOf('-- migrate:down');
  if (start < 0) throw new Error(`${file}: no -- migrate:up marker`);
  return body.slice(start, end < 0 ? undefined : end);
}

suite('the schema the module ships, against a real Postgres', () => {
  let pool: Pool;
  let auth: ReturnType<typeof createAuth<{ userId: string; login: string | null }>>;
  const sent: string[] = [];

  beforeAll(async () => {
    pool = new Pool({ connectionString: URL_, max: 2 });
    await pool.query(
      'DROP TABLE IF EXISTS two_factor, verification, sessions, identities, users CASCADE',
    );

    // The migrations the module hands the product, applied the way a product's
    // runner applies them — in order, each file as one statement batch, and
    // BEFORE the instance exists. See the admin test for why that ordering is
    // not a preference: this suite spent its whole life building first and
    // migrating after, and failed about half the time with "Missing columns
    // users.two_factor_enabled" on a database that had the column by the time
    // anybody looked.
    for (const file of authMigrations({ totp: true })) {
      await pool.query(up(file));
    }

    auth = createAuth({
      db: pool,
      secret: () => 'k'.repeat(48),
      baseUrl: 'http://localhost:3000',
      cookieName: 'probe_session',
      secureCookie: false,
      sessionDays: 7,
      providers: {},
      totp: { issuer: 'probe' },
      email: {
        send: async (_to, _subject, text) => {
          sent.push(text);
        },
        letters: {
          magicLink: (link) => ({ subject: 'link', text: link.url }),
          verifyEmail: (link) => ({ subject: 'verify', text: link.url }),
          resetPassword: (link) => ({ subject: 'reset', text: link.url }),
        },
        password: true,
      },
      resolvePrincipal: async (userId) => {
        const rows = await pool.query<{ login: string | null }>(
          'SELECT login FROM users WHERE id = $1',
          [userId],
        );
        return rows.rows[0] ? { userId, login: rows.rows[0].login } : null;
      },
    });
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
  });

  it('puts a uuid in a uuid column, under our names', async () => {
    const response = await auth.instance.api.signUpEmail({
      body: { email: 'Pg.User@Example.com', password: 'a-real-password', name: 'Pg User' },
      asResponse: true,
    });
    expect(response.status).toBe(200);

    const users = await pool.query<{ id: string; login: string; email: string; email_verified: boolean }>(
      'SELECT id, login, email, email_verified FROM users',
    );
    expect(users.rows).toHaveLength(1);
    const user = users.rows[0]!;
    // A uuid, in a column Postgres itself declares to be `uuid` — so a product
    // whose other tables reference users(id) needs no rewrite.
    expect(user.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    const type = await pool.query<{ data_type: string }>(
      `SELECT data_type FROM information_schema.columns
        WHERE table_name = 'users' AND column_name = 'id'`,
    );
    expect(type.rows[0]!.data_type).toBe('uuid');
    // Lowercased on the way in, and the handle filled from the address.
    expect(user.email).toBe('pg.user@example.com');
    expect(user.login).toBe('pg.user');
    expect(user.email_verified).toBe(false);

    // The identity, under the two names auth.md fixed.
    const identities = await pool.query<{ provider: string; provider_id: string; user_id: string }>(
      'SELECT provider, provider_id, user_id FROM identities',
    );
    expect(identities.rows[0]!.provider).toBe('credential');
    expect(identities.rows[0]!.user_id).toBe(user.id);

    // And the verification letter went out, through the product's transport.
    expect(sent).toHaveLength(1);
  });

  it('signs in, writes a session row we can read, and lists it without the token', async () => {
    await pool.query('UPDATE users SET email_verified = true');
    const signIn = await auth.instance.api.signInEmail({
      body: { email: 'pg.user@example.com', password: 'a-real-password' },
      asResponse: true,
    });
    expect(signIn.status).toBe(200);

    const sessions = await pool.query<{ token: string; ip: string | null; expires_at: Date }>(
      'SELECT token, ip, expires_at FROM sessions',
    );
    expect(sessions.rows).toHaveLength(1);
    expect(sessions.rows[0]!.token.length).toBeGreaterThan(16);

    const headers = new Headers({
      cookie: signIn.headers.getSetCookie().map((c) => c.split(';')[0]).join('; '),
    });
    const principal = await auth.getPrincipal(headers);
    expect(principal).toEqual({ userId: expect.any(String), login: 'pg.user' });

    const listed = await auth.listSessions(headers);
    expect(listed).toHaveLength(1);
    expect(listed[0]!.current).toBe(true);
    expect(JSON.stringify(listed)).not.toContain(sessions.rows[0]!.token);
  });

  it('lists the devices of a session older than a day, over the real adapter', async () => {
    // v0.10.0: `auth.listSessions` no longer goes through the library's
    // `freshSessionMiddleware`. The memory adapter proves the logic; this proves
    // the internal adapter's query over our renamed columns.
    const signIn = await auth.instance.api.signInEmail({
      body: { email: 'pg.user@example.com', password: 'a-real-password' },
      asResponse: true,
    });
    const headers = new Headers({
      cookie: signIn.headers.getSetCookie().map((c) => c.split(';')[0]).join('; '),
    });
    await pool.query("UPDATE sessions SET created_at = now() - interval '2 days'");
    const listed = await auth.listSessions(headers);
    expect(listed.length).toBeGreaterThanOrEqual(1);
    expect(listed.filter((session) => session.current)).toHaveLength(1);
  });

  it('stores the reset row hashed and the letter still resets, over the real adapter', async () => {
    sent.length = 0;
    await auth.instance.api.requestPasswordReset({
      body: { email: 'pg.user@example.com', redirectTo: 'http://localhost:3000/reset' },
      headers: new Headers(),
    });
    const token = new URL(sent.at(-1)!).pathname.split('/').pop()!;
    const rows = await pool.query<{ identifier: string; value: string }>('SELECT identifier, value FROM verification');
    expect(rows.rows.length).toBeGreaterThan(0);
    for (const row of rows.rows) {
      expect(row.identifier).not.toContain(token);
      expect(row.value).not.toContain(token);
    }
    await auth.instance.api.resetPassword({ body: { token, newPassword: 'a-real-password' } });
    expect(
      (
        await auth.instance.api.signInEmail({
          body: { email: 'pg.user@example.com', password: 'a-real-password' },
          asResponse: true,
        })
      ).status,
    ).toBe(200);
  });

  it('rejects a second identity row for the same provider account', async () => {
    // The unique key the library does not create (§3.1). Two tabs finishing one
    // login at the same moment would otherwise leave two rows.
    const existing = await pool.query<{ provider: string; provider_id: string; user_id: string }>(
      'SELECT provider, provider_id, user_id FROM identities LIMIT 1',
    );
    const row = existing.rows[0]!;
    await expect(
      pool.query('INSERT INTO identities (provider, provider_id, user_id) VALUES ($1, $2, $3)', [
        row.provider,
        row.provider_id,
        row.user_id,
      ]),
    ).rejects.toThrow(/identities_provider_key|duplicate key/);
  });

  it('rejects a second account for the same address in a different case', async () => {
    await expect(
      pool.query('INSERT INTO users (email) VALUES ($1)', ['PG.USER@example.com']),
    ).rejects.toThrow(/users_email_lower_key|duplicate key/);
  });

  it('the admin plugin’s own columns are there when it is on, and renamed', async () => {
    // `admin: true` needs four columns on `users` and one on `sessions` that
    // 001 does not create, and the plugin declares them in camelCase — so this
    // fails both ways if 003 is missing or if the rename did not travel through
    // the plugin's schema. The library refuses to serve a request at all on a
    // mismatch, so one call is the whole assertion.
    // The SQL goes in BEFORE the instance is built, and that ordering is the
    // reason `authMigrations` exists as a standalone export: Better Auth 1.7.4
    // checks the schema once and REMEMBERS the answer, so an instance
    // constructed over a database that is missing its columns keeps refusing
    // after the columns arrive. Building first and migrating after — which is
    // what this test used to do — fails with "Missing columns users.role" on a
    // database that plainly has `users.role`.
    const adminMigrations = authMigrations({ admin: true });
    expect(adminMigrations.map((path) => path.split('/').pop())).toContain('20200101000003_kit_auth_admin.sql');
    for (const file of adminMigrations) {
      await pool.query(up(file));
    }

    const withAdmin = createAuth({
      db: pool,
      secret: () => 'k'.repeat(48),
      baseUrl: 'http://localhost:3000',
      cookieName: 'probe_session',
      secureCookie: false,
      sessionDays: 7,
      providers: {},
      admin: true,
      resolvePrincipal: async (userId) => ({ userId, login: null }),
    });
    // What the instance would have applied is what was just applied.
    expect(withAdmin.migrations).toEqual(adminMigrations);

    const response = await withAdmin.handler(
      new Request('http://localhost:3000/api/account/get-session'),
    );
    expect(response.status).toBe(200);
    const columns = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'users' AND column_name IN ('role','banned','ban_reason','ban_expires','banReason')`,
    );
    expect(columns.rows.map((row) => row.column_name).sort()).toEqual([
      'ban_expires',
      'ban_reason',
      'banned',
      'role',
    ]);
  });

  it('rewrites a foreign password hash in the column the rename actually made', async () => {
    // `email.legacyPassword` is proved next door over the memory adapter, with
    // a real bcrypt string. What only Postgres can say is that the WRITE lands:
    // `internalAdapter.updatePassword` matches on `userId`, `providerId` and
    // `accountId`, and in our schema those three are `user_id`, `provider` and
    // `provider_id`. A rename that failed to travel would leave the row
    // untouched and the sign-in still 200 — a bridge that silently never
    // crosses anybody, which is the one failure the memory adapter cannot see.
    //
    // The foreign hash here is a fixed string rather than bcrypt: the kit does
    // not depend on a hashing library, and what is under test is the rewrite,
    // not somebody else's algorithm.
    const legacy = 'legacy$not-a-kit-hash';
    const asked: string[] = [];
    const bridged = createAuth<{ userId: string; login: string | null }>({
      db: pool,
      secret: () => 'k'.repeat(48),
      baseUrl: 'http://localhost:3000',
      cookieName: 'probe_session',
      secureCookie: false,
      sessionDays: 7,
      providers: {},
      email: {
        send: async () => {},
        letters: {
          magicLink: (link) => ({ subject: 'link', text: link.url }),
          verifyEmail: (link) => ({ subject: 'verify', text: link.url }),
          resetPassword: (link) => ({ subject: 'reset', text: link.url }),
        },
        password: true,
        legacyPassword: {
          verify: async ({ password, hash }) => {
            asked.push(hash);
            return hash === legacy && password === 'what-they-typed-in-2019';
          },
        },
      },
      resolvePrincipal: async (userId) => ({ userId, login: null }),
    });

    await pool.query('UPDATE users SET email_verified = true');
    await pool.query(`UPDATE identities SET password = $1 WHERE provider = 'credential'`, [legacy]);

    const signIn = await bridged.instance.api.signInEmail({
      body: { email: 'pg.user@example.com', password: 'what-they-typed-in-2019' },
      asResponse: true,
    });
    expect(signIn.status).toBe(200);
    expect(asked).toEqual([legacy]);

    const after = await pool.query<{ password: string }>(
      `SELECT password FROM identities WHERE provider = 'credential'`,
    );
    expect(after.rows[0]!.password.startsWith('scrypt$')).toBe(true);

    // The same password, the same person, one request later — and now it is
    // the kit's own hash answering. Nobody had to change anything they know.
    asked.length = 0;
    const again = await bridged.instance.api.signInEmail({
      body: { email: 'pg.user@example.com', password: 'what-they-typed-in-2019' },
      asResponse: true,
    });
    expect(again.status).toBe(200);
    expect(asked).toEqual([]);

    // Restore what the rest of the file expects to find.
    await pool.query(`UPDATE identities SET password = $1 WHERE provider = 'credential'`, [
      await hashPassword('a-real-password'),
    ]);
  });

  it('is idempotent: the migrations apply twice without complaint', async () => {
    for (const file of auth.migrations) {
      await expect(pool.query(up(file))).resolves.toBeDefined();
    }
    const count = await pool.query<{ n: string }>('SELECT count(*)::text AS n FROM users');
    expect(count.rows[0]!.n).toBe('1');
  });
});
