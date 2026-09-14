# Changelog

Semantic versioning. One tag covers the whole kit; the sections below are per
module, so a consumer can see whether a release touches anything it imports.

## v0.9.1 — 2026-09-14

Templates only. No module changed; a consumer's bump does nothing.

### templates

**Docker archetypes** (plan §5 C2, the kit half). Written from the decisions the
product half left in §10 of `products/AGENTS.md`, block «Модульність, C2
(продуктова половина)». `templates/docker/` gains seven Dockerfile archetypes —
`static-nginx` (+ `nginx.conf`), `next-standalone`, `node-api` (+ `build.mjs`),
`node-prisma`, `node-worker`, `python-uv`, `python-wrapper` — and
`compose-service.yml`, with a README that names the placeholders, the canonical
portfolio member of each form, and the proof. Common to all seven: a base with
the Debian codename in the tag (`node:22-bookworm-slim`,
`python:3.12-slim-trixie` — the bare tags already point at different Debian
releases), a non-root `USER`, a `HEALTHCHECK` with `--start-interval` and no
curl or wget in Node and Python images, `ARG APP_VERSION` in the last stage,
gates in a stage the final image actually copies. Three decisions taken here
rather than lifted from a product: the worker form is on bookworm-slim, not
alpine; the wrapper form installs with `pip --require-hashes`; the compose block
carries `no-new-privileges` and `cap_drop: ALL` but not `read_only`. Reasons are
in the files.

**Each archetype was built and run** over a stub of its form; numbers in
`templates/docker/README.md`. The negative proofs: without `rm -rf node_modules`
pnpm 12.4.1 still carries dev packages into the runtime (61 MB with typescript,
esbuild and vite, against 15 MB), and a failing test in `python-uv`'s `test`
stage fails the build.

README: new section "Templates: `templates/`". `templates/migrate.sh` is untouched.

## v0.9.0 — 2026-09-14

The queue of requests product sessions left in §10 of `products/AGENTS.md` on
2026-09-13, closed in one release. **Minor, not patch: A changes a contract** —
what `sessions.id` holds and what `resolvePrincipal` receives — and existing
rows need a one-off `UPDATE` on the bump. In 0.x a breaking change is a minor.

### auth-core

**A. Session ids are stored hashed** (N-24; §10, block «netwatch: хвіст аудиту
(N-04, N-06, N-11, N-12, N-17) і канон `DATABASE_URL`»). `createSession` writes
`sha256(raw)` hex into `sessions.id` and returns the raw id for the cookie;
`resolveSession` and `revokeSession` hash what the cookie carries before it
touches `sql` or the cache; cache keys are the stored form, which is what lets
the bulk revocations clear them from ids read out of the table. **Contract
change:** `resolvePrincipal(sql, storedId)` now receives the hash, and so
`SessionInfo.id` and whatever a principal builds its `sessionId` from are the
hash too. `revokeOwnedSession` and `revokeOtherSessions` take that stored form;
`resolveSession` and `revokeSession` take the raw one. New export
`sessionIdHash(raw)` (also on the store, beside `AuthTokens.tokenHash`).

**On the bump, every consumer with rows runs once:**
`UPDATE sessions SET id = encode(sha256(convert_to(id, 'UTF8')), 'hex');` — or
`TRUNCATE sessions` and everybody signs in again. README, "Session ids are
stored hashed since v0.9.0", has both and the window between them. Proven on a
copy of netwatch's live database (3 rows), not only by a test.

**B. A revocation says whether it happened** (§10, block «netwatch: хвіст
аудиту …», N-11 and the request under N-24). `revokeUserSessions`,
`revokeOtherSessions` and `revokeSession` answer `RevokeResult` —
`{ ok: true, revoked: n }` or `{ ok: false }` — and `invalidateUserCache`
answers `InvalidateResult` (`invalidated: n`). They used to answer `void`, and
`ids ?? []` read a DELETE that threw as "nothing to delete", which is how
netwatch could tell an administrator `sessionsRevoked: true` about sessions that
were still live. **Compatible:** `void` → a value breaks no caller that ignored
it. `query`'s `null` is what tells the branches apart — every callback here
returns a row list, which is an array even when empty — so `SessionStoreConfig`
does not grow a `tryQuery`. `revokeSession` was not in the request and has the
same shape, so it moved too.

Not moved, deliberately: `revokeOwnedSession` still answers `boolean`, so its
`false` still covers "not yours" and "no database". An object there would be
truthy in exointel's `if (match && (await revokeOwnedSession(…)))` and turn
every refusal into a success — the opposite of this entry.

### auth

**C. The magic link's row is a hash** (§10, block «Модульність, B2, споживач 2:
exoanima на `@exo/kit/auth`», request 2). `magicLink({ storeToken: 'hashed' })`:
`verification.identifier` is SHA-256 (base64url) of the token, and the library
hashes the incoming token before its lookup, so the link in the letter works as
before at no cost. `test/auth-wrapper.test.ts` holds both halves — nothing in the
row contains the token, and the letter's link still signs in — and fails with
the option removed.

**No rows are moved, and that has a visible edge:** a link sent before the bump
holds its token as issued, and the lookup now hashes, so that one link stops
working. They live `linkMinutes`; whoever clicks one asks for another.

Said plainly, because the request read wider than this: the password-reset row
(`reset-password:<token>`) still stores the token as issued — Better Auth 1.7.4
has no option for it. The comment in `20200101000001_kit_auth.sql` that calls
`verification` live credentials is left alone: changing the file's bytes would
fail every consumer's `exo-kit-migrations check` on the bump for a comment.

**D. `@exo/kit/auth/migrations` — the migration list on its own subpath**
(packaging). Not a numbered request in §10: B3's first half (block «Модульність,
B3 (перша половина)») moved `authMigrations` into its own module and left the
export where it was, and E1-syncwatch (request 2) paid for the barrel in a Next
build. `src/auth/migrations.ts` never imported
`better-auth`, but `package.json` exported it only through the `@exo/kit/auth`
barrel, which does; the kit's own CLI dodged that with a deep import into
`dist/` that `exports` forbids a consumer. `import { authMigrations } from
'@exo/kit/auth/migrations'` now costs nothing. The barrel keeps its re-export
(compatibility). `test/entry-graph.test.ts` pins the subpath, its empty import
graph, and — new — that every `exports` entry has a source module.

What D does **not** fix: Turbopack failing on `new URL('../../migrations/auth/',
import.meta.url)` in a Next build. The subpath is the same code; a product on
Next that imports the barrel still needs `serverExternalPackages`.

### migrate

**E. `format: 'prisma'` — a vendored copy Prisma can apply** (§10, block
«Модульність, E1-syncwatch», request 3 — not B2-exoanima, which the queue
named). Prisma applies a migration file whole, so a byte copy of a kit file ran
its own `-- migrate:down … RAISE EXCEPTION` and failed. `syncKitMigrations` /
`checkKitMigrations` take `format: 'dbmate' | 'prisma'` (default `dbmate`), and
the CLI takes `--format prisma`: `<dir>/<name>/migration.sql` with a two-line
header and the up half only; `check` compares against that rendering. In the
shared Prisma directory only `20200101…` subdirectories count as copies (new
export `KIT_VERSION_FLOOR`); new export `migrateUpHalf(text)`. `--format` with
anything else exits 2. Run end to end through the CLI against a Prisma-shaped
directory (sync → check exit 0; the product's own migration and
`migration_lock.toml` untouched); **not** run through `prisma migrate deploy`
here — the kit has no Prisma. The half it renders is the same half syncwatch
cut by hand and Prisma applied in production.

**Nobody on dbmate regenerates anything:** the default format and the SQL files
are byte-identical to v0.8.0. syncwatch, the one Prisma consumer, keeps its hand
copy under `20260913100001_kit_auth` until its own session decides — the tool
would add the floor-named copy beside it (README, "A product on Prisma").

### templates

**F. `migrate.sh` on the canonical `DATABASE_URL`** (C3, the control session's
decision of 2026-09-13 in plan §5; and §10, block «Модульність, B2, споживач 2:
exoanima на `@exo/kit/auth`», request 5 — both halves). The template no longer
reads `POSTGRES_URL` and translates it: it reads the variable named by a
**fifth parameter**, `DATABASE_VAR="DATABASE_URL"`, beside `IMAGE`,
`IMAGE_WORKDIR`, `MIGRATION_DIRS` and `DBMATE`, so exoanima and exopost keep
their prefixes. `?sslmode=disable` is still appended when absent (trap 2 is
real). **`MIGRATE_DATABASE_URL`** is captured *before* `set -a; . ./.env` —
which overwrites the environment, and is how B2-exoanima's rehearsal aimed at a
copy went to the live database — so `.env` can neither override it nor set it,
and a run with it prints a warning naming the target host (not the
credentials). `test/migrate-template.test.ts` (new) runs the real template under
bash with a fake `docker` and asserts the `DATABASE_URL` the dbmate container
would get, in eight cases.

**A copy of the old template in a product keeps working** — copies are the
product's. A product re-copying it from v0.9.0 while still on `POSTGRES_URL`
is refused by name (`DATABASE_URL не задано в .env`) and nothing runs.

### infra, env

Prose only, for C3: the `createDb` and `defineEnv` examples and two doc comments
say `DATABASE_URL`; `test/env.test.ts` uses it as the sample name. The kit still
never reads `process.env`.

### env

**G1. `defineEnv(schema, source, { refine })` — rules across variables** (§10,
block «Модульність, B1-netwatch: другий споживач kit v0.5.1», request 1).
filebrowser's `pair()` and netwatch's mode-dependent `SESSION_SECRET` lived
outside `EnvError` and so outside its promise. `refine(values) => problems[]`
runs once every field has parsed, over the typed frozen values, and its problems
join the same `EnvError` by name (typed to the schema's keys). A reason that
contains any variable's raw value is replaced with `rejected by a rule across
variables` — except a value the schema spells out itself (an enum member, a
boolean word: new `FieldMeta.vocabulary`), found the hard way by the kit's own
test, whose `required in production` was being eaten because `NODE_ENV` was
`production`. Deliberate: a rule is not run while a field is failing — its
argument would be typed as a lie — so a bad field and a broken rule take two
boots, not one. New exports `EnvProblem`, `DefineEnvOptions`. Compatible: the
third argument is optional.

### infra

**G2. `ErrorContext.component` is open** (§10, block «Модульність,
B1-teamself: третій і останній споживач kit v0.5.1», request 1).
`KitComponent | (string & {})`: the kit's names stay as suggestions, and a
product factory (`createLinear`, `component: 'linear'`) takes the same
`reportError` as a kit factory with no wrapper. New export `KitComponent`. This
retracts v0.8.0's note that an exhaustive `switch` over the field gets a compile
error — that was the closed union's only benefit and the reason products could
not share the reporter.

Tests: 441 → 483, files 28 → 30 (`sessions` A and B, `auth-wrapper` C,
`entry-graph` D, `migrate` E, `migrate-template` F — new, `env` and
`error-context` G — new); 7 opt-in skipped, as before. The opt-in
`auth-postgres` suite was not run for this release.

## v0.8.0 — 2026-09-13

### ai (new)

**`createAiClient` — the wire to exo-ai, the model service.** Step E2-a of the
modularity plan. A product asks for a tier (`fast`, `capable`, `agent`) and
gets back either the answer — with the model, pool and rung that produced it —
or a typed refusal. `complete()` never throws.

The reason it exists as its own module rather than as a fifth provider under
`llm`: **the two refusals a product must tell apart are the discriminant of the
result.** `budget_exhausted` (a daily ceiling closed, `degrade:
'human_handoff'`) and `all_rungs_failed` (every rung tried, none answered) call
for opposite actions — a person versus the fail-safe — and `@exo/kit/llm`
answered both with `null`. A bare 429 or 503 without the service's body is
`unavailable`, not either of them.

Three things deliberately not in it: **retries** (the service climbs the ladder;
a client retry would run it again and charge the ceiling twice), a **default or
fallback model** (the thing the service takes away from products), and
**`process.env`**. The timeout is per call, over the whole ladder, with a 60 s
client default — `llm` fixed 30 s for everything. A `subject` over the
service's 200 characters is refused before sending, because the service would
truncate it and two subjects sharing the prefix would share one counter.
`usage()` reads `GET /v1/usage`.

Pulls in nothing; `test/entry-graph.test.ts` pins that.

### infra

`ErrorContext.component` gains `'ai'`. A widening of a closed union: a product
that switches on it exhaustively gets a compile error, which is the point.

### llm

Unchanged, and not deprecated yet. `createEmbedder` has no replacement — the
service does not compute embeddings — and exointel still chats through
`createLlm`. The chat half goes once the last consumer has moved.

Tests: 418 → 441 (+22 `ai`, +1 entry graph); 7 opt-in skipped, as before.

## v0.7.1 — 2026-09-13

Two requests from consumers, both of which were blocking step E1.

### auth

**`email.legacyPassword` — a bridge off somebody else's hash format.** The one
amendment fixed decision 4 has taken. syncwatch has six live people on bcrypt
`$2b$10$` and not one address the kit could mail; tyusha has its own on cost 12.
Both were unable to reach this module at all, because `verify` was sealed inside
`buildAuthOptions` and everything but `scrypt$` was refused.

```ts
email: {
  password: true,
  legacyPassword: { verify: ({ password, hash }) => bcrypt.compare(password, hash) },
}
```

The product's function is asked **only** about a string `scrypt$` does not
claim, never instead of the native path; a password it accepts is **rewritten**
into the native format on that same sign-in, so the option empties itself and is
then deleted; and a throw counts as "no", because these rows are where a
malformed string survives and one refused password beats everybody's 500.
`bcryptjs` is a `devDependency` of the kit and nothing more — the kit has no
opinion about which format a product is leaving.

The rewrite cannot live in `verify`: the library hands that callback two strings
and no identity, so it cannot write a row. It lives in the module's own `after`
middleware on `/sign-in/email`, which has the typed password, the identity and
the adapter at once. Nothing is carried over from `verify` — a sign-in that
reached a session proves the match, so a row still foreign at that point is one
the product's reader just accepted. Alternatives weighed (`databaseHooks`,
`checkPassword`) and the two deliberate silences are in the README, "a password
hashed before the kit existed".

Proved on a copy of the live syncwatch database with its E1 migration applied:
six real `$2b$10$` rows in, six `scrypt$` out, second sign-in never reaching the
product's function.

`@exo/kit/auth-core` gains **`isKitPasswordHash`** — the shape test
`verifyPassword` already made, named because the bridge needs the same answer
for a different reason.

**`test/auth-postgres.test.ts` was dead, and is alive.** The opt-in suite
applied each migration file whole, including the `migrate:down` block added in
v0.6.x — and ours refuse to roll back by raising, which rolled the whole batch
back and killed `beforeAll` before one assertion ran. Once it ran, it was also
racy by construction: it built the instance and migrated afterwards, and Better
Auth 1.7.4 checks the schema **once and remembers**, so about half of all runs
failed with `Missing columns users.two_factor_enabled` against a database that
had the column. Both fixed; ten consecutive green runs. The ordering is a trap
for products too, and is now written down under "Migrations".

### env

**`zod` may be 3 or 4.** The peer range becomes `^3.25 || ^4`. A peer conflict
stops `npm ci` from installing the tree at all, so tyusha (on `zod@^4.4.3`) was
carrying an `overrides` block purely to install the kit; it can drop it.

Not widened blind: the whole suite was run against `zod@4.6.4` and is green on
both majors. One thing broke, and it is a type rather than a behaviour —
`CustomSchema<T>`, the argument type of `env.custom()`, spelled `z.ZodTypeDef`
in `ZodType`'s second slot, and zod 4 removed that type and gave the slot a
different meaning. It is now `z.ZodType<T, any, any> & { _input: string }`,
which means the same thing in both majors. `test/env.test.ts` gained the
compile-time assertions that hold it, so `npm run typecheck` is the check.

## v0.7.0 — 2026-09-13

### migrate (new)

`@exo/kit/migrate` — `syncKitMigrations`, `checkKitMigrations`,
`migrationVersion`, and the `exo-kit-migrations` CLI the package now installs.
Migrations across the box are applied by **dbmate** in its own container
(plan §4.3, B3); this module is the part of that which cannot be a shell
script — it copies the SQL a block ships into the product's tree, where dbmate
can read it, and fails a gate when the copy and the installed package have
drifted apart. The decision to vendor rather than resolve paths at run time,
and what the rejected alternative would have cost, are in the README section
"Migrations: `@exo/kit/migrate`".

`templates/migrate.sh` ships with the package: the canonical dbmate wrapper,
with the five traps it exists to avoid written into it.

### auth

**Breaking, for anything that reads the file names.** The SQL is renamed to
what dbmate orders by:

    001_kit_auth.sql       → 20200101000001_kit_auth.sql
    002_kit_auth_2fa.sql   → 20200101000002_kit_auth_2fa.sql
    003_kit_auth_admin.sql → 20200101000003_kit_auth_admin.sql

`authMigrations()` and `auth.migrations` are unchanged in shape and return the
new paths. The `20200101` prefix is an ordering floor, not a date: dbmate
orders by that number across every `-d` directory at once, and a kit block must
land before product migrations that are themselves older than this module. A
product already carrying the old names must rename its recorded rows — the
recipe is in the README ("Moving a live database onto dbmate").

Each file now carries `-- migrate:up` and `-- migrate:down`. dbmate 2.35.1
refuses a migration missing either, at apply time rather than at `status`. The
down block raises: a convergent migration has no single meaning for "undo", and
every honest guess drops a table with accounts in it.

`authMigrations` moved to its own module (`auth/migrations.ts`, still exported
from `@exo/kit/auth`) so reading the list imports no `better-auth`. The CLI
needs it in an image build where that peer dependency may not be installed at
all — the same reason v0.6.2 split it off `createAuth`, one step further.

## v0.6.2 — 2026-09-13

### auth

New export: `authMigrations({ totp, admin })` — the SQL file list on its own.
Found by the first consumer's migration runner, in a deploy: reading the list
through `createAuth` means handing `betterAuth` a database it will try to
connect to, so a script whose whole job was to read three file names died with
`Failed to initialize database adapter`. `auth.migrations` is unchanged and is
now this with the product's flags filled in.

## v0.6.1 — 2026-09-13

### auth

`letters.magicLink` (and the two password letters) now receive
`{ url, token }` instead of a ready URL alone, and the `beforeLink` hook is
gone. Both found by the first consumer.

The token is there because the ready URL consumes it on a GET, and mail scanners
follow links before a person does — filebrowser has had a consume PAGE since it
was written for exactly that reason, and without the raw token it could not keep
it. `beforeLink` went because it could only be handed nulls: the thing it was
sketched for is the provider prefix in `state`, and Better Auth's own state
handling (a row and a signed cookie, both compared, row deleted on use) is
strictly stronger than the prefix check it would have rebuilt. The README says
so where a reader of the standard will look for it.

## v0.6.0 — 2026-09-13

### auth (new subpath)

New: `@exo/kit/auth` — `createAuth({ db, secret, baseUrl, cookieName,
secureCookie, sessionDays, providers, email, totp, admin, rateLimitStorage,
trustedProxies, resolvePrincipal, hooks })` → `{ handler, fastifyPlugin,
getPrincipal, listSessions, revokeSession, migrations, instance }`, over
**Better Auth 1.7.4**, pinned exactly. Five of the portfolio's login
implementations become configuration; `auth-core` stays exactly where it is for
exointel and netwatch until they move.

The module's whole purpose is that **the policy in `auth.md` is not something a
product can get wrong**. Better Auth can express that policy and can equally
express its opposite, so seven decisions are fixed in the wrapper and are not
parameters — the merge rule, the base path and cookie attributes, verification
at sign-up, the password format, `uuid` ids, the session list without tokens,
and the encapsulated Fastify mount. The README has each one with its reason.

Three of those came out of the sandbox session and contradict what the
modularity plan §4.1 recommended:

* **`trustedProviders` weakens the policy, it does not express it.** A provider
  named there *skips* the incoming `emailVerified` check. The list is therefore
  empty and not exposed, and `test/auth-linking.test.ts` carries all four merge
  cases plus that exact violation as a regression — against a fake OAuth
  provider on loopback, so it needs no keys and no domain.
* **There is no second account when in doubt.** `users.email` is unique, so the
  library refuses the login where the standard promised a duplicate account.
* **A magic link into an unverified row deletes its password and OAuth links.**
  Deliberate (`GHSA-qq9h-g4jm-xgf3`), and the reason verification at sign-up is
  fixed on wherever a password exists beside a link.

Decisions worth naming, because a later reader will wonder.

**`id` is `uuid`.** The cost of `text` is not a row migration — `users.id` is
referenced by five other tables in exoanima and seven in exointel, and each of
those columns would change type with it. `generateId: 'uuid'` is a first-class
mode in 1.7.4, so this is cheap and supported.

**`/list-sessions` is disabled and answered by the kit.** The library's version
returns each session's raw token, and `revokeSession` therefore takes an id that
is looked up inside the process. A cabinet page that is XSS'd leaks one device's
id, not every device's credential.

**The address ceiling survives.** The plan said the product's `LoginLimits`
disappears into the library; only half of it does. Better Auth counts IP + path,
`LoginLimits` counted the recipient of the letter, and behind Traefik the first
is one bucket for everybody. `createAuthRateLimitStorage` serves the library's
ceiling over Redis and `createAddressLimit` keeps ours beside it.

Two bugs found while building it, both fixed here.

* `magic-link` calls `createUser({ email })` with the address **as typed**,
  while every lookup lowercases it — so a first-ever link from `Alice@x` lands a
  row no later lookup can find, and the next link makes a second account. The
  wrapper normalises in a `databaseHooks`, and `UNIQUE (lower(email))` in the
  migration makes that a guarantee rather than a hope.
* `options.user.fields` does not reach a field a **plugin** declares, so
  `twoFactorEnabled`, `banReason`, `banExpires` and `impersonatedBy` were being
  written in camelCase beside our snake_case columns. The rename now travels
  through each plugin's own `schema`. Only a real database can see this — the
  library refuses to serve anything on a schema mismatch — which is why
  `test/auth-postgres.test.ts` exists and is opt-in via
  `KIT_TEST_POSTGRES_URL`.

Migrations ship with the module rather than being copied per product:
`migrations/auth/001_kit_auth.sql` always, `002` with `totp`, `003` with
`admin`, all convergent so a product that already has `auth.md`-shaped tables
gets `ADD COLUMN` instead of a rewrite.

**`better-auth` is pinned exactly and is an optional peer dependency** — twenty
advisories in a year, two of them the holes `auth.md` closed by design, and a
product that does not mount a login must not pay 50 MB for one. The entry-graph
test records that price instead of hiding it.

360 → 395 tests (5 of them skipped without a database).

## v0.5.1 — 2026-09-12

### env

`renderEnvExample(schema, { labels })` takes the product's own wording for the
one line the kit writes itself — required, optional, default. Found by the
first consumer: the generated `.env.example` is read by an operator, all the
descriptions in it are the product's, and an English "Required." in the middle
of them is the kit deciding what language a person reads. The defaults are
unchanged, so nothing that does not pass `labels` moves.

## v0.5.0 — 2026-09-12

Three modules that were never mechanism in anyone's repository, because each
one looked too small to extract: two health routes, an `env.ts`, a
`captureException` that knows which SDK is installed. Counted across the
portfolio they are eight hand-written probes, two env readers and none in the
other nine products, and one seam that had already been extracted once by hand.

### health (new subpath)

New: `@exo/kit/health` — `createHealth({ version, checks, required, timeoutMs,
reportError })` → `live(): Response` and `ready(): Promise<Response>`. It
imports nothing; the entry-graph test holds the row empty.

`live` answers 200 without calling a check, because a compose healthcheck hits
it and restarting a healthy process would not fix the database under it.
`ready` runs every check concurrently, each under its own timeout, and answers
503 when a check named in `required` failed. Both bodies are the shape the
products' contract already fixes: `{status, version, checks}`.

Three decisions worth naming.

**`required` is explicit and has no default.** "All of them" and "none of them"
are each wrong for some product — Qdrant in exointel and qBittorrent in
syncwatch are features, not the product — and the silent version of that choice
is a monitor that is green for a reason nobody chose. A name in `required` that
is not a check throws at construction: that typo would otherwise turn a
required check optional in silence.

**A timeout per check, not per probe.** netwatch had raced a timer against
`redis.ping()` by hand with a comment explaining that a reconnecting ioredis
client waits longer than the monitor's interval. A hung dependency is
indistinguishable from a failed one at the probe's end, so it is a `fail` after
`timeoutMs` (default 3 s) and the timer is cleared either way.

**`skip` is a third state and never fails the probe** — exo-vpn's missing `wg`
binary outside production is a configuration, not a fault. Checks may also
return a boolean or throw, which are the two shapes the existing probes have
(`() => store.ping()` and a tagged `select 1` that throws); the kit maps them rather than
asking nine products to map them nine times.

### env (new subpath)

New: `@exo/kit/env` — `defineEnv(schema, source)` and
`renderEnvExample(schema)`, with field constructors `str`, `num`, `bool`,
`url`, `enumOf` and `custom`. **`zod` is a new optional peer dependency**
(`^3.25`), and it stays behind this one entry.

No TypeScript product in the portfolio validated its environment, and the
failures all had one shape: a `PORT` that parsed to `NaN` and quietly became
the default, half a provider key pair that renders a login button leading to
the provider's error page, a connection string spelled `POSTGRES_URL` here and
`DATABASE_URL` there. The one product that did validate (exopost, through
`pydantic-settings`) has none of them.

**The source is an argument, and that is not a detail.** The rule at the top of
the README — a module never reads `process.env` — has no exception in it, and
this module least of all: `defineEnv(schema, process.env)` is the single line
where a product touches the environment, which is exactly what makes everything
below it portable and every test able to hand in a plain object.

**Empty is not configured.** `FOO=` in a `.env` is how an operator leaves
something for later, so an optional field reads absent *and* empty as `null` —
the same state `createDb({ url: null })` already supports — and a required one
says so by name. Values are trimmed, because the whitespace an editor adds is
the whitespace nobody can see.

**The error never carries the value.** An env failure is the most likely thing
in a deployment to be pasted into a chat window, and the variables that fail
are the secrets. Messages are built from the schema — what was expected, which
values are allowed — and never from what arrived; the one place a message can
come from elsewhere (`custom`, whose zod message is often the most useful text
available) is used only after the raw value has been shown not to appear in it.
`zod`'s own message for a rejected enum quotes the rejected value, which is how
this was found. Every bad variable is reported at once: a fresh deployment has
three of them wrong, and one restart per variable is not a diagnostic.

`renderEnvExample(schema, { header })` writes the `.env.example`. That file is
the one piece of documentation an operator actually follows and the first to
drift — a variable added in code and not in the example is invisible until the
deployment that needs it. A field marked `secret` renders with an empty value
(a placeholder that looks like a key is one somebody pastes into production),
and `omitExample` leaves out what compose or a build arg supplies.

### telemetry (new subpath)

New: `@exo/kit/telemetry` — `createTelemetry({ reporter, logError, logWarn })`
→ `{ captureException, captureMessage, setReporter, reportError }`. Imports
nothing, which is the entire point: a product may run Sentry, may run something
else, may run nothing, and a module that hard-imported an SDK would be deciding
that for every product that imports it.

Lifted from teamself, which had already extracted it by hand when its support
engine stopped being a Next.js app still calling `@sentry/nextjs`. Nothing
wired is the normal state — before the DSN is set, and in every test — and a
reporter that throws is swallowed, because telemetry must never be what takes
down a request that was already handling a failure. `setReporter` works after
boot, since the SDK is usually configured later than the modules that report
through it.

**Added on the way in: `reportError`.** `createDb`, `createRedis`,
`createMailer` and `createLogger` each take a `reportError(err, ctx)`, and
without this every product writes the same mapper next to each of them. The
telemetry hands one out ready-made — `reportError: telemetry.reportError` — and
flattens `ctx.fields` into the reporter's context, where one level less nesting
is one click less in every UI. The kit modules themselves are unchanged.

### infra

`ErrorContext.component` accepts `'health'`. Same widening as v0.4.0 made for
`'mailer'` and `'notify'`, and for the same reason: the union is what tells a
reporter which mechanism is speaking.

### Tests

317 → 359. The three new suites were written before the modules and were
checked against three mutations of the finished code: making an optional check
fail the probe, taking the error message from `zod` instead of from the schema,
and removing the guard around a throwing reporter. Each mutation turned a test
red, which is the only evidence that the tests are about the code and not about
themselves.

## v0.4.0 — 2026-09-11

Two new modules from the support side of two products, and one widened type.
The mailer copies differed by fifteen lines, all of them empty. The notify
copies differed by forty-eight, and the difference was a bug in one of them.

### mailer (new subpath)

New: `@exo/kit/mailer` — `createMailer({ apiKey, from, reportError })` over the
Resend HTTPS API, plus two pure helpers, `senderAddress` and `isOwnSender`. It
imports nothing; the entry-graph test holds the row empty.

The factory hands back two ways to send, because two products disagree on what
a failure is. `sendEmail` is best-effort: any failure is `false`, reported once
through `reportError` (`mailer.send_failed`, with the provider status and the
subject, never the recipient), and never thrown — a request must not fail over
a mail hiccup. `send` is strict: it throws a `MailSendError` carrying `status`
and a `reason` (`not_configured` / `refused` / `transport`), for the caller who
logs it itself and answers the user the same way regardless. Both share one
request. `mailerEnabled()` is the gate a product puts in front of the flows that
only make sense with email.

`isOwnSender(from, email)` is the guard two products had written in their
notify module and needed in front of every inbound message: a support inbox
that is also the escalation target receives its own escalation notice as a new
customer conversation, and an AI answers it — observed twice in production
before the guard existed. It matches one address exactly, never a domain, and
is `false` when either side is missing, because the dangerous failure here is
the one that drops a real customer. It lives in `mailer` because the address in
question is the mailer's `from`.

### notify (new subpath)

New: `@exo/kit/notify` — `createTelegramDm({ botToken, chatId })` and
`createEscalationNotifier({ telegram, sendEmail })`. Imports nothing; the
mailer it composes with is a type.

`notifyEscalation` sends Telegram first and email only when Telegram did not go
out — unconfigured or failed — and never throws, because it runs inside the
webhook that raised the escalation. The notice text is unchanged from the
copies: headline, optional reason, link, with a `[shadow] ` prefix when the
customer was never answered.

**Changed on the way in:** the link is an argument. One copy built it as
`${CHATWOOT_BASE_URL}/app/accounts/${CHATWOOT_ACCOUNT_ID}/conversations/${id}`
from env vars the kit is not allowed to read and that copy's `.env.example`
did not define; the other already took `conversationUrl` from the caller and
said in a comment why. The kit takes the stricter copy: the caller passes a URL
or `null`, and with `null` the notice names the conversation number rather than
pointing at `/app/accounts//conversations/123`. A product whose env does set
both variables builds the same URL it always did, in its wiring file. The
recipient (`to`) is an argument for the same reason — which inbox an
installation escalates to is not the kit's to know.

### infra

`ErrorContext.component` now also admits `'mailer'` and `'notify'`. Additive;
no existing `reportError` needs to change.

### Considered and not added

`env` (a typed reader over `process.env`) has one consumer and waits for a
second, as `python/exo_core` does. `config` (tsconfig / eslint / vitest
presets) was measured rather than assumed: the two Next.js products share a
byte-identical `tsconfig.json` and `eslint.config.mjs`, but the first is the
framework's own scaffold and the second is half product policy (design-canon
lint rules naming a design system one of the two does not have); the other two
products share neither target, module resolution nor strictness with them. What
is genuinely common is one line of vitest configuration, and it is documented in
the README under *Testing a product against the kit* rather than shipped.

## v0.3.0 — 2026-09-11

Two new modules, and both arrived the same way: the mechanism was identical to
the character in two products, and everything they had drifted on turned out to
be a decision one of them was entitled to make and the kit is not.

### http (new subpath)

New: `@exo/kit/http` — `createApiResponse`, `createRateLimiter`,
`createClientIp`, and the SSRF guard (`validateHost`, `safeFetch`, `parseIPv4`,
`isReservedIPv4`).

`createApiResponse({ isProd })` gives `apiOk` / `apiError` / `safeErrorDetail`:
the cache-header matrix, a weak ETag and the `If-None-Match` → 304 path, plus
the one place a caught exception is turned into text a client may read.
`isProd` is an argument because the kit does not read `NODE_ENV`, and because a
default for it would be wrong in one direction or the other — leaking internal
detail, or hiding it from the developer debugging locally.

`apiOk` and `apiError` return `Response`, not `NextResponse`. Nothing was using
what the subclass adds (no caller reads `.cookies` off a response these build),
`NextResponse` **is** a `Response`, and the alternative was making a web
framework a dependency of an error sanitiser.

`createRateLimiter({ redis, policies, failClosed })` is the sliding window over
a Redis sorted set with the in-process window behind it, **and nothing else**.
The two copies had drifted by 223 lines and every one of them was in the route
table: one product paces ~100 routes, the other eleven, and one of them
deliberately has no registration bucket because a limit on a route that must not
exist reads as permission for it. So the table is an argument, the key type is
inferred from it, and a key with no rule throws rather than quietly allowing the
request. The in-process buckets live per limiter rather than in module scope.

`createClientIp({ trustedProxyHops })` reads the caller's address from
`x-forwarded-for` counting from the RIGHT, so prepended entries cannot buy a
caller a fresh rate-limit bucket. **Fixed on the way in:** with a hop count of
zero the copies indexed one past the end of the chain and returned `undefined`
typed as `string`, which would have made the rate-limit bucket key the literal
`"undefined"`, shared by every caller. The index is clamped into the chain now.

### auth-core (new subpath, plus a second narrow entry)

New: `@exo/kit/auth-core` — scrypt passwords, TOTP, single-use tokens and the
session store. And `@exo/kit/auth-core/cookie`, which is a separate entry on
purpose: it imports **nothing at all** and uses Web Crypto, because an edge
proxy verifies a session cookie's signature and would not build if that import
dragged `node:crypto` in behind it. The barrel deliberately does not re-export
it, and `test/entry-graph.test.ts` holds both halves to their word.

`hashPassword` / `verifyPassword` / `passwordLengthError` are unchanged in
behaviour but for one refusal. **Fixed on the way in:** a stored record of the
form `scrypt$16384$8$1$$` — correctly shaped, every field parsing, salt and
hash both empty — asked scrypt for a zero-length key and compared it, equal,
against a zero-length expected value. Every password verified against such a
row. A truncated column or a half-written import was enough. Both copies had it;
nothing could see it, because the format check passed and the login simply
succeeded.

`totpUri(secret, email, issuer)` takes the issuer as a required argument. It is
the name a person reads in their authenticator app, so it belongs to the
product — and a default is precisely the value that survives a copy and is then
read as fact.

`createAuthTokens({ query })` mints, peeks and consumes single-use links —
storing only the SHA-256, consuming in one atomic statement, and rolling a
follow-up write back together with the consume. The purpose union is a type
parameter and there are no lifetime constants: those name which flows an
application has, and the two copies being byte-identical was itself the
evidence, since one of them carried a support-link purpose and its lifetime for
a flow it does not have.

`createSessionStore({ query, cache, resolvePrincipal })` holds the key scheme,
the two lifetimes, the cache-around-resolve, the listing, and the revocation
ordering — the row dies before the cache key, which is what makes "signed out
everywhere" true immediately rather than in a minute. **The principal resolver
is an argument**, because that is the one thing the copies genuinely disagreed
about: one resolves a subscription plan and a permission set unioned from a
grants table, the other an account status and nothing else. That is an
authorization model, not a spelling. The resolver owns the liveness predicate;
the doc block says so and both products pin it.

`createSessionCookie({ cookieName, secret })` signs and verifies
`<sessionId>.<hmac>`. Both arguments are required and undefaulted: one of the
copies was, for a while, issuing a cookie named for the other product, because
the file had arrived by copying and a cookie name is a claim about provenance
that no test can see.

### test/entry-graph

Fixed: the walker skipped `import type X from 'p'` but counted
`import type { X } from 'p'` — the form every one of these files actually uses.
`auth-core` types a query runner with `Sql` and would have been recorded as
importing a database driver it never touches at runtime.

## v0.2.0 — 2026-09-11

### json (new subpath)

New: `@exo/kit/json`. The same seven helpers (`isRecord`, `asArray`,
`asString`, `asNumber`, `asBoolean`, `get`, `getPath`), now reachable from an
entry that imports nothing at all. They are still re-exported from
`@exo/kit/infra`, so nothing needs changing — but new code should take them
from here.

**Why it exists.** `@exo/kit/infra` is a barrel over a pool, a cache and these
helpers, and the first two import `postgres` and `ioredis`. A bundler
resolving the barrel therefore walks into both drivers no matter which export
was wanted. exointel replaced its own `lib/json.ts` with `@exo/kit/infra`,
watched 2499 tests and `tsc --noEmit` stay green, and then had `next build`
fail with `Can't resolve 'net'`: a module reachable from a client component now
dragged a Postgres driver into the browser bundle. That is a broken build, not
a size regression, and nothing before the bundler mentions it.

`test/entry-graph.test.ts` now pins what each subpath can reach — `json`
nothing, `log` only pino, `connector-sdk` only `node:crypto`, `llm` no database
driver, `infra` both and by design. It walks the relative imports from each
entry and collects the bare specifiers, so a stray import anywhere under an
entry fails it.

### llm

Fixed: the providers took the JSON helpers through `../../infra/json.js`, which
was harmless, and now take them from `../../json/index.js`, which the test
above makes permanent. No API change.

## v0.1.0 — 2026-09-11

First release. Four modules, each a factory with an explicit config.

### infra

New: `createDb`, `createRedis`, and the untrusted-JSON helpers (`isRecord`,
`asArray`, `asString`, `asNumber`, `asBoolean`, `get`, `getPath`), all from
`@exo/kit/infra`.

Two rules replaced the three ways the original copies disagreed:

- **The connection string arrives as an argument.** One product spelled the
  variable `POSTGRES_URL`, another `DATABASE_URL`, and a third accepted both
  because an engine once read one name while the installation set the other and
  the package degraded to a silent no-op. Which name is right is a question
  about a deployment, so the kit does not ask it.
- **Error reporting arrives as one `reportError` argument.** One product
  imported an error-reporting SDK directly, another routed through its own
  telemetry wrapper. The kit reports through neither and hands the decision
  back with enough context to make it.

`createDb` returns `{ sql, query, tryQuery, jsonb }`; `createRedis` returns
`{ client, cacheGet, cacheSet, cacheDel, acquireLock, releaseLock,
breakerOpen, reportFailure }`. Destructuring is the intended spelling, so a
consumer keeps its existing flat call sites.

Behaviour carried over unchanged: a `null` URL is a supported state rather than
an error; `query` swallows and reports, `tryQuery` keeps "did not answer"
distinguishable from "answered with nothing"; the Redis circuit breaker; locks
that fail open; `jsonb` as the only correct way into a `jsonb` column.

### log

New: `createLogger({ service, level, openobserve })` from `@exo/kit/log`,
returning `{ logger, logDebug, logInfo, logWarn, logError, logAudit, flush }`.

`service` is required and has no default. It is how one product's records are
told from another's, and a default here is a value that gets copied between
products and then read as fact — which is exactly what had happened to the two
copies this module replaces.

`AuditRecord` is open (`[key: string]: unknown`). Products disagree on what
else belongs in the record — one carries a capability name, another a
conversation id — and closing the shape would mean either listing every
product's vocabulary in the kit or every product keeping its own copy.

### llm

New: `createLlm`, `resolveProviderName`, `flattenConversation`,
`createEmbedder`, and the four providers (`ollama`, `anthropic`, `openai`,
`vibeconduit`) from `@exo/kit/llm`.

Prompts did **not** move. A prompt encodes what a particular product wants said
about its own domain; it is policy, and it stays in the product.

`resolveProviderName` throws on an unrecognised name instead of defaulting: a
silent fallback makes `isAvailable()` report some other backend's liveness, so
callers never take the graceful AI-offline path even though the intended
provider is down. Legacy names are handled by a caller-supplied `aliases` map
rather than a branch in the kit.

The 429 fallback model is kept, and so is the reason: a gateway whose upstream
meters model families separately can leave one family exhausted for days while
another answers normally, and with no fallback every call that depends on it
simply dies for those days.

### connector-sdk

New: `createConnectorHandler` from `@exo/kit/connector-sdk`.

Source was one product's package; the **fail-closed guard came from the
vendored copy in the other product**, which had been hardened after the
original and never merged back. Without it an empty secret becomes a valid HMAC
key, and anyone who knows the scheme can sign their own requests to an endpoint
that answers "who is this customer and what are they paying for". The kit
answers 503 when no secret is configured. This is the drift the kit exists to
end: the safer of the two copies wins, once, for everybody.

Added: `headers` to rename the timestamp/signature headers. Defaults are
unchanged, so an existing signer keeps working.
