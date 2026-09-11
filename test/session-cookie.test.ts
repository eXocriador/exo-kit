import { describe, it, expect } from 'vitest';
import { createSessionCookie } from '../src/auth-core/cookie.js';

/**
 * The cookie value is `<sessionId>.<hmac>`, and the only thing it proves is
 * that we issued it. Everything authoritative — revoked, expired, permitted —
 * is checked server-side; these tests hold the half that runs at the edge.
 */
const alpha = createSessionCookie({ cookieName: 'alpha_session', secret: () => 'secret-a' });
const beta = createSessionCookie({ cookieName: 'beta_session', secret: () => 'secret-b' });

describe('signSession / verifySignedSession', () => {
  it('round-trips a session id', async () => {
    const value = await alpha.signSession('sess-1');
    expect(value.startsWith('sess-1.')).toBe(true);
    expect(await alpha.verifySignedSession(value)).toBe('sess-1');
  });

  it('refuses a value signed with another secret', async () => {
    // Two installations, two secrets: a cookie minted by one must be worthless
    // to the other even when the session id is identical.
    const value = await beta.signSession('sess-1');
    expect(await alpha.verifySignedSession(value)).toBeNull();
  });

  it('refuses a tampered id, a tampered signature, and a missing one', async () => {
    const value = await alpha.signSession('sess-1');
    const [id, sig] = value.split('.');
    expect(await alpha.verifySignedSession(`sess-2.${sig}`)).toBeNull();
    expect(await alpha.verifySignedSession(`${id}.${'0'.repeat(64)}`)).toBeNull();
    expect(await alpha.verifySignedSession(id)).toBeNull();
    expect(await alpha.verifySignedSession('')).toBeNull();
    expect(await alpha.verifySignedSession(null)).toBeNull();
    expect(await alpha.verifySignedSession(undefined)).toBeNull();
    expect(await alpha.verifySignedSession('.abc')).toBeNull();
  });

  it('keeps a session id that contains dots intact', async () => {
    // The split is on the LAST dot, so an id is not silently truncated.
    const value = await alpha.signSession('a.b.c');
    expect(await alpha.verifySignedSession(value)).toBe('a.b.c');
  });

  it('carries the cookie name it was given, with no default to copy', () => {
    expect(alpha.SESSION_COOKIE).toBe('alpha_session');
    expect(beta.SESSION_COOKIE).toBe('beta_session');
  });

  it('reads the secret at call time, so a build never needs one', async () => {
    let calls = 0;
    let current = 'first';
    const rotating = createSessionCookie({
      cookieName: 'c',
      secret: () => {
        calls += 1;
        return current;
      },
    });
    expect(calls).toBe(0); // constructing it asked for nothing
    const value = await rotating.signSession('s');
    expect(calls).toBe(1);
    current = 'second';
    // Rotating the secret invalidates everything signed with the old one —
    // which is what a thunk buys, and why the kit does not cache the key.
    expect(await rotating.verifySignedSession(value)).toBeNull();
  });
});
