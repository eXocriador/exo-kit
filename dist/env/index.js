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
/** What failed, by name. Never carries a value. */
export class EnvError extends Error {
    variables;
    constructor(problems) {
        const names = problems.map((p) => p.name);
        super(`invalid environment (${names.join(', ')}):\n` +
            problems.map((p) => `  ${p.name}: ${p.reason}`).join('\n'));
        this.name = 'EnvError';
        this.variables = names;
    }
}
function makeField(schema, options, extra) {
    const meta = { ...options, ...extra };
    // `value` is a type-level fiction; nothing reads it. Constructing it would
    // mean inventing a value for a variable that has not been read yet.
    return { schema, meta };
}
export function str(options = {}) {
    let schema = z.string();
    if (options.min !== undefined)
        schema = schema.min(options.min);
    if (options.max !== undefined)
        schema = schema.max(options.max);
    if (options.pattern)
        schema = schema.regex(options.pattern);
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
export function num(options = {}) {
    const int = options.int !== false;
    let numeric = int ? z.number().int() : z.number();
    if (options.min !== undefined)
        numeric = numeric.min(options.min);
    if (options.max !== undefined)
        numeric = numeric.max(options.max);
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
        invalid: options.invalid ??
            `expected ${int ? 'a whole number' : 'a number'}${range.length ? ` ${range.join(' and ')}` : ''}`,
        hasDefault: 'default' in options,
        fallback: options.default,
    });
}
// ── boolean ─────────────────────────────────────────────────────────────────
const TRUE = new Set(['1', 'true', 'yes', 'on']);
const FALSE = new Set(['0', 'false', 'no', 'off']);
export function bool(options = {}) {
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
export function url(options = {}) {
    const protocols = options.protocols;
    const schema = z.string().superRefine((raw, ctx) => {
        let parsed;
        try {
            parsed = new URL(raw);
        }
        catch {
            ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'not a url' });
            return;
        }
        if (protocols && !protocols.includes(parsed.protocol.replace(/:$/, ''))) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'wrong protocol' });
        }
    });
    return makeField(schema, options, {
        invalid: options.invalid ??
            `expected a url${protocols ? ` with protocol ${protocols.join(' or ')}` : ''}`,
        hasDefault: 'default' in options,
        fallback: options.default,
    });
}
export function enumOf(values, options = {}) {
    return makeField(z.enum(values), options, {
        // zod's own message for this code quotes what arrived. The allowed values
        // are the schema's; the rejected one stays in the environment.
        invalid: options.invalid ?? `expected one of: ${values.join(', ')}`,
        hasDefault: 'default' in options,
        fallback: options.default,
    });
}
export function custom(schema, options = {}) {
    return makeField(schema, options, { hasDefault: 'default' in options, fallback: options.default });
}
// ── reading ─────────────────────────────────────────────────────────────────
function explain(field, raw, issues) {
    if (field.meta.invalid)
        return field.meta.invalid;
    // A schema the product brought itself: its message is usually the most
    // useful thing available, and it is used only after being shown not to carry
    // the value.
    const message = issues[0]?.message;
    if (message && !message.includes(raw))
        return message;
    return 'rejected by its schema';
}
/**
 * Read, validate and type the environment. Throws {@link EnvError} listing
 * every bad variable — a fresh deployment has three of them wrong, and one
 * restart per variable is not a diagnostic.
 */
export function defineEnv(schema, source) {
    const problems = [];
    const result = {};
    for (const [name, field] of Object.entries(schema)) {
        const raw = (source[name] ?? '').trim();
        if (raw === '') {
            if (field.meta.hasDefault)
                result[name] = field.meta.fallback;
            else if (field.meta.optional)
                result[name] = null;
            else
                problems.push({ name, reason: 'required, but not set' });
            continue;
        }
        const parsed = field.schema.safeParse(raw);
        if (parsed.success)
            result[name] = parsed.data;
        else
            problems.push({ name, reason: explain(field, raw, parsed.error.issues) });
    }
    if (problems.length)
        throw new EnvError(problems);
    // Frozen: the product reads this everywhere and writes it nowhere.
    return Object.freeze(result);
}
const comment = (text) => text
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
export function renderEnvExample(schema, options = {}) {
    const blocks = [];
    if (options.header)
        blocks.push(comment(options.header));
    for (const [name, field] of Object.entries(schema)) {
        const meta = field.meta;
        if (meta.omitExample)
            continue;
        const lines = [];
        if (meta.describe)
            lines.push(comment(meta.describe));
        const labels = options.labels ?? {};
        const note = meta.optional
            ? (labels.optional ?? 'Optional — empty means not configured.')
            : meta.hasDefault
                ? (labels.default ?? ((value) => `Optional — default: ${value}.`))(String(meta.fallback))
                : (labels.required ?? 'Required.');
        lines.push(`# ${note}`);
        lines.push(`${name}=${meta.secret ? '' : (meta.example ?? '')}`);
        blocks.push(lines.join('\n'));
    }
    return `${blocks.join('\n\n')}\n`;
}
//# sourceMappingURL=index.js.map