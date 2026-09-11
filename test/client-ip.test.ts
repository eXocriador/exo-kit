import { describe, it, expect } from 'vitest';
import { createClientIp } from '../src/http/client-ip.js';

function reqWith(headers: Record<string, string>): Request {
  return new Request('http://localhost/api/test', { headers });
}

const { getClientIp } = createClientIp({ trustedProxyHops: 1 });

// One trusted proxy hop — the default, and the shape of a single-host deploy.
// The whole point of this helper is that a client CANNOT pick its own identity
// by prepending entries to x-forwarded-for. With exactly one trusted hop, our
// proxy appends exactly one entry — the peer address it actually saw — so
// that right-most entry is the only trustworthy one, regardless of how many
// entries a client prepends ahead of it.
describe('getClientIp (trusted-proxy-aware)', () => {
  it('uses the entry the trusted proxy saw, not the client-supplied first token', () => {
    // Attacker sends a spoofed XFF; our single proxy appends the real peer
    // address it observed. The right-most (last) entry is the trustworthy one.
    const ip = getClientIp(
      reqWith({ 'x-forwarded-for': 'evil-spoof, 203.0.113.9' }),
    );
    expect(ip).toBe('203.0.113.9');
  });

  it('cannot be spoofed by injecting extra leading XFF entries', () => {
    const a = getClientIp(reqWith({ 'x-forwarded-for': '203.0.113.9' }));
    const b = getClientIp(
      reqWith({ 'x-forwarded-for': 'evil-spoof-1, evil-spoof-2, 203.0.113.9' }),
    );
    // Both resolve to the same real client; any number of prepended tokens
    // are ignored — only the right-most (proxy-appended) entry is trusted.
    expect(a).toBe('203.0.113.9');
    expect(b).toBe('203.0.113.9');
  });

  it('falls back to the right-most entry when the chain is shorter than expected', () => {
    // Direct hit (no proxy chain) — best effort, still not a leading-token pick.
    expect(getClientIp(reqWith({ 'x-forwarded-for': '203.0.113.9' }))).toBe('203.0.113.9');
  });

  it('falls back to x-real-ip, then "unknown", when XFF is absent', () => {
    expect(getClientIp(reqWith({ 'x-real-ip': '198.51.100.7' }))).toBe('198.51.100.7');
    expect(getClientIp(reqWith({}))).toBe('unknown');
  });

  it('ignores an empty or comma-only XFF and falls through to x-real-ip', () => {
    expect(getClientIp(reqWith({ 'x-forwarded-for': '', 'x-real-ip': '198.51.100.7' }))).toBe('198.51.100.7');
    expect(getClientIp(reqWith({ 'x-forwarded-for': ' , , ', 'x-real-ip': '198.51.100.7' }))).toBe('198.51.100.7');
  });

  it('trims surrounding whitespace on the chosen entry', () => {
    expect(getClientIp(reqWith({ 'x-forwarded-for': 'a,   203.0.113.9   ' }))).toBe('203.0.113.9');
    expect(getClientIp(reqWith({ 'x-real-ip': '  198.51.100.7  ' }))).toBe('198.51.100.7');
  });
});

/**
 * The hop count is the whole configuration of this module, and it is the reason
 * the module is a factory: the copies it came from read `TRUSTED_PROXY_HOPS`
 * from the environment at import time, which made the number untestable without
 * stubbing a variable name the kit has no business knowing.
 */
describe('trustedProxyHops', () => {
  it('with two hops, skips the entry the outer proxy appended', () => {
    const { getClientIp: twoHops } = createClientIp({ trustedProxyHops: 2 });
    // client → CDN → our proxy: the chain is [spoof, real-client, cdn-peer],
    // and the entry the OUTER trusted hop observed is the second from the right.
    expect(twoHops(reqWith({ 'x-forwarded-for': 'spoof, 203.0.113.9, 198.51.100.1' }))).toBe(
      '203.0.113.9',
    );
  });

  it('with zero hops, no forwarded entry is trusted beyond the right-most one', () => {
    const { getClientIp: noHops } = createClientIp({ trustedProxyHops: 0 });
    // chain.length - 0 is past the end, so the right-most entry is taken —
    // the same best-effort fallback a too-short chain gets.
    expect(noHops(reqWith({ 'x-forwarded-for': 'spoof, 203.0.113.9' }))).toBe('203.0.113.9');
  });

  it('defaults to one hop and to "unknown"', () => {
    const { getClientIp: byDefault } = createClientIp();
    expect(byDefault(reqWith({ 'x-forwarded-for': 'spoof, 203.0.113.9' }))).toBe('203.0.113.9');
    expect(byDefault(reqWith({}))).toBe('unknown');
  });

  it('a negative or fractional hop count falls back to one rather than mis-indexing', () => {
    const { getClientIp: nonsense } = createClientIp({ trustedProxyHops: -3 });
    expect(nonsense(reqWith({ 'x-forwarded-for': 'spoof, 203.0.113.9' }))).toBe('203.0.113.9');
  });
});
