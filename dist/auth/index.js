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
import { betterAuth, APIError } from 'better-auth';
import { createAuthMiddleware } from 'better-auth/api';
import { admin as adminPlugin } from 'better-auth/plugins/admin';
import { customSession } from 'better-auth/plugins/custom-session';
import { magicLink } from 'better-auth/plugins/magic-link';
import { twoFactor } from 'better-auth/plugins/two-factor';
import { hashPassword, isKitPasswordHash, verifyPassword } from '../auth-core/password.js';
import { createAddressLimit, } from './rate-limit.js';
import { createAuthFastifyPlugin } from './fastify.js';
import { authMigrations } from './migrations.js';
import { ADMIN_SESSION_FIELDS, ADMIN_USER_FIELDS, IDENTITY_FIELDS, MODEL_NAMES, SESSION_FIELDS, TWO_FACTOR_FIELDS, TWO_FACTOR_USER_FIELDS, USER_FIELDS, VERIFICATION_FIELDS, loginFor, } from './schema.js';
export { createAuthRateLimitStorage, createAddressLimit, } from './rate-limit.js';
export { MODEL_NAMES, loginFor } from './schema.js';
export { createAuthFastifyPlugin } from './fastify.js';
export { authMigrations } from './migrations.js';
const BASE_PATH = '/api/account';
const DEFAULT_LINK_MINUTES = 15;
/** The one route that carries a typed password AND ends in a session. */
const SIGN_IN_PASSWORD_PATH = '/sign-in/email';
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
async function rewriteLegacyHash(ctx) {
    const session = ctx.context.newSession;
    if (!session)
        return;
    const password = ctx.body?.password;
    if (typeof password !== 'string' || password === '')
        return;
    try {
        const account = await ctx.context.internalAdapter.findCredentialAccount(session.user.id);
        const stored = account?.password;
        if (typeof stored !== 'string' || stored === '' || isKitPasswordHash(stored))
            return;
        await ctx.context.internalAdapter.updatePassword(session.user.id, await hashPassword(password));
    }
    catch (error) {
        ctx.context.logger.error('kit/auth: could not rewrite a legacy password hash', error);
    }
}
/** `filebrowser_session` → `filebrowser`, so every other cookie is ours too. */
function cookiePrefixFrom(cookieName) {
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
export function buildAuthOptions(o) {
    const email = o.email;
    const linkMinutes = email?.linkMinutes ?? DEFAULT_LINK_MINUTES;
    const passwordOn = email?.password === true;
    if (passwordOn && !(email?.letters.verifyEmail && email?.letters.resetPassword)) {
        // Fixed decision 3. A password without a verification letter is the
        // scenario where the first magic link silently deletes it, so this is a
        // wiring mistake and says so at construction rather than at 3 a.m.
        throw new Error('kit/auth: email.password requires email.letters.verifyEmail and email.letters.resetPassword ' +
            '(a password beside a magic link needs verification at sign-up — sandbox report §3.12)');
    }
    const legacyPassword = email?.legacyPassword;
    if (legacyPassword && !passwordOn) {
        // A reader for the old format, on a login that publishes no password route
        // at all: nothing would ever call it, and the product would read the option
        // as proof its old users can still get in.
        throw new Error('kit/auth: email.legacyPassword requires email.password (nothing verifies a password ' +
            'when the password routes are off)');
    }
    const addressLimit = email?.perAddressLimit
        ? createAddressLimit({ ...email.perAddressLimit, storage: o.rateLimitStorage ?? null })
        : null;
    /** Paths that spend somebody else's mailbox. The address ceiling guards these. */
    const MAIL_PATHS = new Set([
        '/sign-in/magic-link',
        '/send-verification-email',
        '/request-password-reset',
        '/forget-password',
    ]);
    const socialProviders = {};
    if (o.providers.github)
        socialProviders.github = o.providers.github;
    if (o.providers.google)
        socialProviders.google = o.providers.google;
    const plugins = [];
    if (email) {
        plugins.push(magicLink({
            expiresIn: linkMinutes * 60,
            // The row in `verification` is SHA-256 (base64url) of the token, not
            // the token: a dump of the table stops being a list of working login
            // links. The library hashes the incoming token before its lookup, so
            // nothing else changes and nothing costs more. Not a parameter — it is
            // the property `login_tokens` had before this module replaced it.
            storeToken: 'hashed',
            sendMagicLink: async ({ email: to, url, token }) => {
                const letter = email.letters.magicLink({ url, token }, linkMinutes);
                await email.send(to, letter.subject, letter.text);
            },
        }));
    }
    // Each plugin carries its OWN schema, and `options.user.fields` does not
    // reach into it — so the rename travels per plugin or the library writes
    // camelCase columns beside ours. See `TWO_FACTOR_USER_FIELDS`.
    if (o.totp) {
        plugins.push(twoFactor({
            issuer: o.totp.issuer,
            schema: {
                user: { fields: TWO_FACTOR_USER_FIELDS },
                twoFactor: { modelName: MODEL_NAMES.twoFactor, fields: TWO_FACTOR_FIELDS },
            },
        }));
    }
    if (o.admin) {
        plugins.push(adminPlugin({
            schema: {
                user: { fields: ADMIN_USER_FIELDS },
                session: { fields: ADMIN_SESSION_FIELDS },
            },
        }));
    }
    // customSession LAST: it wraps /get-session, and a plugin registered after it
    // would not be reflected in what that route answers.
    plugins.push(customSession(async ({ user, session }) => {
        const principal = await o.resolvePrincipal(user.id, session);
        return { principal, user, session };
    }));
    const options = {
        appName: o.totp?.issuer ?? new URL(o.baseUrl).host,
        secret: o.secret(),
        baseURL: o.baseUrl,
        basePath: BASE_PATH,
        database: o.db,
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
                        if (await verifyPassword(password, hash))
                            return true;
                        if (!legacyPassword || isKitPasswordHash(hash))
                            return false;
                        try {
                            return await legacyPassword.verify({ password, hash });
                        }
                        catch {
                            // A string the product's own reader cannot read is not a
                            // verified password, and it is also not everybody's 500.
                            return false;
                        }
                    },
                },
                sendResetPassword: async ({ user, url, token }) => {
                    const letter = email.letters.resetPassword({ url, token }, linkMinutes);
                    await email.send(user.email, letter.subject, letter.text);
                },
            }
            : { enabled: false },
        ...(passwordOn
            ? {
                emailVerification: {
                    sendOnSignUp: true,
                    autoSignInAfterVerification: false,
                    sendVerificationEmail: async ({ user, url, token }) => {
                        const letter = email.letters.verifyEmail({ url, token }, linkMinutes);
                        await email.send(user.email, letter.subject, letter.text);
                    },
                },
            }
            : {}),
        socialProviders,
        plugins: plugins,
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
                        const data = user;
                        const patch = {};
                        // The library lowercases every address it LOOKS UP and every one
                        // that sign-up writes — but `magic-link` creates a user with the
                        // string as typed. A first-ever link from `Alice@x` then lands a
                        // row that no later lookup can find, and the next link makes a
                        // second account. Normalizing here closes that for every path at
                        // once, and makes the `lower(email)` index in the migration a
                        // guarantee rather than a hope.
                        if (typeof data.email === 'string')
                            patch.email = data.email.trim().toLowerCase();
                        if (!data.login) {
                            const login = loginFor({ ...data, ...patch });
                            if (login)
                                patch.login = login;
                        }
                        return { data: { ...data, ...patch } };
                    },
                },
            },
        },
        hooks: {
            before: createAuthMiddleware(async (ctx) => {
                if (addressLimit && MAIL_PATHS.has(ctx.path)) {
                    const body = ctx.body;
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
            after: o.hooks?.afterSignIn || legacyPassword
                ? createAuthMiddleware(async (ctx) => {
                    if (legacyPassword && ctx.path === SIGN_IN_PASSWORD_PATH) {
                        await rewriteLegacyHash(ctx);
                    }
                    const session = ctx.context.newSession;
                    if (!session)
                        return;
                    if (!o.hooks?.afterSignIn)
                        return;
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
export function createAuth(o) {
    const options = buildAuthOptions(o);
    const instance = betterAuth(options);
    async function rawSessions(headers) {
        const rows = await instance.api.listSessions({ headers });
        return (rows ?? []);
    }
    const iso = (value) => new Date(value).toISOString();
    async function currentSessionId(headers) {
        const current = await instance.api.getSession({ headers });
        const session = current?.session;
        return session?.id ?? null;
    }
    const kit = {
        handler: (request) => instance.handler(request),
        // Replaced just below, once the three functions it closes over exist.
        fastifyPlugin: (async () => { }),
        async getPrincipal(headers) {
            const result = await instance.api.getSession({ headers });
            return (result?.principal ?? null);
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
            if (!match)
                return false;
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
//# sourceMappingURL=index.js.map