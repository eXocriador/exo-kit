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
 */
export { createDb } from './db.js';
export type { Db, DbConfig, DbOutcome } from './db.js';
export { createRedis } from './redis.js';
export type { RedisCache, RedisConfig } from './redis.js';
export type { ErrorContext, ReportError } from './types.js';
export {
  isRecord,
  asArray,
  asString,
  asNumber,
  asBoolean,
  get,
  getPath,
} from './json.js';
export type { JsonRecord } from './json.js';
