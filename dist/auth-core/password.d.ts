/** Single source of truth for the password length policy — enforced at
 *  registration, reset, and change. Keep every route in lockstep by
 *  importing this instead of redefining the bounds locally. */
export declare const MIN_PASSWORD = 10;
export declare const MAX_PASSWORD = 200;
export declare function passwordLengthError(password: string): string | null;
export declare function hashPassword(password: string): Promise<string>;
export declare function verifyPassword(password: string, stored: string): Promise<boolean>;
//# sourceMappingURL=password.d.ts.map