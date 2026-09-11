/**
 * True if a dotted-quad IPv4 string is private, reserved or otherwise not
 * publicly routable. Unparseable input counts as reserved — callers use this to
 * decide whether to send traffic, and "I could not read it" must not mean "go".
 *
 * Single source of truth for reachability: routes taking a user-supplied IP
 * (SSRF guard, subnet sweep, scanner) call this instead of carrying their own
 * block list.
 */
export declare function isReservedIPv4(ip: string): boolean;
/**
 * Canonical dotted-quad for `s`, or null if `s` is not already in dotted-quad
 * form.
 *
 * Deliberately refuses every other notation the C resolver would accept —
 * decimal (`2130706433`), hex (`0x7f000001`), dotted-octal (`0177.0.0.1`) and
 * the short forms (`127.1`). Each of those is a spelling of a loopback or
 * private address that reads as harmless text, and canonicalising them here
 * would mean the block list has to be right about six notations instead of
 * one. Rejecting is both safer and honest: a caller that wants to reach a real
 * host can always write its address the ordinary way. Leading zeros within an
 * octet are the one exception — they are stripped, not rejected, because
 * `01.02.03.04` is unambiguous.
 */
export declare function parseIPv4(s: string): string | null;
export interface ValidationResult {
    ok: boolean;
    reason?: string;
    /** Resolved IPs (literal input or DNS answers). Empty if validation failed before resolution. */
    resolved?: string[];
}
/**
 * Validate that `host` — an IP literal or a hostname — is safe to use as a
 * network target. Fails when the literal is reserved or written in a
 * non-canonical IPv4 notation, when the name is reserved or malformed, or when
 * *any* DNS answer lands in a reserved range.
 */
export declare function validateHost(host: string): Promise<ValidationResult>;
/**
 * `fetch` with the SSRF guard applied to every hop.
 *
 * Redirects are followed by hand rather than by `fetch` because a
 * public-looking URL that 302s to `169.254.169.254` is the standard way past a
 * check that only ever inspected the URL the caller passed in. Each hop is
 * re-validated before it is requested, and credential headers are dropped when
 * a hop crosses to a different origin so a redirect cannot walk our API keys
 * to an attacker's host.
 */
export declare function safeFetch(inputUrl: string, init?: RequestInit & {
    maxRedirects?: number;
}): Promise<Response>;
//# sourceMappingURL=ssrf-guard.d.ts.map