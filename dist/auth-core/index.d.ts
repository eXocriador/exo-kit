/**
 * `@exo/kit/auth-core` — the Node half of session auth: scrypt passwords, TOTP,
 * single-use tokens, and the session store.
 *
 * ── The cookie is deliberately NOT here ──
 * `createSessionCookie` lives at `@exo/kit/auth-core/cookie` and imports
 * nothing at all, because an edge proxy verifies a cookie signature and must
 * not be handed `node:crypto` or a Postgres type to do it. Re-exporting it from
 * this barrel would undo that with one line and nothing before the bundler
 * would say so — the same failure `@exo/kit/json` exists to prevent one module
 * over. `test/entry-graph.test.ts` holds both halves to their word.
 *
 * ── What importing this pulls in ──
 * `node:crypto`, and nothing else at runtime. The Postgres types are type-only
 * imports, erased at build.
 */
export { hashPassword, verifyPassword, passwordLengthError, MIN_PASSWORD, MAX_PASSWORD, } from './password.js';
export { generateTotpSecret, totpUri, verifyTotp, generateRecoveryCodes, recoveryCodeHash, } from './totp.js';
export { createAuthTokens } from './tokens.js';
export type { AuthTokens, AuthTokensConfig } from './tokens.js';
export { createSessionStore } from './sessions.js';
export type { SessionStore, SessionStoreConfig, SessionCache, SessionInfo, SessionMeta, } from './sessions.js';
//# sourceMappingURL=index.d.ts.map