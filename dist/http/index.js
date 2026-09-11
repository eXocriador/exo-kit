/**
 * `@exo/kit/http` — JSON responses, request pacing, an SSRF guard, and the one
 * correct way to read a caller's IP from behind a proxy.
 *
 * ── What importing this pulls in ──
 * `node:crypto` (the ETag), `node:dns/promises` and `node:net` (the guard
 * resolves hostnames and re-checks their answers). Every module behind this
 * entry is server-side by construction, which is why they share one entry:
 * there is no client-safe half to protect, unlike `@exo/kit/infra`, where the
 * JSON helpers had to move out to `@exo/kit/json`. A client component that
 * reaches for any of this is a mistake the bundler will name, and
 * `test/entry-graph.test.ts` pins the list above so the claim stays checkable.
 *
 * Three of the four take configuration, and in each case the configuration is
 * the thing two copies had drifted on: whether this is production
 * (`createApiResponse`), the route table (`createRateLimiter`), and how many
 * proxies are in front (`createClientIp`). The SSRF guard takes none — "is this
 * address something only we can reach" has the same answer everywhere.
 */
export { createApiResponse } from './api-response.js';
export { createRateLimiter } from './rate-limit.js';
export { createClientIp } from './client-ip.js';
export { isReservedIPv4, parseIPv4, validateHost, safeFetch } from './ssrf-guard.js';
//# sourceMappingURL=index.js.map