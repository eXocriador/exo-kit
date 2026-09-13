/**
 * The SQL `@exo/kit/auth` ships, as a list of paths — and nothing else in the
 * file.
 *
 * Its own module, with no import of `better-auth`, because both callers need
 * exactly that. A migration runner wants three file names: reading them
 * through `createAuth` hands `betterAuth` a database it immediately tries to
 * connect to, and a script whose whole job was to read file names dies with
 * `Failed to initialize database adapter` (paid for by a deploy). The
 * `exo-kit-migrations` CLI wants the same list in a product image where
 * `better-auth` is a peer dependency that may not be installed at all.
 */
/**
 * The SQL files this module ships, in the order they must be applied.
 *
 * Both optional files are gated on the option that needs them: a product with
 * no second factor should not carry a `two_factor` table, and the `admin`
 * plugin's four columns on `users` are dead weight — and a lie about what the
 * product does — anywhere it is off. Pass the same flags the product passes to
 * `createAuth`, or read `auth.migrations`, which is this with them filled in.
 */
export function authMigrations(options = {}) {
    const dir = new URL('../../migrations/auth/', import.meta.url);
    const files = [
        '20200101000001_kit_auth.sql',
        ...(options.totp ? ['20200101000002_kit_auth_2fa.sql'] : []),
        ...(options.admin ? ['20200101000003_kit_auth_admin.sql'] : []),
    ];
    return files.map((file) => new URL(file, dir).pathname);
}
//# sourceMappingURL=migrations.js.map