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
export declare function isRecord(v: unknown): v is JsonRecord;
/** Returns the value as an array of `unknown`, or `[]` if it isn't an array. */
export declare function asArray(v: unknown): unknown[];
/** Returns a string, or `fallback` (default "") if not a string. */
export declare function asString(v: unknown, fallback?: string): string;
/** Returns a finite number, or `fallback` (default 0) otherwise. */
export declare function asNumber(v: unknown, fallback?: number): number;
/** Returns a boolean, or `fallback` (default false) otherwise. */
export declare function asBoolean(v: unknown, fallback?: boolean): boolean;
/** Reads `obj[key]` without assuming `obj` is an object. */
export declare function get(obj: unknown, key: string): unknown;
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
export declare function getPath(obj: unknown, path: string): unknown;
//# sourceMappingURL=index.d.ts.map