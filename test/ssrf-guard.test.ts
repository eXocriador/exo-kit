import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// `validateHost` resolves hostnames through node:dns. Tests must never depend
// on the sandbox's real resolver (offline CI would "pass" for the wrong
// reason, and a wildcard DNS provider could make a reserved-range assertion
// flap), so the lookup is mocked and each test states the answer it wants.
const { lookup } = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock('node:dns/promises', () => ({ lookup }));

import { parseIPv4, isReservedIPv4, validateHost, safeFetch } from '../src/http/ssrf-guard.js';

/** Make `lookup(host, {all:true})` answer with these addresses. */
function resolvesTo(...addresses: string[]): void {
  lookup.mockResolvedValue(
    addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })),
  );
}

beforeEach(() => {
  lookup.mockReset();
});

describe('parseIPv4', () => {
  it('accepts and canonicalises dotted-quad', () => {
    expect(parseIPv4('8.8.8.8')).toBe('8.8.8.8');
    expect(parseIPv4('01.02.03.04')).toBe('1.2.3.4'); // leading zeros normalised
  });

  it('canonicalises the boundary octets', () => {
    expect(parseIPv4('0.0.0.0')).toBe('0.0.0.0');
    expect(parseIPv4('255.255.255.255')).toBe('255.255.255.255');
  });

  it('rejects out-of-range octets', () => {
    expect(parseIPv4('256.1.1.1')).toBeNull();
    expect(parseIPv4('1.2.3.999')).toBeNull();
    expect(parseIPv4('1.2.3.256')).toBeNull();
  });

  it('rejects non-canonical / non-dotted-quad forms', () => {
    expect(parseIPv4('2130706433')).toBeNull(); // decimal 127.0.0.1
    expect(parseIPv4('0x7f000001')).toBeNull(); // hex
    expect(parseIPv4('1.2.3')).toBeNull();
    expect(parseIPv4('not.an.ip')).toBeNull();
  });

  /**
   * The whole reason this function refuses to be clever: every one of these is
   * a spelling of 127.0.0.1 that some resolver/kernel will happily accept. If
   * `parseIPv4` ever "helpfully" canonicalised them instead of returning null,
   * they would flow into `isReservedIPv4` — which only understands dotted-quad
   * — and be waved through as a public address. Rejecting is the safe answer.
   */
  it('rejects every alternate encoding of loopback rather than canonicalising it', () => {
    for (const form of [
      '0177.0.0.1', // dotted-octal
      '0x7f.0.0.1', // dotted-hex
      '127.1', // "short" form
      '127.0.1', // 3-part short form
      '017700000001', // pure octal
      '0x7F000001', // upper-case hex
    ]) {
      expect(parseIPv4(form), form).toBeNull();
    }
  });

  it('rejects padding, whitespace and sign tricks', () => {
    for (const form of ['', ' ', ' 8.8.8.8', '8.8.8.8 ', '8.8.8.8.', '.8.8.8.8', '-1.2.3.4', '+1.2.3.4', '8.8.8.8/24']) {
      expect(parseIPv4(form), JSON.stringify(form)).toBeNull();
    }
  });
});

describe('isReservedIPv4', () => {
  it('flags private / loopback / link-local / CGNAT ranges', () => {
    for (const ip of [
      '10.0.0.1',
      '172.16.0.1',
      '192.168.1.1',
      '127.0.0.1',
      '169.254.169.254', // cloud metadata
      '100.64.0.1', // CGNAT
      '0.0.0.0',
      '224.0.0.1', // multicast
    ]) {
      expect(isReservedIPv4(ip), ip).toBe(true);
    }
  });

  it('allows public addresses', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '100.128.0.1', '93.184.216.34']) {
      expect(isReservedIPv4(ip), ip).toBe(false);
    }
  });

  /**
   * Off-by-one in a CIDR mask is the classic way an SSRF block list springs a
   * leak, and it is invisible to "spot-check one address per range" tests. Walk
   * every block: last address *below* it must be public, first and last address
   * *inside* it must be reserved, first address *above* it public again.
   */
  it.each([
    // [name,            justBelow,          firstInside,        lastInside,          justAbove]
    ['0.0.0.0/8', null, '0.0.0.0', '0.255.255.255', '1.0.0.0'],
    ['10.0.0.0/8', '9.255.255.255', '10.0.0.0', '10.255.255.255', '11.0.0.0'],
    ['100.64.0.0/10', '100.63.255.255', '100.64.0.0', '100.127.255.255', '100.128.0.0'],
    ['127.0.0.0/8', '126.255.255.255', '127.0.0.0', '127.255.255.255', '128.0.0.0'],
    ['169.254.0.0/16', '169.253.255.255', '169.254.0.0', '169.254.255.255', '169.255.0.0'],
    ['172.16.0.0/12', '172.15.255.255', '172.16.0.0', '172.31.255.255', '172.32.0.0'],
    ['192.0.0.0/24', '191.255.255.255', '192.0.0.0', '192.0.0.255', '192.0.1.0'],
    ['192.0.2.0/24', '192.0.1.255', '192.0.2.0', '192.0.2.255', '192.0.3.0'],
    ['192.168.0.0/16', '192.167.255.255', '192.168.0.0', '192.168.255.255', '192.169.0.0'],
    ['198.18.0.0/15', '198.17.255.255', '198.18.0.0', '198.19.255.255', '198.20.0.0'],
    ['198.51.100.0/24', '198.51.99.255', '198.51.100.0', '198.51.100.255', '198.51.101.0'],
    ['203.0.113.0/24', '203.0.112.255', '203.0.113.0', '203.0.113.255', '203.0.114.0'],
    ['224.0.0.0/4', '223.255.255.255', '224.0.0.0', '239.255.255.255', null],
    ['240.0.0.0/4', null, '240.0.0.0', '255.255.255.255', null],
  ])('pins the exact edges of %s', (name, justBelow, firstInside, lastInside, justAbove) => {
    expect(isReservedIPv4(firstInside as string), `${name} first`).toBe(true);
    expect(isReservedIPv4(lastInside as string), `${name} last`).toBe(true);
    // `justBelow`/`justAbove` are null where the neighbouring range is itself
    // reserved (0.0.0.0/8 has nothing below; 224/4 and 240/4 are adjacent and
    // run to the end of the space), so there is no public address to assert.
    if (justBelow) expect(isReservedIPv4(justBelow), `${name} below`).toBe(false);
    if (justAbove) expect(isReservedIPv4(justAbove), `${name} above`).toBe(false);
  });

  it('flags the broadcast address', () => {
    expect(isReservedIPv4('255.255.255.255')).toBe(true);
  });

  /**
   * Fail-closed. Callers use this to decide whether to put a packet on the
   * wire, so "I could not parse that" has to mean "do not go" — the opposite
   * default turns any parser gap into an open proxy.
   */
  it('treats unparseable input as reserved rather than public', () => {
    for (const junk of ['', 'not-an-ip', '1.2.3', '1.2.3.4.5', '999.1.1.1', '0x7f000001', '2130706433']) {
      expect(isReservedIPv4(junk), JSON.stringify(junk)).toBe(true);
    }
  });

  it('tolerates surrounding whitespace on an otherwise valid address', () => {
    expect(isReservedIPv4('  127.0.0.1  ')).toBe(true);
    expect(isReservedIPv4('  8.8.8.8  ')).toBe(false);
  });
});

describe('validateHost (offline paths — IP literals & name blocklist)', () => {
  it('accepts a public IPv4 literal without DNS', async () => {
    const r = await validateHost('8.8.8.8');
    expect(r.ok).toBe(true);
    expect(r.resolved).toEqual(['8.8.8.8']);
    expect(lookup).not.toHaveBeenCalled();
  });

  it('rejects reserved IPv4 / IPv6 literals', async () => {
    expect((await validateHost('127.0.0.1')).ok).toBe(false);
    expect((await validateHost('169.254.169.254')).ok).toBe(false);
    expect((await validateHost('[::1]')).ok).toBe(false);
  });

  it('rejects non-canonical (expanded) spellings of reserved IPv6 addresses', async () => {
    // Same address as "::1", spelled out — a string-prefix check on "::"/"::1"
    // misses this form entirely; the numeric comparison must not.
    expect((await validateHost('0:0:0:0:0:0:0:1')).ok).toBe(false);
    expect((await validateHost('0:0:0:0:0:0:0:0')).ok).toBe(false); // "::"
    expect((await validateHost('fe80:0:0:0:0:0:0:1')).ok).toBe(false); // link-local
  });

  /**
   * The IPv4-mapped range ::ffff:0:0/96 is the bypass that a textual
   * prefix check misses most often: `::ffff:127.0.0.1` and `::ffff:7f00:1`
   * are the same 128-bit value written two ways, and only one of them starts
   * with a recognisable "127." string.
   */
  it('rejects IPv4-mapped IPv6 in both dotted and hex-group spellings', async () => {
    for (const form of [
      '::ffff:127.0.0.1',
      '::ffff:7f00:1',
      '::ffff:10.0.0.1',
      '::ffff:169.254.169.254',
      '0:0:0:0:0:ffff:7f00:0001',
    ]) {
      expect((await validateHost(form)).ok, form).toBe(false);
    }
  });

  it.each([
    ['unique-local fc00::/7', 'fc00::1'],
    ['unique-local fd-half', 'fd12:3456::1'],
    ['link-local fe80::/10', 'fe80::1'],
    ['site-local fec0::/10', 'fec0::1'],
    ['multicast ff00::/8', 'ff02::1'],
    ['documentation 2001:db8::/32', '2001:db8::1'],
    ['NAT64 64:ff9b::/96', '64:ff9b::1'],
    ['discard 100::/64', '100::1'],
  ])('rejects reserved IPv6 range: %s', async (_name, addr) => {
    expect((await validateHost(addr)).ok, addr).toBe(false);
  });

  it('allows public IPv6', async () => {
    const r = await validateHost('2001:4860:4860::8888'); // Google DNS
    expect(r.ok).toBe(true);
  });

  it('accepts a bracketed public IPv6 literal and reports it unbracketed', async () => {
    const r = await validateHost('[2001:4860:4860::8888]');
    expect(r.ok).toBe(true);
    expect(r.resolved).toEqual(['2001:4860:4860::8888']);
  });

  it('rejects reserved hostnames before any DNS lookup', async () => {
    for (const name of [
      'localhost',
      'foo.localhost',
      'host.docker.internal',
      'service.internal',
      'printer.local',
      'metadata.google.internal',
    ]) {
      expect((await validateHost(name)).ok, name).toBe(false);
    }
    expect(lookup).not.toHaveBeenCalled();
  });

  it('matches the name blocklist case-insensitively', async () => {
    for (const name of ['LOCALHOST', 'Metadata.Google.Internal', 'Printer.LOCAL']) {
      expect((await validateHost(name)).ok, name).toBe(false);
    }
    expect(lookup).not.toHaveBeenCalled();
  });

  it('rejects empty / whitespace-only input', async () => {
    expect((await validateHost('')).ok).toBe(false);
    expect((await validateHost('   ')).ok).toBe(false);
  });

  it('rejects malformed hostname syntax before DNS', async () => {
    for (const name of ['-bad.example.com', 'bad-.example.com', 'has space.com', 'under_score.com', 'a..b.com']) {
      expect((await validateHost(name)).ok, name).toBe(false);
    }
    expect(lookup).not.toHaveBeenCalled();
  });
});

describe('validateHost (DNS paths)', () => {
  it('accepts a hostname whose answers are all public', async () => {
    resolvesTo('93.184.216.34');
    const r = await validateHost('example.com');
    expect(r.ok).toBe(true);
    expect(r.resolved).toEqual(['93.184.216.34']);
  });

  it('rejects a hostname resolving to a reserved IPv4 (DNS-rebinding style)', async () => {
    resolvesTo('127.0.0.1');
    const r = await validateHost('evil.example.com');
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('127.0.0.1');
  });

  it('rejects the cloud-metadata address specifically', async () => {
    resolvesTo('169.254.169.254');
    expect((await validateHost('metadata.example.com')).ok).toBe(false);
  });

  /**
   * A host with several A records is only as safe as its *worst* answer — a
   * "reject if any answer is reserved" rule, not "accept if any is public".
   * Ordering must not matter, so assert both permutations.
   */
  it('rejects when only one of several answers is reserved, in either order', async () => {
    resolvesTo('93.184.216.34', '10.0.0.1');
    expect((await validateHost('mixed.example.com')).ok).toBe(false);

    resolvesTo('10.0.0.1', '93.184.216.34');
    expect((await validateHost('mixed.example.com')).ok).toBe(false);
  });

  it('rejects when an AAAA answer is reserved even though the A answer is public', async () => {
    resolvesTo('93.184.216.34', '::1');
    const r = await validateHost('dual.example.com');
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('IPv6');
  });

  it('rejects when the resolver returns no records', async () => {
    lookup.mockResolvedValue([]);
    expect((await validateHost('void.example.com')).ok).toBe(false);
  });

  it('fails closed when the lookup itself throws', async () => {
    lookup.mockRejectedValue(new Error('ENOTFOUND'));
    const r = await validateHost('nx.example.com');
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('ENOTFOUND');
  });
});

describe('safeFetch', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  /** Queue up responses for successive fetch calls. */
  function mockFetchSequence(...responses: Response[]) {
    const spy = vi.fn();
    for (const res of responses) spy.mockResolvedValueOnce(res);
    globalThis.fetch = spy as unknown as typeof fetch;
    return spy;
  }

  function redirectTo(location: string): Response {
    return new Response(null, { status: 302, headers: { location } });
  }

  it('rejects non-http(s) protocols before any network call', async () => {
    const spy = mockFetchSequence();
    for (const url of ['file:///etc/passwd', 'gopher://example.com/', 'ftp://example.com/']) {
      await expect(safeFetch(url), url).rejects.toThrow(/blocked protocol/);
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it('rejects an unparseable URL', async () => {
    await expect(safeFetch('not a url')).rejects.toThrow(/invalid URL/);
  });

  it('blocks a request straight at a reserved host', async () => {
    const spy = mockFetchSequence();
    await expect(safeFetch('http://127.0.0.1/admin')).rejects.toThrow(/blocked target/);
    expect(spy).not.toHaveBeenCalled();
  });

  it('passes through a public host and returns the response', async () => {
    resolvesTo('93.184.216.34');
    mockFetchSequence(new Response('ok', { status: 200 }));
    const res = await safeFetch('https://example.com/');
    expect(res.status).toBe(200);
    await expect(res.text()).resolves.toBe('ok');
  });

  /**
   * The reason redirects are followed by hand instead of by `fetch`: a
   * public-looking URL that 302s to the cloud-metadata endpoint is the
   * standard SSRF filter bypass. Every hop must be re-validated, and the
   * second fetch must never happen.
   */
  it('re-validates each redirect hop and blocks a public → reserved redirect', async () => {
    resolvesTo('93.184.216.34');
    const spy = mockFetchSequence(redirectTo('http://169.254.169.254/latest/meta-data/'));
    await expect(safeFetch('https://example.com/')).rejects.toThrow(/blocked target/);
    expect(spy).toHaveBeenCalledTimes(1); // the hop was never fetched
  });

  it('resolves a relative Location against the current URL and re-validates it', async () => {
    resolvesTo('93.184.216.34');
    const spy = mockFetchSequence(redirectTo('/second'), new Response('done', { status: 200 }));
    const res = await safeFetch('https://example.com/first');
    expect(res.status).toBe(200);
    expect(spy.mock.calls[1]?.[0]).toBe('https://example.com/second');
  });

  it('returns the 3xx as-is when it carries no Location header', async () => {
    resolvesTo('93.184.216.34');
    mockFetchSequence(new Response(null, { status: 302 }));
    const res = await safeFetch('https://example.com/');
    expect(res.status).toBe(302);
  });

  it('gives up after maxRedirects hops', async () => {
    resolvesTo('93.184.216.34');
    mockFetchSequence(
      redirectTo('https://example.com/1'),
      redirectTo('https://example.com/2'),
      redirectTo('https://example.com/3'),
      redirectTo('https://example.com/4'),
      redirectTo('https://example.com/5'),
    );
    await expect(safeFetch('https://example.com/', { maxRedirects: 2 })).rejects.toThrow(/too many redirects/);
  });

  /**
   * A redirect is attacker-chosen input. If a hop crosses to another origin,
   * anything that authenticates us must not travel with it — otherwise a
   * cooperating public host can 302 our API key to a collector. Same-origin
   * hops keep their headers, because that is an ordinary redirect.
   */
  it('drops credential headers when a redirect crosses origin', async () => {
    resolvesTo('93.184.216.34');
    const spy = mockFetchSequence(
      redirectTo('https://other.example.org/x'),
      new Response('ok', { status: 200 }),
    );
    await safeFetch('https://example.com/', {
      headers: { authorization: 'Bearer secret', cookie: 'sid=1', 'x-trace': 'keep' },
    });
    const sent = new Headers((spy.mock.calls[1]?.[1] as RequestInit).headers);
    expect(sent.get('authorization')).toBeNull();
    expect(sent.get('cookie')).toBeNull();
    expect(sent.get('x-trace')).toBe('keep'); // non-credential headers survive
  });

  it('keeps credential headers on a same-origin redirect', async () => {
    resolvesTo('93.184.216.34');
    const spy = mockFetchSequence(redirectTo('https://example.com/x'), new Response('ok', { status: 200 }));
    await safeFetch('https://example.com/', { headers: { authorization: 'Bearer secret' } });
    const sent = new Headers((spy.mock.calls[1]?.[1] as RequestInit).headers);
    expect(sent.get('authorization')).toBe('Bearer secret');
  });

  it('drives fetch with redirect:manual and never leaks maxRedirects into the init', async () => {
    resolvesTo('93.184.216.34');
    const spy = mockFetchSequence(new Response('ok'));
    await safeFetch('https://example.com/', { maxRedirects: 1, headers: { 'x-test': '1' } });
    const init = spy.mock.calls[0]?.[1] as RequestInit & { maxRedirects?: number };
    expect(init.redirect).toBe('manual');
    expect(init.maxRedirects).toBeUndefined();
    expect(init.headers).toEqual({ 'x-test': '1' });
  });
});
