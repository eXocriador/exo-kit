/**
 * The caller's IP, for rate-limiting and identity.
 *
 * ── Why this is a factory over one number ──
 * `x-forwarded-for` is client-settable, so its left-most token is whatever the
 * caller felt like typing — trusting it hands every client an unlimited supply
 * of fresh rate-limit buckets. Counting from the right instead, the last
 * `trustedProxyHops` entries were appended by infrastructure the deployment
 * controls; the first of those is the peer address the nearest trusted proxy
 * actually observed, and it is the only entry a client cannot forge.
 *
 * How many hops that is, is a fact about a deployment and nothing else: one
 * reverse proxy on a VPS is one, a CDN in front of it is two. The copies this
 * came from read `TRUSTED_PROXY_HOPS` from the environment at module load, which
 * is the same decision spelled as a variable name the kit is not entitled to
 * know. So it arrives as an argument, and the product's wiring file is where the
 * variable is read.
 */
export interface ClientIpConfig {
    /**
     * Trusted reverse-proxy hops in front of the app. `0` means the app is the
     * peer and no forwarded header is trustworthy at all. Default 1 — one proxy,
     * the common single-host deployment.
     */
    trustedProxyHops?: number;
    /** Returned when no usable header is present. Default `unknown`. */
    fallback?: string;
}
export interface ClientIp {
    getClientIp(req: Request): string;
}
export declare function createClientIp(config?: ClientIpConfig): ClientIp;
//# sourceMappingURL=client-ip.d.ts.map