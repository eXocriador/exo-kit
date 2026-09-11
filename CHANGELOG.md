# Changelog

Semantic versioning. One tag covers the whole kit; the sections below are per
module, so a consumer can see whether a release touches anything it imports.

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
