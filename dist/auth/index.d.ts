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
import { betterAuth, type BetterAuthOptions } from 'better-auth';
import { type AuthRateLimitStorage } from './rate-limit.js';
import { type AuthFastifyPlugin } from './fastify.js';
export { createAuthRateLimitStorage, createAddressLimit, type AuthRateLimitStorage, type AuthRateLimitRule, type AuthRateLimitDecision, type AuthRateLimitRedis, type AddressLimit, } from './rate-limit.js';
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
        magicLink(link: {
            url: string;
            token: string;
        }, minutes: number): AuthLetter;
        /** Required when `password` is on — sign-up sends this before a session exists. */
        verifyEmail?(link: {
            url: string;
            token: string;
        }, minutes: number): AuthLetter;
        /** Required when `password` is on. */
        resetPassword?(link: {
            url: string;
            token: string;
        }, minutes: number): AuthLetter;
    };
    /** How long a link lives. Default 15 minutes — on its own life it equals a password. */
    linkMinutes?: number;
    /**
     * The ceiling on letters to ONE address — `{ max: 3, windowMs: 900_000 }` is
     * what the products used. Keep it: Better Auth's own limiter counts IP, and
     * an IP ceiling does not protect a stranger's mailbox from whoever changes
     * IP. Omitted means no address ceiling, which is a choice, not a default.
     */
    perAddressLimit?: {
        max: number;
        windowMs: number;
    };
    /**
     * A password beside the link. Off by default, and that is not timidity: a
     * product with no password UI would otherwise publish `/sign-up/email` and
     * `/sign-in/email`, and the owner who chose links-only would have an open
     * registration endpoint nobody decided on.
     */
    password?: boolean;
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
    totp?: {
        issuer: string;
    };
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
        afterSignIn?(info: {
            userId: string;
            provider: string | null;
        }): Promise<void>;
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
/**
 * The exact options object this module fixes.
 *
 * Exported so the kit's own tests can bolt a fake OAuth provider onto the real
 * policy instead of asserting against a copy of it, and so a product can read
 * what it got. **Not a seam for adding plugins in production** — anything added
 * here is outside everything this file promises.
 */
export declare function buildAuthOptions<P>(o: CreateAuthOptions<P>): BetterAuthOptions;
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
export declare function createAuth<P>(o: CreateAuthOptions<P>): KitAuth<P>;
//# sourceMappingURL=index.d.ts.map