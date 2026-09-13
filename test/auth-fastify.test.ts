import { describe, it, expect } from 'vitest';
import { createAuthFastifyPlugin } from '../src/auth/fastify.js';

/**
 * What the mount registers, and where.
 *
 * The expensive mistake this file guards is one line in Better Auth's own
 * documentation: a raw `application/json` parser added to the app turns every
 * product route's body into a string, `zod` schemas start refusing valid input,
 * and nothing in the failure names the cause (sandbox §3.9). The fix is that
 * the parser is registered on the instance the plugin is HANDED — Fastify
 * encapsulates that by construction — and never on anything wider.
 *
 * A recording fake rather than real Fastify: what belongs to the kit is which
 * calls it makes on the scope it was given, and that is exactly what a fake can
 * hold. Encapsulation itself is Fastify's promise, and it is proven end to end
 * where it matters — in a product whose JSON routes go on working beside the
 * login (filebrowser's `server.test.ts`).
 */

interface Recorded {
  parsers: string[];
  routes: { method: string[]; url: string }[];
  handlers: Map<string, (request: unknown, reply: unknown) => Promise<unknown>>;
}

function recordingInstance() {
  const recorded: Recorded = { parsers: [], routes: [], handlers: new Map() };
  const instance = {
    addContentTypeParser(contentType: string) {
      recorded.parsers.push(contentType);
    },
    route(options: { method: string[]; url: string; handler: (r: unknown, p: unknown) => Promise<unknown> }) {
      recorded.routes.push({ method: options.method, url: options.url });
      recorded.handlers.set(options.url, options.handler);
    },
  };
  return { instance, recorded };
}

function fakeReply() {
  const state = { status: 0, headers: [] as [string, string][], payload: undefined as unknown };
  const reply = {
    code(status: number) {
      state.status = status;
      return reply;
    },
    header(name: string, value: string) {
      state.headers.push([name, value]);
      return reply;
    },
    send(payload?: unknown) {
      state.payload = payload;
      return reply;
    },
  };
  return { reply, state };
}

function plugin(overrides: Partial<Parameters<typeof createAuthFastifyPlugin>[0]> = {}) {
  return createAuthFastifyPlugin({
    basePath: '/api/account',
    baseUrl: 'https://files.example.com',
    handler: async () => new Response('{}', { status: 200 }),
    listSessions: async () => [],
    revokeSession: async () => true,
    ...overrides,
  });
}

describe('the Fastify mount', () => {
  it('registers the raw body parser on the scope it was given, and nothing else', async () => {
    const { instance, recorded } = recordingInstance();
    await plugin()(instance as never);
    // One parser, one content type. A second would mean the plugin had started
    // deciding how the product's own routes are parsed.
    expect(recorded.parsers).toEqual(['application/json']);
  });

  it('claims three routes: the two it answers itself, and the library’s catch-all', async () => {
    const { instance, recorded } = recordingInstance();
    await plugin()(instance as never);
    expect(recorded.routes.map((route) => route.url)).toEqual([
      '/api/account/list-sessions',
      '/api/account/revoke-session',
      '/api/account/*',
    ]);
    // Static paths are registered BEFORE the wildcard and Fastify prefers them
    // regardless — but the order is also the reading order for a person.
    expect(recorded.routes[2]!.method).toContain('POST');
    expect(recorded.routes[2]!.method).toContain('GET');
  });

  it('parses its own body itself, because the scope handed it a string', async () => {
    // The price of the encapsulated parser: inside this scope OUR routes also
    // receive text. A plugin that forgot this would read `undefined` from
    // `request.body.id` and answer 400 to every revoke.
    const seen: string[] = [];
    const { instance, recorded } = recordingInstance();
    await plugin({
      revokeSession: async (_headers, id) => {
        seen.push(id);
        return true;
      },
    })(instance as never);

    const handler = recorded.handlers.get('/api/account/revoke-session')!;
    const { reply, state } = fakeReply();
    await handler(
      { method: 'POST', url: '/api/account/revoke-session', headers: {}, body: '{"id":"abc"}' },
      reply,
    );
    expect(seen).toEqual(['abc']);
    expect(state.status).toBe(200);
  });

  it('answers a missing or foreign session id with 404, never 403', async () => {
    const { instance, recorded } = recordingInstance();
    await plugin({ revokeSession: async () => false })(instance as never);
    const handler = recorded.handlers.get('/api/account/revoke-session')!;

    const missing = fakeReply();
    await handler({ method: 'POST', url: '/x', headers: {}, body: '{"id":"nope"}' }, missing.reply);
    expect(missing.state.status).toBe(404);

    const noId = fakeReply();
    await handler({ method: 'POST', url: '/x', headers: {}, body: '{}' }, noId.reply);
    expect(noId.state.status).toBe(400);

    const garbage = fakeReply();
    await handler({ method: 'POST', url: '/x', headers: {}, body: 'not json' }, garbage.reply);
    expect(garbage.state.status).toBe(400);
  });

  it('passes every Set-Cookie through separately', async () => {
    // A sign-in that also clears a two-factor cookie sends two, and
    // `Headers.get('set-cookie')` joins them with a comma — which is how a
    // browser ends up with one malformed cookie instead of two good ones.
    const response = new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
    response.headers.append('set-cookie', 'a_session=1; Path=/; HttpOnly');
    response.headers.append('set-cookie', 'a_two_factor=; Max-Age=0');

    const { instance, recorded } = recordingInstance();
    await plugin({ handler: async () => response })(instance as never);
    const handler = recorded.handlers.get('/api/account/*')!;
    const { reply, state } = fakeReply();
    await handler({ method: 'GET', url: '/api/account/get-session', headers: {} }, reply);

    const cookies = state.headers.filter(([name]) => name === 'set-cookie').map(([, value]) => value);
    expect(cookies).toEqual(['a_session=1; Path=/; HttpOnly', 'a_two_factor=; Max-Age=0']);
    expect(state.headers).toContainEqual(['content-type', 'application/json']);
    expect(state.payload).toBe('{"ok":true}');
  });

  it('builds an absolute URL for the handler, and sends no body on a GET', async () => {
    // A Web `Request` has no relative form, so the configured origin is what
    // makes one. A body on a GET throws inside `Request` before the handler is
    // ever reached.
    const seen: { url: string; body: string | null }[] = [];
    const { instance, recorded } = recordingInstance();
    await plugin({
      handler: async (request) => {
        seen.push({ url: request.url, body: request.body ? await request.text() : null });
        return new Response(null, { status: 204 });
      },
    })(instance as never);
    const handler = recorded.handlers.get('/api/account/*')!;

    await handler({ method: 'GET', url: '/api/account/get-session?x=1', headers: {} }, fakeReply().reply);
    expect(seen[0]!.url).toBe('https://files.example.com/api/account/get-session?x=1');
    expect(seen[0]!.body).toBe(null);

    await handler(
      { method: 'POST', url: '/api/account/sign-out', headers: {}, body: '{"a":1}' },
      fakeReply().reply,
    );
    expect(seen[1]!.body).toBe('{"a":1}');
  });

  it('forwards the request headers as a Headers, arrays included', async () => {
    const seen: Headers[] = [];
    const { instance, recorded } = recordingInstance();
    await plugin({
      handler: async (request) => {
        seen.push(request.headers);
        return new Response(null, { status: 204 });
      },
    })(instance as never);
    const handler = recorded.handlers.get('/api/account/*')!;
    await handler(
      {
        method: 'GET',
        url: '/api/account/get-session',
        headers: { cookie: 'a=1', 'x-forwarded-for': ['10.0.0.1', '10.0.0.2'], 'x-empty': undefined },
        },
      fakeReply().reply,
    );
    expect(seen[0]!.get('cookie')).toBe('a=1');
    expect(seen[0]!.get('x-forwarded-for')).toBe('10.0.0.1, 10.0.0.2');
    expect(seen[0]!.has('x-empty')).toBe(false);
  });
});
