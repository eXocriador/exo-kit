#!/usr/bin/env node
// exo-kit-migrations — put the SQL a kit block ships where a migration runner
// can read it, and tell a gate when the copy and the package have drifted apart.
//
//   exo-kit-migrations sync  --dir apps/api/migrations/kit [--totp] [--admin]
//   exo-kit-migrations check --dir apps/api/migrations/kit [--totp] [--admin]
//   exo-kit-migrations check --dir prisma/migrations --format prisma [--totp] [--admin]
//
// `sync` is a person's command (and, one day, a step of `exo upgrade`): run it
// after bumping @exo/kit, commit what it wrote. `check` is a gate's — it writes
// nothing and exits non-zero on any disagreement, which is what belongs in an
// image build.
//
// The flags MUST mirror what the product passes to `createAuth`. They decide
// which files exist at all: a product with no second factor should not carry a
// `two_factor` table, and `--totp` here with `totp` off there vendors a
// migration dbmate will happily apply.
//
// `--format` is which runner reads the copies: `dbmate` (default) gets the
// kit's files byte for byte; `prisma` gets `<dir>/<name>/migration.sql` with
// the `-- migrate:up` half only, because Prisma applies a file whole and the
// kit's down half raises on purpose.
//
// Exit codes: 0 — nothing to complain about; 1 — drift (`check`), or drift that
// `sync` must not fix on its own; 2 — bad usage.

import { authMigrations } from '../dist/auth/migrations.js';
import { checkKitMigrations, syncKitMigrations } from '../dist/migrate/index.js';

const argv = process.argv.slice(2);
const command = argv[0];
const flag = (name) => argv.includes(`--${name}`);
const value = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? undefined : argv[i + 1];
};

const USAGE =
  'usage: exo-kit-migrations <sync|check> --dir <path> [--format dbmate|prisma] [--totp] [--admin]';

if (command !== 'sync' && command !== 'check') {
  console.error(USAGE);
  process.exit(2);
}

const dir = value('dir');
if (!dir) {
  console.error('--dir is required: where the copies live, e.g. apps/api/migrations/kit');
  process.exit(2);
}

const format = value('format') ?? 'dbmate';
if (format !== 'dbmate' && format !== 'prisma') {
  console.error(`--format must be dbmate or prisma, not ${format}\n${USAGE}`);
  process.exit(2);
}

const options = { files: authMigrations({ totp: flag('totp'), admin: flag('admin') }), dir, format };
const result = command === 'sync' ? syncKitMigrations(options) : checkKitMigrations(options);

for (const file of result.files) {
  console.log(`  ${file.state.padEnd(7)} ${file.name}`);
}
if (command === 'sync') {
  console.log(
    result.written.length === 0
      ? '[kit-migrations] up to date — nothing written.'
      : `[kit-migrations] wrote ${result.written.length} file(s) into ${dir} — commit them.`,
  );
}
for (const problem of result.problems) console.error(`[kit-migrations] ${problem}`);

process.exit(result.ok ? 0 : 1);
