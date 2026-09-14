import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * `templates/migrate.sh` is the one piece of the migration story that is a
 * shell script, and a product copies it — so a bug here is copied too. These
 * run the real file under bash with a fake `docker` on PATH that records what
 * it was asked to run: the assertions are about the `-e DATABASE_URL=…` the
 * dbmate container would have got, which is the whole of what the template
 * decides.
 *
 * C3 (plan §5): the canonical name is DATABASE_URL, so the template no longer
 * translates POSTGRES_URL. B2-exoanima: the variable's name is the fifth
 * parameter, and MIGRATE_DATABASE_URL — read before `.env` — is how a
 * rehearsal is pointed at a copy without `.env` quietly pointing it back.
 */
const here = dirname(fileURLToPath(import.meta.url));
const TEMPLATE = resolve(here, '../templates/migrate.sh');

let root: string;
let product: string;
let log: string;

const FAKE_DOCKER = `#!/usr/bin/env bash
case "$1" in
  image) exit 0 ;;
  create) echo carrier-1 ;;
  cp) mkdir -p "$3" ;;
  rm) exit 0 ;;
  run) shift; printf '%s\\n' "$@" > "$DOCKER_LOG" ;;
  *) echo "unexpected docker $*" >&2; exit 9 ;;
esac
`;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kit-migrate-sh-'));
  product = join(root, 'product');
  mkdirSync(join(root, 'bin'), { recursive: true });
  mkdirSync(product, { recursive: true });
  writeFileSync(join(root, 'bin', 'docker'), FAKE_DOCKER);
  chmodSync(join(root, 'bin', 'docker'), 0o755);
  copyFileSync(TEMPLATE, join(product, 'migrate.sh'));
  log = join(root, 'docker-run.log');
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function run(dotenv: string, extraEnv: Record<string, string> = {}, arg = 'status') {
  writeFileSync(join(product, '.env'), dotenv);
  const result = spawnSync('bash', [join(product, 'migrate.sh'), arg], {
    encoding: 'utf8',
    // A clean environment on purpose: a MIGRATE_DATABASE_URL in the shell
    // running the suite must not decide what these assertions see.
    env: { PATH: `${join(root, 'bin')}:/usr/bin:/bin`, HOME: root, DOCKER_LOG: log, ...extraEnv },
  });
  const args = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : null;
  const databaseUrl = args?.find((a) => a.startsWith('DATABASE_URL='))?.slice('DATABASE_URL='.length) ?? null;
  return { status: result.status, stderr: result.stderr, args, databaseUrl };
}

/** The template with one of its parameters set the way a product would set it. */
function setParam(name: string, value: string) {
  const path = join(product, 'migrate.sh');
  const text = readFileSync(path, 'utf8');
  const next = text.replace(new RegExp(`^${name}=.*$`, 'm'), `${name}="${value}"`);
  expect(next, `parameter ${name} not found`).not.toBe(text);
  writeFileSync(path, next);
}

describe('templates/migrate.sh', () => {
  it('reads DATABASE_URL — the canonical name — and hands it to dbmate with sslmode', () => {
    const r = run('DATABASE_URL=postgresql://app:pw@postgres:5432/app\n');
    expect(r.status).toBe(0);
    expect(r.databaseUrl).toBe('postgresql://app:pw@postgres:5432/app?sslmode=disable');
    expect(r.args?.at(-1)).toBe('status');
    expect(r.args).toContain('--no-dump-schema');
  });

  it('adds sslmode after an existing query, and leaves one that is already there', () => {
    expect(run('DATABASE_URL=postgresql://a@db/app?application_name=m\n').databaseUrl).toBe(
      'postgresql://a@db/app?application_name=m&sslmode=disable',
    );
    rmSync(log);
    expect(run('DATABASE_URL=postgresql://a@db/app?sslmode=require\n').databaseUrl).toBe(
      'postgresql://a@db/app?sslmode=require',
    );
  });

  it('no longer translates POSTGRES_URL — a product still on it is told, and nothing runs', () => {
    const r = run('POSTGRES_URL=postgresql://app:pw@postgres:5432/app\n');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('DATABASE_URL не задано в .env');
    expect(r.args).toBeNull();
  });

  it('takes the variable name as its fifth parameter, for a product with a prefix', () => {
    setParam('DATABASE_VAR', 'EXOANIMA_DATABASE_URL');
    const r = run('DATABASE_URL=postgresql://wrong@db/other\nEXOANIMA_DATABASE_URL=postgresql://anima@postgres/exoanima\n');
    expect(r.status).toBe(0);
    expect(r.databaseUrl).toBe('postgresql://anima@postgres/exoanima?sslmode=disable');
  });

  it('declares exactly five parameters, and the template says so', () => {
    const text = readFileSync(TEMPLATE, 'utf8');
    for (const name of ['IMAGE', 'IMAGE_WORKDIR', 'MIGRATION_DIRS', 'DBMATE', 'DATABASE_VAR']) {
      expect(text, name).toMatch(new RegExp(`^${name}=`, 'm'));
    }
    expect(text).toContain("різняться лише п'ять змінних нижче");
    expect(text).not.toMatch(/^[^#]*POSTGRES_URL/m);
  });

  describe('MIGRATE_DATABASE_URL — a rehearsal on a copy', () => {
    it('wins over .env, and says out loud that this is not the live database', () => {
      const r = run('DATABASE_URL=postgresql://app:live@postgres/app\n', {
        MIGRATE_DATABASE_URL: 'postgresql://app:copy@postgres/app_copy',
      });
      expect(r.status).toBe(0);
      expect(r.databaseUrl).toBe('postgresql://app:copy@postgres/app_copy?sslmode=disable');
      expect(r.stderr).toContain('УВАГА: MIGRATE_DATABASE_URL задано');
      expect(r.stderr).toContain('postgres/app_copy');
      // The warning names the target, not the credentials in front of it.
      expect(r.stderr).not.toContain('copy@');
    });

    it('cannot be overridden by .env — the trap it exists for', () => {
      // The B2-exoanima rehearsal: the target was exported, `set -a; . ./.env`
      // replaced it, and `status` ran against the live database.
      const r = run(
        'DATABASE_URL=postgresql://app:live@postgres/app\nMIGRATE_DATABASE_URL=postgresql://app:live@postgres/app\n',
        { MIGRATE_DATABASE_URL: 'postgresql://app:copy@postgres/app_copy' },
      );
      expect(r.databaseUrl).toBe('postgresql://app:copy@postgres/app_copy?sslmode=disable');
    });

    it('is not read from .env either — .env names the live database and nothing else', () => {
      const r = run('DATABASE_URL=postgresql://app:live@postgres/app\nMIGRATE_DATABASE_URL=postgresql://x@elsewhere/db\n');
      expect(r.databaseUrl).toBe('postgresql://app:live@postgres/app?sslmode=disable');
      expect(r.stderr).not.toContain('УВАГА');
    });
  });
});
