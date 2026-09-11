export interface ConnectorHandlerOptions {
    /**
     * Shared with the support installation. Pass an array to accept two during a
     * rotation window.
     */
    secret: string | string[];
    facts: () => Promise<unknown> | unknown;
    resolveIdentity?: (query: unknown) => Promise<unknown> | unknown;
    /** Named lookups, keyed by the tool names the engine knows. */
    tools?: Record<string, (userId: string) => Promise<unknown> | unknown>;
    /** Reject requests whose timestamp is older than this. Default 5 minutes. */
    toleranceMs?: number;
    /** Header names, in case the installation brands them differently. */
    headers?: {
        timestamp?: string;
        signature?: string;
    };
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
export declare function createConnectorHandler(opts: ConnectorHandlerOptions): (req: Request) => Promise<Response>;
export { type ConnectorHandlerOptions as ConnectorOptions };
//# sourceMappingURL=index.d.ts.map