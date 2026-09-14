/**
 * `@exo/kit/infra` — Postgres, Redis and untrusted-JSON helpers.
 *
 * Two rules hold this module together, and both come from the same place:
 *
 *   1. **Nothing here reads `process.env`.** Connection strings arrive as
 *      arguments. Variable names belong to a deployment, not to a pool.
 *   2. **Not configured is a state, not an error.** A `null` URL gives a
 *      working accessor whose every call takes the unavailable branch, so a
 *      product can run without a database or a cache and find out by checking,
 *      not by crashing.
 *
 * ── Importing this pulls in the drivers ──
 * This entry is a barrel over three things, and two of them import `postgres`
 * and `ioredis`. A bundler resolving `@exo/kit/infra` therefore walks into
 * both drivers even when the only thing wanted is an untrusted-JSON helper —
 * and a driver that reaches a browser bundle is a build failure (`Can't
 * resolve 'net'`), not a size regression. The JSON helpers are re-exported
 * here for the products that already import them from this path; everything
 * new should take them from `@exo/kit/json`, which imports nothing at all.
 */
export { createDb } from './db.js';
export type { Db, DbConfig, DbOutcome } from './db.js';
export { createRedis } from './redis.js';
export type { RedisCache, RedisConfig } from './redis.js';
export type { ErrorContext, KitComponent, ReportError } from './types.js';
export {
  isRecord,
  asArray,
  asString,
  asNumber,
  asBoolean,
  get,
  getPath,
} from '../json/index.js';
export type { JsonRecord } from '../json/index.js';
