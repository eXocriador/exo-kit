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
    addContentTypeParser(contentType: string, options: {
        parseAs: 'string';
    }, parser: (request: FastifyLikeRequest, body: string, done: (err: Error | null, body?: unknown) => void) => void): void;
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
export declare function createAuthFastifyPlugin(config: AuthFastifyConfig): AuthFastifyPlugin;
export {};
//# sourceMappingURL=fastify.d.ts.map