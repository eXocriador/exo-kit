import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
/**
 * SSRF guard for every route that turns a user-supplied host, IP or URL into an
 * outbound request.
 *
 * The guard answers one question — "is this address something the internet can
 * reach, or something only we can reach?" — and answers it the same way for
 * both address families. IPv4 and IPv6 are widened to a single 128-bit integer
 * and matched against one table of CIDR blocks, so there is exactly one
 * comparison routine to audit rather than a per-family pair that can drift.
 *
 * Two properties this file is responsible for, both load-bearing:
 *
 *   - **Textual spelling can never change the verdict.** An address is decoded
 *     to its numeric value before anything is compared. `::1`,
 *     `0:0:0:0:0:0:0:1` and `::ffff:127.0.0.1` are the same host and must all
 *     be refused; a prefix/substring check on the text would catch only some.
 *   - **Anything we cannot decode is refused, not allowed.** Every parse
 *     failure returns "reserved". A guard that fails open is not a guard.
 *
 * Hostnames are additionally resolved and re-checked against their answers.
 * That stops every non-rebinding attack; it does not stop an attacker who can
 * flip a TTL=0 record between our lookup and the socket connect. Closing that
 * last gap needs IP pinning at the socket layer, which Node's fetch does not
 * expose — so `safeFetch` re-validates on every redirect hop instead, which is
 * where the bypass is actually reachable in practice.
 */
// tsconfig targets ES2017, where `123n` literals are a syntax error — hence
// BigInt(...) calls throughout.
const ZERO = BigInt(0);
const ONE = BigInt(1);
const V4_MAPPED_BASE = BigInt('0xffff00000000'); // ::ffff:0:0 — where IPv4 sits in the 128-bit space
/** Decode dotted-quad text to its 32-bit value, or null if it is not one. */
function decodeIPv4(text) {
    const octets = text.split('.');
    if (octets.length !== 4)
        return null;
    let value = ZERO;
    for (const octet of octets) {
        // Digits only: this rejects '0x7f', '-1', '' and whitespace padding in one
        // test, so no alternate base or sign convention can sneak past.
        if (!/^\d{1,3}$/.test(octet))
            return null;
        const n = Number(octet);
        if (n > 255)
            return null;
        value = (value << BigInt(8)) | BigInt(n);
    }
    return value;
}
/**
 * Decode any textual IPv6 form — compressed, fully expanded, or carrying an
 * embedded IPv4 tail such as `::ffff:127.0.0.1` — to its 128-bit value.
 * Returns null for anything malformed; callers must read null as "unsafe".
 */
function decodeIPv6(text) {
    let body = text;
    // An embedded IPv4 tail is rewritten into the two hex groups it stands for,
    // so the group walk below only ever deals with hex.
    const tail = /(\d{1,3}\.){3}\d{1,3}$/.exec(body);
    if (tail) {
        const v4 = decodeIPv4(tail[0]);
        if (v4 === null)
            return null;
        const hi = (v4 >> BigInt(16)).toString(16);
        const lo = (v4 & BigInt(0xffff)).toString(16);
        body = `${body.slice(0, tail.index)}${hi}:${lo}`;
    }
    const runs = body.split('::');
    if (runs.length > 2)
        return null; // '::' may appear at most once
    const split = (s) => (s ? s.split(':') : []);
    const head = split(runs[0] ?? '');
    const rest = runs.length === 2 ? split(runs[1] ?? '') : [];
    let groups;
    if (runs.length === 2) {
        const zeros = 8 - head.length - rest.length;
        if (zeros < 0)
            return null;
        groups = [...head, ...Array(zeros).fill('0'), ...rest];
    }
    else {
        groups = head; // no '::' means every group must be written out
    }
    if (groups.length !== 8)
        return null;
    let value = ZERO;
    for (const group of groups) {
        if (!/^[0-9a-fA-F]{1,4}$/.test(group))
            return null;
        value = (value << BigInt(16)) | BigInt(parseInt(group, 16));
    }
    return value;
}
/** Decode `"10.0.0.0/8"` / `"fe80::/10"` into a matchable range. */
function cidr(notation) {
    const [network = '', bitsText] = notation.split('/');
    const bits = Number(bitsText);
    const isV6 = network.includes(':');
    const decoded = isV6 ? decodeIPv6(network) : decodeIPv4(network);
    // These are compile-time constants below; a typo must fail loudly at import
    // rather than silently produce a block that matches nothing.
    if (decoded === null)
        throw new Error(`ssrf-guard: malformed CIDR ${notation}`);
    // IPv4 blocks are lifted into the IPv4-mapped range so one matcher serves
    // both families: a /8 in v4 terms is a /104 of the 128-bit space.
    const base = isV6 ? decoded : V4_MAPPED_BASE | decoded;
    const width = isV6 ? bits : bits + 96;
    const mask = ((ONE << BigInt(width)) - ONE) << BigInt(128 - width);
    return { base: base & mask, mask };
}
/**
 * IPv4 ranges that must never be reachable from a user-supplied target.
 * Stored pre-widened into the IPv4-mapped region of the 128-bit space so the
 * same `matches()` serves both families.
 */
const RESERVED_V4 = [
    '0.0.0.0/8', //        "this" network
    '10.0.0.0/8', //       RFC1918 private
    '100.64.0.0/10', //    CGNAT / Tailscale
    '127.0.0.0/8', //      loopback
    '169.254.0.0/16', //   link-local, incl. cloud metadata 169.254.169.254
    '172.16.0.0/12', //    RFC1918 private
    '192.0.0.0/24', //     IETF protocol assignments
    '192.0.2.0/24', //     TEST-NET-1
    '192.168.0.0/16', //   RFC1918 private
    '198.18.0.0/15', //    benchmarking
    '198.51.100.0/24', //  TEST-NET-2
    '203.0.113.0/24', //   TEST-NET-3
    '224.0.0.0/4', //      multicast
    '240.0.0.0/4', //      reserved, incl. the 255.255.255.255 broadcast
].map(cidr);
/**
 * IPv6 ranges that must never be reachable.
 *
 * `::ffff:0:0/96` blocks the IPv4-mapped region outright rather than unwrapping
 * it to the IPv4 rules. That is deliberate and stricter than it needs to be:
 * a caller with a genuine public target has no reason to write it as
 * `::ffff:8.8.8.8`, whereas that notation is a well-worn way to smuggle a
 * loopback past a checker that only pattern-matched v4 text. This list is
 * therefore NOT consulted for ordinary IPv4 — the blanket entry would match
 * every address once widened.
 */
const RESERVED_V6 = [
    '::/128', //           unspecified
    '::1/128', //          loopback
    '::ffff:0:0/96', //    IPv4-mapped — refused wholesale, see above
    '64:ff9b::/96', //     NAT64
    '64:ff9b:1::/48', //   local-use NAT64
    '100::/64', //         discard-only
    '2001:db8::/32', //    documentation
    'fc00::/7', //         unique-local
    'fe80::/10', //        link-local
    'fec0::/10', //        site-local — deprecated, still routed to internal hosts on some stacks
    'ff00::/8', //         multicast
].map(cidr);
function matches(value, blocks) {
    return blocks.some((block) => (value & block.mask) === block.base);
}
/**
 * True if a dotted-quad IPv4 string is private, reserved or otherwise not
 * publicly routable. Unparseable input counts as reserved — callers use this to
 * decide whether to send traffic, and "I could not read it" must not mean "go".
 *
 * Single source of truth for reachability: routes taking a user-supplied IP
 * (SSRF guard, subnet sweep, scanner) call this instead of carrying their own
 * block list.
 */
export function isReservedIPv4(ip) {
    const value = decodeIPv4(ip.trim());
    if (value === null)
        return true;
    return matches(V4_MAPPED_BASE | value, RESERVED_V4);
}
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
export function parseIPv4(s) {
    const value = decodeIPv4(s);
    if (value === null)
        return null;
    return [24, 16, 8, 0].map((shift) => (value >> BigInt(shift)) & BigInt(0xff)).join('.');
}
/**
 * Names that are never a legitimate target regardless of what they resolve to.
 * Checked before DNS: the answer does not matter, and a lookup would leak the
 * attempt to whoever controls the zone.
 */
const RESERVED_NAMES = [
    /^localhost$/,
    /\.localhost$/,
    /^host\.docker\.internal$/,
    /\.local$/,
    /\.internal$/,
];
// Letters/digits, inner hyphens, dot-separated. Rejects the empty label in
// 'a..b', leading/trailing hyphens, spaces and underscores.
const HOSTNAME = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)*$/;
/**
 * Validate that `host` — an IP literal or a hostname — is safe to use as a
 * network target. Fails when the literal is reserved or written in a
 * non-canonical IPv4 notation, when the name is reserved or malformed, or when
 * *any* DNS answer lands in a reserved range.
 */
export async function validateHost(host) {
    const name = host.trim();
    if (!name)
        return { ok: false, reason: 'empty host' };
    const lower = name.toLowerCase();
    if (RESERVED_NAMES.some((re) => re.test(lower))) {
        return { ok: false, reason: 'hostname matches reserved name pattern' };
    }
    // `[::1]` → `::1`; harmless for everything that is not a bracketed literal.
    const literal = name.replace(/^\[|\]$/g, '');
    const family = isIP(literal);
    if (family === 4) {
        const canonical = parseIPv4(literal);
        if (!canonical)
            return { ok: false, reason: 'non-canonical IPv4 form rejected' };
        if (isReservedIPv4(canonical))
            return { ok: false, reason: 'IPv4 in reserved range' };
        return { ok: true, resolved: [canonical] };
    }
    if (family === 6) {
        const value = decodeIPv6(literal);
        if (value === null || matches(value, RESERVED_V6)) {
            return { ok: false, reason: 'IPv6 in reserved range' };
        }
        return { ok: true, resolved: [literal] };
    }
    if (!HOSTNAME.test(name))
        return { ok: false, reason: 'invalid hostname syntax' };
    let answers;
    try {
        answers = await lookup(name, { all: true });
    }
    catch (err) {
        return { ok: false, reason: `DNS lookup failed: ${err.message}` };
    }
    if (answers.length === 0)
        return { ok: false, reason: 'hostname has no A/AAAA records' };
    // Reject if ANY answer is reserved. A host is only as trustworthy as its
    // worst record — accepting because one answer looked public would let a
    // multi-record zone walk straight past the guard.
    for (const { address, family: fam } of answers) {
        if (fam === 4 && isReservedIPv4(address)) {
            return { ok: false, reason: `hostname resolves to reserved IPv4 ${address}` };
        }
        if (fam === 6) {
            const value = decodeIPv6(address);
            if (value === null || matches(value, RESERVED_V6)) {
                return { ok: false, reason: `hostname resolves to reserved IPv6 ${address}` };
            }
        }
    }
    return { ok: true, resolved: answers.map((a) => a.address) };
}
/** Headers that must not survive a redirect to a different origin. */
const CREDENTIAL_HEADERS = ['authorization', 'cookie', 'proxy-authorization'];
function stripCredentials(init) {
    if (!init.headers)
        return init;
    const headers = new Headers(init.headers);
    for (const h of CREDENTIAL_HEADERS)
        headers.delete(h);
    return { ...init, headers };
}
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
export async function safeFetch(inputUrl, init = {}) {
    const { maxRedirects = 3, ...passInit } = init;
    let url = inputUrl;
    let requestInit = passInit;
    for (let hop = 0; hop <= maxRedirects; hop++) {
        let parsed;
        try {
            parsed = new URL(url);
        }
        catch {
            throw new Error('safeFetch: invalid URL');
        }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            throw new Error(`safeFetch: blocked protocol ${parsed.protocol}`);
        }
        const check = await validateHost(parsed.hostname);
        if (!check.ok)
            throw new Error(`safeFetch: blocked target — ${check.reason}`);
        const res = await fetch(url, { ...requestInit, redirect: 'manual' });
        if (res.status < 300 || res.status >= 400)
            return res;
        const location = res.headers.get('location');
        if (!location)
            return res; // a 3xx with nowhere to go is the caller's to interpret
        const next = new URL(location, url);
        if (next.origin !== parsed.origin)
            requestInit = stripCredentials(requestInit);
        url = next.toString();
    }
    throw new Error('safeFetch: too many redirects');
}
//# sourceMappingURL=ssrf-guard.js.map