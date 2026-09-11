# Changelog

Semantic versioning. One tag covers the whole kit; the sections below are per
module, so a consumer can see whether a release touches anything it imports.

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
