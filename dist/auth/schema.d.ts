/**
 * Better Auth's five tables under the names `/srv/docs/standards/auth.md`
 * fixed: `users`, `identities`, `sessions`, `verification`, `two_factor`, with
 * snake_case columns.
 *
 * This is a rename, not a translation layer: `modelName` + `fields` are read by
 * the library's own adapter, so every query it builds already carries our
 * names and no row is copied anywhere. Proven by a run against a real Postgres
 * (`/srv/docs/audits/2026-09-12-auth-sandbox.md` §3.1) and held here by
 * `test/auth-schema.test.ts`.
 *
 * Two columns in `users` are ours and not the library's:
 *
 *   * `login` — auth.md keeps a short handle separate from a display `name`,
 *     and Better Auth has only `name`. It arrives as an `additionalFields`
 *     entry so the adapter knows the column exists, and `createAuth` fills it
 *     (see `loginFor`), because nothing in the library ever would.
 *   * `role` is NOT here. A product that wants one declares it itself; the
 *     `admin` plugin adds its own when it is enabled.
 */
/** The field map for one model: library field name → our column name. */
export type FieldMap = Record<string, string>;
export declare const USER_FIELDS: FieldMap;
/**
 * Columns a PLUGIN adds, and why they cannot be renamed in `USER_FIELDS`.
 *
 * `options.user.fields` only renames the fields the core declares. A plugin
 * declares its own, they are merged in afterwards, and the rename has to travel
 * through that plugin's `schema` option instead — otherwise the library writes
 * `twoFactorEnabled` and `banReason` in camelCase beside our snake_case columns
 * and refuses to start with "Database schema mismatch".
 *
 * Found by `test/auth-postgres.test.ts`, which is the only test that can see it:
 * the check runs against an introspected database, so no amount of asserting on
 * the options object would have caught it.
 */
export declare const TWO_FACTOR_USER_FIELDS: FieldMap;
export declare const ADMIN_USER_FIELDS: FieldMap;
export declare const ADMIN_SESSION_FIELDS: FieldMap;
export declare const SESSION_FIELDS: FieldMap;
/**
 * `account` is our `identities`, and the two field names that matter are the
 * pair auth.md calls the identity: `providerId` → `provider`, `accountId` →
 * `provider_id`. Everything else is token bookkeeping the library owns.
 */
export declare const IDENTITY_FIELDS: FieldMap;
export declare const VERIFICATION_FIELDS: FieldMap;
export declare const TWO_FACTOR_FIELDS: FieldMap;
export declare const MODEL_NAMES: {
    readonly user: "users";
    readonly session: "sessions";
    readonly account: "identities";
    readonly verification: "verification";
    readonly twoFactor: "two_factor";
};
/**
 * The short handle for a new account.
 *
 * The address' local part first, because it is what the person typed and what
 * auth.md's own email provider used; the display name only when there is no
 * address at all. Never unique and never searched on — auth.md forbids keying
 * anything on a handle, and two domains share a local part easily.
 */
export declare function loginFor(user: {
    email?: unknown;
    name?: unknown;
}): string | null;
//# sourceMappingURL=schema.d.ts.map