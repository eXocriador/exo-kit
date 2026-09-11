# @exo/kit

Shared mechanism for a handful of small self-hosted services: database and
cache accessors, structured logging with an audit trail, a multi-provider LLM
client, and the SDK a product mounts to be supportable.

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
npm i github:eXocriador/exo-kit#v0.1.0
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
uv add "git+https://github.com/eXocriador/exo-kit@v0.1.0#subdirectory=python"
```

## Modules

| Import | What it gives you |
|---|---|
| `@exo/kit/infra` | `createDb`, `createRedis`, untrusted-JSON helpers |
| `@exo/kit/log` | `createLogger` — pino + an audit trail, optional log shipping |
| `@exo/kit/llm` | `createLlm` over Ollama / Anthropic / OpenAI / an OpenAI-compatible gateway |
| `@exo/kit/connector-sdk` | `createConnectorHandler` — HMAC-signed support connector |

Peer dependencies (`postgres`, `ioredis`, `pino`) are optional. Importing a
subpath pulls in only that module's, so a product that wants a logger does not
need a Postgres driver on disk.

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

Destructuring is the point: the returned functions are bound to that instance,
so existing flat call sites (`dbQuery(...)`, `logWarn(...)`) keep working and
the diff is one file instead of every file.

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
cooldown, the replay window rejecting both a stale and a future timestamp, and
the connector answering 503 rather than serving an unsigned request. A test
that cannot fail proves nothing about the code it names.

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
