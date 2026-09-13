/**
 * A fake OAuth provider, in one loopback HTTP server.
 *
 * This is the thing that makes the tests next door possible. The merge policy
 * is the most important decision `@exo/kit/auth` makes, and it only ever fires
 * on the way back from a provider — so without a provider it can only be
 * asserted against a copy of the config, which is exactly the kind of test that
 * stays green through the upgrade that breaks it. GitHub and Google are
 * unreachable without a domain and keys; forty lines of `http` are not.
 *
 * `genericOAuth` is used to register it, and that matters for what the test
 * proves: in 1.7.4 the plugin injects its providers into the SAME
 * `socialProviders` list GitHub and Google land in, so `/sign-in/social` and
 * `/callback/:id` run the identical code path. The fake is in the provider
 * slot, not in the policy.
 *
 * Lifted from `/srv/staging/auth-spike/app/idp.mjs`, the sandbox session's own
 * fake (report §2), and kept here because the sandbox is gone.
 */
import { createServer, type Server } from 'node:http';

export interface FakeIdp {
  /** What the next `/userinfo` will claim. Set per test case. */
  profile: { sub: string; email: string; emailVerified: boolean; name: string };
  port: number;
  close(): Promise<void>;
}

export async function startFakeIdp(): Promise<FakeIdp> {
  const state: FakeIdp['profile'] = {
    sub: 'idp-subject-1',
    email: 'a@example.com',
    emailVerified: true,
    name: 'A Person',
  };

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/authorize') {
      // No consent screen, no login: bounce straight back with a code. The
      // thing under test is what our side does with the answer.
      const back = new URL(url.searchParams.get('redirect_uri') ?? '');
      back.searchParams.set('code', 'the-code');
      back.searchParams.set('state', url.searchParams.get('state') ?? '');
      res.writeHead(302, { location: back.toString() }).end();
      return;
    }
    if (url.pathname === '/token') {
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ access_token: 'access-token', token_type: 'Bearer' }));
      return;
    }
    if (url.pathname === '/userinfo') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          sub: state.sub,
          email: state.email,
          // The field name a real OIDC provider uses, and the trap auth.md
          // names: a provider that sends the STRING "false" here would make
          // `Boolean(value)` true. The mapping below compares to `true`.
          email_verified: state.emailVerified,
          name: state.name,
        }),
      );
      return;
    }
    res.writeHead(404).end();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  return {
    profile: state,
    port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** The `genericOAuth` entry that points at a running fake. */
export function fakeIdpConfig(port: number) {
  return {
    providerId: 'fakeidp',
    clientId: 'client-id',
    clientSecret: 'client-secret',
    authorizationUrl: `http://127.0.0.1:${port}/authorize`,
    tokenUrl: `http://127.0.0.1:${port}/token`,
    userInfoUrl: `http://127.0.0.1:${port}/userinfo`,
    scopes: ['openid', 'email'],
    // Without discovery the plugin reads `profile.id`, which an OIDC provider
    // does not send; the identity is `sub`.
    accountSubject: ({ profile }: { profile: Record<string, unknown> }) => String(profile.sub ?? ''),
    mapProfileToUser: (profile: Record<string, unknown>) => ({
      email: String(profile.email ?? ''),
      emailVerified: profile.email_verified === true,
      name: typeof profile.name === 'string' ? profile.name : undefined,
    }),
  };
}
