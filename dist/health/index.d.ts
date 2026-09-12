/**
 * `@exo/kit/health` — the two probes every product on the box writes by hand.
 *
 * ── What importing this pulls in ──
 * Nothing. `Response` is Web-standard and present in Node 18+, which is why
 * the same factory serves a Next route handler (`export const GET = () =>
 * health.live()`) and a Fastify route (`reply.code(res.status).send(await
 * res.json())`) without the kit knowing either framework.
 *
 * ── Why this is a module and not a snippet ──
 * It was written eight times, and the copies did not merely drift, they
 * disagreed about what the probe is for. exo-vpn served `index.html` for
 * `/health/ready` because the SPA fallback sat in front of a route that did
 * not exist: both probes "worked" without being in the code at all, and the
 * monitor stayed green on a node whose WireGuard interface and Xray API were
 * both down. netwatch had to race a timer against `redis.ping()` by hand,
 * because a reconnecting client waits longer than the monitor's interval.
 * Those are the two failures this factory is shaped around.
 *
 * ── live and ready are not two names for one thing ──
 * `live` answers while the process answers, and touches nothing: a compose
 * healthcheck hits it, and restarting a healthy process would not fix the
 * database it depends on. `ready` answers whether the product can do what it
 * exists for, and a monitor watches that one — so it has to be able to go red.
 *
 * ── Required and optional ──
 * A failing check listed in `required` makes `ready` answer 503. Anything else
 * only informs: Qdrant in exointel and qBittorrent in syncwatch are features,
 * not the product, and a probe that went red for them would be training its
 * reader to ignore it. `skip` is the third state — "not applicable here", like
 * a missing `wg` binary outside production — and it never fails the probe.
 */
import type { ReportError } from '../infra/types.js';
/** `'skip'` is neither: the check does not apply to this installation. */
export type CheckState = 'ok' | 'fail' | 'skip';
/**
 * One probe. Booleans are accepted because that is the shape the existing
 * probes already have (`() => store.ping()`); a throw is a `fail`, which is
 * the other shape (`await db\`select 1\``).
 */
export type HealthCheck = () => Promise<CheckState | boolean> | CheckState | boolean;
export interface HealthConfig {
    /**
     * Goes into both bodies. The short commit the image was built from, as the
     * product's `APP_VERSION` — it is what makes a probe answer the question
     * "is the thing running the thing I deployed".
     */
    version: string;
    /** Name → probe. The names are what a person reads at 3am; `db`, `redis`, `media`. */
    checks: Record<string, HealthCheck>;
    /**
     * Which checks make `ready` answer 503 when they fail. Explicit and without
     * a default on purpose: "all of them" and "none of them" are both wrong for
     * some product, and the silent version of this decision is the green monitor
     * that proves nothing. A name that is not a check is a typo, and throws.
     */
    required: string[];
    /**
     * Per-check ceiling. Default 3 s — a probe that takes longer than the
     * monitor's own timeout is indistinguishable from a hung one, and a hung
     * client (ioredis mid-reconnect) is exactly the case this is here for.
     */
    timeoutMs?: number;
    /** Where a failing or timing-out check is reported. Silent when omitted. */
    reportError?: ReportError;
}
export interface HealthBody {
    status: 'ok' | 'fail';
    version: string;
    checks: Record<string, CheckState>;
}
export interface Health {
    /** 200, always, without calling a check. */
    live(): Response;
    /** 200, or 503 when a required check failed. */
    ready(): Promise<Response>;
}
export declare function createHealth(config: HealthConfig): Health;
//# sourceMappingURL=index.d.ts.map