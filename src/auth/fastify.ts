/**
 * The Fastify mount, and the one thing it must not do.
 *
 * Better Auth needs the unparsed request body, and its documentation says to
 * add a raw `application/json` parser. Added to the app — which is how the
 * snippet reads — it turns EVERY product route's body into a string: `zod`
 * schemas start refusing valid requests, and nothing in the failure points at
 * the line that caused it. Proven in the sandbox (§3.9):
 *
 *     global raw parser  → product route body: { typeofBody: 'string' }
 *     encapsulated       → product route: 'object'   auth branch: 'string'
 *
 * So the parser is registered inside an encapsulated plugin, which is a thing
 * the kit does for the product rather than a thing the product is told to
 * remember. The cost shows up here: inside this scope OUR own routes also
 * receive a string, and the two below parse it themselves.
 *
 * Nothing here imports Fastify — not even for a type. The slices used are
 * spelled structurally, the same way `./rate-limit.ts` spells a Redis client,
 * so `@exo/kit/auth` stays importable by a product that mounts it elsewhere.
 */
import type { AuthSessionInfo } from './index.js';

interface FastifyLikeRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
}

interface FastifyLikeReply {
  code(status: number): FastifyLikeReply;
  header(name: string, value: string): FastifyLikeReply;
  send(payload?: unknown): FastifyLikeReply;
}

interface FastifyLikeInstance {
  addContentTypeParser(
    contentType: string,
    options: { parseAs: 'string' },
    parser: (request: FastifyLikeRequest, body: string, done: (err: Error | null, body?: unknown) => void) => void,
  ): void;
  route(options: {
    method: string[];
    url: string;
    handler: (request: FastifyLikeRequest, reply: FastifyLikeReply) => Promise<unknown>;
  }): void;
}

export type AuthFastifyPlugin = (instance: FastifyLikeInstance) => Promise<void>;

/** What the plugin needs from the auth instance. */
export interface AuthFastifyConfig {
  basePath: string;
  /** Absolute origin — a Web `Request` has no relative form. */
  baseUrl: string;
  handler(request: Request): Promise<Response>;
  listSessions(headers: Headers): Promise<AuthSessionInfo[]>;
  revokeSession(headers: Headers, sessionId: string): Promise<boolean>;
}

const BODYLESS = new Set(['GET', 'HEAD', 'OPTIONS']);
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

function toHeaders(source: Record<string, string | string[] | undefined>): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const one of value) headers.append(name, one);
    else headers.set(name, value);
  }
  return headers;
}

/** The string this scope's parser left us. `{}` for anything unparseable. */
function jsonBody(body: unknown): Record<string, unknown> {
  if (typeof body === 'object' && body !== null) return body as Record<string, unknown>;
  if (typeof body !== 'string' || body.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(body);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * A refusal the library threw, answered in the library's own shape.
 *
 * `listSessions` and `revokeSession` go through `auth.api.*`, which THROWS an
 * `APIError` where the HTTP route would have answered. Left to Fastify's error
 * handler that became `{ statusCode: 401, error: 'Unauthorized' }` — no `code`
 * — while every other route under `basePath` says `{ message, code }`. kit-ui
 * had to read "401 without a code" as `no-session` (D1, 2026-09-14). The code
 * sent is the library's (`UNAUTHORIZED`), not a kit name: a product's client
 * already maps that one, and a third dialect for the same state buys nothing.
 *
 * Recognised structurally, like everything else in this file — no import from
 * the library. Only a 4xx with a string code is forwarded; anything else is a
 * real failure and stays Fastify's to report.
 */
function libraryRefusal(error: unknown): { status: number; body: { message: string; code: string } } | null {
  if (typeof error !== 'object' || error === null) return null;
  const { statusCode, body } = error as { statusCode?: unknown; body?: unknown };
  if (typeof statusCode !== 'number' || statusCode < 400 || statusCode > 499) return null;
  if (typeof body !== 'object' || body === null) return null;
  const { code, message } = body as { code?: unknown; message?: unknown };
  if (typeof code !== 'string' || code === '') return null;
  return { status: statusCode, body: { message: typeof message === 'string' ? message : code, code } };
}

export function createAuthFastifyPlugin(config: AuthFastifyConfig): AuthFastifyPlugin {
  const { basePath, baseUrl } = config;

  return async function authPlugin(app: FastifyLikeInstance): Promise<void> {
    // Scoped, not global. See the file comment — this single line is the
    // difference between a working product and one whose every JSON route
    // refuses valid input.
    app.addContentTypeParser('application/json', { parseAs: 'string' }, (_request, body, done) => {
      done(null, body);
    });

    // ── The two routes the kit answers instead of the library ──────────────
    // `/list-sessions` is in `disabledPaths`, because the library's version
    // hands back each session's raw token (§3.3). This one does not, and
    // `/revoke-session` therefore takes an id, since the caller never saw a
    // token. Both are registered as static paths, so Fastify prefers them over
    // the wildcard below.
    app.route({
      method: ['GET'],
      url: `${basePath}/list-sessions`,
      handler: async (request, reply) => {
        try {
          const sessions = await config.listSessions(toHeaders(request.headers));
          return reply.code(200).send({ sessions });
        } catch (error) {
          const refusal = libraryRefusal(error);
          if (!refusal) throw error;
          return reply.code(refusal.status).send(refusal.body);
        }
      },
    });

    app.route({
      method: ['POST'],
      url: `${basePath}/revoke-session`,
      handler: async (request, reply) => {
        const body = jsonBody(request.body);
        const id = typeof body.id === 'string' ? body.id : '';
        if (!id) return reply.code(400).send({ message: 'id is required', code: 'BAD_REQUEST' });
        let revoked: boolean;
        try {
          revoked = await config.revokeSession(toHeaders(request.headers), id);
        } catch (error) {
          const refusal = libraryRefusal(error);
          if (!refusal) throw error;
          return reply.code(refusal.status).send(refusal.body);
        }
        // Somebody else's session and a session that never existed answer the
        // same: a 403 would confirm that the id is real.
        if (!revoked) return reply.code(404).send({ message: 'Session not found', code: 'NOT_FOUND' });
        return reply.code(200).send({ status: true });
      },
    });

    // ── Everything else under basePath belongs to the library ──────────────
    app.route({
      method: METHODS,
      url: `${basePath}/*`,
      handler: async (request, reply) => {
        const response = await config.handler(
          new Request(new URL(request.url, baseUrl), {
            method: request.method,
            headers: toHeaders(request.headers),
            body: BODYLESS.has(request.method)
              ? undefined
              : typeof request.body === 'string'
                ? request.body
                : request.body === undefined || request.body === null
                  ? undefined
                  : JSON.stringify(request.body),
          }),
        );

        reply.code(response.status);
        // `getSetCookie` and nothing else: two cookies in one `Set-Cookie`
        // header is how a sign-in that also clears a two-factor cookie loses
        // one of them, and `Headers.get` joins them with a comma.
        // `forEach`, not `for…of`: the kit compiles against `lib: DOM` without
        // `DOM.Iterable`, and this file is the only place in it that walks a
        // `Headers`.
        response.headers.forEach((value, name) => {
          if (name.toLowerCase() === 'set-cookie') return;
          reply.header(name, value);
        });
        for (const cookie of response.headers.getSetCookie()) reply.header('set-cookie', cookie);

        const text = await response.text();
        return reply.send(text.length > 0 ? text : undefined);
      },
    });
  };
}
