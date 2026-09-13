import { describe, it, expect } from 'vitest';
import { compare as bcryptCompare, hash as bcryptHash } from 'bcryptjs';
import { memoryAdapter } from 'better-auth/adapters/memory';
import { buildAuthOptions, createAuth } from '../src/auth/index.js';
import { hashPassword, isKitPasswordHash } from '../src/auth-core/password.js';

/**
 * The bridge off somebody else's hash format — `email.legacyPassword`.
 *
 * `bcryptjs` is a devDependency HERE and nowhere else, and that is the point of
 * the file. A test that substituted a fake verifier would be asserting that the
 * kit calls a function it was handed, which it obviously does; what needs
 * proving is that a REAL `$2b$10$` string — the thing syncwatch's six people
 * actually have in their column — gets through the library, and that the row it
 * came from stops being bcrypt afterwards. `test/auth-wrapper.test.ts` has the
 * older "a hash made outside the library" case, and that one substitutes the
 * kit's OWN format: it proves the hash need not come from this process, not
 * that a foreign format is readable.
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
  magicLink: (link: { url: string }) => ({ subject: 'link', text: link.url }),
  verifyEmail: (link: { url: string }) => ({ subject: 'verify', text: link.url }),
  resetPassword: (link: { url: string }) => ({ subject: 'reset', text: link.url }),
};

/** What syncwatch's product code will pass: bcryptjs, and nothing of the kit's. */
function build(options: { verify?: (input: { password: string; hash: string }) => Promise<boolean> } = {}) {
  const store = emptyStore();
  const asked: { password: string; hash: string }[] = [];
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
      letters,
      password: true,
      legacyPassword: {
        verify: async (input) => {
          asked.push(input);
          return options.verify ? options.verify(input) : bcryptCompare(input.password, input.hash);
        },
      },
    },
    resolvePrincipal: async (userId) => ({ userId }),
  });
  return { auth, store, asked };
}

/**
 * A row exactly as the E1 migration will leave it: the person exists, their
 * address is verified because an admin approved them by hand, and their
 * password is the `$2b$10$` string Prisma wrote years ago. Built by signing up
 * and then overwriting the hash, so every column the library needs is the
 * library's own work and only the format under test is ours.
 */
async function seedLegacyUser(
  built: ReturnType<typeof build>,
  email: string,
  password: string,
  rounds = 10,
): Promise<string> {
  await built.auth.instance.api.signUpEmail({
    body: { email, password: 'placeholder-password', name: 'Legacy' },
    asResponse: true,
  });
  built.store.users[0]!.email_verified = true;
  const legacy = await bcryptHash(password, rounds);
  expect(legacy.startsWith(`$2b$${String(rounds).padStart(2, '0')}$`)).toBe(true);
  built.store.identities[0]!.password = legacy;
  return legacy;
}

const signIn = (built: ReturnType<typeof build>, email: string, password: string) =>
  built.auth.instance.api.signInEmail({ body: { email, password }, asResponse: true });

describe('a password hashed before the kit existed', () => {
  it('lets a real bcrypt row in, and the row stops being bcrypt', async () => {
    // The whole request, in one test: syncwatch cannot mail a reset to anybody,
    // so the six live `$2b$10$` rows must sign in as they stand — and must not
    // still be bcrypt on the way out, or this is not a bridge.
    const built = build();
    const legacy = await seedLegacyUser(built, 'six@example.com', 'their-real-password');

    const first = await signIn(built, 'six@example.com', 'their-real-password');
    expect(first.status).toBe(200);
    expect(built.asked).toEqual([{ password: 'their-real-password', hash: legacy }]);

    const stored = built.store.identities[0]!.password as string;
    expect(stored).not.toBe(legacy);
    expect(isKitPasswordHash(stored)).toBe(true);
  });

  it('is not asked again once the row is rewritten', async () => {
    // The difference between a bridge and permission to live on bcrypt for
    // ever. After the first sign-in the product's function is dead weight, and
    // when every row has crossed, the option can be deleted.
    const built = build();
    await seedLegacyUser(built, 'six@example.com', 'their-real-password');

    expect((await signIn(built, 'six@example.com', 'their-real-password')).status).toBe(200);
    expect(built.asked).toHaveLength(1);
    expect((await signIn(built, 'six@example.com', 'their-real-password')).status).toBe(200);
    expect(built.asked).toHaveLength(1);
  });

  it('is never asked about a hash of ours, even when that hash is refused', async () => {
    // "Only after the native path declines, never instead of it." A `scrypt$`
    // row is ours to answer for, right or wrong, and handing it to a product's
    // verifier is how one permissive function would put the portfolio back on
    // bcrypt without anybody deciding to.
    const built = build();
    await built.auth.instance.api.signUpEmail({
      body: { email: 'native@example.com', password: 'a-real-password', name: 'N' },
      asResponse: true,
    });
    built.store.users[0]!.email_verified = true;
    built.store.identities[0]!.password = await hashPassword('a-real-password');

    expect((await signIn(built, 'native@example.com', 'a-real-password')).status).toBe(200);
    await expect(
      built.auth.instance.api.signInEmail({ body: { email: 'native@example.com', password: 'wrong-password' } }),
    ).rejects.toThrow();
    expect(built.asked).toEqual([]);
  });

  it('refuses a wrong password against a legacy row, and rewrites nothing', async () => {
    const built = build();
    const legacy = await seedLegacyUser(built, 'six@example.com', 'their-real-password');

    await expect(
      built.auth.instance.api.signInEmail({ body: { email: 'six@example.com', password: 'not-their-password' } }),
    ).rejects.toThrow();
    // The product's reader was asked — the string is not ours to answer for —
    // and said no. The after hooks still run on a thrown endpoint, so this also
    // holds the guard that a refused sign-in cannot reach the rewrite.
    expect(built.asked).toHaveLength(1);
    expect(built.store.identities[0]!.password).toBe(legacy);
  });

  it('treats a verifier that throws as a no, not as a 500', async () => {
    // These rows are exactly where a truncated or half-imported string
    // survives, and `bcrypt.compare` rejects on one. One person's password
    // being refused is the right cost; everybody's login returning 500 is not.
    const built = build({
      verify: () => {
        throw new Error('malformed hash');
      },
    });
    await seedLegacyUser(built, 'six@example.com', 'their-real-password');

    const refused = await signIn(built, 'six@example.com', 'their-real-password');
    expect(refused.status).toBe(401);
  });

  it('crosses tyusha’s cost 12 with the same function', async () => {
    // Two products, two costs, one product-supplied reader: the cost is inside
    // the string, so the kit has nothing to configure and tyusha needs no
    // second seam.
    const built = build();
    await seedLegacyUser(built, 'twelve@example.com', 'their-real-password', 12);

    expect((await signIn(built, 'twelve@example.com', 'their-real-password')).status).toBe(200);
    expect(isKitPasswordHash(built.store.identities[0]!.password as string)).toBe(true);
  });

  it('refuses to be configured without the password routes it needs', () => {
    // A reader for the old format on a links-only login: nothing would ever
    // call it, and the option would read as proof the old users can still get
    // in.
    expect(() =>
      buildAuthOptions({
        db: {} as unknown,
        secret: () => SECRET,
        baseUrl: 'http://localhost:3000',
        cookieName: 'c_session',
        secureCookie: true,
        sessionDays: 30,
        providers: {},
        email: {
          send: async () => {},
          letters,
          legacyPassword: { verify: async () => true },
        },
        resolvePrincipal: async () => null,
      }),
    ).toThrow(/legacyPassword requires email\.password/);
  });
});

describe('the format predicate both halves share', () => {
  it('claims our strings and disclaims everybody else’s', async () => {
    expect(isKitPasswordHash(await hashPassword('x'.repeat(12)))).toBe(true);
    expect(isKitPasswordHash(await bcryptHash('x'.repeat(12), 10))).toBe(false);
    // Six fields is part of the shape: a truncated row is not ours to read, and
    // `verifyPassword` refusing it is what keeps an empty salt from verifying
    // every password.
    expect(isKitPasswordHash('scrypt$16384$8$1$')).toBe(false);
    expect(isKitPasswordHash('')).toBe(false);
  });
});
