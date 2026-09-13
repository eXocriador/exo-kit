const BODYLESS = new Set(['GET', 'HEAD', 'OPTIONS']);
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
function toHeaders(source) {
    const headers = new Headers();
    for (const [name, value] of Object.entries(source)) {
        if (value === undefined)
            continue;
        if (Array.isArray(value))
            for (const one of value)
                headers.append(name, one);
        else
            headers.set(name, value);
    }
    return headers;
}
/** The string this scope's parser left us. `{}` for anything unparseable. */
function jsonBody(body) {
    if (typeof body === 'object' && body !== null)
        return body;
    if (typeof body !== 'string' || body.length === 0)
        return {};
    try {
        const parsed = JSON.parse(body);
        return typeof parsed === 'object' && parsed !== null ? parsed : {};
    }
    catch {
        return {};
    }
}
export function createAuthFastifyPlugin(config) {
    const { basePath, baseUrl } = config;
    return async function authPlugin(app) {
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
                const sessions = await config.listSessions(toHeaders(request.headers));
                return reply.code(200).send({ sessions });
            },
        });
        app.route({
            method: ['POST'],
            url: `${basePath}/revoke-session`,
            handler: async (request, reply) => {
                const body = jsonBody(request.body);
                const id = typeof body.id === 'string' ? body.id : '';
                if (!id)
                    return reply.code(400).send({ message: 'id is required', code: 'BAD_REQUEST' });
                const revoked = await config.revokeSession(toHeaders(request.headers), id);
                // Somebody else's session and a session that never existed answer the
                // same: a 403 would confirm that the id is real.
                if (!revoked)
                    return reply.code(404).send({ message: 'Session not found', code: 'NOT_FOUND' });
                return reply.code(200).send({ status: true });
            },
        });
        // ── Everything else under basePath belongs to the library ──────────────
        app.route({
            method: METHODS,
            url: `${basePath}/*`,
            handler: async (request, reply) => {
                const response = await config.handler(new Request(new URL(request.url, baseUrl), {
                    method: request.method,
                    headers: toHeaders(request.headers),
                    body: BODYLESS.has(request.method)
                        ? undefined
                        : typeof request.body === 'string'
                            ? request.body
                            : request.body === undefined || request.body === null
                                ? undefined
                                : JSON.stringify(request.body),
                }));
                reply.code(response.status);
                // `getSetCookie` and nothing else: two cookies in one `Set-Cookie`
                // header is how a sign-in that also clears a two-factor cookie loses
                // one of them, and `Headers.get` joins them with a comma.
                // `forEach`, not `for…of`: the kit compiles against `lib: DOM` without
                // `DOM.Iterable`, and this file is the only place in it that walks a
                // `Headers`.
                response.headers.forEach((value, name) => {
                    if (name.toLowerCase() === 'set-cookie')
                        return;
                    reply.header(name, value);
                });
                for (const cookie of response.headers.getSetCookie())
                    reply.header('set-cookie', cookie);
                const text = await response.text();
                return reply.send(text.length > 0 ? text : undefined);
            },
        });
    };
}
//# sourceMappingURL=fastify.js.map