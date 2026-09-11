import { describe, it, expect, vi, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import {
  generateTotpSecret,
  totpUri,
  verifyTotp,
  generateRecoveryCodes,
  recoveryCodeHash,
} from '../src/auth-core/totp.js';

/**
 * The second authentication factor, hand-rolled on node:crypto — and until now
 * the only file in the auth stack with no tests at all. Nothing above it can
 * substitute: the enrollment route only checks that `verifyTotp` said yes, so
 * a drift window that quietly widened, a `/^\d{6}$/` that stopped anchoring,
 * or a recovery-code hash that stopped matching what enrollment stored are all
 * silent — the login flow keeps working, it just accepts more than it should
 * or locks people out of their own recovery codes.
 *
 * Codes come from the RFC 6238 test vectors (SHA-1, 30 s step) truncated to
 * this implementation's 6 digits, so they pin the algorithm against the
 * standard rather than against itself.
 */

/** RFC 6238 §B: the ASCII secret "12345678901234567890", base32-encoded. */
const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

/** T=59 s → step 1 → 94287082, and T=1111111109 → step 37037036 → 07081804. */
const AT_STEP_1 = '287082';
const AT_STEP_37037036 = '081804';

const at = (seconds: number) => vi.setSystemTime(seconds * 1000);

afterEach(() => vi.useRealTimers());

describe('verifyTotp', () => {
  it('accepts the RFC 6238 vectors at their own step', () => {
    vi.useFakeTimers();
    at(59);
    expect(verifyTotp(RFC_SECRET, AT_STEP_1)).toBe(true);
    at(1_111_111_109);
    expect(verifyTotp(RFC_SECRET, AT_STEP_37037036)).toBe(true);
  });

  it('tolerates exactly one step of drift in each direction, and no more', () => {
    vi.useFakeTimers();
    // Step 1's code is 30 s wide; ±1 step covers a clock up to a minute off.
    at(59); // step 1 itself
    expect(verifyTotp(RFC_SECRET, AT_STEP_1)).toBe(true);
    at(89); // step 2 — the code is one step late
    expect(verifyTotp(RFC_SECRET, AT_STEP_1)).toBe(true);
    at(29); // step 0 — one step early
    expect(verifyTotp(RFC_SECRET, AT_STEP_1)).toBe(true);

    // Two steps out must fail: every extra step is another 6-digit code a
    // guesser gets for free, and an hour-stale code is not clock drift.
    at(119); // step 3
    expect(verifyTotp(RFC_SECRET, AT_STEP_1)).toBe(false);
    at(1_111_111_109);
    expect(verifyTotp(RFC_SECRET, AT_STEP_1)).toBe(false);
  });

  it('rejects a code minted for a different secret', () => {
    vi.useFakeTimers();
    at(59);
    expect(verifyTotp(generateTotpSecret(), AT_STEP_1)).toBe(false);
  });

  it.each([
    ['empty', ''],
    ['five digits', '28708'],
    ['seven digits', '2870821'],
    ['letters', 'abcdef'],
    ['a digit string with a suffix', '287082x'],
    ['a leading-plus number', '+87082'],
  ])('rejects a malformed code (%s) without comparing anything', (_label, code) => {
    vi.useFakeTimers();
    at(59);
    // The length check is what keeps `timingSafeEqual` from throwing on a
    // mismatched buffer length, so this is a crash guard as much as a policy.
    expect(() => verifyTotp(RFC_SECRET, code)).not.toThrow();
    expect(verifyTotp(RFC_SECRET, code)).toBe(false);
  });

  it('accepts the spacing authenticator apps display', () => {
    vi.useFakeTimers();
    at(59);
    // Apps show "287 082"; users paste it verbatim.
    expect(verifyTotp(RFC_SECRET, ' 287 082 ')).toBe(true);
  });
});

describe('generateTotpSecret / totpUri', () => {
  it('mints a fresh 160-bit base32 secret each time', () => {
    const a = generateTotpSecret();
    const b = generateTotpSecret();
    expect(a).toMatch(/^[A-Z2-7]{32}$/); // 20 bytes → 32 base32 chars
    expect(a).not.toBe(b);
  });

  it('describes the same parameters the verifier uses', () => {
    const secret = generateTotpSecret();
    const uri = new URL(totpUri(secret, 'analyst@example.com', 'Alpha'));

    expect(uri.protocol).toBe('otpauth:');
    expect(uri.searchParams.get('secret')).toBe(secret);
    // A URI that disagreed with the verifier would enroll an app whose codes
    // never validate — the failure mode looks like "2FA is broken".
    expect(uri.searchParams.get('algorithm')).toBe('SHA1');
    expect(uri.searchParams.get('digits')).toBe('6');
    expect(uri.searchParams.get('period')).toBe('30');
    expect(decodeURIComponent(uri.pathname)).toContain('analyst@example.com');
  });

  /**
   * The issuer has no default here, and that is the point: it is the name a
   * person reads in their authenticator app, so it belongs to the product. The
   * copies this came from defaulted it to their own brand constant, which is
   * exactly the kind of value that travels intact when a file is copied and is
   * then read as fact by whoever finds it next.
   */
  it("puts the caller's issuer in both the label and the parameter", () => {
    const uri = new URL(totpUri(generateTotpSecret(), 'analyst@example.com', 'Alpha'));
    expect(uri.searchParams.get('issuer')).toBe('Alpha');
    expect(decodeURIComponent(uri.pathname)).toContain('Alpha:analyst@example.com');
  });
});

describe('recovery codes', () => {
  it('mints ten distinct codes with their stored hashes', () => {
    const { raw, hashes } = generateRecoveryCodes();
    expect(raw).toHaveLength(10);
    expect(new Set(raw).size).toBe(10);
    expect(hashes).toHaveLength(10);
    for (const code of raw) expect(code).toMatch(/^[0-9a-f]{10}$/);
    for (const h of hashes) expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it('hashes what enrollment stored, so a minted code can actually be redeemed', () => {
    // Enrollment stores `hashes`; redemption looks up `recoveryCodeHash(input)`.
    // If those two ever normalise differently, every recovery code silently
    // stops working and the only way to find out is to be locked out.
    const { raw, hashes } = generateRecoveryCodes();
    raw.forEach((code, i) => expect(recoveryCodeHash(code)).toBe(hashes[i]));
  });

  it('normalises the way a human retypes a code', () => {
    const { raw, hashes } = generateRecoveryCodes();
    const code = raw[0] as string;
    expect(recoveryCodeHash(` ${code.toUpperCase()} `)).toBe(hashes[0]);
    expect(recoveryCodeHash(code.replace(/(.{5})/, '$1 '))).toBe(hashes[0]);
  });

  it('does not collide with a different code', () => {
    const { raw, hashes } = generateRecoveryCodes();
    expect(recoveryCodeHash(raw[1] as string)).not.toBe(hashes[0]);
    expect(recoveryCodeHash('')).not.toBe(hashes[0]);
  });

  it('stores a hash, never the code itself', () => {
    const { raw, hashes } = generateRecoveryCodes();
    for (let i = 0; i < raw.length; i++) {
      expect(hashes[i]).not.toContain(raw[i]);
      expect(hashes[i]).toBe(createHash('sha256').update(raw[i] as string).digest('hex'));
    }
  });
});
