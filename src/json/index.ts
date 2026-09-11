/**
 * Safe accessors for untrusted JSON (third-party API responses).
 *
 * The contract: never trust the shape. `await res.json()` is `unknown`, and
 * every read goes through one of these helpers, which return a safe default
 * when the field is missing or the wrong type. If an upstream service changes
 * its response format, we degrade to defaults instead of crashing on
 * `data.field.subfield`.
 *
 * Pair these with `Raw*` interfaces (all fields optional) that *document* the
 * shape we expect without promising the runtime value matches.
 */

export type JsonRecord = Record<string, unknown>;

/** True for plain objects (not null, not arrays). Narrows to JsonRecord. */
export function isRecord(v: unknown): v is JsonRecord {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Returns the value as an array of `unknown`, or `[]` if it isn't an array. */
export function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/** Returns a string, or `fallback` (default "") if not a string. */
export function asString(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

/** Returns a finite number, or `fallback` (default 0) otherwise. */
export function asNumber(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/** Returns a boolean, or `fallback` (default false) otherwise. */
export function asBoolean(v: unknown, fallback = false): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

/** Reads `obj[key]` without assuming `obj` is an object. */
export function get(obj: unknown, key: string): unknown {
  return isRecord(obj) ? obj[key] : undefined;
}

/**
 * Walks a dotted path (`"a.b.c"`, or `"a.0.b"` to index an array) through
 * nested untrusted JSON, returning `undefined` at the first non-object,
 * non-array link instead of throwing.
 *
 * Numeric segments index arrays, and that is not a nicety. An `isRecord` check
 * alone excludes arrays, so a path crossing one returns `undefined` for every
 * field underneath it — silently, with no error anywhere, because the caller
 * asked for a value it was willing to default. Every array-shaped upstream
 * field read through such a walker reads as absent.
 */
export function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const key of path.split('.')) {
    if (Array.isArray(cur)) {
      const idx = Number(key);
      cur = key !== '' && Number.isInteger(idx) ? cur[idx] : undefined;
    } else if (isRecord(cur)) {
      cur = cur[key];
    } else {
      return undefined;
    }
  }
  return cur;
}
