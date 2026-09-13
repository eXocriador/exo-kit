/**
 * `@exo/kit/env` — one schema per product: the environment is read once,
 * validated at boot, and typed from then on.
 *
 * ── What importing this pulls in ──
 * `zod`, and nothing else. It is an optional peer, like `pino`: a product that
 * does not import this entry does not need it on disk.
 *
 * ── The rule this module does not break ──
 * A kit module never reads `process.env`, and this one is not an exception:
 * the source is an argument. `defineEnv(schema, process.env)` is the one line
 * in the one file where a product touches the environment, which is exactly
 * the property that makes everything below it portable.
 *
 * ── What it is for ──
 * No TypeScript product in the portfolio validated its environment. The
 * failures that produced were all the same shape: a `PORT` that parsed to
 * `NaN` and silently became the default, half a provider key pair that made a
 * login button that leads to the provider's error page, a connection string
 * spelled `POSTGRES_URL` in one product and `DATABASE_URL` in the next. The
 * Python product that did validate (`pydantic-settings`) has none of them.
 *
 * ── Empty is not configured ──
 * `FOO=` in a `.env` is how an operator leaves something for later. An
 * optional field reads it as `null`, matching `createDb({ url: null })` in
 * `@exo/kit/infra`: not configured is a state, the product boots, and the
 * feature that needs it is simply not offered. A required field says so by
 * name.
 *
 * ── The error never contains the value ──
 * An env failure is the single most likely thing to be pasted into a chat
 * window or an issue, and the variables that fail are the secrets. Messages
 * are built from the schema — what was expected — never from what arrived.
 *
 * ```ts
 * // src/env.ts — the whole of it
 * import { defineEnv, str, num, url, bool } from '@exo/kit/env';
 *
 * export const schema = {
 *   POSTGRES_URL: url({ optional: true, protocols: ['postgresql', 'postgres'],
 *                       describe: 'Shared postgres. Empty = the product runs without one.' }),
 *   SESSION_SECRET: str({ min: 32, secret: true, describe: 'openssl rand -base64 48' }),
 *   PORT: num({ default: 3000, omitExample: true, describe: 'Set by compose.' }),
 * };
 *
 * export const env = defineEnv(schema, process.env);
 * ```
 */
import { z } from 'zod';

export type EnvSource = Record<string, string | undefined>;

export interface FieldMeta {
  /** Comment lines above the name in a generated `.env.example`. */
  describe?: string;
  /** Placeholder value in a generated `.env.example`. */
  example?: string;
  /** Render with an empty value: a secret must have no placeholder to copy. */
  secret?: boolean;
  /** Supplied by compose or a build arg, not by the file — left out of the example. */
  omitExample?: boolean;
  /** Empty reads as `null` instead of failing. */
  optional?: boolean;
  /** Whether {@link FieldMeta.fallback} applies. */
  hasDefault?: boolean;
  /** Used when the variable is absent or empty. */
  fallback?: unknown;
  /**
   * What to say when the value is rejected. Written by whoever declared the
   * field, from the schema's side — so that nothing derived from the value can
   * reach the message.
   */
  invalid?: string;
}

/**
 * One variable. `value` is type-only: it is never set and never read, and it
 * exists so that `defineEnv` can give the product an object typed field by
 * field without a second declaration to keep in step.
 */
export interface EnvField<T> {
  readonly schema: z.ZodTypeAny;
  readonly meta: FieldMeta;
  readonly value: T;
}

export type EnvSchema = Record<string, EnvField<unknown>>;

export type EnvOf<S extends EnvSchema> = { readonly [K in keyof S]: S[K]['value'] };

/** What failed, by name. Never carries a value. */
export class EnvError extends Error {
  readonly variables: string[];
  constructor(problems: ReadonlyArray<{ name: string; reason: string }>) {
    const names = problems.map((p) => p.name);
    super(
      `invalid environment (${names.join(', ')}):\n` +
        problems.map((p) => `  ${p.name}: ${p.reason}`).join('\n'),
    );
    this.name = 'EnvError';
    this.variables = names;
  }
}

interface CommonOptions {
  describe?: string;
  example?: string;
  secret?: boolean;
  omitExample?: boolean;
  invalid?: string;
}

function makeField(schema: z.ZodTypeAny, options: CommonOptions & { optional?: boolean }, extra: Partial<FieldMeta>): EnvField<never> {
  const meta: FieldMeta = { ...options, ...extra };
  // `value` is a type-level fiction; nothing reads it. Constructing it would
  // mean inventing a value for a variable that has not been read yet.
  return { schema, meta } as unknown as EnvField<never>;
}

// ── string ──────────────────────────────────────────────────────────────────

export interface StrOptions extends CommonOptions {
  min?: number;
  max?: number;
  pattern?: RegExp;
}

export function str(options?: StrOptions & { optional?: false; default?: string }): EnvField<string>;
export function str(options: StrOptions & { optional: true }): EnvField<string | null>;
export function str(options: StrOptions & { optional?: boolean; default?: string } = {}): EnvField<never> {
  let schema = z.string();
  if (options.min !== undefined) schema = schema.min(options.min);
  if (options.max !== undefined) schema = schema.max(options.max);
  if (options.pattern) schema = schema.regex(options.pattern);
  const limits = [
    options.min === undefined ? '' : `at least ${options.min} characters`,
    options.max === undefined ? '' : `at most ${options.max} characters`,
    options.pattern ? 'matching the expected form' : '',
  ].filter(Boolean);
  return makeField(schema, options, {
    ...(limits.length ? { invalid: options.invalid ?? `expected a value ${limits.join(', ')}` } : {}),
    hasDefault: 'default' in options,
    fallback: options.default,
  });
}

// ── number ──────────────────────────────────────────────────────────────────

export interface NumOptions extends CommonOptions {
  /** Whole numbers only. Default true: ports, days and retries are counts. */
  int?: boolean;
  min?: number;
  max?: number;
}

export function num(options?: NumOptions & { optional?: false; default?: number }): EnvField<number>;
export function num(options: NumOptions & { optional: true }): EnvField<number | null>;
export function num(options: NumOptions & { optional?: boolean; default?: number } = {}): EnvField<never> {
  const int = options.int !== false;
  let numeric = int ? z.number().int() : z.number();
  if (options.min !== undefined) numeric = numeric.min(options.min);
  if (options.max !== undefined) numeric = numeric.max(options.max);
  // Not `parseInt`: it reads '30d' as 30, which is how a truncated value
  // becomes a working configuration nobody wrote.
  const schema = z
    .string()
    .refine((raw) => raw !== '' && Number.isFinite(Number(raw)), { message: 'not a number' })
    .transform((raw) => Number(raw))
    .pipe(numeric);
  const range = [
    options.min === undefined ? '' : `>= ${options.min}`,
    options.max === undefined ? '' : `<= ${options.max}`,
  ].filter(Boolean);
  return makeField(schema, options, {
    invalid:
      options.invalid ??
      `expected ${int ? 'a whole number' : 'a number'}${range.length ? ` ${range.join(' and ')}` : ''}`,
    hasDefault: 'default' in options,
    fallback: options.default,
  });
}

// ── boolean ─────────────────────────────────────────────────────────────────

const TRUE = new Set(['1', 'true', 'yes', 'on']);
const FALSE = new Set(['0', 'false', 'no', 'off']);

export function bool(options?: CommonOptions & { optional?: false; default?: boolean }): EnvField<boolean>;
export function bool(options: CommonOptions & { optional: true }): EnvField<boolean | null>;
export function bool(options: CommonOptions & { optional?: boolean; default?: boolean } = {}): EnvField<never> {
  const schema = z
    .string()
    .transform((raw) => raw.toLowerCase())
    .refine((raw) => TRUE.has(raw) || FALSE.has(raw), { message: 'not a boolean' })
    .transform((raw) => TRUE.has(raw));
  return makeField(schema, options, {
    invalid: options.invalid ?? `expected one of ${[...TRUE].join('/')} or ${[...FALSE].join('/')}`,
    hasDefault: 'default' in options,
    fallback: options.default,
  });
}

// ── url ─────────────────────────────────────────────────────────────────────

export interface UrlOptions extends CommonOptions {
  /** Allowed schemes, without the colon. Omit to allow any. */
  protocols?: readonly string[];
}

export function url(options?: UrlOptions & { optional?: false; default?: string }): EnvField<string>;
export function url(options: UrlOptions & { optional: true }): EnvField<string | null>;
export function url(options: UrlOptions & { optional?: boolean; default?: string } = {}): EnvField<never> {
  const protocols = options.protocols;
  const schema = z.string().superRefine((raw, ctx) => {
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'not a url' });
      return;
    }
    if (protocols && !protocols.includes(parsed.protocol.replace(/:$/, ''))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'wrong protocol' });
    }
  });
  return makeField(schema, options, {
    invalid:
      options.invalid ??
      `expected a url${protocols ? ` with protocol ${protocols.join(' or ')}` : ''}`,
    hasDefault: 'default' in options,
    fallback: options.default,
  });
}

// ── enum ────────────────────────────────────────────────────────────────────

export function enumOf<const V extends readonly [string, ...string[]]>(
  values: V,
  options?: CommonOptions & { optional?: false; default?: V[number] },
): EnvField<V[number]>;
export function enumOf<const V extends readonly [string, ...string[]]>(
  values: V,
  options: CommonOptions & { optional: true },
): EnvField<V[number] | null>;
export function enumOf<const V extends readonly [string, ...string[]]>(
  values: V,
  options: CommonOptions & { optional?: boolean; default?: V[number] } = {},
): EnvField<never> {
  return makeField(z.enum(values as unknown as [string, ...string[]]), options, {
    // zod's own message for this code quotes what arrived. The allowed values
    // are the schema's; the rejected one stays in the environment.
    invalid: options.invalid ?? `expected one of: ${values.join(', ')}`,
    hasDefault: 'default' in options,
    fallback: options.default,
  });
}

// ── anything else ───────────────────────────────────────────────────────────

/**
 * A zod schema whose input is the raw string this module hands it.
 *
 * Written this way to compile on zod 3 AND zod 4, which is not the same as
 * being written this way for fun. `ZodType`'s second type parameter means
 * different things in the two majors — `Def` in 3, `Input` in 4 — and
 * `ZodTypeDef`, which the zod-3 spelling named there, does not exist in 4 at
 * all. So the positional parameters are given up (`any`, in both majors) and
 * the constraint that actually matters is stated directly: `_input` is the
 * declared input type on `ZodType` in both, so `& { _input: string }` still
 * turns away a schema expecting an object or a number, which is the only thing
 * the old three-parameter spelling was buying. `test/env.test.ts` holds both
 * halves of that — what it accepts and what it refuses — under whichever major
 * is installed.
 */
export type CustomSchema<T> = z.ZodType<T, any, any> & { _input: string };

/**
 * Any zod schema, for the variable the helpers above do not describe — a
 * comma-separated list, a JSON blob, a branded id. This is what the dependency
 * buys: the escape hatch is a library a reader already knows, not a second
 * validation dialect in the kit.
 */
export function custom<T>(
  schema: CustomSchema<T>,
  options?: CommonOptions & { optional?: false; default?: T },
): EnvField<T>;
export function custom<T>(schema: CustomSchema<T>, options: CommonOptions & { optional: true }): EnvField<T | null>;
export function custom<T>(
  schema: CustomSchema<T>,
  options: CommonOptions & { optional?: boolean; default?: T } = {},
): EnvField<never> {
  return makeField(schema, options, { hasDefault: 'default' in options, fallback: options.default });
}

// ── reading ─────────────────────────────────────────────────────────────────

function explain(field: EnvField<unknown>, raw: string, issues: z.ZodIssue[]): string {
  if (field.meta.invalid) return field.meta.invalid;
  // A schema the product brought itself: its message is usually the most
  // useful thing available, and it is used only after being shown not to carry
  // the value.
  const message = issues[0]?.message;
  if (message && !message.includes(raw)) return message;
  return 'rejected by its schema';
}

/**
 * Read, validate and type the environment. Throws {@link EnvError} listing
 * every bad variable — a fresh deployment has three of them wrong, and one
 * restart per variable is not a diagnostic.
 */
export function defineEnv<S extends EnvSchema>(schema: S, source: EnvSource): EnvOf<S> {
  const problems: Array<{ name: string; reason: string }> = [];
  const result: Record<string, unknown> = {};

  for (const [name, field] of Object.entries(schema) as Array<[string, EnvField<unknown>]>) {
    const raw = (source[name] ?? '').trim();

    if (raw === '') {
      if (field.meta.hasDefault) result[name] = field.meta.fallback;
      else if (field.meta.optional) result[name] = null;
      else problems.push({ name, reason: 'required, but not set' });
      continue;
    }

    const parsed = field.schema.safeParse(raw);
    if (parsed.success) result[name] = parsed.data;
    else problems.push({ name, reason: explain(field, raw, parsed.error.issues) });
  }

  if (problems.length) throw new EnvError(problems);
  // Frozen: the product reads this everywhere and writes it nowhere.
  return Object.freeze(result) as EnvOf<S>;
}

// ── the example file ────────────────────────────────────────────────────────

export interface RenderEnvExampleOptions {
  /** Comment block at the top of the file. */
  header?: string;
  /**
   * The one line per variable the kit writes itself — whether it must be
   * filled in. English by default; a product whose operator reads another
   * language passes its own, because this file is read by a person and the
   * kit has no business choosing their language.
   */
  labels?: {
    required?: string;
    optional?: string;
    default?: (value: string) => string;
  };
}

const comment = (text: string): string =>
  text
    .split('\n')
    .map((line) => (line.trim() ? `# ${line}` : '#'))
    .join('\n');

/**
 * The `.env.example` for a schema, as text. It exists because that file is the
 * one piece of documentation an operator actually follows, and it is also the
 * first to drift: a variable added in code and not in the example is invisible
 * until the deployment that needs it.
 *
 * A secret is rendered with an empty value — a placeholder that looks like a
 * key is one somebody copies into production.
 */
export function renderEnvExample(schema: EnvSchema, options: RenderEnvExampleOptions = {}): string {
  const blocks: string[] = [];
  if (options.header) blocks.push(comment(options.header));

  for (const [name, field] of Object.entries(schema) as Array<[string, EnvField<unknown>]>) {
    const meta = field.meta;
    if (meta.omitExample) continue;
    const lines: string[] = [];
    if (meta.describe) lines.push(comment(meta.describe));
    const labels = options.labels ?? {};
    const note = meta.optional
      ? (labels.optional ?? 'Optional — empty means not configured.')
      : meta.hasDefault
        ? (labels.default ?? ((value: string) => `Optional — default: ${value}.`))(String(meta.fallback))
        : (labels.required ?? 'Required.');
    lines.push(`# ${note}`);
    lines.push(`${name}=${meta.secret ? '' : (meta.example ?? '')}`);
    blocks.push(lines.join('\n'));
  }

  return `${blocks.join('\n\n')}\n`;
}
