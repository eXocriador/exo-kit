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
 * ── A product on Prisma ──
 * Two products run `prisma migrate deploy` instead, and a byte copy is wrong
 * for them twice over. Prisma reads `<dir>/<name>/migration.sql`, not flat
 * files; and it applies a file WHOLE, where dbmate reads only the half between
 * its markers — so the `-- migrate:down` block, which in every kit file raises
 * on purpose, runs too and fails the migration on the kit's own guard.
 * `format: 'prisma'` writes that layout with the `migrate:up` half only, and
 * `check` compares against the same rendering, so the gate still means
 * something.
 *
 * ── What importing this pulls in ──
 * `node:fs` and `node:path`. No database driver, no dbmate, no network: this
 * module never applies a migration and never opens a connection.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, } from 'node:fs';
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
export function migrationVersion(file) {
    const name = basename(file);
    const digits = /^(\d+)/.exec(name);
    if (!digits) {
        throw new Error(`migration file name must start with a version (digits): ${name}. ` +
            'dbmate records that number and orders by it, across every -d directory at once.');
    }
    return digits[1];
}
/**
 * The date every kit migration's version starts with — an ordering floor,
 * not a day (README, "File names are an ordering floor"). In `prisma` format it
 * is also how a kit copy is told apart from a product's migration in the one
 * directory they share.
 */
export const KIT_VERSION_FLOOR = '20200101';
/**
 * The `-- migrate:up` half of a dbmate migration: from the marker line up to,
 * not including, `-- migrate:down` — the half a runner that cannot read the
 * markers must be given on its own.
 *
 * @throws when there is no `-- migrate:up` line: there is no half to take, and
 * the whole file is not a safe guess.
 */
export function migrateUpHalf(text, name = 'migration') {
    const up = /^-- migrate:up\b.*$/m.exec(text);
    if (!up)
        throw new Error(`${name}: no "-- migrate:up" line — nothing to take the up half of`);
    const rest = text.slice(up.index);
    const down = /^-- migrate:down\b.*$/m.exec(rest);
    return down ? rest.slice(0, down.index) : rest;
}
function renderPrisma(source, name) {
    // The header names neither marker: a copy that contained the word for the
    // half it left out would be one grep away from looking like it kept it.
    const header = `-- ${name} from @exo/kit, apply half only. Prisma runs a file whole, and the kit's\n` +
        `-- rollback half refuses by raising. Written by exo-kit-migrations; edit the kit, not this.\n`;
    return Buffer.from(header + migrateUpHalf(readFileSync(source, 'utf8'), name), 'utf8');
}
function formatOf(options) {
    const format = options.format ?? 'dbmate';
    if (format !== 'dbmate' && format !== 'prisma') {
        throw new Error(`unknown migration format: ${String(format)} (expected dbmate or prisma)`);
    }
    return format;
}
function packageFiles(files) {
    const out = new Map();
    for (const path of files) {
        const name = basename(path);
        migrationVersion(name);
        if (out.has(name))
            throw new Error(`two migrations named ${name} in the same list`);
        out.set(name, resolve(path));
    }
    return out;
}
function isDirectory(dir) {
    try {
        if (!statSync(dir).isDirectory())
            throw new Error(`${dir} is not a directory`);
        return true;
    }
    catch (err) {
        if (err.code === 'ENOENT')
            return false;
        throw err;
    }
}
/** Kit file names the product holds a copy of, in the given format. */
function vendoredNames(dir, format) {
    if (!isDirectory(dir))
        return [];
    if (format === 'dbmate') {
        return readdirSync(dir)
            .filter((name) => name.endsWith('.sql'))
            .sort();
    }
    return readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name.startsWith(KIT_VERSION_FLOOR))
        .map((entry) => `${entry.name}.sql`)
        .sort();
}
/** Where the copy of kit file `name` lives. */
function targetOf(dir, name, format) {
    return format === 'dbmate' ? join(dir, name) : join(dir, name.replace(/\.sql$/, ''), 'migration.sql');
}
/** What the copy of `source` must contain, byte for byte. */
function expectedBytes(source, name, format) {
    return format === 'dbmate' ? readFileSync(source) : renderPrisma(source, name);
}
/**
 * Compare the copies in `dir` against the files the package ships.
 *
 * Byte comparison, not a checksum file: a checksum is a third thing to keep
 * honest, and these files are small enough that reading both sides costs
 * nothing. Nothing is written and nothing is fixed — that is `sync`'s job, and
 * a gate that repaired what it was measuring would always pass.
 */
export function checkKitMigrations(options) {
    const format = formatOf(options);
    const shipped = packageFiles(options.files);
    const present = new Set(vendoredNames(options.dir, format));
    const names = [...new Set([...shipped.keys(), ...present])].sort();
    const files = [];
    const problems = [];
    for (const name of names) {
        const source = shipped.get(name);
        const target = targetOf(options.dir, name, format);
        let state;
        if (!source) {
            state = 'extra';
            problems.push(`${name}: in ${options.dir}, not shipped by the kit for this configuration — ` +
                'a block turned off since the copy was made, or a file the kit renamed. ' +
                `${format === 'dbmate' ? 'dbmate' : 'Prisma'} applies it anyway.`);
        }
        else if (!present.has(name) || !existsSync(target)) {
            state = 'missing';
            problems.push(`${name}: shipped by the kit, missing from ${options.dir}. Run \`sync\`.`);
        }
        else if (expectedBytes(source, name, format).equals(readFileSync(target))) {
            state = 'same';
        }
        else {
            state = 'changed';
            problems.push(`${name}: the copy in ${options.dir} differs from the installed @exo/kit. ` +
                'Edit the file in the kit, then run `sync`; a copy edited in place is a ' +
                'second truth about the schema and the next kit release overwrites it.');
        }
        files.push({ name, version: migrationVersion(name), state });
    }
    return { ok: problems.length === 0, files, problems };
}
/**
 * Copy the package's SQL into the product's tree, and report what changed.
 *
 * Leftovers (`extra`) are reported, never deleted: a file the product has
 * already applied on a live database is not garbage, and dropping it here
 * would quietly change what a fresh database gets. Removing one is a decision
 * with a database behind it, so it stays a person's.
 */
export function syncKitMigrations(options) {
    const format = formatOf(options);
    const before = checkKitMigrations(options);
    const shipped = packageFiles(options.files);
    const written = [];
    mkdirSync(options.dir, { recursive: true });
    for (const file of before.files) {
        if (file.state !== 'missing' && file.state !== 'changed')
            continue;
        const source = shipped.get(file.name);
        if (!source)
            continue;
        const target = targetOf(options.dir, file.name, format);
        if (format === 'dbmate') {
            copyFileSync(source, target);
        }
        else {
            mkdirSync(join(target, '..'), { recursive: true });
            writeFileSync(target, renderPrisma(source, file.name));
        }
        written.push(file.name);
    }
    return { ...checkKitMigrations(options), written };
}
//# sourceMappingURL=index.js.map