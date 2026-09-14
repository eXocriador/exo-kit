import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * What a subpath drags in with it.
 *
 * `@exo/kit/infra` is a barrel over three unrelated things, and two of them
 * import a database driver. exointel found out the way this kind of thing is
 * always found out: it swapped `lib/json.ts` for `@exo/kit/infra`, every test
 * and `tsc --noEmit` stayed green, and `next build` then failed with
 * `Can't resolve 'net'` — because a module a client component touches now
 * walked into `postgres`. A driver in a browser bundle is a broken build, not
 * a size regression, and nothing before the bundler says a word about it.
 *
 * So the promise each entry makes about its dependencies is pinned here:
 * follow the relative imports from an entry file and collect every bare
 * specifier reachable from it. `@exo/kit/json` must reach none at all — that
 * is the whole reason it exists as a separate entry.
 */
const here = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(here, '../src');

function bareSpecifiers(entry: string): Set<string> {
  const seen = new Set<string>();
  const bare = new Set<string>();
  const walk = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    // Comments come out first, or the usage examples in the doc blocks count
    // as imports — `connector-sdk/index.ts` documents itself with the very
    // `import ... from '@exo/kit/connector-sdk'` line a product writes.
    const source = readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
      // Type-only statements are erased at build, so a bundler never follows
      // them. Both spellings have to go: the lookbehind below catches
      // `import type X from 'p'`, but not `import type { X } from 'p'`, which
      // is the form every one of these files actually uses — `auth-core` types
      // a query runner with `Sql` and would otherwise have claimed to import a
      // database driver it never touches at runtime.
      .replace(/\b(?:import|export)\s+type\s+[^;]*?from\s+'[^']*'/g, '');
    // `from '...'` covers both `import` and `export ... from`, which is what
    // a bundler follows.
    for (const m of source.matchAll(/(?<!\btype\s)\bfrom\s+'([^']+)'/g)) {
      const spec = m[1];
      if (!spec) continue;
      if (!spec.startsWith('.')) {
        bare.add(spec);
        continue;
      }
      const target = resolve(dirname(file), spec.replace(/\.js$/, '.ts'));
      if (existsSync(target)) walk(target);
    }
  };
  walk(resolve(SRC, entry));
  return bare;
}

describe('subpath entries and what they import', () => {
  it('@exo/kit/json reaches no package at all', () => {
    // Not "no drivers" — nothing. These are seven pure functions over
    // `unknown`, and anything they needed from a package would be a sign one
    // of them had stopped being pure.
    expect([...bareSpecifiers('json/index.ts')]).toEqual([]);
  });

  it('@exo/kit/log needs pino and nothing else', () => {
    expect([...bareSpecifiers('log/index.ts')].sort()).toEqual(['pino']);
  });

  it('@exo/kit/connector-sdk needs only node:crypto', () => {
    expect([...bareSpecifiers('connector-sdk/index.ts')].sort()).toEqual(['node:crypto']);
  });

  it('@exo/kit/ai reaches no package at all', () => {
    // A wire to one HTTP service over global `fetch`, reading its JSON through
    // `json/`. Any bare specifier here would be a dependency a product pays
    // for on every support turn and the client has no use for.
    expect([...bareSpecifiers('ai/index.ts')]).toEqual([]);
  });

  it('@exo/kit/llm reaches no database driver', () => {
    // It talks to HTTP endpoints with global `fetch`. It reads untrusted JSON,
    // which is why it must take those helpers from `json/` directly and never
    // through the `infra` barrel.
    const specs = bareSpecifiers('llm/index.ts');
    expect(specs.has('postgres')).toBe(false);
    expect(specs.has('ioredis')).toBe(false);
  });

  it('@exo/kit/http is server-side all the way down, and says which builtins', () => {
    // Every module behind this entry is server-side by construction — an ETag
    // over node:crypto, a guard that resolves hostnames — so unlike `infra`
    // there is no client-safe half to move out. What matters is that the list
    // stays this short: a web framework or a database driver appearing here
    // would mean the response helpers had acquired a dependency the error
    // sanitiser has no use for.
    expect([...bareSpecifiers('http/index.ts')].sort()).toEqual([
      'node:crypto',
      'node:dns/promises',
      'node:net',
    ]);
  });

  it('@exo/kit/auth-core needs node:crypto and no driver', () => {
    // The Postgres types it uses are type-only imports, erased at build — so a
    // product that mounts the session store needs the driver, and one that only
    // hashes a password does not.
    expect([...bareSpecifiers('auth-core/index.ts')].sort()).toEqual(['node:crypto']);
  });

  it('@exo/kit/auth-core/cookie reaches nothing at all — an edge proxy imports it', () => {
    // This is the same promise `@exo/kit/json` makes, for the same reason and a
    // sharper one: an edge runtime has no `node:crypto`, so a barrel that
    // re-exported the cookie alongside scrypt would not merely bloat a bundle,
    // it would fail to build. The cookie uses Web Crypto precisely so this row
    // can be empty.
    expect([...bareSpecifiers('auth-core/cookie.ts')]).toEqual([]);
  });

  it('the auth-core barrel does not re-export the cookie half', () => {
    // Belt and braces: the row above stays empty only while nothing pulls the
    // node half in behind it, and one convenient re-export would do it.
    const barrel = readFileSync(resolve(SRC, 'auth-core/index.ts'), 'utf8');
    expect(barrel).not.toMatch(/from '\.\/cookie\.js'/);
  });

  it('@exo/kit/auth is the one entry that pulls a framework-sized package in', () => {
    // Every other row in this file is about keeping a dependency OUT. This one
    // is the opposite: it writes down what a product pays for the login, so the
    // cost stays visible and so nobody mounts it from a client bundle. 50 MB,
    // 86 packages, ~1.5 s added to start-up and ~80 MB of RSS (sandbox §3.10).
    //
    // It must not reach a database driver: the product passes its own `pg` Pool
    // in, and `postgres`/`ioredis` appearing here would mean the module had
    // started opening connections of its own.
    const specs = bareSpecifiers('auth/index.ts');
    expect([...specs].sort()).toEqual([
      'better-auth',
      'better-auth/api',
      'better-auth/plugins/admin',
      'better-auth/plugins/custom-session',
      'better-auth/plugins/magic-link',
      'better-auth/plugins/two-factor',
      'node:crypto',
    ]);
    expect(specs.has('postgres')).toBe(false);
    expect(specs.has('ioredis')).toBe(false);
    expect(specs.has('pg')).toBe(false);
  });

  it('@exo/kit/mailer reaches no package at all', () => {
    // One HTTPS call with the global `fetch`. A product that only wants to
    // know whether email is configured should not pay for anything else, and
    // an edge-adjacent caller of `isOwnSender` must not drag Node in.
    expect([...bareSpecifiers('mailer/index.ts')]).toEqual([]);
  });

  it('@exo/kit/notify reaches no package at all', () => {
    // Same shape: the Telegram leg is a `fetch`, the email leg is a function
    // the product hands in. The mailer it composes with is a type import only.
    expect([...bareSpecifiers('notify/index.ts')]).toEqual([]);
  });

  it('@exo/kit/health reaches no package at all', () => {
    // Two `Response` objects and a `setTimeout`. The probe is the one route a
    // monitor is allowed to reach on a product that is otherwise broken, so it
    // must not be able to fail to import: the `ReportError` it takes is a type.
    expect([...bareSpecifiers('health/index.ts')]).toEqual([]);
  });

  it('@exo/kit/telemetry reaches no package at all', () => {
    // The whole point of the seam. A module that imported an error-reporting
    // SDK would be choosing one for every product that imports it — which is
    // the coupling teamself extracted this out of.
    expect([...bareSpecifiers('telemetry/index.ts')]).toEqual([]);
  });

  it('@exo/kit/env needs zod and nothing else', () => {
    // The one new dependency in v0.5.0, and it stays behind one entry: a
    // product that does not declare its environment through the kit does not
    // get zod on disk because of the kit.
    expect([...bareSpecifiers('env/index.ts')].sort()).toEqual(['zod']);
  });

  it('@exo/kit/migrate needs two builtins and no database driver', () => {
    // It copies files and compares bytes. A driver here would mean the module
    // had started applying migrations — which is dbmate's job precisely
    // because dbmate is not a Node program and does not care what the product
    // is written in.
    expect([...bareSpecifiers('migrate/index.ts')].sort()).toEqual(['node:fs', 'node:path']);
  });

  it('the auth migration list reaches nothing — the CLI runs where better-auth may not exist', () => {
    // `exo-kit-migrations` runs in a product's image build to check the
    // vendored copies. Importing the list through `auth/index.ts` would make
    // that gate need a 50 MB peer dependency to read three file names.
    expect([...bareSpecifiers('auth/migrations.ts')]).toEqual([]);
  });

  it('@exo/kit/auth/migrations is its own subpath, so a script gets the list without Better Auth', () => {
    // The row above says the FILE imports nothing. That was true before this
    // subpath existed and bought a product nothing: the only way in was the
    // `@exo/kit/auth` barrel, which walks into `better-auth` first. The kit's
    // own CLI got round that with a deep import into `dist/`, which a consumer
    // cannot do — `exports` refuses any path it does not list.
    const pkg = JSON.parse(readFileSync(resolve(here, '../package.json'), 'utf8')) as {
      exports: Record<string, { types: string; import: string } | string>;
    };
    expect(pkg.exports['./auth/migrations']).toEqual({
      types: './dist/auth/migrations.d.ts',
      import: './dist/auth/migrations.js',
    });
    const specs = [...bareSpecifiers('auth/migrations.ts')];
    expect(specs.filter((s) => s.startsWith('better-auth'))).toEqual([]);
    // Compatibility, not a second door to maintain: the barrel keeps it.
    expect(readFileSync(resolve(SRC, 'auth/index.ts'), 'utf8')).toMatch(
      /export \{ authMigrations \} from '\.\/migrations\.js'/,
    );
  });

  it('every subpath in package.json exports points at a module that exists in src', () => {
    // A subpath whose source was renamed builds nothing into dist/, and the
    // first to find out is a product's `npm ci` + import at run time.
    const pkg = JSON.parse(readFileSync(resolve(here, '../package.json'), 'utf8')) as {
      exports: Record<string, { import: string } | string>;
    };
    for (const [subpath, target] of Object.entries(pkg.exports)) {
      if (typeof target === 'string') continue; // ./package.json
      const source = resolve(SRC, target.import.replace(/^\.\/dist\//, '').replace(/\.js$/, '.ts'));
      expect(existsSync(source), `${subpath} → ${source}`).toBe(true);
    }
  });

  it('@exo/kit/infra is the one entry that pulls both drivers', () => {
    // Stated, not lamented: this entry exists to hand out a pool and a cache.
    // The test is here so the line stays true in both directions — an entry
    // that quietly stopped needing a driver would be worth knowing about too.
    expect([...bareSpecifiers('infra/index.ts')].sort()).toEqual(['ioredis', 'postgres']);
  });
});
