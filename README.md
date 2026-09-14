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
npm i github:eXocriador/exo-kit#v0.8.0
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
uv add "git+https://github.com/eXocriador/exo-kit@v0.8.0#subdirectory=python"
```

## Modules

| Import | What it gives you | Pulls in |
|---|---|---|
| `@exo/kit/infra` | `createDb`, `createRedis` | `postgres`, `ioredis` |
| `@exo/kit/json` | `isRecord`, `asArray`, `asString`, `asNumber`, `asBoolean`, `get`, `getPath` | nothing |
| `@exo/kit/log` | `createLogger` — pino + an audit trail, optional log shipping | `pino` |
| `@exo/kit/ai` | `createAiClient` — ask the exo-ai model service for a tier; typed refusals | nothing |
| `@exo/kit/llm` | `createLlm` over Ollama / Anthropic / OpenAI / an OpenAI-compatible gateway; `createEmbedder` | nothing |
| `@exo/kit/http` | `createApiResponse`, `createRateLimiter`, `createClientIp`, `validateHost`, `safeFetch` | `node:crypto`, `node:dns`, `node:net` |
| `@exo/kit/auth-core` | `hashPassword`, `verifyPassword`, TOTP, `createAuthTokens`, `createSessionStore` | `node:crypto` |
| `@exo/kit/auth-core/cookie` | `createSessionCookie` — sign and verify a session cookie | nothing |
| `@exo/kit/auth` | `createAuth` — the whole login: providers, magic link, TOTP, cabinet, admin | `better-auth`, `pg` |
| `@exo/kit/auth/migrations` | `authMigrations` — the SQL files the login ships, for a migration script | nothing |
| `@exo/kit/health` | `createHealth` — `live()` / `ready()` as Web-standard responses | nothing |
| `@exo/kit/env` | `defineEnv`, `renderEnvExample` — one schema per product | `zod` |
| `@exo/kit/telemetry` | `createTelemetry` — one seam for "something went wrong" | nothing |
| `@exo/kit/mailer` | `createMailer` — transactional email over Resend; `senderAddress`, `isOwnSender` | nothing |
| `@exo/kit/notify` | `createTelegramDm`, `createEscalationNotifier` — Telegram first, email as the fallback | nothing |
| `@exo/kit/migrate` | `syncKitMigrations`, `checkKitMigrations`, `migrationVersion` — put a block's SQL where dbmate can read it, and catch drift | `node:fs`, `node:path` |
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

**`zod` may be 3 or 4.** The peer range is `^3.25 || ^4` since v0.7.1. It used
to be `^3.25` alone, and because a peer conflict stops `npm ci` from installing
the tree *at all*, a product on zod 4 could not install the kit without an
`overrides` block — which is what tyusha was carrying. Widening it was not a
guess: every one of the kit's schemas was run against `zod@4.6.4`, and the whole
suite is green on both majors. Only one thing actually broke, and it is a type
rather than a behaviour — `CustomSchema<T>`, the argument type of `env.custom()`,
named `z.ZodTypeDef` in `ZodType`'s second slot, and zod 4 both removed that type
and gave the slot a different meaning (`Input`). It is now spelled
`z.ZodType<T, any, any> & { _input: string }`, which means the same thing in both
majors: a schema whose input is the raw environment string. `test/env.test.ts`
holds what it accepts and what it refuses, so `npm run typecheck` is the check —
run it under both majors when touching that type:

```bash
npm run typecheck && npm test          # whichever major is installed
npm i zod@4 --no-save && npm run typecheck && npm test && npm i
```

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

## Models: `@exo/kit/ai`

A product asks the exo-ai service for a **tier** — `fast`, `capable`, `agent` —
and never for a model. Which model answers, which pool it is metered in, how
far the ladder has to climb to find a live one and how many calls a product or
one of its customers may make today live in the service, shared by every
product. This module is the wire to it.

```ts
// src/infra/ai.ts — the product's wiring
import { createAiClient } from '@exo/kit/ai';

export const ai = createAiClient({
  baseUrl: env.EXO_AI_URL, // http://exo-ai-web:3000
  key: env.EXO_AI_KEY,     // the product's key; it also names the product in the ledger
  reportError,
  logWarn,
});

const out = await ai.complete({
  tier: plan.free ? 'fast' : 'capable', // which tier a plan buys is the product's decision
  messages,
  subject: `${productId}:user:${userId}`,
  timeoutMs: 90_000,
});

if (out.ok) return out.content;                       // plus out.model, out.pool, out.rung
if (out.error === 'budget_exhausted') return handOver(); // a person, not an error, not a bill
return failSafe();                                    // all_rungs_failed, timeout, unavailable, …
```

### Two refusals, two actions

`@exo/kit/llm` answered every failure with `null`, so a product could only
ever do one thing about all of them. Two of them mean opposite things:

| result | what happened | what the product does |
|---|---|---|
| `budget_exhausted` (`degrade: 'human_handoff'`) | a daily ceiling closed; the service is healthy and chose not to call a model | hand the conversation to a person — no error on screen, no charge |
| `all_rungs_failed` | every rung was tried across pools and none answered | the product's fail-safe |
| `unknown_tier`, `unauthorized`, `bad_request` | an integration mistake — reported through `reportError` | fail-safe, and fix the wiring |
| `timeout`, `unavailable` | the service did not answer the contract | fail-safe |
| `not_configured` | no address or no key; nothing was sent or reported | whatever the product does without models |

A bare 429 or 503 **without** the service's body is `unavailable`, not either
refusal: it is some other hop talking, and neither "the ceiling closed" nor
"the ladder ran" is true of it. `complete()` never throws.

### The timeout is the whole ladder's

The service has its own timeout per model and may try several, so the client's
ceiling bounds the whole climb. It is set per call (`timeoutMs`), with a client
default of 60 s — `@exo/kit/llm` fixed one 30 s for everything, which made a
long reasoning call indistinguishable from a dead one. A call the client gave
up on may still finish, and still count, inside the service.

### What is deliberately not here

* **Retries.** The service retries per model and steps across pools. A client
  retry would run that ladder again and charge the ceiling twice for one
  question.
* **A long `subject`.** The service keeps 200 characters; a longer one is
  refused before sending, because two subjects sharing a 200-character prefix
  would share one counter.
* **Embeddings.** The service does not compute them. `createEmbedder` stays in
  `@exo/kit/llm`, and so does the chat client, until the last product still
  calling it has moved.

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
    // `link` carries both the ready URL and the raw token — see below.
    letters: { magicLink: (link, minutes) => loginEmail(link, minutes) },
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
   with no reset. A product arriving with somebody *else's* format may hand in
   `email.legacyPassword.verify`; that is a bridge with an end, not a second
   supported format — see "a password hashed before the kit existed".
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

### A password hashed before the kit existed

`email.legacyPassword` — added in v0.7.1, and the only amendment fixed decision
4 has ever taken.

Two products cannot reach this module without it. syncwatch has six live people
on bcrypt `$2b$10$` and **not one address the kit could mail**; tyusha has its
own on cost 12. "Everybody resets their password" is not a migration there, it
is a locked door with nobody on the other side to open it.

```ts
email: {
  password: true,
  legacyPassword: { verify: ({ password, hash }) => bcrypt.compare(password, hash) },
}
```

Three rules make it a bridge rather than a hole:

* **It is asked only about a string our own format does not claim.** A
  `scrypt$…` row never reaches the product's function, so one permissive
  verifier cannot quietly put the portfolio back on bcrypt.
* **Accepting a password rewrites the row.** The same sign-in that lets the
  person in stores `scrypt$…`, and their next one takes the native path. The
  option empties itself; when `select count(*) from identities where provider =
  'credential' and password not like 'scrypt$%'` is zero, delete it.
* **A throw counts as "no".** These rows are exactly where a truncated or
  half-imported string survives, and `bcrypt.compare` rejects on one. One
  person's password refused is the right cost; everybody's login returning 500
  is not.

`bcryptjs` is deliberately **not** a kit dependency — the kit has no opinion
about which format a product is leaving. It is a `devDependency` only, because a
test that substituted a fake verifier would prove the kit calls a function it
was handed, which was never in doubt.

#### Why the rewrite is not inside `verify`

This was the whole design question, and the obvious shape does not work. The
library types that callback as

```ts
verify: (data: { password: string; hash: string }) => Promise<boolean>
```

— no user id, no context, no adapter. It is asked "does this string match this
hash", and a function that only ever sees those two strings **cannot write a
row**. So the bridge needs a second seam, and three were on the table:

* `databaseHooks` — never see a plaintext password, so they cannot produce the
  new hash. Out.
* `ctx.context.password.checkPassword(userId, ctx)` — does have the identity,
  and is **built into the context rather than read from the options**
  (`create-context.mjs` closes over the imported function). It is not a seam at
  all, and it only delegates to `password.verify` anyway. Out.
* The module's own `after` middleware on `/sign-in/email` — has the typed
  password (`ctx.body`), the identity (`ctx.context.newSession`) and the write
  (`internalAdapter.updatePassword`). **Chosen.**

Nothing is carried over from `verify` — no marker, no map keyed by a hash. A
sign-in that reached a session proves the password matched, so a stored string
that is *still foreign at that point* is one the product's reader just accepted.
That makes the decision stateless, and two people signing in at the same moment
cannot be confused for each other. It costs one indexed `SELECT` per password
sign-in, charged only to a product that configured the option.

Two silences are deliberate. The after hooks **also run when the endpoint
threw** — `dispatch.mjs` keeps the `APIError` as the response and runs them
anyway — so `newSession` is the success test and a wrong password rewrites
nothing. And a failed write is logged through the library's logger and
swallowed: the person is already authenticated, and turning their successful
login into a 500 to announce that the next one will also be slow is the wrong
trade.

Proved on a copy of the live syncwatch database with its E1 migration applied —
all six real `$2b$10$` rows in, all six `scrypt$` out, second sign-in never
reaching the product's function. `test/auth-legacy-password.test.ts` holds it
over the memory adapter with real bcrypt strings, and `test/auth-postgres.test.ts`
holds the half only Postgres can state: that the write lands in the renamed
columns.

### Three things the schema changes about `auth.md`

* **`users.email` is now UNIQUE** (on `lower(email)`). The standard used to say
  "if in doubt, a second account"; the library cannot express that and refuses
  the login instead. Same safety property, different experience.
* **`UNIQUE (provider, provider_id)` is ours.** `auth@1.7.4 generate` emits only
  an index on `userId`, so two tabs finishing one login at the same moment would
  write two identity rows. The migration supplies the key.
* **Only the magic link's row in `verification` is hashed.** Since v0.9.0 the
  kit passes `storeToken: 'hashed'`, so that row's `identifier` is SHA-256 of the
  token (the column earlier text here called `value`), which is what the
  products' own `login_tokens` stored. The password-reset row
  (`reset-password:<token>`) still holds the token as issued — Better Auth
  1.7.4 has no switch for it — so a dump of the table is a working reset link
  until that row expires.

### The magic link deletes passwords, and that is deliberate

A magic link into a row with `email_verified = false` **deletes that row's
password and every OAuth link it had**, then marks the address verified. It is
not a bug: it is the fix for `GHSA-qq9h-g4jm-xgf3`, and it says the proven owner
of a mailbox inherits nothing that predates the proof. The consequence is fixed
decision 3 — without verification at sign-up, a person who registers with a
password and then clicks a login link loses that password permanently and
silently. `test/auth-wrapper.test.ts` pins the behaviour so it cannot change
under us unnoticed.

### The letter gets the token, not just the URL

`letters.magicLink({ url, token }, minutes)`. The ready `url` consumes the token
on a **GET**, and mail scanners and link previewers follow URLs before a person
does — a one-time link they burn makes the login fail silently for whoever asked
for it. A product that cares puts `…/login?token=<token>` in the letter instead,
pointing at a page whose *button* navigates to the verify route; the scanner then
fetches a static page and spends nothing. filebrowser does that.

### What is NOT reproduced from `auth.md`

The standard puts the provider's name inside the `state` value
(`"<provider>.<nonce>"`) so a code from one path cannot be presented on another
"before the network". Better Auth does not, and does something stronger instead:
the state is written to both a row and a signed cookie, both are compared on
return, and the row is deleted on use. The prefix only ever added an earlier
failure to an exchange that could not have succeeded anyway, so it is dropped
rather than rebuilt.

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

`auth.migrations` — or `authMigrations({ totp, admin })`, which is the same list
without building anything, and is what a migration runner should use: reading it
through `createAuth` means handing `betterAuth` a database it will try to
connect to, and the script dies with `Failed to initialize database adapter`.

The list is SQL file paths, in order, to be applied **before the product's
own**: `20200101000001_kit_auth.sql` always, `20200101000002_kit_auth_2fa.sql`
only with `totp`, `20200101000003_kit_auth_admin.sql` only with `admin`. What
applies them is dbmate, and how the files get to it is
[`@exo/kit/migrate`](#migrations-exokitmigrate). Each one is
convergent — `CREATE TABLE IF NOT EXISTS` for a new product, `ADD COLUMN IF NOT
EXISTS` for one that already has `auth.md`-shaped tables. What they deliberately
do not do is change the type of an existing column or move a primary key: that
needs to know how many rows are in the table, and only the product knows that.

**The migrations must run before `createAuth`, not after.** Better Auth 1.7.4
checks the schema once and remembers the answer, so an instance built over a
database that is still missing its columns keeps refusing after the columns
arrive — with `Database schema mismatch / Missing columns users.two_factor_enabled`
against a database that plainly has the column. A deploy that constructs the
login and then runs `migrate.sh` is the shape that hits this. Use
`authMigrations({ totp, admin })` for exactly that reason: the list is available
before there is anything to build. Found in v0.7.1, by an opt-in test that had
been building first and migrating after and failing about half the time.

Enabling `admin` is worth a thought rather than a reflex. Its gate is
`users.role = 'admin'`, a row in the database — so a product whose admin is
decided another way (filebrowser matches a verified address against
`ADMIN_EMAIL`) gains fifteen routes its only admin can never pass.

### Turning TOTP on costs the secret

Better Auth **encrypts** `two_factor.secret` and the backup codes with the
application secret, where `auth-core/totp` stored the secret as issued. Strictly
better — a database dump no longer mints codes — and it means **losing
`SESSION_SECRET` now loses every second factor**, not just every session.

## Migrations: `@exo/kit/migrate`

Migrations are applied by **dbmate** (`amacneil/dbmate:2.35.1`), a single Go
binary in its own container — not by a runner in this package. Five products
had five runners, three of them copies of each other that had already drifted,
and the sixth product is Python: a runner written in the product's language is
a runner per language, a container is one per box. The wrapper that calls it is
`templates/migrate.sh`, copied into each product as `migrate.sh`.

This module is the one part of that which cannot be a shell script.

### The decision: the SQL is vendored, not read from the package

dbmate reads **directories**. The SQL a kit block ships lives inside an npm
package, and dbmate's container has no Node in it, no `node_modules` mounted,
and no way to ask what `authMigrations()` would return. Something has to put
those files where it can see them.

**What we do:** `exo-kit-migrations sync --dir <product>/migrations/kit` copies
them, byte for byte, into the product's tree, where the product commits them
like any other file. This is what plan §4.3 describes, and it is the step
`exo upgrade` will absorb.

**The price, stated plainly:** there are now two copies of the login schema —
the kit's and the product's — and a stale copy silently applies an old schema.
That is a real cost and it is why `checkKitMigrations` exists: it compares the
copies against the installed package byte for byte and names every way they can
disagree (`missing`, `changed`, `extra`). It runs as a gate in the product's
image build, where the installed package is the pinned version and drift is
still cheap to fix. `sync` never deletes a leftover — a file already applied to
a live database is not garbage, and nothing in this process knows which
databases exist.

**The alternative we did not take**, and what it would have cost: resolve the
paths at run time through `authMigrations()`, so there is only ever one copy.
The B2 session left that argument in `filebrowser`'s runner and it is a good
one — but dbmate cannot call Node. Honouring it means either a Node runtime on
the host with the product's `node_modules` installed there (RAM we do not have,
and a tree that belongs to another user), or a Node bootstrap inside every
product image to extract the files before dbmate starts. The second works for
Node products and cannot work for `exopost`, which is Python — and language
neutrality is the main reason dbmate was chosen at all (plan §4.3). Paying for
one truth with a mechanism that only half the products can run is the worse
trade. So: one mechanism everywhere, and a gate against the copy going stale.

### Calling it

```ts
// Its own subpath since v0.9.0: `@exo/kit/auth` still re-exports it, but
// through that barrel a script pays for Better Auth to read three file names.
import { authMigrations } from '@exo/kit/auth/migrations';
import { checkKitMigrations, syncKitMigrations } from '@exo/kit/migrate';

// The flags must mirror what the product passes to `createAuth` — they decide
// which files exist at all.
const options = { files: authMigrations({ totp: false }), dir: 'apps/api/migrations/kit' };

syncKitMigrations(options);   // after bumping @exo/kit; commit what it writes
checkKitMigrations(options);  // in the image build; `{ ok: false }` fails the gate
```

or, without writing a script, the CLI the package installs:

```
exo-kit-migrations sync  --dir apps/api/migrations/kit [--totp] [--admin]
exo-kit-migrations check --dir apps/api/migrations/kit [--totp] [--admin]
```

`check` exits 1 on any disagreement and writes nothing — a gate that repaired
what it measured would always pass.

### File names are an ordering floor, not dates

A kit block's files are `20200101…`. That is not the day they were written: it
is a floor. dbmate orders by the number in the file name **across every `-d`
directory at once**, and a kit block has to land before the product migrations
that build on it — including netwatch, whose own first migration is
`20260828…`, and any product older still. The floor is the same in every
product, so the version recorded for the file is the same everywhere too.

### Every file needs both markers, and ours refuse to roll back

dbmate 2.35.1 rejects a migration with no `-- migrate:up` **and** one with no
`-- migrate:down` — at apply time, not at `status`, so a missing marker is
found by a deploy unless a test finds it first (`test/migrate.test.ts` does).

Our files carry a down block that raises:

```sql
-- migrate:down
DO $$ BEGIN RAISE EXCEPTION 'no rollback: 20200101000001_kit_auth'; END $$;
```

Convergent migrations have no single meaning for "undo" — the same file may
have created a table or added a column to one that was already there — and
every honest guess drops something with accounts in it. So `rollback` fails
loudly, the schema and the recorded version both survive (verified: the
exception aborts dbmate's transaction, exit code 2), and forward-only stays the
standard. A migration written from scratch for a product may of course carry a
real `down`.

### Moving a live database onto dbmate

Our runners recorded the **file name**; dbmate records the **version**, the
digits the name starts with. So an existing product is a rename plus a
hand-written seed, and without the seed dbmate re-applies the whole history to
a live database.

1. Rename each `NNN_name.sql` to `<timestamp>_name.sql`, taking the timestamp
   from `applied_at` of the real run (`SELECT filename, applied_at FROM
   schema_migrations`), so the new order is the order that actually happened.
   Kit files keep the floor version above instead — it is the file's name in
   every product.
2. Add `-- migrate:up` / `-- migrate:down` to each.
3. Then, in one transaction:

```sql
BEGIN;
CREATE TABLE schema_migrations_pre_dbmate AS SELECT * FROM schema_migrations;
DROP TABLE schema_migrations;
CREATE TABLE schema_migrations (version character varying NOT NULL PRIMARY KEY);
INSERT INTO schema_migrations (version) VALUES ('20200101000001'), ('20260912080138');
COMMIT;
```

`DROP`, not `ALTER`: dbmate's table is `version varchar PRIMARY KEY` and the
old one is `(filename, applied_at)`. Left in place it is not ignored — dbmate
fails with `pq: column "version" does not exist` before doing anything, which
is at least loud.

**The proof of a transition is `dbmate status` against the live database**:
`Pending: 0`, every historical migration marked `[X]`, nothing re-applied. Not
a runner's log — the status output.

### The five traps in `migrate.sh`

Proven by running them (audit `2026-09-12-auth-sandbox.md` §4), each one worth
a broken deploy:

1. **Only `DATABASE_URL`.** Our canonical name is `POSTGRES_URL`, so
   `--env-file .env` alone does nothing — the wrapper translates the name.
2. **`?sslmode=disable` is required**, or `pq: SSL is not enabled on the server`.
3. **`--no-dump-schema` is required**, or dbmate writes `db/schema.sql` into
   the mounted directory — a silent edit of the product's tree. The wrapper
   mounts `:ro` as well.
4. **On failure dbmate prints `Applied: … in 11.17ms` first and `Error:`
   after.** The output cannot be read; only the exit code can.
5. **The accounting key is the timestamp in the name, not the name.** Two
   directories via `-d` twice work, and the order is by timestamp across both
   — not "this directory, then that one".

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
  // `storedId` is the hash in `sessions.id`, not the cookie's id (v0.9.0).
  resolvePrincipal: async (sql, storedId) => {
    const rows = await sql`
      SELECT s.id AS session_id, u.id::text AS user_id, u.role, u.status
      FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id = ${storedId} AND s.expires_at > NOW()
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

### Session ids are stored hashed since v0.9.0

`createSessionStore` puts the SHA-256 (hex) of a session id into `sessions.id`
and hands the raw id back for the cookie — the way `createAuthTokens` has
always stored `auth_tokens`. Before v0.9.0 the column held the id as issued, so
a copy of the table was a list of live sessions (netwatch audit, N-24).

What that changes for a product:

- **`resolvePrincipal(sql, storedId)` receives the hash.** A resolver that only
  compares (`WHERE s.id = ${storedId}`) needs no edit. Whatever the principal
  carries as `sessionId` is therefore the hash too — and so is `SessionInfo.id`,
  so `s.id === principal.sessionId` in a cabinet keeps working.
- **Raw in, from a cookie:** `resolveSession(raw)`, `revokeSession(raw)`.
  **Stored in, from the database:** `revokeOwnedSession(userId, storedId)`,
  `revokeOtherSessions(userId, keepStoredId)`. A product writing its own query
  against `sessions` uses `sessionIdHash(raw)` from `@exo/kit/auth-core`.
- **Existing rows must be moved once.** The column stays `text`, and the hash
  of a 64-character hex id is 64 hex characters. Postgres ≥ 11 computes the
  same string natively — no `pgcrypto`:

  ```sql
  -- Exactly once per database. A second run hashes the hashes and signs
  -- everybody out; a dbmate migration in the product is what keeps it to once.
  UPDATE sessions SET id = encode(sha256(convert_to(id, 'UTF8')), 'hex');
  ```

  Put it in a product migration so it runs in the deploy's migrate step, right
  before the new image starts. Between the two, the old code looks up raw ids
  in a table of hashes: a request that lands in those seconds is refused once
  (the row is not lost — the next request on the new code resolves).

  The two alternatives, named for what they cost:
  - **`TRUNCATE sessions`** — everybody is signed out, and nothing needs
    thinking about.
  - **Do nothing** — the same outcome as `TRUNCATE` for every user (no existing
    cookie resolves any more), with the old rows left in the table until their
    `expires_at`. They are no longer credentials — a raw id presented as a
    cookie is hashed and matches nothing — but they are dead weight nobody
    chose to keep.

Proven on a copy of netwatch's live database before release (v0.9.0): the
`UPDATE` above, read out of this file rather than retyped, left no raw id in the
table; `sessionIdHash(raw)` found each of the three rows; and the raw id of each
resolved through the new store, with netwatch's resolver verbatim, to a
principal of the same user whose `sessionId` is the hash. All three sessions had
already lapsed, so the copy — only the copy — had `expires_at` moved an hour
ahead first; without that the resolver's expiry predicate is all a run proves.

### A revocation says whether it happened

`revokeUserSessions`, `revokeOtherSessions` and `revokeSession` answer
`{ ok: true, revoked }` or `{ ok: false }`; `invalidateUserCache` answers
`{ ok: true, invalidated }` or `{ ok: false }`. Zero is an answer — the database
replied and there was nothing to do. `ok: false` is the database not replying,
and then nothing was revoked, not even from the cache: the ids were never read.
A route that reports the result to a person must read it:

```ts
const revoked = await revokeUserSessions(id);
if (!revoked.ok) return apiError('Database unavailable — sessions were NOT revoked', 503);
return apiOk({ ok: true, sessionsRevoked: true });
```

`revokeOwnedSession` still answers a `boolean`, and its `false` still means
either "not this user's" or "no database": an object in its place would be
truthy in every `if (await revokeOwnedSession(…))` that exists.

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

Modules whose "Pulls in" column reads *nothing* (`json`, `ai`, `llm`, `mailer`,
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
