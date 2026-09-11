# @exo/kit

Shared mechanism for a handful of small self-hosted services: database and
cache accessors, structured logging with an audit trail, a multi-provider LLM
client, JSON responses and request pacing, the primitives behind session auth,
and the SDK a product mounts to be supportable.

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
npm i github:eXocriador/exo-kit#v0.3.0
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
uv add "git+https://github.com/eXocriador/exo-kit@v0.3.0#subdirectory=python"
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
| `@exo/kit/connector-sdk` | `createConnectorHandler` — HMAC-signed support connector | `node:crypto` |

Peer dependencies (`postgres`, `ioredis`, `pino`) are optional, and the right
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

Destructuring is the point: the returned functions are bound to that instance,
so existing flat call sites (`dbQuery(...)`, `logWarn(...)`, `resolveSession(id)`)
keep working and the diff is one file instead of every file.

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
