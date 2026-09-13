# @exo/kit

Shared mechanism for a handful of small self-hosted services: database and
cache accessors, structured logging with an audit trail, a multi-provider LLM
client, JSON responses and request pacing, the primitives behind session auth,
transactional email and the notice that gets an escalation to a human, and the
SDK a product mounts to be supportable.

One npm package with subpath exports, one git tag for the whole kit, and one
rule that shapes every module in it:

> **A module is a factory with an explicit config. It never reads
> `process.env`, and it never knows the name of a product.**

That rule is not tidiness. Every module here started as two or three copies in
separate repositories, and every place they had drifted was a place one of them
read the environment directly: a connection-string variable spelled differently
per deployment, an error reporter imported by name, a service label copied
between products and then read as fact. Take the environment away and the
copies become the same file.

## Install

```bash
npm i github:eXocriador/exo-kit#v0.6.0
```

`dist/` is committed, so `npm ci` inside a Docker build does not compile
anything. The deps stage needs `git` (npm clones the dependency over HTTPS); no
token, and no `git` in the runtime stage.

```dockerfile
FROM node:22-slim AS deps
RUN apt-get update && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/*
```

Python:

```bash
uv add "git+https://github.com/eXocriador/exo-kit@v0.6.0#subdirectory=python"
```

## Modules

| Import | What it gives you | Pulls in |
|---|---|---|
| `@exo/kit/infra` | `createDb`, `createRedis` | `postgres`, `ioredis` |
| `@exo/kit/json` | `isRecord`, `asArray`, `asString`, `asNumber`, `asBoolean`, `get`, `getPath` | nothing |
| `@exo/kit/log` | `createLogger` — pino + an audit trail, optional log shipping | `pino` |
| `@exo/kit/llm` | `createLlm` over Ollama / Anthropic / OpenAI / an OpenAI-compatible gateway | nothing |
| `@exo/kit/http` | `createApiResponse`, `createRateLimiter`, `createClientIp`, `validateHost`, `safeFetch` | `node:crypto`, `node:dns`, `node:net` |
| `@exo/kit/auth-core` | `hashPassword`, `verifyPassword`, TOTP, `createAuthTokens`, `createSessionStore` | `node:crypto` |
| `@exo/kit/auth-core/cookie` | `createSessionCookie` — sign and verify a session cookie | nothing |
| `@exo/kit/auth` | `createAuth` — the whole login: providers, magic link, TOTP, cabinet, admin | `better-auth`, `pg` |
| `@exo/kit/health` | `createHealth` — `live()` / `ready()` as Web-standard responses | nothing |
| `@exo/kit/env` | `defineEnv`, `renderEnvExample` — one schema per product | `zod` |
| `@exo/kit/telemetry` | `createTelemetry` — one seam for "something went wrong" | nothing |
| `@exo/kit/mailer` | `createMailer` — transactional email over Resend; `senderAddress`, `isOwnSender` | nothing |
| `@exo/kit/notify` | `createTelegramDm`, `createEscalationNotifier` — Telegram first, email as the fallback | nothing |
| `@exo/kit/connector-sdk` | `createConnectorHandler` — HMAC-signed support connector | `node:crypto` |

Peer dependencies (`better-auth`, `pg`, `postgres`, `ioredis`, `pino`, `zod`) are
optional, and the right
column is the reason to care which subpath you reach for. `@exo/kit/infra` is a
barrel over a pool and a cache, so importing it walks into both drivers — take
the JSON helpers from `@exo/kit/json`, which imports nothing at all. They are
re-exported from `infra` as well, and that is compatibility, not an invitation:
a driver that reaches a browser bundle is a build failure (`Can't resolve
'net'`), not a size regression, and the first thing that says so is the
bundler. `test/entry-graph.test.ts` pins each row of that column.

`@exo/kit/auth-core/cookie` is the same split made a second time, and for a
sharper reason. An edge proxy verifies a session cookie's signature and has no
`node:crypto` at all, so a barrel that re-exported the cookie next to scrypt and
TOTP would not bloat a bundle — it would fail to build. The cookie half uses Web
Crypto and imports nothing; the barrel does not re-export it, and a test says so
out loud rather than a comment asking nicely.

`@exo/kit/auth` is the one row in that table where the dependency column is a
warning rather than a promise. It pulls `better-auth` in: 50 MB on disk, 86
packages, about 1.5 s added to start-up and 80 MB of RSS. A product that only
needs to hash a password or verify a cookie must keep using `auth-core`, which
costs `node:crypto` and nothing else.

## The login: `@exo/kit/auth`

It exists to make one sentence true: **the login policy is not something a
product can get wrong.** Better Auth can express our policy and can also express
its exact opposite, with one list left non-empty — so the decisions below are
fixed in the wrapper and are not parameters, and a product passes in only what
is genuinely its own.

```ts
// src/auth.ts
import { createAuth, createAuthRateLimitStorage } from '@exo/kit/auth';
import { Pool } from 'pg';

const pool = new Pool({ connectionString: env.postgresUrl, max: 5 });

export const auth = createAuth<Principal>({
  db: pool,
  secret: () => env.sessionSecret,
  baseUrl: env.siteUrl,
  cookieName: 'alpha_session',
  secureCookie: env.secureCookie,
  sessionDays: 30,
  trustedProxies: env.trustedProxies,        // every product is behind Traefik
  providers: {},                             // empty is a working state
  email: {
    send: (to, subject, text) => mailer.send({ to, subject, text }),
    letters: { magicLink: (url, minutes) => loginEmail(url, minutes) },
    perAddressLimit: { max: 3, windowMs: 15 * 60_000 },
  },
  rateLimitStorage: createAuthRateLimitStorage({ redis: redis.client }),
  resolvePrincipal: (userId) => principalOf(userId),
});

app.register(auth.fastifyPlugin);
```

### What it fixes, and will not let a product change

1. **`accountLinking = { enabled: true, trustedProviders: [], requireLocalEmailVerified: true }`.**
   Two logins become one account only when the address is verified on **both**
   sides. `trustedProviders` is not exposed, because a provider named there
   *skips* the incoming `emailVerified` check — the list weakens the policy
   rather than expressing it, which is the opposite of how it reads.
   `test/auth-linking.test.ts` holds all four cases plus that one.
2. **`basePath: '/api/account'`**, cookie `httpOnly + sameSite=lax + path=/`,
   and `secure` from an explicit flag — never guessed from the URL. The
   `cookieName` also becomes the prefix for every other cookie, so the
   two-factor and session-data cookies are not called `better-auth.*`.
3. **Email verification at sign-up whenever a password exists beside a magic
   link.** Not tidiness — see "the magic link" below. Configuring a password
   without verification letters throws at construction.
4. **Passwords are `@exo/kit/auth-core/password`** — one `scrypt$N$r$p$salt$hash`
   format across the portfolio, and the hashes exointel already has are accepted
   with no reset.
5. **`id` is `uuid`.** See below.
6. **The session cookie cache is off, and `/list-sessions` never leaves the
   process.** The library answers that route with each session's raw `token` —
   the caller's own, so not a leak, but one XSS on a cabinet page then hands over
   every device instead of one. The route is in `disabledPaths`; `listSessions()`
   answers it without tokens and `revokeSession()` takes an **id**.
7. **Fastify is mounted as an encapsulated plugin.** The raw-body parser Better
   Auth's docs tell you to add globally turns every product JSON route's body
   into a string, and nothing in the resulting `zod` failures points at the
   cause.

What stays the product's: the shape of its principal and the query behind it,
its `ADMIN_EMAIL` rule, the text of its letters, its `/api/account/health`, and
the page with the provider buttons.

### Why `id` is `uuid` and not `text`

Better Auth generates either — `advanced.database.generateId: 'uuid'` is a
first-class mode and its own generator emits `uuid` columns for it — so this is
our decision, not the library's. The cost of `text` is not a row migration;
`users.id` is referenced by five other tables in exoanima and seven in exointel,
and every one of those columns would have to change type with it. `uuid` is also
what `gen_random_uuid()` already put in those rows, so an existing set stays
valid untouched. A new product pays nothing either way.

### Three things the schema changes about `auth.md`

* **`users.email` is now UNIQUE** (on `lower(email)`). The standard used to say
  "if in doubt, a second account"; the library cannot express that and refuses
  the login instead. Same safety property, different experience.
* **`UNIQUE (provider, provider_id)` is ours.** `auth@1.7.4 generate` emits only
  an index on `userId`, so two tabs finishing one login at the same moment would
  write two identity rows. The migration supplies the key.
* **`verification.value` is the token as issued**, where the products' own
  `login_tokens` stored a SHA-256. A dump of that table is live credentials
  until the rows expire.

### The magic link deletes passwords, and that is deliberate

A magic link into a row with `email_verified = false` **deletes that row's
password and every OAuth link it had**, then marks the address verified. It is
not a bug: it is the fix for `GHSA-qq9h-g4jm-xgf3`, and it says the proven owner
of a mailbox inherits nothing that predates the proof. The consequence is fixed
decision 3 — without verification at sign-up, a person who registers with a
password and then clicks a login link loses that password permanently and
silently. `test/auth-wrapper.test.ts` pins the behaviour so it cannot change
under us unnoticed.

### Two ceilings, counting different things

Better Auth's limiter counts **IP + path**; `createAuthRateLimitStorage` serves
it over Redis so a restart hands nobody a fresh budget. The address ceiling
counts **the recipient of the letter**, and it does not follow from the first:
behind Traefik the socket address is identical for everyone, and an IP ceiling
does not protect a stranger's mailbox from whoever is willing to change IP. Keep
both.

### Upgrading `better-auth`

The version is pinned **exactly** (`"better-auth": "1.7.4"`, no caret), and that
is not caution for its own sake: twenty advisories in a year, two of them the
very holes `auth.md` closed by design. The merge policy now lives in somebody
else's release rather than in our SQL, so `test/auth-linking.test.ts` is the
replacement for the `WHERE email_verified = true` that used to carry it.

**On every version bump: run the auth tests and read the advisories.** Two of
them need a real database and are skipped without one —

```bash
KIT_TEST_POSTGRES_URL=postgres://…/scratch npx vitest run test/auth-postgres.test.ts
```

— and they are the only tests that can see a schema mismatch, which is how the
plugin-field rename bug was found: `options.user.fields` does not reach a field a
*plugin* declares, so `twoFactor` and `admin` carry their own rename.

### Migrations

`auth.migrations` is a list of SQL file paths, in order, for the product's runner
to apply **before its own**: `001_kit_auth.sql` always, `002_kit_auth_2fa.sql`
only with `totp`, `003_kit_auth_admin.sql` only with `admin`. Each one is
convergent — `CREATE TABLE IF NOT EXISTS` for a new product, `ADD COLUMN IF NOT
EXISTS` for one that already has `auth.md`-shaped tables. What they deliberately
do not do is change the type of an existing column or move a primary key: that
needs to know how many rows are in the table, and only the product knows that.

Enabling `admin` is worth a thought rather than a reflex. Its gate is
`users.role = 'admin'`, a row in the database — so a product whose admin is
decided another way (filebrowser matches a verified address against
`ADMIN_EMAIL`) gains fifteen routes its only admin can never pass.

### Turning TOTP on costs the secret

Better Auth **encrypts** `two_factor.secret` and the backup codes with the
application secret, where `auth-core/totp` stored the secret as issued. Strictly
better — a database dump no longer mints codes — and it means **losing
`SESSION_SECRET` now loses every second factor**, not just every session.

## Using it

The intended shape is one small wiring module per product that calls the
factory and re-exports. That file is the product's configuration; everything
below it is mechanism.

```ts
// src/lib/log.ts
import { createLogger } from '@exo/kit/log';

export const { logger, logDebug, logInfo, logWarn, logError, logAudit } =
  createLogger({
    service: 'alpha-web',
    openobserve: process.env.OPENOBSERVE_URL
      ? {
          url: process.env.OPENOBSERVE_URL,
          org: process.env.OPENOBSERVE_ORG,
          stream: 'alpha',
          token: process.env.OPENOBSERVE_TOKEN,
        }
      : null,
  });
```

```ts
// src/lib/infra/db.ts
import { createDb } from '@exo/kit/infra';
import { captureException } from '@sentry/nextjs';
import { logWarn } from '@/lib/log';

export const { sql: db, query: dbQuery, tryQuery: dbTry, jsonb } = createDb({
  url: process.env.POSTGRES_URL,
  globalKey: '__db',
  reportError: (err, ctx) => {
    logWarn(ctx.event, ctx.fields);
    captureException(err, { tags: { component: ctx.component } });
  },
});
```

```ts
// src/lib/auth/sessions.ts
import { createSessionStore } from '@exo/kit/auth-core';
import { dbQuery } from '@/lib/infra/db';
import { cacheGet, cacheSet, cacheDel } from '@/lib/infra/redis';

export interface Principal { sessionId: string; userId: string; role: string }

export const {
  createSession, resolveSession, revokeSession, revokeUserSessions,
  revokeOwnedSession, revokeOtherSessions, listUserSessions, invalidateUserCache,
} = createSessionStore<Principal>({
  query: dbQuery,
  cache: { cacheGet, cacheSet, cacheDel },
  // This app's idea of who a caller is, and the one query that decides it.
  // The expiry predicate lives here: the kit does not re-check it, because
  // this runs once per gated request and splitting it would cost a round trip.
  resolvePrincipal: async (sql, sessionId) => {
    const rows = await sql`
      SELECT s.id AS session_id, u.id::text AS user_id, u.role, u.status
      FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id = ${sessionId} AND s.expires_at > NOW()
      LIMIT 1`;
    const row = rows[0];
    if (!row || row.status !== 'active') return null;
    return { sessionId: row.session_id, userId: row.user_id, role: row.role };
  },
});
```

```ts
// src/lib/email/mailer.ts
import { createMailer } from '@exo/kit/mailer';
import { logError } from '@/lib/log';

export const { mailerEnabled, sendEmail, isOwnSender } = createMailer({
  apiKey: process.env.RESEND_API_KEY,
  from: process.env.EMAIL_FROM,
  reportError: (err, ctx) => logError('email_send_failed', err, ctx.fields),
});
```

```ts
// src/lib/support/notify.ts
import { createTelegramDm, createEscalationNotifier } from '@exo/kit/notify';
import { sendEmail } from '@/lib/email/mailer';

const { notifyEscalation: notify } = createEscalationNotifier({
  telegram: createTelegramDm({
    botToken: process.env.TELEGRAM_BOT_TOKEN,
    chatId: process.env.SUPPORT_OWNER_TELEGRAM_CHAT_ID,
  }),
  sendEmail,
});

// The product decides who is told and where the conversation is opened. The
// kit will not build that URL: which account a conversation lives in is a
// fact about the product, and a copy that read it from an env var would emit
// `/app/accounts//conversations/123` in any installation that left it unset.
export const notifyEscalation = (input: { conversationId: number; category: string; reason: string | null; shadow: boolean }) =>
  notify({ ...input, to: SUPPORT_EMAIL, conversationUrl: conversationUrl(input.conversationId) });
```

Destructuring is the point: the returned functions are bound to that instance,
so existing flat call sites (`dbQuery(...)`, `logWarn(...)`, `resolveSession(id)`)
keep working and the diff is one file instead of every file.

```ts
// src/lib/health.ts — the two probes, and which of them is allowed to be red
import { createHealth } from '@exo/kit/health';
import { db } from '@/lib/infra/db';
import { redis } from '@/lib/infra/redis';

export const health = createHealth({
  version: process.env.APP_VERSION ?? 'dev',
  checks: {
    db: async () => { await db`select 1`; return 'ok'; },
    redis: async () => (await redis.ping()) === 'PONG',
    // A feature, not the product: it reports itself and never takes the
    // monitor red, because a probe that cries wolf is one nobody reads.
    qdrant: async () => (await qdrantUp()) ? 'ok' : 'fail',
  },
  required: ['db', 'redis'],
  reportError: telemetry.reportError,
});

// Next route handlers take it as it is — a route handler IS a Web-standard
// Request/Response function:
//   app/health/live/route.ts   export const GET = () => health.live();
//   app/health/ready/route.ts  export const GET = () => health.ready();
//
// Fastify needs the one line that unwraps it:
//   app.get('/health/ready', async (_req, reply) => {
//     const res = await health.ready();
//     return reply.code(res.status).send(await res.json());
//   });
```

```ts
// src/env.ts — the one file in the product that touches the environment
import { defineEnv, str, num, url, bool, renderEnvExample } from '@exo/kit/env';

export const schema = {
  POSTGRES_URL: url({ optional: true, protocols: ['postgresql', 'postgres'],
                      describe: 'Shared postgres. Empty = the product runs without one.',
                      example: 'postgresql://app:<password>@postgres:5432/app' }),
  SESSION_SECRET: str({ min: 32, secret: true, describe: 'openssl rand -base64 48' }),
  SESSION_DAYS: num({ default: 30, describe: 'How long a session lives.' }),
  SECURE_COOKIE: bool({ default: true, describe: 'Off only for http://localhost.' }),
  PORT: num({ default: 3000, omitExample: true, describe: 'Set by compose.' }),
};

// Throws on the way up, listing every bad variable by name — and never the
// value: an env error is the thing most likely to be pasted into a chat.
export const env = defineEnv(schema, process.env);

// `node -e "…"` in a script, or a test that asserts the file on disk matches:
// the .env.example stops being a second place to keep the truth.
export const example = () => renderEnvExample(schema, { header: 'Values are placeholders.' });
```

```ts
// src/lib/telemetry.ts — one seam, filled once
import { createTelemetry } from '@exo/kit/telemetry';
import { logError, logWarn } from '@/lib/log';

export const telemetry = createTelemetry({ logError, logWarn });
// …and, where the SDK is configured:
telemetry.setReporter((err, ctx) => Sentry.captureException(err, { extra: ctx }));

// Every kit factory's `reportError` is then the same one object:
//   createDb({ url, globalKey: '__db', reportError: telemetry.reportError })
```

### Not configured is a state

`createDb({ url: null })` and `createRedis({ url: null })` return working
accessors whose every call takes the unavailable branch — a query answers
`null`, a cache read misses, a lock is granted. A product with no database
boots and finds out by checking, not by crashing. Nothing is reported in that
state either: "no database" is a configuration, not a fault, and a product that
runs without one should not spend its error budget saying so.

`tryQuery` exists for the callers where that is not good enough. `query`'s
`null` conflates three things — not configured, threw, and returned nothing —
which is fine for a read path that degrades to empty and dangerous for anything
whose empty result *means* something. An exactly-once ledger reads a swallowed
error as "already handled".

### Testing a product against the kit

Vitest hands a dependency from `node_modules` straight to Node, so a
`vi.mock('node:dns/promises')` in a product test never reaches the kit's SSRF
guard, and the test goes green without running the code it names. Any product
that takes a module with a `node:*` import from the kit and mocks that builtin
in its own tests needs the kit transformed rather than externalised:

```ts
// vitest.config.ts, in the node project
server: { deps: { inline: [/@exo\/kit/] } },
```

Modules whose "Pulls in" column reads *nothing* (`json`, `llm`, `mailer`,
`notify`, `auth-core/cookie`, `health`, `telemetry`) take `fetchImpl` or plain
arguments instead and need no such line.

## Three conditions

This repository is public and MIT-licensed. That is a decision, and it rests on
three conditions that hold for every commit:

1. **The kit never contains a product's configuration.** Routes, rate-limit
   policies, cookie names, domains, prompts and plan tables stay in the private
   repositories they belong to. What is here is mechanism; policy is an
   argument passed into it.
2. **No `.env` with real values, ever.** A gitleaks scan runs in the pre-commit
   hook and again in `scripts/release.sh`. Enable the hook in a fresh clone
   with `git config core.hooksPath .githooks`.
3. **Privacy is not a layer of defence.** The code is written as though an
   attacker is reading it, because one may be. Nothing here is safe by being
   unpublished — the primitives are safe, or they are not.

## Development

```bash
npm install
npm test          # vitest, node environment
npm run typecheck
npm run build     # writes dist/
npm run scan      # gitleaks over the working tree
```

Every module has tests, and they are meant to be able to fail: the suite covers
the not-configured branches, the circuit breaker closing again after its
cooldown, the replay window rejecting both a stale and a future timestamp, the
connector answering 503 rather than serving an unsigned request, a rate limit
that refuses at the ceiling **and lets the caller through once the window has
slid past**, and a revocation whose row dies before its cache key. A test that
cannot fail proves nothing about the code it names — three of these were written
first and found something: an empty stored password hash that verified every
password, a proxy hop count of zero that made one rate-limit bucket for the
whole internet, and an entry-graph walker that could not see a braced type
import.

## Releasing

```bash
./scripts/release.sh 0.1.1
```

Scan, then typecheck and tests, then build `dist/`, then commit, tag `vX.Y.Z`
and push. The scan is first because a secret that reaches a push on a public
repository is already exposed, and the build is after the tests because `dist/`
is committed and shipping an artifact from an unverified tree puts untested
code into a release.

A version is what products pin. Tags are never moved.
