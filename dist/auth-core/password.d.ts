/** Single source of truth for the password length policy — enforced at
 *  registration, reset, and change. Keep every route in lockstep by
 *  importing this instead of redefining the bounds locally. */
export declare const MIN_PASSWORD = 10;
export declare const MAX_PASSWORD = 200;
export declare function passwordLengthError(password: string): string | null;
export declare function hashPassword(password: string): Promise<string>;
/**
 * Is this string one of OURS — `scrypt$N$r$p$salt$hash`?
 *
 * The shape test `verifyPassword` already made, given a name because a second
 * caller needs the same answer for a different reason: `@exo/kit/auth` decides
 * from it whether a stored string belongs to a product's PREVIOUS hash format,
 * and so whether that product's own verifier may be asked about it (README,
 * "a password hashed before the kit existed"). One predicate, so "ours" cannot
 * come to mean two things.
 *
 * It answers about the FORMAT, never about the secret: `true` here says only
 * that `verifyPassword` is the function that can read this string.
 */
export declare function isKitPasswordHash(stored: string): boolean;
export declare function verifyPassword(password: string, stored: string): Promise<boolean>;
//# sourceMappingURL=password.d.ts.map