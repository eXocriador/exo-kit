/**
 * The version dbmate records for a file: the digits its name starts with.
 *
 * This is the whole accounting key — the rest of the name is a label. Our own
 * runners recorded the file name instead, which is why moving a live database
 * onto dbmate is a rename plus a hand-written seed and not a no-op (README,
 * "Moving a live database onto dbmate").
 *
 * @throws if the name does not start with digits — a file dbmate would refuse
 * to order, and it is better to hear that from a gate than from a deploy.
 */
export declare function migrationVersion(file: string): string;
/** One file's verdict in {@link checkKitMigrations}. */
export type VendoredState = 
/** The copy is byte-identical to the package's file. */
'same'
/** The copy exists and differs — someone edited it, or the kit moved on. */
 | 'changed'
/** The package ships it and the product has no copy. */
 | 'missing'
/**
 * The product has a copy the package does not ship: a block turned off
 * (`totp: false` now, `true` when the copy was made), or a file the kit
 * renamed. Applied already or not, dbmate would keep applying it.
 */
 | 'extra';
export interface VendoredFile {
    /** File name, the same on both sides. */
    name: string;
    /** The version dbmate would record for it. */
    version: string;
    state: VendoredState;
}
export interface CheckResult {
    /** True when every file is `same` — nothing missing, changed or left over. */
    ok: boolean;
    /** Every file involved, package side and product side, sorted by name. */
    files: VendoredFile[];
    /** One line per disagreement, ready to print. Empty when `ok`. */
    problems: string[];
}
export interface VendorOptions {
    /**
     * The SQL the product's blocks ship, as absolute paths — `authMigrations()`
     * with the same flags the product passes to `createAuth`. The flags are the
     * point: a product with no second factor must not carry a `two_factor`
     * table, so the list is built from the product's configuration and never
     * from a directory listing.
     */
    files: string[];
    /**
     * Where the copies live in the product's tree, e.g.
     * `apps/api/migrations/kit`. Created by `sync` if it does not exist; every
     * `.sql` in it is treated as a copy of a kit file, so nothing else belongs
     * there.
     */
    dir: string;
}
/**
 * Compare the copies in `dir` against the files the package ships.
 *
 * Byte comparison, not a checksum file: a checksum is a third thing to keep
 * honest, and these files are small enough that reading both sides costs
 * nothing. Nothing is written and nothing is fixed — that is `sync`'s job, and
 * a gate that repaired what it was measuring would always pass.
 */
export declare function checkKitMigrations(options: VendorOptions): CheckResult;
export interface SyncResult extends CheckResult {
    /** Files written by this call — copied because they were missing or changed. */
    written: string[];
}
/**
 * Copy the package's SQL into the product's tree, and report what changed.
 *
 * Leftovers (`extra`) are reported, never deleted: a file the product has
 * already applied on a live database is not garbage, and dropping it here
 * would quietly change what a fresh database gets. Removing one is a decision
 * with a database behind it, so it stays a person's.
 */
export declare function syncKitMigrations(options: VendorOptions): SyncResult;
//# sourceMappingURL=index.d.ts.map