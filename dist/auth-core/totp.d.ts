/** Generate a new random base32 secret for enrollment. */
export declare function generateTotpSecret(): string;
/** otpauth:// URI for the authenticator app to scan (as a QR) or paste. */
export declare function totpUri(secret: string, email: string, issuer: string): string;
/**
 * Verify a 6-digit code against the secret, tolerating clock drift by
 * checking the previous/current/next 30s step (±30s window).
 */
export declare function verifyTotp(secret: string, code: string): boolean;
/** Mint a fresh set of recovery codes: raw values (shown once) + their hashes (stored). */
export declare function generateRecoveryCodes(): {
    raw: string[];
    hashes: string[];
};
export declare function recoveryCodeHash(raw: string): string;
//# sourceMappingURL=totp.d.ts.map