import { describe, it, expect } from 'vitest';
import { isRecord, asArray, asString, asNumber, asBoolean, get, getPath } from '../src/infra/json.js';

describe('isRecord', () => {
  it('is true only for plain objects', () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ a: 1 })).toBe(true);
    expect(isRecord([])).toBe(false);
    expect(isRecord(null)).toBe(false);
    expect(isRecord('x')).toBe(false);
    expect(isRecord(42)).toBe(false);
    expect(isRecord(undefined)).toBe(false);
  });
});

describe('scalar coercion helpers', () => {
  it('asArray returns arrays or []', () => {
    expect(asArray([1, 2])).toEqual([1, 2]);
    expect(asArray('nope')).toEqual([]);
    expect(asArray(null)).toEqual([]);
  });

  it('asString honours fallback', () => {
    expect(asString('hi')).toBe('hi');
    expect(asString(5)).toBe('');
    expect(asString(undefined, 'def')).toBe('def');
  });

  it('asNumber rejects non-finite values', () => {
    expect(asNumber(3.14)).toBe(3.14);
    expect(asNumber('3')).toBe(0);
    expect(asNumber(Number.NaN)).toBe(0);
    expect(asNumber(Number.POSITIVE_INFINITY, -1)).toBe(-1);
  });

  it('asBoolean only accepts real booleans', () => {
    expect(asBoolean(true)).toBe(true);
    expect(asBoolean('true')).toBe(false);
    expect(asBoolean(1, true)).toBe(true);
  });
});

describe('get', () => {
  it('reads a key without assuming the container is an object', () => {
    expect(get({ a: 1 }, 'a')).toBe(1);
    expect(get(null, 'a')).toBeUndefined();
    expect(get([1, 2], 'a')).toBeUndefined();
  });
});

describe('getPath', () => {
  it('walks nested objects', () => {
    expect(getPath({ a: { b: { c: 7 } } }, 'a.b.c')).toBe(7);
  });

  it('returns undefined at the first non-object link instead of throwing', () => {
    expect(getPath({ a: 1 }, 'a.b.c')).toBeUndefined();
    expect(getPath(null, 'a')).toBeUndefined();
  });

  /**
   * The regression this helper exists for: an `isRecord`-only walker excludes
   * arrays, so every field under an array-shaped upstream response reads as
   * absent — with no error anywhere, because the caller was willing to default.
   */
  it('indexes arrays with numeric segments', () => {
    const data = { choices: [{ message: { content: 'hello' } }] };
    expect(getPath(data, 'choices.0.message.content')).toBe('hello');
  });

  it('rejects non-integer and empty segments on an array', () => {
    expect(getPath({ xs: [1, 2] }, 'xs.one')).toBeUndefined();
    expect(getPath({ xs: [1, 2] }, 'xs.')).toBeUndefined();
    expect(getPath({ xs: [1, 2] }, 'xs.1')).toBe(2);
  });
});
