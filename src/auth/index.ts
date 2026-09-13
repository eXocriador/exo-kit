/**
 * `@exo/kit/auth` — the login every product gets, over Better Auth **1.7.4**.
 *
 * This module exists to make one sentence true: *the policy in
 * `/srv/docs/standards/auth.md` is not something a product can get wrong.*
 * Better Auth can express that policy and can also express its exact opposite,
 * with one list left non-empty. So the seven decisions below are fixed here and
 * are not parameters, and what a product passes in is only what is genuinely
 * its own — its keys, its letters, its principal.
 *
 * ── What is FIXED and cannot be overridden ───────────────────────────────────
 *
 *  1. **`accountLinking = { enabled: true, trustedProviders: [],
 *     requireLocalEmailVerified: true }`.** Two logins become one account only
 *     when the address is verified on BOTH sides. `trustedProviders` is not
 *     exposed because a provider named there *skips* the incoming
 *     `emailVerified` check — the list weakens the policy rather than
 *     expressing it, which is the opposite of how it reads (sandbox §3.2,
 *     proven by five runs; `test/auth-linking.test.ts` holds all five).
 *  2. **`basePath: '/api/account'`**, cookie `httpOnly + sameSite=lax +
 *     path=/`, and `secure` from an explicit flag — never guessed from the URL.
 *  3. **Email verification on sign-up is on whenever a password exists beside
 *     a magic link.** Not tidiness: a magic link into an `emailVerified:
 *     false` row deletes that row's password and every OAuth link it had
 *     (`revokeUnprovenAccountAccess`, sandbox §3.12). Without verification at
 *     sign-up that is the ordinary path through the product, not an edge case.
 *  4. **Passwords are `@exo/kit/auth-core/password`** — `scrypt$N$r$p$salt$hash`,
 *     one format across every product, and the hashes exointel already has are
 *     accepted with no reset (sandbox §3.5). A product arriving with somebody
 *     ELSE's format (syncwatch and tyusha carry bcrypt) may hand in
 *     `email.legacyPassword.verify`, and that is a BRIDGE, not a second
 *     format: the kit asks it only about a string its own format does not
 *     claim, and the first sign-in it accepts rewrites the row in `scrypt$`.
 *     The option therefore empties itself, and the product deletes it. See
 *     "a password hashed before the kit existed" in the README for why the
 *     rewrite cannot live inside `verify` and what it costs.
 *  5. **`id` is `uuid`.** See the README; the short version is that `text` ids
 *     would have to be paid for by every table that references `users(id)`.
 *  6. **The session cookie cache is off, and `/list-sessions` never leaves the
 *     process.** The library answers that route with each session's raw
 *     `token` — the caller's own, so not a leak, but one XSS on the cabinet
 *     page then hands over every device instead of one (sandbox §3.3).
 *  7. **Fastify is mounted as an encapsulated plugin.** The raw-body parser
 *     Better Auth's docs tell you to add globally turns every product JSON
 *     route's body into a string (sandbox §3.9). See `./fastify.js`.
 *
 * ── What stays the product's ─────────────────────────────────────────────────
 * The shape of its principal and the query behind it (roles, permissions,
 * capabilities), its `ADMIN_EMAIL` rule, the text of its letters, its
 * `/api/account/health`, and the page with the provider buttons.
 *
 * ── Upgrading `better-auth` ──────────────────────────────────────────────────
 * The version is pinned exactly, and that is deliberate: twenty advisories in a
 * year, two of them the very holes auth.md closed by design. The merge policy
 * now lives in somebody else's release rather than in our SQL, so
 * `test/auth-linking.test.ts` is the replacement for the `WHERE email_verified
 * = true` that used to carry it. **Run the auth tests and read the advisories
 * on every version bump.**
 */
import { betterAuth, APIError, type BetterAuthOptions } from 'better-auth';
import { createAuthMiddleware } from 'better-auth/api';
import { admin as adminPlugin } from 'better-auth/plugins/admin';
import { customSession } from 'better-auth/plugins/custom-session';
import { magicLink } from 'better-auth/plugins/magic-link';
import { twoFactor } from 'better-auth/plugins/two-factor';
import { hashPassword, isKitPasswordHash, verifyPassword } from '../auth-core/password.js';
import {
  createAddressLimit,
  type AuthRateLimitStorage,
  type AddressLimit,
} from './rate-limit.js';
import { createAuthFastifyPlugin, type AuthFastifyPlugin } from './fastify.js';
import { authMigrations } from './migrations.js';
import {
  ADMIN_SESSION_FIELDS,
  ADMIN_USER_FIELDS,
  IDENTITY_FIELDS,
  MODEL_NAMES,
  SESSION_FIELDS,
  TWO_FACTOR_FIELDS,
  TWO_FACTOR_USER_FIELDS,
  USER_FIELDS,
  VERIFICATION_FIELDS,
  loginFor,
} from './schema.js';

export {
  createAuthRateLimitStorage,
  createAddressLimit,
  type AuthRateLimitStorage,
  type AuthRateLimitRule,
  type AuthRateLimitDecision,
  type AuthRateLimitRedis,
  type AddressLimit,
} from './rate-limit.js';
export { MODEL_NAMES, loginFor } from './schema.js';
export { createAuthFastifyPlugin, type AuthFastifyPlugin } from './fastify.js';
export { authMigrations } from './migrations.js';

/** The session row, as the library hands it to a principal resolver. */
export interface AuthSession {
  id: string;
  userId: string;
  expiresAt: Date | string;
  ipAddress?: string | null;
  userAgent?: string | null;
}

/** One of the caller's own devices. The raw session token is never in here. */
export interface AuthSessionInfo {
  id: string;
  ip: string | null;
  userAgent: string | null;
  createdAt: string;
  expiresAt: string;
  /** The session this request arrived on. */
  current: boolean;
}

/** A letter: the product's words, the kit's trigger. */
export interface AuthLetter {
  subject: string;
  text: string;
}

export interface AuthProviderKeys {
  clientId: string;
  clientSecret: string;
}

export interface AuthEmailOptions {
  /** The product's transport — `@exo/kit/mailer`, usually. */
  send(to: string, subject: string, text: string): Promise<void>;
  /**
   * The words. The kit never writes a sentence a person reads: the product
   * chooses the language, and two spellings of "your login link" in one
   * portfolio is how they drift.
   */
  letters: {
    /**
     * `link.url` goes straight to `/magic-link/verify`, which consumes the
     * token on a GET. **`link.token` is here because that is sometimes the
     * wrong thing to put in a letter:** mail scanners and link previewers
     * follow URLs before a person does, and a one-time link they burn makes the
     * login fail silently for the person who asked for it. A product that cares
     * builds its own `…/login?token=<token>` pointing at a page whose BUTTON
     * navigates to the verify route — the scanner then fetches a static page
     * and nothing is spent. filebrowser does exactly that.
     */
    magicLink(link: { url: string; token: string }, minutes: number): AuthLetter;
    /** Required when `password` is on — sign-up sends this before a session exists. */
    verifyEmail?(link: { url: string; token: string }, minutes: number): AuthLetter;
    /** Required when `password` is on. */
    resetPassword?(link: { url: string; token: string }, minutes: number): AuthLetter;
  };
  /** How long a link lives. Default 15 minutes — on its own life it equals a password. */
  linkMinutes?: number;
  /**
   * The ceiling on letters to ONE address — `{ max: 3, windowMs: 900_000 }` is
   * what the products used. Keep it: Better Auth's own limiter counts IP, and
   * an IP ceiling does not protect a stranger's mailbox from whoever changes
   * IP. Omitted means no address ceiling, which is a choice, not a default.
   */
  perAddressLimit?: { max: number; windowMs: number };
  /**
   * A password beside the link. Off by default, and that is not timidity: a
   * product with no password UI would otherwise publish `/sign-up/email` and
   * `/sign-in/email`, and the owner who chose links-only would have an open
   * registration endpoint nobody decided on.
   */
  password?: boolean;
  /**
   * The product's PREVIOUS hash format, for a database that predates the kit.
   *
   * syncwatch has six live people on `$2b$10$` and not one address the kit
   * could mail — "everybody resets their password" is not a migration there,
   * it is a locked door. So the kit accepts a second reader, under three rules
   * that make it a bridge rather than a second supported format:
   *
   *  - **Asked only about a string our own format does not claim.** A
   *    `scrypt$…` row never reaches this function, so a product cannot quietly
   *    put the whole portfolio back on bcrypt by passing something permissive.
   *  - **Accepting a password rewrites the row.** The next sign-in for that
   *    person takes the native path and this function is never called for them
   *    again — which is the difference between a bridge and permission to live
   *    on bcrypt forever.
   *  - **A throw counts as "no".** The rows this reads are exactly where a
   *    malformed string survives, and one of those must cost its owner a
   *    refused password, not everybody a 500.
   *
   * `bcryptjs` is deliberately NOT a kit dependency: the kit has no opinion on
   * which format a product is leaving, and the portfolio should not carry a
   * hashing library for two products and a finite number of logins.
   *
   *     legacyPassword: { verify: ({ password, hash }) => bcrypt.compare(password, hash) }
   *
   * Requires `password: true`. When every row is rewritten — `select count(*)
   * from identities where provider = 'credential' and password not like
   * 'scrypt$%'` is zero — delete the option.
   */
  legacyPassword?: {
    verify(input: { password: string; hash: string }): boolean | Promise<boolean>;
  };
}

export interface CreateAuthOptions<P> {
  /**
   * The product's `pg` Pool. Better Auth's built-in adapter speaks `pg`, and
   * this is the one place the kit asks for a driver it does not otherwise use
   * — `max: 5` is plenty, since the product's own queries keep running through
   * `@exo/kit/infra`. The module never reads `process.env`, so the connection
   * string is the product's business, as always.
   */
  db: unknown;
  /**
   * The signing secret. Read once, at construction: unlike
   * `createSessionCookie`, Better Auth takes a string and has no notion of a
   * secret that changes under it, so rotation means a restart. A function
   * rather than a string anyway, so a product cannot accidentally log the
   * config object with the secret inside it.
   */
  secret: () => string;
  /** Public origin, e.g. `https://files.exocriador.dev`. No trailing slash. */
  baseUrl: string;
  /** Session cookie name. Required, no default — a kit rule, and here it also names every other cookie. */
  cookieName: string;
  /** `Secure` on the cookie. Explicit, never guessed from the URL. */
  secureCookie: boolean;
  /** How long a session lives. */
  sessionDays: number;
  /**
   * Empty is a working state, not a fault: a product deploys before its owner
   * has been to the GitHub and Google consoles.
   */
  providers: {
    github?: AuthProviderKeys;
    google?: AuthProviderKeys;
  };
  /** Absent means no magic link, no password, no verification mail — OAuth only. */
  email?: AuthEmailOptions;
  /** Absent means no second factor. `issuer` is what a person sees in their authenticator. */
  totp?: { issuer: string };
  /**
   * The `admin` plugin: roles in `users.role`, ban, impersonation, fifteen
   * routes. Only worth it when admins are actually marked in that column — a
   * product whose admin is decided by an `ADMIN_EMAIL` match gets fifteen
   * routes its only admin cannot pass.
   */
  admin?: boolean;
  /** Better Auth's IP+path ceiling over our Redis. See `createAuthRateLimitStorage`. */
  rateLimitStorage?: AuthRateLimitStorage;
  /**
   * Every product is behind Traefik, and without this the library puts every
   * client in one bucket under the key `no-trusted-ip`.
   */
  trustedProxies?: string[];
  /**
   * Who is making this request, in the product's own shape. One query, the
   * same one the product's `sessions.ts` held before. Runs inside
   * `customSession`, so `/get-session` and `getPrincipal` answer identically.
   */
  resolvePrincipal(userId: string, session: AuthSession): Promise<P | null>;
  /**
   * `afterSignIn` is the one hook here, and the one auth.md asks for that is
   * NOT reproduced is worth naming: the standard puts the provider's name
   * inside the `state` value (`"<provider>.<nonce>"`) so a code from one path
   * cannot be presented on another "before the network". Better Auth does not,
   * and does something stronger instead — the state is written to BOTH a row
   * and a signed cookie, both are compared on return, and the row is deleted on
   * use. The prefix only ever added an earlier failure for an exchange that
   * could not have succeeded anyway, so it is dropped rather than rebuilt.
   */
  hooks?: {
    afterSignIn?(info: { userId: string; provider: string | null }): Promise<void>;
  };
}

export interface KitAuth<P> {
  /** Web-standard handler: `(Request) => Response`. Any runtime. */
  handler(request: Request): Promise<Response>;
  /** Encapsulated Fastify plugin — its own body parser, nothing global. */
  fastifyPlugin: AuthFastifyPlugin;
  /** The product's principal, or `null`. */
  getPrincipal(headers: Headers): Promise<P | null>;
  /** The caller's devices, without the raw tokens the library would include. */
  listSessions(headers: Headers): Promise<AuthSessionInfo[]>;
  /** Revoke one of the caller's own sessions BY ID. `false` — not theirs, or gone. */
  revokeSession(headers: Headers, sessionId: string): Promise<boolean>;
  /** SQL files to apply, in order, before the product's own. */
  migrations: string[];
  /** The library instance, for the few things a product legitimately needs (`auth.api.*`). */
  instance: ReturnType<typeof betterAuth>;
}

const BASE_PATH = '/api/account';
const DEFAULT_LINK_MINUTES = 15;
/** The one route that carries a typed password AND ends in a session. */
const SIGN_IN_PASSWORD_PATH = '/sign-in/email';

/**
 * What `rewriteLegacyHash` needs out of the middleware context, named because
 * `createAuthMiddleware` types `ctx` from a static options object and ours is
 * assembled from what the product asked for — the same reason the tests narrow
 * `instance.api`. Every field here is read straight from Better Auth 1.7.4 and
 * is covered by `test/auth-legacy-password.test.ts`.
 */
interface RewriteContext {
  body?: { password?: unknown };
  context: {
    newSession: { user: { id: string } } | null;
    internalAdapter: {
      findCredentialAccount(userId: string): Promise<{ password?: string | null } | null>;
      updatePassword(userId: string, password: string): Promise<void>;
    };
    logger: { error(message: string, ...rest: unknown[]): void };
  };
}

/**
 * Put the row this sign-in came from into `scrypt$`.
 *
 * **Why this is not inside `emailAndPassword.password.verify`.** The library
 * hands that callback `{ password, hash }` and nothing else — no user id, no
 * context, no adapter. It is asked the question "does this string match this
 * hash", and a function that only ever sees those two strings cannot write a
 * row. So the bridge needs a second seam, and this is the only place in 1.7.4
 * that has all three halves at once: the typed password (`ctx.body`), the
 * identity (`ctx.context.newSession`), and the write
 * (`internalAdapter.updatePassword`). The alternatives were weighed and are in
 * the README; the short version is that `databaseHooks` never see a plaintext
 * password, and `ctx.context.password.checkPassword` is built into the context
 * rather than read from the options, so it is not a seam at all.
 *
 * **Why re-reading the row is the whole correlation.** Nothing is carried over
 * from `verify` — no marker, no shared map keyed by a hash. A sign-in that
 * reached a session proves the password matched, so a stored string that is
 * still foreign AT THIS POINT is one the product's own reader just accepted.
 * That makes the decision stateless, and two people signing in at the same
 * moment cannot be confused for each other.
 *
 * The cost is one indexed SELECT per password sign-in for as long as the
 * option is configured, and it is charged only to products that configured it.
 *
 * Two deliberate silences:
 *  - The after hooks also run when the endpoint THREW (dispatch.mjs keeps the
 *    `APIError` as the response and runs them anyway), so `newSession` is the
 *    success test. A wrong password rewrites nothing.
 *  - A failed write is logged and swallowed. The person is already
 *    authenticated; turning their successful login into a 500 to report that
 *    the NEXT one will also be slow is the wrong trade. `newSession` is also
 *    null while a 2FA challenge is in flight — the person has no session yet,
 *    and their row is rewritten on the sign-in that gives them one.
 */
async function rewriteLegacyHash(ctx: RewriteContext): Promise<void> {
  const session = ctx.context.newSession;
  if (!session) return;
  const password = ctx.body?.password;
  if (typeof password !== 'string' || password === '') return;
  try {
    const account = await ctx.context.internalAdapter.findCredentialAccount(session.user.id);
    const stored = account?.password;
    if (typeof stored !== 'string' || stored === '' || isKitPasswordHash(stored)) return;
    await ctx.context.internalAdapter.updatePassword(session.user.id, await hashPassword(password));
  } catch (error) {
    ctx.context.logger.error('kit/auth: could not rewrite a legacy password hash', error);
  }
}

/** `filebrowser_session` → `filebrowser`, so every other cookie is ours too. */
function cookiePrefixFrom(cookieName: string): string {
  const trimmed = cookieName.replace(/[_.-]?session(_token)?$/i, '');
  return trimmed || cookieName;
}

/**
 * The exact options object this module fixes.
 *
 * Exported so the kit's own tests can bolt a fake OAuth provider onto the real
 * policy instead of asserting against a copy of it, and so a product can read
 * what it got. **Not a seam for adding plugins in production** — anything added
 * here is outside everything this file promises.
 */
export function buildAuthOptions<P>(o: CreateAuthOptions<P>): BetterAuthOptions {
  const email = o.email;
  const linkMinutes = email?.linkMinutes ?? DEFAULT_LINK_MINUTES;
  const passwordOn = email?.password === true;

  if (passwordOn && !(email?.letters.verifyEmail && email?.letters.resetPassword)) {
    // Fixed decision 3. A password without a verification letter is the
    // scenario where the first magic link silently deletes it, so this is a
    // wiring mistake and says so at construction rather than at 3 a.m.
    throw new Error(
      'kit/auth: email.password requires email.letters.verifyEmail and email.letters.resetPassword ' +
        '(a password beside a magic link needs verification at sign-up — sandbox report §3.12)',
    );
  }

  const legacyPassword = email?.legacyPassword;
  if (legacyPassword && !passwordOn) {
    // A reader for the old format, on a login that publishes no password route
    // at all: nothing would ever call it, and the product would read the option
    // as proof its old users can still get in.
    throw new Error(
      'kit/auth: email.legacyPassword requires email.password (nothing verifies a password ' +
        'when the password routes are off)',
    );
  }

  const addressLimit: AddressLimit | null = email?.perAddressLimit
    ? createAddressLimit({ ...email.perAddressLimit, storage: o.rateLimitStorage ?? null })
    : null;

  /** Paths that spend somebody else's mailbox. The address ceiling guards these. */
  const MAIL_PATHS = new Set([
    '/sign-in/magic-link',
    '/send-verification-email',
    '/request-password-reset',
    '/forget-password',
  ]);

  const socialProviders: Record<string, AuthProviderKeys> = {};
  if (o.providers.github) socialProviders.github = o.providers.github;
  if (o.providers.google) socialProviders.google = o.providers.google;

  const plugins: unknown[] = [];
  if (email) {
    plugins.push(
      magicLink({
        expiresIn: linkMinutes * 60,
        sendMagicLink: async ({ email: to, url, token }) => {
          const letter = email.letters.magicLink({ url, token }, linkMinutes);
          await email.send(to, letter.subject, letter.text);
        },
      }),
    );
  }
  // Each plugin carries its OWN schema, and `options.user.fields` does not
  // reach into it — so the rename travels per plugin or the library writes
  // camelCase columns beside ours. See `TWO_FACTOR_USER_FIELDS`.
  if (o.totp) {
    plugins.push(
      twoFactor({
        issuer: o.totp.issuer,
        schema: {
          user: { fields: TWO_FACTOR_USER_FIELDS },
          twoFactor: { modelName: MODEL_NAMES.twoFactor, fields: TWO_FACTOR_FIELDS },
        },
      }),
    );
  }
  if (o.admin) {
    plugins.push(
      adminPlugin({
        schema: {
          user: { fields: ADMIN_USER_FIELDS },
          session: { fields: ADMIN_SESSION_FIELDS },
        },
      }),
    );
  }
  // customSession LAST: it wraps /get-session, and a plugin registered after it
  // would not be reflected in what that route answers.
  plugins.push(
    customSession(async ({ user, session }) => {
      const principal = await o.resolvePrincipal(user.id, session as unknown as AuthSession);
      return { principal, user, session };
    }),
  );

  const options: BetterAuthOptions = {
    appName: o.totp?.issuer ?? new URL(o.baseUrl).host,
    secret: o.secret(),
    baseURL: o.baseUrl,
    basePath: BASE_PATH,
    database: o.db as BetterAuthOptions['database'],
    trustedOrigins: [o.baseUrl],

    advanced: {
      // FIXED 5. Also makes the library's own generator emit `uuid` columns.
      database: { generateId: 'uuid' },
      cookiePrefix: cookiePrefixFrom(o.cookieName),
      cookies: { session_token: { name: o.cookieName } },
      // FIXED 2. `secure` arrives as a flag; guessing it costs an open cookie
      // on the day the product is reached over http once.
      defaultCookieAttributes: {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        secure: o.secureCookie,
      },
      ...(o.trustedProxies?.length ? { ipAddress: { trustedProxies: o.trustedProxies } } : {}),
    },

    // FIXED 1 — the whole reason this wrapper exists.
    account: {
      accountLinking: {
        enabled: true,
        trustedProviders: [],
        requireLocalEmailVerified: true,
      },
      modelName: MODEL_NAMES.account,
      fields: IDENTITY_FIELDS,
    },

    session: {
      modelName: MODEL_NAMES.session,
      fields: SESSION_FIELDS,
      expiresIn: o.sessionDays * 86_400,
      // FIXED 6a. An admin taking a permission away must take effect on the
      // next request; a cookie-cached session answers from the cookie for as
      // long as the cache lives, and the product's old `invalidateUserCache`
      // had no way to reach inside a browser.
      cookieCache: { enabled: false },
    },

    user: {
      modelName: MODEL_NAMES.user,
      fields: USER_FIELDS,
      additionalFields: {
        // auth.md keeps a short handle apart from a display name; the library
        // has only `name`, so the column is declared here and filled below.
        login: { type: 'string', required: false, input: false },
      },
    },

    verification: { modelName: MODEL_NAMES.verification, fields: VERIFICATION_FIELDS },

    emailAndPassword: passwordOn
      ? {
          enabled: true,
          // FIXED 3.
          requireEmailVerification: true,
          // FIXED 4 — one hash format across the portfolio, and exointel's
          // live rows are accepted as they stand. `legacyPassword` is asked
          // SECOND and only about a string `scrypt$` does not claim; the row it
          // accepts is rewritten in `rewriteLegacyHash` below, which is the
          // half this callback cannot do — see its comment.
          password: {
            hash: hashPassword,
            verify: async ({ hash, password }) => {
              if (await verifyPassword(password, hash)) return true;
              if (!legacyPassword || isKitPasswordHash(hash)) return false;
              try {
                return await legacyPassword.verify({ password, hash });
              } catch {
                // A string the product's own reader cannot read is not a
                // verified password, and it is also not everybody's 500.
                return false;
              }
            },
          },
          sendResetPassword: async ({ user, url, token }) => {
            const letter = email!.letters.resetPassword!({ url, token }, linkMinutes);
            await email!.send(user.email, letter.subject, letter.text);
          },
        }
      : { enabled: false },

    ...(passwordOn
      ? {
          emailVerification: {
            sendOnSignUp: true,
            autoSignInAfterVerification: false,
            sendVerificationEmail: async ({ user, url, token }) => {
              const letter = email!.letters.verifyEmail!({ url, token }, linkMinutes);
              await email!.send(user.email, letter.subject, letter.text);
            },
          },
        }
      : {}),

    socialProviders,
    plugins: plugins as BetterAuthOptions['plugins'],

    rateLimit: {
      enabled: true,
      ...(o.rateLimitStorage ? { customStorage: o.rateLimitStorage } : {}),
    },

    // FIXED 6b. The route the cabinet used to call is gone from HTTP entirely;
    // `listSessions` below answers it without the tokens. `auth.api.*` is
    // unaffected, which is how the replacement reads them.
    disabledPaths: ['/list-sessions'],

    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            const data = user as Record<string, unknown>;
            const patch: Record<string, unknown> = {};
            // The library lowercases every address it LOOKS UP and every one
            // that sign-up writes — but `magic-link` creates a user with the
            // string as typed. A first-ever link from `Alice@x` then lands a
            // row that no later lookup can find, and the next link makes a
            // second account. Normalizing here closes that for every path at
            // once, and makes the `lower(email)` index in the migration a
            // guarantee rather than a hope.
            if (typeof data.email === 'string') patch.email = data.email.trim().toLowerCase();
            if (!data.login) {
              const login = loginFor({ ...data, ...patch });
              if (login) patch.login = login;
            }
            return { data: { ...data, ...patch } };
          },
        },
      },
    },

    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (addressLimit && MAIL_PATHS.has(ctx.path)) {
          const body = ctx.body as { email?: unknown } | undefined;
          const to = typeof body?.email === 'string' ? body.email : '';
          if (to && !(await addressLimit.allow(to))) {
            // Says nothing about whether the account exists — the ceiling is
            // about the address the caller typed, so it is not an oracle.
            throw new APIError('TOO_MANY_REQUESTS', {
              message: 'Too many requests for this address.',
              code: 'TOO_MANY_REQUESTS',
            });
          }
        }
      }),
      after:
        o.hooks?.afterSignIn || legacyPassword
          ? createAuthMiddleware(async (ctx) => {
              if (legacyPassword && ctx.path === SIGN_IN_PASSWORD_PATH) {
                await rewriteLegacyHash(ctx as unknown as RewriteContext);
              }
              const session = ctx.context.newSession;
              if (!session) return;
              if (!o.hooks?.afterSignIn) return;
              await o.hooks.afterSignIn({
                userId: session.user.id,
                provider: ctx.path.startsWith('/callback/') ? ctx.path.slice('/callback/'.length) : null,
              });
            })
          : undefined,
    },
  };

  return options;
}

/**
 * Build the product's login.
 *
 *     const auth = createAuth({
 *       db: pool, secret: () => env.sessionSecret, baseUrl: env.siteUrl,
 *       cookieName: 'filebrowser_session', secureCookie: env.secureCookie,
 *       sessionDays: 30, providers: { }, email: { send, letters },
 *       resolvePrincipal: (userId) => principalOf(userId),
 *     });
 *     app.register(auth.fastifyPlugin);
 */
export function createAuth<P>(o: CreateAuthOptions<P>): KitAuth<P> {
  const options = buildAuthOptions(o);
  const instance = betterAuth(options);

  async function rawSessions(headers: Headers) {
    const rows = await instance.api.listSessions({ headers });
    return (rows ?? []) as unknown as {
      id: string;
      token: string;
      ip?: string | null;
      ipAddress?: string | null;
      userAgent?: string | null;
      createdAt: Date | string;
      expiresAt: Date | string;
    }[];
  }

  const iso = (value: Date | string) => new Date(value).toISOString();

  async function currentSessionId(headers: Headers): Promise<string | null> {
    const current = await instance.api.getSession({ headers });
    const session = (current as { session?: { id?: string } } | null)?.session;
    return session?.id ?? null;
  }

  const kit: KitAuth<P> = {
    handler: (request) => instance.handler(request),
    // Replaced just below, once the three functions it closes over exist.
    fastifyPlugin: (async () => {}) as AuthFastifyPlugin,

    async getPrincipal(headers) {
      const result = await instance.api.getSession({ headers });
      return ((result as { principal?: P } | null)?.principal ?? null) as P | null;
    },

    async listSessions(headers) {
      const [rows, currentId] = await Promise.all([rawSessions(headers), currentSessionId(headers)]);
      // `token` is dropped here and nowhere else is it read out: the HTTP route
      // that would have carried it is in `disabledPaths`.
      return rows.map((row) => ({
        id: row.id,
        ip: row.ip ?? row.ipAddress ?? null,
        userAgent: row.userAgent ?? null,
        createdAt: iso(row.createdAt),
        expiresAt: iso(row.expiresAt),
        current: row.id === currentId,
      }));
    },

    async revokeSession(headers, sessionId) {
      // By id, because the cabinet never saw a token. The list is already
      // scoped to the caller, so looking the token up in it is the whole
      // authorization check: an id belonging to somebody else is simply absent.
      const rows = await rawSessions(headers);
      const match = rows.find((row) => row.id === sessionId);
      if (!match) return false;
      await instance.api.revokeSession({ headers, body: { token: match.token } });
      return true;
    },

    migrations: authMigrations({ totp: o.totp !== undefined, admin: o.admin === true }),
    instance,
  };

  kit.fastifyPlugin = createAuthFastifyPlugin({
    basePath: BASE_PATH,
    baseUrl: o.baseUrl,
    handler: kit.handler,
    listSessions: kit.listSessions,
    revokeSession: kit.revokeSession,
  });

  return kit;
}
