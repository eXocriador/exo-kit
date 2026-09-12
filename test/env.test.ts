import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  defineEnv,
  renderEnvExample,
  EnvError,
  str,
  num,
  bool,
  url,
  enumOf,
  custom,
} from '../src/env/index.js';

/**
 * What an env module is for, in one line: the product finds out at boot, by
 * name, instead of at 3am by symptom. Every failure mode below was observed
 * somewhere in the portfolio — a spelled-differently connection string, a
 * provider key set to half a pair, a `PORT` that parsed to `NaN` and silently
 * became the default.
 *
 * And one rule that is not about validation at all: the error text never
 * contains the value. An env failure is the single most likely thing to be
 * pasted into a chat window, and the variables that fail are the secrets.
 */
const SECRET = 'sk-live-00000000000000000000';

describe('defineEnv', () => {
  it('names a required variable that is missing', () => {
    const schema = { SESSION_SECRET: str({ describe: 'Cookie signing key' }) };

    expect(() => defineEnv(schema, {})).toThrow(/SESSION_SECRET/);
    expect(() => defineEnv(schema, {})).toThrow(EnvError);
  });

  it('treats an empty value as not set at all', () => {
    // `.env` files are written by hand and half-filled on purpose; `FOO=` is
    // how an operator leaves something for later, not how they set it to "".
    expect(() => defineEnv({ SESSION_SECRET: str() }, { SESSION_SECRET: '   ' })).toThrow(/SESSION_SECRET/);
  });

  it('an optional variable left empty is null, not an error and not an empty string', () => {
    const env = defineEnv(
      { RESEND_API_KEY: str({ optional: true }), EMAIL_FROM: str({ optional: true }) },
      { RESEND_API_KEY: '' },
    );

    expect(env).toEqual({ RESEND_API_KEY: null, EMAIL_FROM: null });
  });

  it('uses the default when the variable is absent, and the value when it is there', () => {
    const schema = { PORT: num({ default: 3000 }), HOST: str({ default: '0.0.0.0' }) };

    expect(defineEnv(schema, {})).toEqual({ PORT: 3000, HOST: '0.0.0.0' });
    expect(defineEnv(schema, { PORT: '8080', HOST: '127.0.0.1' })).toEqual({ PORT: 8080, HOST: '127.0.0.1' });
  });

  it('trims, because an editor adds the whitespace and the operator cannot see it', () => {
    expect(defineEnv({ ADMIN_EMAIL: str() }, { ADMIN_EMAIL: '  owner@example.com \n' }))
      .toEqual({ ADMIN_EMAIL: 'owner@example.com' });
  });

  it('reports every bad variable at once, not the first one', () => {
    // A fresh deployment has three of these wrong. Failing one at a time turns
    // that into three restarts.
    let caught: EnvError | null = null;
    try {
      defineEnv({ A: str(), B: str(), C: str({ default: 'fine' }) }, {});
    } catch (err) {
      caught = err as EnvError;
    }

    expect(caught).toBeInstanceOf(EnvError);
    expect(caught!.variables).toEqual(['A', 'B']);
    expect(caught!.message).toMatch(/A/);
    expect(caught!.message).toMatch(/B/);
  });

  it('never puts the value in the message — not the number, not the url, not the secret', () => {
    // The leak test. Written first and kept first: the failure this guards
    // against looks exactly like success (a helpful error the operator pastes
    // into a chat), and nothing else in the system would notice.
    const cases: Array<[Record<string, unknown>, Record<string, string>]> = [
      [{ PORT: num() }, { PORT: SECRET }],
      [{ SITE_URL: url() }, { SITE_URL: SECRET }],
      [{ LOG_LEVEL: enumOf(['debug', 'info']) }, { LOG_LEVEL: SECRET }],
      [{ SECURE_COOKIE: bool() }, { SECURE_COOKIE: SECRET }],
      [{ API_KEY: custom(z.string().min(40)) }, { API_KEY: SECRET }],
    ];

    for (const [schema, source] of cases) {
      let message = '';
      try {
        defineEnv(schema as never, source);
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).not.toBe('');
      expect(message).not.toContain(SECRET);
    }
  });

  it('num takes whole numbers and refuses everything else', () => {
    expect(defineEnv({ SESSION_DAYS: num() }, { SESSION_DAYS: '30' })).toEqual({ SESSION_DAYS: 30 });
    expect(() => defineEnv({ SESSION_DAYS: num() }, { SESSION_DAYS: '30.5' })).toThrow(/SESSION_DAYS/);
    expect(() => defineEnv({ SESSION_DAYS: num() }, { SESSION_DAYS: 'lots' })).toThrow(/SESSION_DAYS/);
    // `parseInt` says 30 to this one, which is how a truncated value becomes a
    // working configuration nobody meant to write.
    expect(() => defineEnv({ SESSION_DAYS: num() }, { SESSION_DAYS: '30d' })).toThrow(/SESSION_DAYS/);
  });

  it('num honours min and max, and allows a fraction when asked', () => {
    expect(() => defineEnv({ PORT: num({ min: 1, max: 65535 }) }, { PORT: '0' })).toThrow(/PORT/);
    expect(defineEnv({ RATIO: num({ int: false }) }, { RATIO: '0.35' })).toEqual({ RATIO: 0.35 });
  });

  it('url refuses what is not a url, and what is the wrong protocol', () => {
    expect(defineEnv({ SITE_URL: url() }, { SITE_URL: 'https://files.example.dev' }))
      .toEqual({ SITE_URL: 'https://files.example.dev' });
    expect(() => defineEnv({ SITE_URL: url() }, { SITE_URL: 'files.example.dev' })).toThrow(/SITE_URL/);
    expect(() => defineEnv({ POSTGRES_URL: url({ protocols: ['postgresql'] }) }, { POSTGRES_URL: 'redis://redis:6379/1' }))
      .toThrow(/POSTGRES_URL/);
    expect(defineEnv({ POSTGRES_URL: url({ protocols: ['postgresql', 'postgres'] }) }, { POSTGRES_URL: 'postgres://db/app' }))
      .toEqual({ POSTGRES_URL: 'postgres://db/app' });
  });

  it('enumOf accepts a listed value and names the allowed ones when it does not', () => {
    expect(defineEnv({ NODE_ENV: enumOf(['development', 'production']) }, { NODE_ENV: 'production' }))
      .toEqual({ NODE_ENV: 'production' });

    let message = '';
    try {
      defineEnv({ NODE_ENV: enumOf(['development', 'production']) }, { NODE_ENV: 'prod' });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/NODE_ENV/);
    expect(message).toMatch(/development/);
    expect(message).toMatch(/production/);
    // The allowed values come from the schema; the rejected one came from the
    // environment and stays there.
    expect(message).not.toMatch(/'prod'/);
  });

  it('bool reads what an operator actually writes in a .env', () => {
    const schema = { SECURE_COOKIE: bool() };
    for (const yes of ['1', 'true', 'TRUE', 'yes', 'on']) {
      expect(defineEnv(schema, { SECURE_COOKIE: yes })).toEqual({ SECURE_COOKIE: true });
    }
    for (const no of ['0', 'false', 'no', 'off']) {
      expect(defineEnv(schema, { SECURE_COOKIE: no })).toEqual({ SECURE_COOKIE: false });
    }
    expect(() => defineEnv(schema, { SECURE_COOKIE: 'maybe' })).toThrow(/SECURE_COOKIE/);
  });

  it('custom takes any zod schema — this is what the dependency buys', () => {
    const schema = {
      ORIGINS: custom(
        z.string().transform((raw) => raw.split(',').map((s) => s.trim()).filter(Boolean)),
        { describe: 'Allowed origins, comma separated' },
      ),
    };

    expect(defineEnv(schema, { ORIGINS: 'https://a.example, https://b.example' }))
      .toEqual({ ORIGINS: ['https://a.example', 'https://b.example'] });
  });

  it('an optional field that is set is still validated', () => {
    // "Optional" is about presence, not about correctness: a half-typed
    // POSTGRES_URL must not reach the driver as a working configuration.
    expect(() => defineEnv({ POSTGRES_URL: url({ optional: true }) }, { POSTGRES_URL: 'postgres//db' }))
      .toThrow(/POSTGRES_URL/);
    // How lenient the parser underneath is, said out loud: `new URL` accepts
    // 'postgres:/db' — a scheme and a path, no host. `url()` checks that a URL
    // parses and that its protocol is one of the expected ones; a product that
    // needs a host in there checks for a host.
    expect(defineEnv({ POSTGRES_URL: url({ optional: true }) }, { POSTGRES_URL: 'postgres:/db' }))
      .toEqual({ POSTGRES_URL: 'postgres:/db' });
  });

  it('reads only the names in the schema and ignores the rest of the environment', () => {
    const env = defineEnv({ PORT: num({ default: 3000 }) }, { PORT: '8080', PATH: '/usr/bin', AWS_SECRET: SECRET });
    expect(env).toEqual({ PORT: 8080 });
  });
});

describe('renderEnvExample', () => {
  const schema = {
    DOMAIN: str({ describe: 'Public host.', example: 'files.example.dev' }),
    POSTGRES_URL: url({
      optional: true,
      protocols: ['postgresql', 'postgres'],
      describe: 'Shared postgres in the internal network.\nEmpty means the product runs without a database.',
      example: 'postgresql://app:<password>@postgres:5432/app',
    }),
    SESSION_SECRET: str({ describe: 'Cookie signing key: openssl rand -base64 48', secret: true }),
    PORT: num({ default: 3000, describe: 'Set by compose, not by the file.', omitExample: true }),
  };

  it('writes a .env.example that carries every name and no value for a secret', () => {
    const text = renderEnvExample(schema, { header: 'Names come from the schema. Values here are placeholders.' });

    expect(text).toContain('# Names come from the schema.');
    expect(text).toContain('# Public host.');
    expect(text).toContain('DOMAIN=files.example.dev');
    expect(text).toContain('POSTGRES_URL=postgresql://app:<password>@postgres:5432/app');
    // A secret gets a name and an explanation, never a placeholder that could
    // be pasted into production by someone in a hurry.
    expect(text).toContain('SESSION_SECRET=\n');
    // Multi-line descriptions stay comments all the way down.
    expect(text).toContain('# Empty means the product runs without a database.');
    // What compose supplies is not part of the file an operator fills in.
    expect(text).not.toContain('PORT=');
    expect(text.endsWith('\n')).toBe(true);
  });

  it('marks what is optional so the operator can tell what must be filled in', () => {
    const text = renderEnvExample(schema);
    const lines = text.split('\n');
    const postgres = lines.findIndex((l) => l.startsWith('POSTGRES_URL='));
    expect(lines.slice(0, postgres).join('\n')).toMatch(/optional/i);
  });

  it('takes the product\'s own words for required and optional', () => {
    // The file is read by a person, and which language that person reads is
    // not something a shared mechanism gets to decide.
    const text = renderEnvExample(schema, {
      labels: {
        required: 'Обов\'язкова.',
        optional: 'Необов\'язкова — порожньо означає «не налаштовано».',
        default: (value) => `Необов'язкова — типово: ${value}.`,
      },
    });

    expect(text).toContain("# Обов'язкова.");
    expect(text).toContain('# Необов\'язкова — порожньо означає «не налаштовано».');
    expect(text).not.toMatch(/^# Required\.$/m);
    expect(text).not.toMatch(/^# Optional/m);
  });

  it('the example values it prints are values the schema accepts', () => {
    // The whole point of generating the file: `.env.example` stops drifting
    // from the code. A placeholder the schema would reject is drift with extra
    // steps.
    const text = renderEnvExample(schema);
    const source: Record<string, string> = { SESSION_SECRET: 'x' };
    for (const line of text.split('\n')) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m && m[2]) source[m[1]!] = m[2];
    }
    expect(() => defineEnv(schema, source)).not.toThrow();
  });
});
