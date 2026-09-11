import { scrypt, randomBytes, timingSafeEqual, type ScryptOptions } from 'node:crypto';

/**
 * Password hashing with Node's built-in scrypt — no native dependency, no
 * Docker build pain. Format stored in users.password_hash:
 *
 *   scrypt$<N>$<r>$<p>$<salt_b64>$<hash_b64>
 *
 * Parameters are embedded so they can be tuned later without breaking existing
 * hashes (verify reads them from the stored string).
 *
 * NOTE: Node runtime only (uses node:crypto scrypt) — never import from an
 * edge runtime. An edge proxy validates a session cookie, not a password, and
 * that is why the cookie half of this module is a separate entry
 * (`@exo/kit/auth-core/cookie`) that imports nothing at all.
 */

/** Promisified scrypt that accepts the cost-parameter options object. */
function scryptAsync(
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, options, (err, derived) => {
      if (err) reject(err);
      else resolve(derived);
    });
  });
}

// cost ≈ 2^15; r/p standard. ~50–100ms/hash — fine for interactive login.
const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 64;
const SALT_BYTES = 16;

/** Single source of truth for the password length policy — enforced at
 *  registration, reset, and change. Keep every route in lockstep by
 *  importing this instead of redefining the bounds locally. */
export const MIN_PASSWORD = 10;
export const MAX_PASSWORD = 200;

export function passwordLengthError(password: string): string | null {
  if (password.length < MIN_PASSWORD || password.length > MAX_PASSWORD) {
    return `Password must be ${MIN_PASSWORD}-${MAX_PASSWORD} characters`;
  }
  return null;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const derived = await scryptAsync(password, salt, KEYLEN, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${derived.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  // Defaults only exist to satisfy the checker: the length test above already
  // proves all six are present. An empty string would fail the very next check.
  const [, nStr = '', rStr = '', pStr = '', saltB64 = '', hashB64 = ''] = parts;
  const n = Number(nStr);
  const r = Number(rStr);
  const p = Number(pStr);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false;

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(saltB64, 'base64');
    expected = Buffer.from(hashB64, 'base64');
  } catch {
    return false;
  }

  // A record whose salt or hash decoded to nothing is malformed, and it must be
  // refused HERE, before scrypt is asked for a zero-length key: an empty derived
  // key compares equal to an empty expected one, so `scrypt$16384$8$1$$` — a
  // truncated column, a half-written row, a bad import — would verify EVERY
  // password. Both copies this file came from had that hole; it is closed on the
  // way in, because a verifier that can answer `true` with no stored secret is
  // not a verifier.
  if (salt.length === 0 || expected.length === 0) return false;

  let derived: Buffer;
  try {
    derived = await scryptAsync(password, salt, expected.length, { N: n, r, p });
  } catch {
    return false;
  }
  // Lengths must match for timingSafeEqual; they will if the hash is well-formed.
  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}
