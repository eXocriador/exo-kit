import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { betterAuth, type BetterAuthOptions } from 'better-auth';
import { memoryAdapter } from 'better-auth/adapters/memory';
import { genericOAuth } from 'better-auth/plugins/generic-oauth';
import { buildAuthOptions } from '../src/auth/index.js';
import { fakeIdpConfig, startFakeIdp, type FakeIdp } from './auth-idp.js';

/**
 * **This file is the replacement for a line of SQL, and that is the only way to
 * read it correctly.**
 *
 * auth.md kept the merge condition inside the query on purpose — "місце, де її
 * можна забути наступною правкою, коштує чужого акаунта". Better Auth keeps it
 * in an `if` in somebody else's release. The safety property is the same; where
 * it lives is not, and what used to be guaranteed by a schema is now guaranteed
 * by a version. So these five cases are not a unit test of a config object:
 * they are the thing that has to run on every `better-auth` bump, and the
 * reason the version is pinned exactly.
 *
 * All five reproduce the sandbox's live Postgres runs (report §3.2) — A, B, C,
 * D, and B2 — against the memory adapter, so they need no database and no
 * network beyond loopback.
 */

const SECRET = 'k'.repeat(48);
let idp: FakeIdp;

type Row = Record<string, unknown>;
interface Store {
  users: Row[];
  sessions: Row[];
  identities: Row[];
  verification: Row[];
}

function emptyStore(): Store {
  return { users: [], sessions: [], identities: [], verification: [] };
}

/**
 * The real policy object with the fake provider bolted on.
 *
 * `buildAuthOptions` is what `createAuth` itself passes to `betterAuth`, so
 * what is under test is the shipped configuration and not a restatement of it.
 * `trustedProviders` is spliced in afterwards for case B2 only — it is NOT an
 * option of ours, and that is the point of the case.
 */
function build(store: Store, options: { trustedProviders?: string[] } = {}) {
  const base = buildAuthOptions({
    db: store as unknown,
    secret: () => SECRET,
    baseUrl: 'http://localhost:3000',
    cookieName: 'probe_session',
    secureCookie: false,
    sessionDays: 7,
    providers: {},
    email: {
      send: async () => {},
      letters: { magicLink: (link) => ({ subject: 's', text: link.url }) },
    },
    resolvePrincipal: async (userId) => ({ userId }),
  });

  const account = { ...(base.account as Record<string, unknown>) };
  const linking = { ...(account.accountLinking as Record<string, unknown>) };
  if (options.trustedProviders) linking.trustedProviders = options.trustedProviders;
  account.accountLinking = linking;

  return betterAuth({
    ...base,
    account: account as BetterAuthOptions['account'],
    // The memory adapter keys off the MODEL name, not our table name, so the
    // store above is spelled with our names to match `modelName`.
    database: memoryAdapter(store as unknown as Record<string, Row[]>),
    // Password sign-up is how a local side with a known `email_verified` is
    // created; the module leaves it off unless a product asks for it.
    emailAndPassword: { enabled: true },
    emailVerification: undefined,
    plugins: [
      ...(base.plugins ?? []),
      genericOAuth({ config: [fakeIdpConfig(idp.port) as never] }),
    ],
  });
}

/**
 * The slice of the instance these helpers drive. Spelled out rather than taken
 * from `ReturnType<typeof betterAuth>`: the `account` override below makes the
 * inferred options type narrower than `BetterAuthOptions`, and the two no
 * longer unify.
 */
interface Driveable {
  handler(request: Request): Promise<Response>;
  api: {
    signInSocial(args: unknown): Promise<Response>;
    signUpEmail(args: unknown): Promise<Response>;
  };
}

/** The whole round trip: `/sign-in/social` → IdP → `/callback/fakeidp`. */
async function oauthRound(auth: Driveable) {
  const start = await auth.api.signInSocial({
    body: { provider: 'fakeidp', callbackURL: '/ok', errorCallbackURL: '/fail' },
    asResponse: true,
  });
  const { url } = (await start.json()) as { url: string };
  // The `state` cookie has to travel, or the callback refuses for the other
  // reason and the test would pass for the wrong one.
  const cookies = start.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
  const hop = await fetch(url, { redirect: 'manual' });
  const back = hop.headers.get('location') ?? '';
  const response = await auth.handler(new Request(back, { headers: { cookie: cookies } }));
  return {
    location: response.headers.get('location') ?? '',
    gotSession: response.headers.getSetCookie().some((c) => c.includes('probe_session=')),
  };
}

/** A local account created with a password, with `email_verified` forced. */
async function localAccount(
  auth: Driveable,
  store: Store,
  email: string,
  emailVerified: boolean,
) {
  const response = await auth.api.signUpEmail({
    body: { email, password: 'correct-horse-battery', name: 'Local' },
    asResponse: true,
  });
  expect(response.status).toBe(200);
  if (emailVerified) store.users[0]!.email_verified = true;
}

const providersOf = (store: Store) => store.identities.map((row) => row.provider).sort();

beforeAll(async () => {
  idp = await startFakeIdp();
});
afterAll(async () => {
  await idp.close();
});
beforeEach(() => {
  idp.profile.sub = 'idp-subject-1';
  idp.profile.email = 'a@example.com';
  idp.profile.emailVerified = true;
});

describe('the merge policy of auth.md, case by case', () => {
  it('A — local unverified, provider verified: refuses, and links nothing', async () => {
    // The dangerous direction. Somebody registered the victim's address here
    // without proving it; if a verified provider login merged into that row,
    // whoever registered it would inherit the verified owner's account.
    const store = emptyStore();
    const auth = build(store);
    await localAccount(auth, store, 'a@example.com', false);
    idp.profile.emailVerified = true;

    const result = await oauthRound(auth);
    expect(result.location).toContain('error=account_not_linked');
    expect(result.gotSession).toBe(false);
    expect(providersOf(store)).toEqual(['credential']);
  });

  it('B — local verified, provider unverified: refuses, and links nothing', async () => {
    // The other direction, and the reason `trustedProviders` must stay empty:
    // a provider that does not check addresses is a way to claim any address.
    const store = emptyStore();
    const auth = build(store);
    await localAccount(auth, store, 'a@example.com', true);
    idp.profile.emailVerified = false;

    const result = await oauthRound(auth);
    expect(result.location).toContain('error=account_not_linked');
    expect(result.gotSession).toBe(false);
    expect(providersOf(store)).toEqual(['credential']);
  });

  it('C — no local account, provider verified: creates one', async () => {
    const store = emptyStore();
    const auth = build(store);

    const result = await oauthRound(auth);
    expect(result.location).toBe('/ok');
    expect(result.gotSession).toBe(true);
    expect(store.users).toHaveLength(1);
    expect(providersOf(store)).toEqual(['fakeidp']);
  });

  it('D — verified on both sides: merges into the one account', async () => {
    const store = emptyStore();
    const auth = build(store);
    await localAccount(auth, store, 'a@example.com', true);
    idp.profile.emailVerified = true;

    const result = await oauthRound(auth);
    expect(result.location).toBe('/ok');
    expect(result.gotSession).toBe(true);
    expect(store.users).toHaveLength(1);
    expect(providersOf(store)).toEqual(['credential', 'fakeidp']);
  });

  it('B2 — `trustedProviders` would LINK case B, which is why it is not an option', async () => {
    // The regression that keeps the wrapper honest. The modularity plan
    // recommended `trustedProviders: ['github','google']` as the way to express
    // the policy; naming a provider there makes it SKIP the incoming
    // `emailVerified` check. Same input as case B, opposite outcome.
    const store = emptyStore();
    const auth = build(store, { trustedProviders: ['fakeidp'] });
    await localAccount(auth, store, 'a@example.com', true);
    idp.profile.emailVerified = false;

    const result = await oauthRound(auth);
    expect(result.location).toBe('/ok');
    expect(result.gotSession).toBe(true);
    expect(providersOf(store)).toEqual(['credential', 'fakeidp']);
  });

  it('the shipped options leave trustedProviders empty and require a verified local side', () => {
    const options = buildAuthOptions({
      db: {} as unknown,
      secret: () => SECRET,
      baseUrl: 'http://localhost:3000',
      cookieName: 'probe_session',
      secureCookie: true,
      sessionDays: 30,
      providers: {},
      resolvePrincipal: async () => null,
    });
    expect(options.account?.accountLinking).toEqual({
      enabled: true,
      trustedProviders: [],
      requireLocalEmailVerified: true,
    });
  });
});
