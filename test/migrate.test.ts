import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authMigrations } from '../src/auth/migrations.js';
import { checkKitMigrations, migrationVersion, syncKitMigrations } from '../src/migrate/index.js';

let root: string;
let pkg: string;
let dir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kit-migrate-'));
  pkg = join(root, 'package');
  dir = join(root, 'product', 'migrations', 'kit');
  mkdirSync(pkg, { recursive: true });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

/** A file as a block would ship it. */
function ship(name: string, body = `-- migrate:up\nSELECT 1;\n-- migrate:down\nSELECT 1;\n`): string {
  const path = join(pkg, name);
  writeFileSync(path, body);
  return path;
}

describe('migrationVersion', () => {
  it('is the digits the name starts with, not the name', () => {
    // The whole difference between our old runners and dbmate. Recorded once
    // here so the seeding recipe in the README has something to point at.
    expect(migrationVersion('20200101000001_kit_auth.sql')).toBe('20200101000001');
    expect(migrationVersion('/abs/path/20260912080138_auth.sql')).toBe('20260912080138');
  });

  it('refuses a name dbmate could not order', () => {
    // `001_auth.sql` parses (leading digits), but a name with none at all is
    // a file dbmate silently... does not: it errors. Better from a gate.
    expect(() => migrationVersion('auth.sql')).toThrow(/must start with a version/);
  });
});

describe('checkKitMigrations', () => {
  it('is ok when every copy is byte-identical', () => {
    const files = [ship('20200101000001_a.sql'), ship('20200101000002_b.sql')];
    syncKitMigrations({ files, dir });

    const result = checkKitMigrations({ files, dir });
    expect(result.ok).toBe(true);
    expect(result.problems).toEqual([]);
    expect(result.files.map((f) => f.state)).toEqual(['same', 'same']);
    expect(result.files.map((f) => f.version)).toEqual(['20200101000001', '20200101000002']);
  });

  it('reports a missing copy', () => {
    const files = [ship('20200101000001_a.sql')];
    const result = checkKitMigrations({ files, dir });
    expect(result.ok).toBe(false);
    expect(result.files[0]?.state).toBe('missing');
    expect(result.problems[0]).toMatch(/missing from/);
  });

  it('reports a copy edited in place — the second truth this module exists for', () => {
    const files = [ship('20200101000001_a.sql')];
    syncKitMigrations({ files, dir });
    writeFileSync(join(dir, '20200101000001_a.sql'), '-- migrate:up\nDROP TABLE users;\n');

    const result = checkKitMigrations({ files, dir });
    expect(result.ok).toBe(false);
    expect(result.files[0]?.state).toBe('changed');
    expect(result.problems[0]).toMatch(/differs from the installed @exo\/kit/);
  });

  it('reports a leftover from a block that has since been turned off', () => {
    // `totp: true` when the copy was made, `false` now. The file is still in
    // the directory, so dbmate still applies it — the product would carry a
    // `two_factor` table it has no code for.
    const withTotp = [ship('20200101000001_a.sql'), ship('20200101000002_2fa.sql')];
    syncKitMigrations({ files: withTotp, dir });

    const result = checkKitMigrations({ files: [withTotp[0]!], dir });
    expect(result.ok).toBe(false);
    expect(result.files.find((f) => f.name === '20200101000002_2fa.sql')?.state).toBe('extra');
    expect(result.problems[0]).toMatch(/not shipped by the kit for this configuration/);
  });

  it('treats a missing directory as "nothing vendored yet", not an error', () => {
    const files = [ship('20200101000001_a.sql')];
    expect(checkKitMigrations({ files, dir: join(root, 'nowhere') }).files[0]?.state).toBe('missing');
  });

  it('refuses two shipped files with the same name', () => {
    const files = [ship('20200101000001_a.sql'), join(pkg, '20200101000001_a.sql')];
    expect(() => checkKitMigrations({ files, dir })).toThrow(/two migrations named/);
  });
});

describe('syncKitMigrations', () => {
  it('writes what is missing and reports what it wrote', () => {
    const files = [ship('20200101000001_a.sql'), ship('20200101000002_b.sql')];
    const result = syncKitMigrations({ files, dir });

    expect(result.written.sort()).toEqual(['20200101000001_a.sql', '20200101000002_b.sql']);
    expect(result.ok).toBe(true);
    expect(readFileSync(join(dir, '20200101000001_a.sql'), 'utf8')).toBe(
      readFileSync(files[0]!, 'utf8'),
    );
  });

  it('is a no-op the second time', () => {
    const files = [ship('20200101000001_a.sql')];
    syncKitMigrations({ files, dir });
    expect(syncKitMigrations({ files, dir }).written).toEqual([]);
  });

  it('overwrites a copy that drifted', () => {
    const files = [ship('20200101000001_a.sql')];
    syncKitMigrations({ files, dir });
    writeFileSync(join(dir, '20200101000001_a.sql'), 'edited in place\n');

    expect(syncKitMigrations({ files, dir }).written).toEqual(['20200101000001_a.sql']);
    expect(checkKitMigrations({ files, dir }).ok).toBe(true);
  });

  it('never deletes a leftover, and stays not-ok while one is there', () => {
    // A file the product has already applied to a live database is not
    // garbage: deleting it here would quietly change what a fresh database
    // gets, and nothing in this process knows which databases exist.
    const withTotp = [ship('20200101000001_a.sql'), ship('20200101000002_2fa.sql')];
    syncKitMigrations({ files: withTotp, dir });

    const result = syncKitMigrations({ files: [withTotp[0]!], dir });
    expect(readdirSync(dir).sort()).toEqual(['20200101000001_a.sql', '20200101000002_2fa.sql']);
    expect(result.written).toEqual([]);
    expect(result.ok).toBe(false);
  });
});

describe('the SQL @exo/kit/auth actually ships', () => {
  const files = authMigrations({ totp: true, admin: true });

  it('is named the way dbmate orders by, and the floor sorts before any product', () => {
    const names = files.map((f) => f.split('/').pop()!);
    expect(names).toEqual([
      '20200101000001_kit_auth.sql',
      '20200101000002_kit_auth_2fa.sql',
      '20200101000003_kit_auth_admin.sql',
    ]);
    // Not a date: an ordering floor. netwatch's own first migration is
    // 20260828…, filebrowser's is 20260912…, and a kit block has to land
    // before both — dbmate orders across every -d directory at once.
    const versions = files.map(migrationVersion);
    expect(versions).toEqual([...versions].sort());
    expect(Number(versions[versions.length - 1])).toBeLessThan(20260828131448);
  });

  it('carries both markers in every file — dbmate 2.35.1 refuses a file without them', () => {
    // Proven by running it: a file with no `-- migrate:up` dies with "dbmate
    // requires each migration to define an up block", and one with no
    // `-- migrate:down` with the matching sentence — at APPLY time, not at
    // `status`, so a missing marker is found by a deploy unless something
    // like this line finds it first.
    for (const file of files) {
      const body = readFileSync(file, 'utf8');
      expect(body, file).toContain('\n-- migrate:up\n');
      expect(body, file).toContain('\n-- migrate:down\n');
    }
  });

  it('refuses rollback rather than guessing what "undo" means', () => {
    for (const file of files) {
      const down = readFileSync(file, 'utf8').split('\n-- migrate:down\n')[1] ?? '';
      expect(down, file).toMatch(/RAISE EXCEPTION 'no rollback/);
      expect(down, file).not.toMatch(/\bDROP\s+TABLE\b/i);
    }
  });

  it('vendors byte-for-byte, so the copy a product commits is the kit file', () => {
    const result = syncKitMigrations({ files, dir });
    expect(result.ok).toBe(true);
    for (const file of files) {
      const name = file.split('/').pop()!;
      expect(readFileSync(join(dir, name)).equals(readFileSync(file)), name).toBe(true);
    }
  });
});
