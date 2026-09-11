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
      .replace(/^\s*\/\/.*$/gm, '');
    // `from '...'` covers both `import` and `export ... from`, which is what
    // a bundler follows. Type-only imports are erased, so they are skipped.
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

  it('@exo/kit/llm reaches no database driver', () => {
    // It talks to HTTP endpoints with global `fetch`. It reads untrusted JSON,
    // which is why it must take those helpers from `json/` directly and never
    // through the `infra` barrel.
    const specs = bareSpecifiers('llm/index.ts');
    expect(specs.has('postgres')).toBe(false);
    expect(specs.has('ioredis')).toBe(false);
  });

  it('@exo/kit/infra is the one entry that pulls both drivers', () => {
    // Stated, not lamented: this entry exists to hand out a pool and a cache.
    // The test is here so the line stays true in both directions — an entry
    // that quietly stopped needing a driver would be worth knowing about too.
    expect([...bareSpecifiers('infra/index.ts')].sort()).toEqual(['ioredis', 'postgres']);
  });
});
