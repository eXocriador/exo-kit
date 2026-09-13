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
 *     accepted with no reset (sandbox §3.5).
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
import { hashPassword, verifyPassword } from '../auth-core/password.js';
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
                // live rows are accepted as they stand.
                password: { hash: hashPassword, verify: ({ hash, password }) => verifyPassword(password, hash) },
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
            after: o.hooks?.afterSignIn
                ? createAuthMiddleware(async (ctx) => {
                    const session = ctx.context.newSession;
                    if (!session)
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