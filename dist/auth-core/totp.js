import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
/**
 * TOTP two-factor auth (RFC 6238 / RFC 4226), implemented directly on Node's
 * built-in crypto — no dependency, same posture as `password.ts`'s scrypt.
 * 30s step, 6 digits, SHA-1 (the universal choice — every authenticator app
 * assumes it, including ones that don't read the otpauth `algorithm` param).
 *
 * Four of the five functions here take no configuration at all, so they are
 * plain exports rather than a factory. The fifth takes an `issuer`, and it is
 * required: the copies this came from defaulted it to their own brand constant,
 * and a default is precisely the value that gets carried across when a file is
 * copied and then read as fact afterwards. The name a person sees in their
 * authenticator app belongs to the product, not to the algorithm.
 */
const STEP_SECONDS = 30;
const DIGITS = 6;
const SECRET_BYTES = 20; // 160 bits, standard for TOTP
const RECOVERY_CODE_COUNT = 10;
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Encode(buf) {
    let bits = 0;
    let value = 0;
    let out = '';
    for (const byte of buf) {
        value = (value << 8) | byte;
        bits += 8;
        while (bits >= 5) {
            out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
            bits -= 5;
        }
    }
    if (bits > 0)
        out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
    return out;
}
function base32Decode(str) {
    const clean = str.toUpperCase().replace(/[^A-Z2-7]/g, '');
    let bits = 0;
    let value = 0;
    const bytes = [];
    for (const char of clean) {
        const idx = BASE32_ALPHABET.indexOf(char);
        if (idx === -1)
            continue;
        value = (value << 5) | idx;
        bits += 5;
        if (bits >= 8) {
            bytes.push((value >>> (bits - 8)) & 0xff);
            bits -= 8;
        }
    }
    return Buffer.from(bytes);
}
/** Generate a new random base32 secret for enrollment. */
export function generateTotpSecret() {
    return base32Encode(randomBytes(SECRET_BYTES));
}
/** otpauth:// URI for the authenticator app to scan (as a QR) or paste. */
export function totpUri(secret, email, issuer) {
    const label = encodeURIComponent(`${issuer}:${email}`);
    const params = new URLSearchParams({
        secret,
        issuer,
        algorithm: 'SHA1',
        digits: String(DIGITS),
        period: String(STEP_SECONDS),
    });
    return `otpauth://totp/${label}?${params.toString()}`;
}
function hotp(secret, counter) {
    const key = base32Decode(secret);
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64BE(BigInt(counter));
    const hmac = createHmac('sha1', key).update(buf).digest();
    const offset = hmac.readUInt8(hmac.length - 1) & 0x0f;
    // RFC 4226 dynamic truncation: the four bytes at `offset`, big-endian, with
    // the sign bit cleared. Spelled as one read rather than four masked shifts —
    // the value is identical and there is no index to bounds-check.
    const binary = hmac.readUInt32BE(offset) & 0x7fffffff;
    return String(binary % 10 ** DIGITS).padStart(DIGITS, '0');
}
/**
 * Verify a 6-digit code against the secret, tolerating clock drift by
 * checking the previous/current/next 30s step (±30s window).
 */
export function verifyTotp(secret, code) {
    const clean = code.trim().replace(/\s+/g, '');
    if (!/^\d{6}$/.test(clean))
        return false;
    const counter = Math.floor(Date.now() / 1000 / STEP_SECONDS);
    for (const drift of [0, -1, 1]) {
        // A counter below zero is only reachable with the clock at the epoch, but
        // `writeBigUInt64BE` THROWS on it rather than returning a non-matching
        // code — and this runs inside a login handler, so that would be a 500 on
        // the 2FA step instead of a rejected code.
        if (counter + drift < 0)
            continue;
        const expected = hotp(secret, counter + drift);
        if (timingSafeEqual(Buffer.from(expected), Buffer.from(clean)))
            return true;
    }
    return false;
}
function hashCode(raw) {
    return createHash('sha256').update(raw).digest('hex');
}
/** Mint a fresh set of recovery codes: raw values (shown once) + their hashes (stored). */
export function generateRecoveryCodes() {
    const raw = [];
    const hashes = [];
    for (let i = 0; i < RECOVERY_CODE_COUNT; i++) {
        const code = randomBytes(5).toString('hex'); // 10 hex chars, e.g. "a1b2c3d4e5"
        raw.push(code);
        hashes.push(hashCode(code));
    }
    return { raw, hashes };
}
export function recoveryCodeHash(raw) {
    return hashCode(raw.trim().toLowerCase().replace(/\s+/g, ''));
}
//# sourceMappingURL=totp.js.map