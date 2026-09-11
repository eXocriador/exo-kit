/**
 * `@exo/kit/connector-sdk` — what a product installs to be supportable.
 *
 * A product implements three things about itself and mounts one route. From
 * that moment its customers are answered by the support installation, with
 * their real plan and their real usage, and nothing about the product lives in
 * the support engine.
 *
 *   // app/api/support-connector/[...path]/route.ts   (Next.js)
 *   import { createConnectorHandler } from '@exo/kit/connector-sdk';
 *
 *   const handler = createConnectorHandler({
 *     secret: process.env.SUPPORT_CONNECTOR_SECRET!,
 *     facts: async () => ({ ... }),
 *     resolveIdentity: async (query) => { ... },
 *     tools: {
 *       account_status: async (userId) => { ... },
 *     },
 *   });
 *
 *   export const GET = handler;
 *   export const POST = handler;
 *
 * Everything is optional except `facts`: a product that implements only facts
 * gets agents that answer from its knowledge base, which is already the whole
 * job for most questions.
 *
 * ── This is one half of an HMAC agreement ──
 * The other half is the signer in the support installation. If the scheme
 * changes on one side only, every connector call returns 401 and the support
 * agents lose this product's plans, usage and identities — silently, because a
 * connector failure degrades to "unidentified customer" rather than an error a
 * human sees. Change both halves in the same release, and bump the kit version
 * the installation pins.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
function verify(secrets, timestamp, body, signature, toleranceMs) {
    const ts = Number(timestamp);
    if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > toleranceMs)
        return false;
    const got = Buffer.from(signature.replace(/^sha256=/, ''), 'hex');
    return secrets.some((secret) => {
        const expected = Buffer.from(createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex'), 'hex');
        return expected.length === got.length && timingSafeEqual(expected, got);
    });
}
function json(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { 'content-type': 'application/json' },
    });
}
/**
 * Builds a Web-standard request handler. Works anywhere `Request`/`Response`
 * do — Next.js route handlers, Hono, Bun, Deno, workers.
 *
 * Authenticity is not optional and there is no unsigned fallback: this
 * endpoint answers "who is this customer and what are they paying for" to
 * anyone who can reach it. An unsigned connector is an account-enumeration
 * API.
 */
export function createConnectorHandler(opts) {
    const secrets = (Array.isArray(opts.secret) ? opts.secret : [opts.secret]).filter(Boolean);
    const tolerance = opts.toleranceMs ?? 5 * 60_000;
    const tsHeader = opts.headers?.timestamp ?? 'x-teamself-timestamp';
    const sigHeader = opts.headers?.signature ?? 'x-teamself-signature';
    return async function handler(req) {
        // No secret configured is not "allow everything" — it is a
        // misconfiguration of an endpoint that reads customer records, so it fails
        // closed. Without this the empty string becomes a valid HMAC key and
        // anyone who knows the scheme can sign their own requests.
        if (!secrets.length)
            return json({ error: 'connector is not configured' }, 503);
        const body = req.method === 'GET' ? '' : await req.text();
        const timestamp = req.headers.get(tsHeader) ?? '';
        const signature = req.headers.get(sigHeader) ?? '';
        if (!verify(secrets, timestamp, body, signature, tolerance)) {
            return json({ error: 'bad signature' }, 401);
        }
        const path = new URL(req.url).pathname.replace(/.*?(\/facts|\/identity\/resolve|\/tools\/[^/]+)$/, '$1');
        if (path === '/facts')
            return json(await opts.facts());
        if (path === '/identity/resolve') {
            if (!opts.resolveIdentity)
                return json(null);
            const query = body ? JSON.parse(body) : {};
            return json((await opts.resolveIdentity(query)) ?? null);
        }
        const tool = path.startsWith('/tools/') ? path.slice('/tools/'.length) : null;
        if (tool) {
            const fn = opts.tools?.[tool];
            if (!fn)
                return json({ error: `tool "${tool}" not implemented` }, 404);
            const { userId } = body ? JSON.parse(body) : {};
            if (!userId)
                return json({ error: 'userId required' }, 400);
            return json(await fn(userId));
        }
        return json({ error: 'unknown connector path' }, 404);
    };
}
export {};
//# sourceMappingURL=index.js.map