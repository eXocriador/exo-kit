import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { readFileSync } from 'node:fs';
import { createAuth } from '../src/auth/index.js';

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

suite('the schema the module ships, against a real Postgres', () => {
  let pool: Pool;
  let auth: ReturnType<typeof createAuth<{ userId: string; login: string | null }>>;
  const sent: string[] = [];

  beforeAll(async () => {
    pool = new Pool({ connectionString: URL_, max: 2 });
    await pool.query(
      'DROP TABLE IF EXISTS two_factor, verification, sessions, identities, users CASCADE',
    );

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

    // The migrations the module hands the product, applied the way a product's
    // runner applies them — in order, each file as one statement batch.
    for (const file of auth.migrations) {
      await pool.query(readFileSync(file, 'utf8'));
    }
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
    for (const file of withAdmin.migrations) {
      await pool.query(readFileSync(file, 'utf8'));
    }
    expect(withAdmin.migrations.map((path) => path.split('/').pop())).toContain('003_kit_auth_admin.sql');

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

  it('is idempotent: the migrations apply twice without complaint', async () => {
    for (const file of auth.migrations) {
      await expect(pool.query(readFileSync(file, 'utf8'))).resolves.toBeDefined();
    }
    const count = await pool.query<{ n: string }>('SELECT count(*)::text AS n FROM users');
    expect(count.rows[0]!.n).toBe('1');
  });
});
