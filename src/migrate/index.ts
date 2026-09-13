/**
 * `@exo/kit/migrate` — how a product on this box runs SQL migrations, and the
 * one piece of it that cannot be a shell script.
 *
 * ── What runs the migrations ──
 * dbmate (`amacneil/dbmate`), a single Go binary in its own container. Not a
 * runner in this package: five products had five runners, three of them
 * copies of each other that had already drifted, and the sixth product is
 * Python. A migration runner written in the product's language is a runner
 * per language; a container is a runner per box. `templates/migrate.sh` is
 * the wrapper, and README says what the five traps in it are for.
 *
 * ── What this module is for ──
 * dbmate reads directories. The SQL a kit block ships lives inside an npm
 * package, in a container that has no Node in it and no `node_modules`
 * mounted. Something has to put those files where dbmate can see them, and
 * that something is `syncKitMigrations` — it copies them into the product's
 * tree, byte for byte, under `migrations/kit/`, where the product commits
 * them like any other file.
 *
 * A copy is a second truth about the schema, and this module is shaped around
 * that being the risk: `checkKitMigrations` compares the copies against the
 * installed package and reports every way they can disagree — missing,
 * changed, or a leftover from a block the product has since turned off. It is
 * meant to run as a gate in the product's image build, where the installed
 * package is the pinned version and drift can still be fixed cheaply. The
 * alternative — reading the package at run time — and the reason it was not
 * taken are in the README; the short version is that it makes dbmate's
 * language neutrality, the whole reason it was chosen, conditional on the
 * product being a Node product.
 *
 * ── What importing this pulls in ──
 * `node:fs` and `node:path`. No database driver, no dbmate, no network: this
 * module never applies a migration and never opens a connection.
 */
import { copyFileSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

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
export function migrationVersion(file: string): string {
  const name = basename(file);
  const digits = /^(\d+)/.exec(name);
  if (!digits) {
    throw new Error(
      `migration file name must start with a version (digits): ${name}. ` +
        'dbmate records that number and orders by it, across every -d directory at once.',
    );
  }
  return digits[1]!;
}

/** One file's verdict in {@link checkKitMigrations}. */
export type VendoredState =
  /** The copy is byte-identical to the package's file. */
  | 'same'
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

function packageFiles(files: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const path of files) {
    const name = basename(path);
    migrationVersion(name);
    if (out.has(name)) throw new Error(`two migrations named ${name} in the same list`);
    out.set(name, resolve(path));
  }
  return out;
}

function vendoredNames(dir: string): string[] {
  try {
    if (!statSync(dir).isDirectory()) throw new Error(`${dir} is not a directory`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  return readdirSync(dir)
    .filter((name) => name.endsWith('.sql'))
    .sort();
}

/**
 * Compare the copies in `dir` against the files the package ships.
 *
 * Byte comparison, not a checksum file: a checksum is a third thing to keep
 * honest, and these files are small enough that reading both sides costs
 * nothing. Nothing is written and nothing is fixed — that is `sync`'s job, and
 * a gate that repaired what it was measuring would always pass.
 */
export function checkKitMigrations(options: VendorOptions): CheckResult {
  const shipped = packageFiles(options.files);
  const present = new Set(vendoredNames(options.dir));
  const names = [...new Set([...shipped.keys(), ...present])].sort();

  const files: VendoredFile[] = [];
  const problems: string[] = [];

  for (const name of names) {
    const source = shipped.get(name);
    const target = join(options.dir, name);
    let state: VendoredState;
    if (!source) {
      state = 'extra';
      problems.push(
        `${name}: in ${options.dir}, not shipped by the kit for this configuration — ` +
          'a block turned off since the copy was made, or a file the kit renamed. ' +
          'dbmate applies it anyway.',
      );
    } else if (!present.has(name)) {
      state = 'missing';
      problems.push(`${name}: shipped by the kit, missing from ${options.dir}. Run \`sync\`.`);
    } else if (readFileSync(source).equals(readFileSync(target))) {
      state = 'same';
    } else {
      state = 'changed';
      problems.push(
        `${name}: the copy in ${options.dir} differs from the installed @exo/kit. ` +
          'Edit the file in the kit, then run `sync`; a copy edited in place is a ' +
          'second truth about the schema and the next kit release overwrites it.',
      );
    }
    files.push({ name, version: migrationVersion(name), state });
  }

  return { ok: problems.length === 0, files, problems };
}

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
export function syncKitMigrations(options: VendorOptions): SyncResult {
  const before = checkKitMigrations(options);
  const shipped = packageFiles(options.files);
  const written: string[] = [];

  mkdirSync(options.dir, { recursive: true });
  for (const file of before.files) {
    if (file.state !== 'missing' && file.state !== 'changed') continue;
    const source = shipped.get(file.name);
    if (!source) continue;
    copyFileSync(source, join(options.dir, file.name));
    written.push(file.name);
  }

  return { ...checkKitMigrations(options), written };
}
