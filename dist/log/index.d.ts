import type { Logger } from 'pino';
/**
 * `@exo/kit/log` — structured logging plus an audit trail, from one factory.
 *
 * Always emits structured JSON to stdout (a container runtime captures it). If
 * an OpenObserve endpoint is configured, the same records are ALSO shipped
 * there in the background — best-effort, non-blocking, and a no-op when unset,
 * matching the optional-infra pattern in `@exo/kit/infra`. No external SaaS,
 * no heavy SDK.
 *
 * Node runtime only (pino). Never import this from an edge runtime.
 */
export interface OpenObserveConfig {
    /** Base URL. When empty or absent, shipping is off and every `ship` is a no-op. */
    url?: string | null;
    org?: string;
    /** Stream name. A product that leaves this at a neighbour's value files its logs under that neighbour's name. */
    stream: string;
    /** Pre-encoded basic-auth payload, or an email/password pair to encode. */
    token?: string | null;
    email?: string | null;
    password?: string | null;
    /** Flush interval in ms. Default 2000. */
    flushMs?: number;
    /** Flush early once this many records are buffered. Default 100. */
    maxBatch?: number;
}
export interface LoggerConfig {
    /**
     * Goes into every record as `service`. Required, and deliberately has no
     * default: the name is how one product's logs are told from another's, and a
     * default here is a value that gets copied between products and then read as
     * fact. The kit does not know product names — this is the argument where the
     * product says its own.
     */
    service: string;
    /** pino level. Default: `info` in production, `debug` otherwise. */
    level?: string;
    /** Ship a copy of info/warn/error/audit records to OpenObserve. Omit to disable. */
    openobserve?: OpenObserveConfig | null;
    /** Injected for tests. Defaults to global `fetch`. */
    fetchImpl?: typeof fetch;
}
export type LogFields = Record<string, unknown>;
/**
 * A privileged-call / AI-action / admin-read audit record — the
 * abuse-detection trail.
 *
 * `admin_read` covers an operator reading data that belongs to another
 * account. `userId` is who read; `targetUserId` is whose data was read — the
 * pair is what makes an operator able to answer "who looked at whose records".
 *
 * `admin_write` is the same pair for a privilege CHANGE rather than a read,
 * plus `fields` (names only) and an `outcome` of `applied` or `blocked`: a
 * refused escalation is exactly as worth recording as a successful one. Routes
 * behind an admin gate must log this themselves — an automatic
 * `privileged_call` record does not fire for them, because a role check is not
 * a capability check.
 *
 * The type is open on purpose (`[key: string]: unknown`). Products disagree on
 * what else belongs in the record — one carries a capability name, another a
 * conversation id — and making the kit's shape closed would mean either
 * enumerating every product's vocabulary here (the kit knowing product names)
 * or every product keeping its own copy of this function. Extra fields ship as
 * given.
 */
export interface AuditRecord {
    event: 'privileged_call' | 'support_ai_action' | 'admin_read' | 'admin_write' | (string & {});
    path: string;
    method: string;
    userId: string | null;
    ip: string;
    email?: string | null;
    requestId?: string;
    internal?: boolean;
    tool?: string;
    outcome?: string;
    identityProven?: boolean;
    /** Whose data an `admin_read`/`admin_write` touched. */
    targetUserId?: string | null;
    /**
     * Which fields an `admin_write` changed — NAMES only, never values. The
     * trail answers "who granted whom what", which needs no plaintext of the
     * grant; recording values would put account states, plans and secrets into
     * the log stream for no added answer.
     */
    fields?: string[];
    [key: string]: unknown;
}
export interface KitLogger {
    /** The underlying pino instance, for the rare caller that needs a child logger. */
    readonly logger: Logger;
    /** Verbose per-call detail. Not shipped — dev-only noise. */
    logDebug(event: string, fields?: LogFields): void;
    logInfo(event: string, fields?: LogFields): void;
    logWarn(event: string, fields?: LogFields): void;
    logError(event: string, err: unknown, fields?: LogFields): void;
    logAudit(record: AuditRecord): void;
    /** Force a flush of the ship buffer. Await it before a process exits. */
    flush(): Promise<void>;
}
export declare function createLogger(config: LoggerConfig): KitLogger;
//# sourceMappingURL=index.d.ts.map