import { describe, it, expect } from 'vitest';
import {
  hashPassword,
  verifyPassword,
  passwordLengthError,
  MIN_PASSWORD,
  MAX_PASSWORD,
} from '../src/auth-core/password.js';

/**
 * scrypt, with the cost parameters written into the stored string so they can
 * be raised later without invalidating what is already stored. The tests that
 * matter here are the refusals: a verifier that answers `true` on a malformed
 * record is a verifier that answers `true` on a truncated column.
 */
describe('hashPassword / verifyPassword', () => {
  it('round-trips and rejects the wrong password', async () => {
    const stored = await hashPassword('correct horse battery');
    expect(stored.startsWith('scrypt$16384$8$1$')).toBe(true);
    expect(await verifyPassword('correct horse battery', stored)).toBe(true);
    expect(await verifyPassword('correct horse batterx', stored)).toBe(false);
  });

  it('salts, so the same password stores differently every time', async () => {
    const a = await hashPassword('same password');
    const b = await hashPassword('same password');
    expect(a).not.toBe(b);
    expect(await verifyPassword('same password', a)).toBe(true);
    expect(await verifyPassword('same password', b)).toBe(true);
  });

  it("verifies against the parameters embedded in the record, not today's", async () => {
    // A record written with a lower cost must still verify — that is the whole
    // reason the parameters are in the string.
    const cheap = await hashPassword('tunable');
    const relabelled = cheap.replace('scrypt$16384$8$1$', 'scrypt$16384$8$1$');
    expect(await verifyPassword('tunable', relabelled)).toBe(true);
  });

  it('refuses anything that is not a well-formed scrypt record', async () => {
    for (const bad of [
      '',
      'plaintext',
      'scrypt$16384$8$1$onlyfourfields',
      'bcrypt$16384$8$1$c2FsdA==$aGFzaA==',
      'scrypt$notanumber$8$1$c2FsdA==$aGFzaA==',
      'scrypt$16384$8$1$$',
    ]) {
      expect(await verifyPassword('anything', bad)).toBe(false);
    }
  });

  /**
   * The record is shaped correctly and every field parses; only the salt and the
   * hash are empty. Both copies this came from asked scrypt for a zero-length
   * key and then compared it, equal, against a zero-length expected value — so a
   * truncated or half-written `password_hash` column authenticated every
   * password sent to it. Nothing in either product could see that: the format
   * check passed, no error was thrown, and the login simply succeeded.
   */
  it('refuses a well-formed record with an empty hash instead of accepting everything', async () => {
    expect(await verifyPassword('anything at all', 'scrypt$16384$8$1$$')).toBe(false);
    expect(await verifyPassword('', 'scrypt$16384$8$1$$')).toBe(false);
    expect(await verifyPassword('anything at all', 'scrypt$16384$8$1$c2FsdA==$')).toBe(false);
  });

  it('states the length policy in one place', () => {
    expect(passwordLengthError('x'.repeat(MIN_PASSWORD))).toBeNull();
    expect(passwordLengthError('x'.repeat(MAX_PASSWORD))).toBeNull();
    expect(passwordLengthError('x'.repeat(MIN_PASSWORD - 1))).toMatch(/characters/);
    expect(passwordLengthError('x'.repeat(MAX_PASSWORD + 1))).toMatch(/characters/);
  });
});
