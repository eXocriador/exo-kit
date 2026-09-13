import { describe, it, expect, beforeEach } from 'vitest';
import { betterAuth } from 'better-auth';
import { memoryAdapter } from 'better-auth/adapters/memory';
import { authMigrations, buildAuthOptions, createAuth, loginFor } from '../src/auth/index.js';
import { createAddressLimit, createAuthRateLimitStorage } from '../src/auth/rate-limit.js';
import { hashPassword } from '../src/auth-core/password.js';

/**
 * The rest of the mandatory set from the sandbox report §5: the password
 * format, the magic link's documented destructiveness, the address ceiling, and
 * the session list the library would have handed out with tokens in it.
 *
 * The merge policy lives next door in `auth-linking.test.ts`, because it needs
 * a provider to fire at all.
 */

const SECRET = 'k'.repeat(48);

type Row = Record<string, unknown>;
interface Store {
  users: Row[];
  sessions: Row[];
  identities: Row[];
  verification: Row[];
}
const emptyStore = (): Store => ({ users: [], sessions: [], identities: [], verification: [] });

const letters = {
  magicLink: (link: { url: string }, minutes: number) => ({ subject: 'link', text: `${link.url} ${minutes}` }),
  verifyEmail: (link: { url: string }) => ({ subject: 'verify', text: link.url }),
  resetPassword: (link: { url: string }) => ({ subject: 'reset', text: link.url }),
};

interface Built {
  auth: ReturnType<typeof createAuth<{ userId: string }>>;
  store: Store;
  sent: { to: string; subject: string; text: string }[];
}

/**
 * The module under test, over the memory adapter.
 *
 * `db` is whatever Better Auth accepts as a `database`, and the memory adapter
 * is one of those — so this is the real `createAuth`, with the real options
 * object, and the only substitution is Postgres. Nothing about the wrapper is
 * re-implemented here, which is the difference between this file and a copy of
 * itself.
 */
function build(
  options: { password?: boolean; perAddressLimit?: { max: number; windowMs: number } } = {},
): Built {
  const store = emptyStore();
  const sent: Built['sent'] = [];
  const auth = createAuth<{ userId: string }>({
    db: memoryAdapter(store as unknown as Record<string, Row[]>),
    secret: () => SECRET,
    baseUrl: 'http://localhost:3000',
    cookieName: 'probe_session',
    secureCookie: false,
    sessionDays: 7,
    providers: {},
    email: {
      send: async (to, subject, text) => {
        sent.push({ to, subject, text });
      },
      letters,
      ...(options.password ? { password: true } : {}),
      ...(options.perAddressLimit ? { perAddressLimit: options.perAddressLimit } : {}),
    },
    resolvePrincipal: async (userId) => ({ userId }),
  });
  return { auth, store, sent };
}

/**
 * `instance.api` is typed from a STATIC options object, and ours is assembled
 * from what the product asked for — so the magic-link route exists at runtime
 * and not in the type. Narrowing here rather than at each call site keeps the
 * cast in one place with the reason attached.
 */
const magicLinkApi = (auth: Built['auth']) =>
  auth.instance.api as unknown as {
    signInMagicLink(args: { body: { email: string }; headers: Headers }): Promise<unknown>;
  };

const cookieOf = (response: Response) =>
  new Headers({ cookie: response.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ') });

describe('passwords', () => {
  it('accepts a hash made outside the library, with no reset', async () => {
    // The exointel migration in one assertion: a row whose `password` came from
    // `@exo/kit/auth-core` — written by a different process, years earlier —
    // signs in. If this ever fails, moving a product onto this module starts
    // costing every live user their password.
    const { auth, store } = build({ password: true });
    const signUp = await auth.instance.api.signUpEmail({
      body: { email: 'p@example.com', password: 'first-password-here', name: 'P' },
      asResponse: true,
    });
    expect(signUp.status).toBe(200);
    store.users[0]!.email_verified = true;

    const ours = await hashPassword('kit-made-password');
    expect(ours.startsWith('scrypt$')).toBe(true);
    store.identities[0]!.password = ours;

    const ok = await auth.instance.api.signInEmail({
      body: { email: 'p@example.com', password: 'kit-made-password' },
      asResponse: true,
    });
    expect(ok.status).toBe(200);

    await expect(
      auth.instance.api.signInEmail({ body: { email: 'p@example.com', password: 'wrong-password' } }),
    ).rejects.toThrow();
  });

  it('refuses to be configured with a password and no verification letters', () => {
    // Fixed decision 3, enforced at construction rather than discovered by the
    // first person whose password silently stopped working.
    expect(() =>
      buildAuthOptions({
        db: {} as unknown,
        secret: () => SECRET,
        baseUrl: 'http://localhost:3000',
        cookieName: 'c_session',
        secureCookie: true,
        sessionDays: 30,
        providers: {},
        email: { send: async () => {}, letters: { magicLink: () => ({ subject: 's', text: 't' }) }, password: true },
        resolvePrincipal: async () => null,
      }),
    ).toThrow(/verifyEmail/);
  });

  it('leaves email+password off unless the product asks', () => {
    const options = buildAuthOptions({
      db: {} as unknown,
      secret: () => SECRET,
      baseUrl: 'http://localhost:3000',
      cookieName: 'c_session',
      secureCookie: true,
      sessionDays: 30,
      providers: {},
      email: { send: async () => {}, letters: { magicLink: () => ({ subject: 's', text: 't' }) } },
      resolvePrincipal: async () => null,
    });
    // A product with no password UI must not publish /sign-up/email.
    expect(options.emailAndPassword?.enabled).toBe(false);
    // And when it IS on, verification at sign-up is not negotiable.
    const withPassword = buildAuthOptions({
      db: {} as unknown,
      secret: () => SECRET,
      baseUrl: 'http://localhost:3000',
      cookieName: 'c_session',
      secureCookie: true,
      sessionDays: 30,
      providers: {},
      email: { send: async () => {}, letters, password: true },
      resolvePrincipal: async () => null,
    });
    expect(withPassword.emailAndPassword?.requireEmailVerification).toBe(true);
    expect(withPassword.emailVerification?.sendOnSignUp).toBe(true);
  });
});

describe('a magic link into an unproven account', () => {
  it('DELETES its password and every link it had — recorded, not fixed', async () => {
    // The most expensive finding of the sandbox session (§3.12), pinned here so
    // it cannot change under us unnoticed. It is not a bug: it is the fix for
    // GHSA-qq9h-g4jm-xgf3, and it says the verified owner of a mailbox inherits
    // nothing that predates the proof. The consequence is why verification at
    // sign-up is fixed on whenever a password exists — see the test above.
    const { auth, store, sent } = build({ password: true });
    await auth.instance.api.signUpEmail({
      body: { email: 'c@example.com', password: 'a-real-password', name: 'C' },
      asResponse: true,
    });
    expect(store.identities.map((row) => row.provider)).toEqual(['credential']);

    await magicLinkApi(auth).signInMagicLink({
      body: { email: 'c@example.com' },
      headers: new Headers(),
    });
    const link = sent.find((letter) => letter.subject === 'link');
    expect(link).toBeDefined();
    const verify = await auth.handler(new Request(link!.text.split(' ')[0]!));
    expect([200, 302]).toContain(verify.status);

    // The row survives; everything that could sign into it does not.
    expect(store.users).toHaveLength(1);
    expect(store.users[0]!.email_verified).toBe(true);
    expect(store.identities).toHaveLength(0);
  });
});

describe('the letter', () => {
  it('carries the raw token as well as the ready URL', async () => {
    // Not a convenience. The ready URL consumes the token on a GET, and mail
    // scanners follow links before a person does — so a product that wants its
    // own consume page needs the token itself. filebrowser had that page before
    // this module existed and keeps it.
    const seen: { url: string; token: string; minutes: number }[] = [];
    const store = emptyStore();
    const auth = createAuth<{ userId: string }>({
      db: memoryAdapter(store as unknown as Record<string, Row[]>),
      secret: () => SECRET,
      baseUrl: 'http://localhost:3000',
      cookieName: 'probe_session',
      secureCookie: false,
      sessionDays: 7,
      providers: {},
      email: {
        send: async () => {},
        linkMinutes: 20,
        letters: {
          magicLink: (link, minutes) => {
            seen.push({ ...link, minutes });
            return { subject: 'link', text: link.url };
          },
        },
      },
      resolvePrincipal: async (userId) => ({ userId }),
    });

    await (
      auth.instance.api as unknown as {
        signInMagicLink(args: { body: { email: string }; headers: Headers }): Promise<unknown>;
      }
    ).signInMagicLink({ body: { email: 'a@example.com' }, headers: new Headers() });

    expect(seen).toHaveLength(1);
    expect(seen[0]!.token).toMatch(/^[A-Za-z]{32}$/);
    expect(seen[0]!.url).toContain(seen[0]!.token);
    expect(seen[0]!.minutes).toBe(20);
  });
});

describe('the ceiling on letters to one address', () => {
  it('counts the recipient, not the caller', async () => {
    // Better Auth's own limiter keys on IP + path. Behind Traefik that is one
    // bucket for everybody, and it does not protect a stranger's mailbox from
    // whoever is willing to change IP. Three letters per address is what the
    // products used.
    const { auth, sent } = build({ perAddressLimit: { max: 2, windowMs: 60_000 } });
    const ask = (email: string) =>
      auth.handler(
        new Request('http://localhost:3000/api/account/sign-in/magic-link', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email }),
        }),
      );

    expect((await ask('one@example.com')).status).toBe(200);
    expect((await ask('one@example.com')).status).toBe(200);
    expect((await ask('one@example.com')).status).toBe(429);
    // A different address has its own budget — the ceiling is per mailbox.
    expect((await ask('two@example.com')).status).toBe(200);
    expect(sent.filter((letter) => letter.to === 'one@example.com')).toHaveLength(2);
  });

  it('is case- and whitespace-insensitive, so the ceiling cannot be stepped around', async () => {
    const limit = createAddressLimit({ max: 1, windowMs: 60_000 });
    expect(await limit.allow('a@example.com')).toBe(true);
    expect(await limit.allow('  A@Example.com ')).toBe(false);
  });

  it('survives a restart when given a storage', async () => {
    // The products' own counters lived in process memory and a restart handed
    // everyone a fresh budget. With the Redis storage the bucket is shared.
    const storage = createAuthRateLimitStorage({ redis: null });
    const first = createAddressLimit({ max: 1, windowMs: 60_000, storage });
    const afterRestart = createAddressLimit({ max: 1, windowMs: 60_000, storage });
    expect(await first.allow('a@example.com')).toBe(true);
    expect(await afterRestart.allow('a@example.com')).toBe(false);
  });

  it('reports a retryAfter a caller can act on', async () => {
    const storage = createAuthRateLimitStorage({ redis: null });
    expect(await storage.consume('k', { max: 1, window: 10 })).toEqual({ allowed: true, retryAfter: null });
    const refused = await storage.consume('k', { max: 1, window: 10 });
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfter).toBeGreaterThan(0);
  });
});

describe('the session list', () => {
  let built: Built;
  beforeEach(() => {
    built = build({ password: true });
  });

  it('never carries the raw token, and the HTTP route that would is gone', async () => {
    // The library answers /list-sessions with each session's `token` — the
    // caller's own, so not a leak, but one XSS on the cabinet page then hands
    // over every device instead of one.
    const { auth, store } = built;
    // `requireEmailVerification` is fixed on, so sign-up deliberately issues no
    // session: the cookie comes from signing in after the address is proven.
    await auth.instance.api.signUpEmail({
      body: { email: 's@example.com', password: 'a-real-password', name: 'S' },
      asResponse: true,
    });
    store.users[0]!.email_verified = true;
    const headers = cookieOf(
      await auth.instance.api.signInEmail({
        body: { email: 's@example.com', password: 'a-real-password' },
        asResponse: true,
      }),
    );

    const sessions = await auth.listSessions(headers);
    expect(sessions).toHaveLength(1);
    expect(JSON.stringify(sessions)).not.toContain(String(store.sessions[0]!.token));
    expect(Object.keys(sessions[0]!).sort()).toEqual([
      'createdAt',
      'current',
      'expiresAt',
      'id',
      'ip',
      'userAgent',
    ]);
    // Which device is this one — the cabinet needs it and the library's own
    // answer did not say.
    expect(sessions[0]!.current).toBe(true);

    const direct = await auth.handler(
      new Request('http://localhost:3000/api/account/list-sessions', { headers }),
    );
    expect(direct.status).toBe(404);
  });

  it('revokes by id, and a stranger’s id is indistinguishable from a missing one', async () => {
    const { auth, store } = built;
    await auth.instance.api.signUpEmail({
      body: { email: 's@example.com', password: 'a-real-password', name: 'S' },
      asResponse: true,
    });
    store.users[0]!.email_verified = true;
    const first = await auth.instance.api.signInEmail({
      body: { email: 's@example.com', password: 'a-real-password' },
      asResponse: true,
    });
    const second = await auth.instance.api.signInEmail({
      body: { email: 's@example.com', password: 'a-real-password' },
      asResponse: true,
    });
    const headers = cookieOf(first);
    const sessions = await auth.listSessions(headers);
    expect(sessions).toHaveLength(2);

    const other = sessions.find((session) => !session.current)!;
    expect(await auth.revokeSession(headers, other.id)).toBe(true);
    expect(await auth.listSessions(headers)).toHaveLength(1);
    // Gone, made up, or somebody else's — all `false`, so the answer never
    // confirms that an id is real.
    expect(await auth.revokeSession(headers, other.id)).toBe(false);
    expect(await auth.revokeSession(headers, '00000000-0000-4000-8000-000000000000')).toBe(false);
    expect(second.status).toBe(200);
  });
});

describe('the handle auth.md keeps beside a name', () => {
  it('comes from the address, and falls back to the display name', () => {
    expect(loginFor({ email: 'Taras@example.com', name: 'Taras S' })).toBe('Taras');
    expect(loginFor({ email: '', name: 'Taras S' })).toBe('Taras S');
    expect(loginFor({})).toBe(null);
  });

  it('lowercases the address on creation, whatever route created the account', async () => {
    // `magic-link` creates a user with the string as typed, while every lookup
    // lowercases. A first-ever link from `Alice@x` would otherwise land a row
    // nothing could find again, and the next link would make a second account.
    const { auth, store, sent } = build();
    await magicLinkApi(auth).signInMagicLink({
      body: { email: 'Alice@Example.com' },
      headers: new Headers(),
    });
    const link = sent.find((letter) => letter.subject === 'link')!;
    await auth.handler(new Request(link.text.split(' ')[0]!));
    expect(store.users).toHaveLength(1);
    expect(store.users[0]!.email).toBe('alice@example.com');
    expect(store.users[0]!.login).toBe('alice');
  });
});

describe('what the wrapper refuses to expose', () => {
  it('fixes the base path, the cookie attributes and the uuid id', () => {
    const options = buildAuthOptions({
      db: {} as unknown,
      secret: () => SECRET,
      baseUrl: 'https://files.example.com',
      cookieName: 'filebrowser_session',
      secureCookie: true,
      sessionDays: 30,
      providers: {},
      resolvePrincipal: async () => null,
    });
    expect(options.basePath).toBe('/api/account');
    expect(options.advanced?.database?.generateId).toBe('uuid');
    expect(options.advanced?.defaultCookieAttributes).toEqual({
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      secure: true,
    });
    // Every cookie, not just the session one: the sandbox found the two-factor
    // and session-data cookies still called themselves `better-auth.*`.
    expect(options.advanced?.cookies?.session_token?.name).toBe('filebrowser_session');
    expect(options.advanced?.cookiePrefix).toBe('filebrowser');
    // The cache cookie would answer from the browser for as long as it lives,
    // and an admin taking `write` away must land on the next request.
    expect(options.session?.cookieCache?.enabled).toBe(false);
  });

  it('maps every table and column onto the names auth.md fixed', () => {
    const options = buildAuthOptions({
      db: {} as unknown,
      secret: () => SECRET,
      baseUrl: 'https://files.example.com',
      cookieName: 'c_session',
      secureCookie: true,
      sessionDays: 30,
      providers: {},
      totp: { issuer: 'files' },
      resolvePrincipal: async () => null,
    });
    expect(options.user?.modelName).toBe('users');
    expect(options.session?.modelName).toBe('sessions');
    expect(options.account?.modelName).toBe('identities');
    expect(options.verification?.modelName).toBe('verification');
    // The identity auth.md names: (provider, provider_id).
    expect(options.account?.fields?.providerId).toBe('provider');
    expect(options.account?.fields?.accountId).toBe('provider_id');
    expect(options.user?.fields?.emailVerified).toBe('email_verified');
  });

  it('lists its SQL without building anything — a migration runner needs only that', () => {
    // Reading the list used to mean constructing `createAuth`, which hands
    // `betterAuth` a database and dies with "Failed to initialize database
    // adapter" in a script that wanted three file names. Found by the first
    // consumer's migration runner, in a deploy.
    expect(authMigrations().map((path) => path.split('/').pop())).toEqual(['20200101000001_kit_auth.sql']);
    expect(authMigrations({ totp: true, admin: true }).map((path) => path.split('/').pop())).toEqual([
      '20200101000001_kit_auth.sql',
      '20200101000002_kit_auth_2fa.sql',
      '20200101000003_kit_auth_admin.sql',
    ]);
  });

  it('ships the 2FA migration only to a product that enabled TOTP', () => {
    const withoutTotp = createAuth({
      db: memoryAdapter(emptyStore() as unknown as Record<string, Row[]>),
      secret: () => SECRET,
      baseUrl: 'https://files.example.com',
      cookieName: 'c_session',
      secureCookie: true,
      sessionDays: 30,
      providers: {},
      resolvePrincipal: async () => null,
    });
    expect(withoutTotp.migrations.map((path) => path.split('/').pop())).toEqual(['20200101000001_kit_auth.sql']);
    const withTotp = createAuth({
      db: memoryAdapter(emptyStore() as unknown as Record<string, Row[]>),
      secret: () => SECRET,
      baseUrl: 'https://files.example.com',
      cookieName: 'c_session',
      secureCookie: true,
      sessionDays: 30,
      providers: {},
      totp: { issuer: 'files' },
      resolvePrincipal: async () => null,
    });
    expect(withTotp.migrations.map((path) => path.split('/').pop())).toEqual([
      '20200101000001_kit_auth.sql',
      '20200101000002_kit_auth_2fa.sql',
    ]);
  });
});
