/**
 * `@exo/kit/mailer` — transactional email over the Resend HTTPS API.
 *
 * ── What importing this pulls in ──
 * Nothing. One `fetch` to one endpoint; the entry-graph test holds the row
 * empty. HTTPS rather than SMTP is not a preference: 443 egress is the one
 * path a container on a small VPS reliably has, and SMTP would mean a mail
 * server, queues, IP reputation and DKIM by hand.
 *
 * ── Not configured is a state ──
 * No key or no sender address means `mailerEnabled()` is false and the
 * best-effort `sendEmail` answers `false` without a network call. A product
 * gates its flows on that — "reset your password by email" is simply not
 * offered — and reports nothing, because an unconfigured mailer is a
 * configuration, not a fault.
 *
 * ── Two ways to send, because two products disagree on what a failure is ──
 * `sendEmail` is best-effort: any failure is `false`, reported once through
 * `reportError`, and never thrown — a request must not fail over a mail
 * hiccup. `send` is strict: it throws a `MailSendError` carrying the
 * provider's status, for the caller who logs it itself and answers the user
 * the same way regardless. Both share one request; neither logs a recipient.
 *
 * ── The sender address is also a guard ──
 * `senderAddress` / `isOwnSender` exist because a support inbox that is also
 * the escalation target receives its own escalation notice as a new customer
 * conversation, and an AI answers it. The invariant is "this arrived from our
 * own outbound address" — one address, exactly — and it lives here because the
 * address in question is the mailer's `from`.
 *
 * The one configuration note that is really about Resend: quote the display
 * name. RFC 5322 atext excludes most punctuation, so a brand with a bracket,
 * comma or dot in it is rejected by the API rather than by anything here:
 *   from: '"Support" <no-reply@example.com>'
 * The sender domain must be verified in Resend.
 */
import type { ReportError } from '../infra/types.js';
export interface MailerConfig {
    /** Resend API key. `null` / `undefined` / `''` means "not configured". */
    apiKey: string | null | undefined;
    /**
     * The `From` mailbox, as Resend expects it — typically
     * `'"Display Name" <address@verified.domain>'`. A bare address is valid too.
     * Empty means "not configured".
     */
    from: string | null | undefined;
    /**
     * Where a failed best-effort send is reported. Fires with
     * `event: 'mailer.send_failed'` and the provider status in `fields`; the
     * recipient is never included. Silent when omitted.
     */
    reportError?: ReportError;
    /** Per-request ceiling. Default 10 s: a hung provider must not hold a request open. */
    timeoutMs?: number;
    /** Injected for tests. Default: the global `fetch`. */
    fetchImpl?: typeof fetch;
}
export interface EmailMessage {
    to: string;
    subject: string;
    text: string;
    html?: string;
}
export type MailSendReason = 'not_configured' | 'refused' | 'transport';
/**
 * What `send` throws. `status` is the provider's HTTP status when the request
 * was answered and `null` when it never was (not configured, or transport).
 * The response body is deliberately not carried: it can echo the address.
 */
export declare class MailSendError extends Error {
    readonly status: number | null;
    readonly reason: MailSendReason;
    constructor(reason: MailSendReason, status: number | null, options?: {
        cause?: unknown;
    });
}
export interface Mailer {
    /** True when both a key and a sender are configured; callers gate flows on this. */
    mailerEnabled(): boolean;
    /**
     * Best-effort. `false` when not configured, refused, or unreachable — reported
     * once (unless not configured), never thrown.
     */
    sendEmail(msg: EmailMessage): Promise<boolean>;
    /** Strict. Resolves on success, throws {@link MailSendError} otherwise. Reports nothing: the caller has the error. */
    send(msg: EmailMessage): Promise<void>;
    /** The bare, lower-cased address inside the configured `from`. `''` when not configured. */
    senderAddress(): string;
    /** `isOwnSender(from, email)` bound to this instance's `from`. */
    isOwnSender(email: string | null | undefined): boolean;
}
/**
 * The bare address out of a `From` mailbox. `'"Support" <no-reply@x.example>'`
 * → `no-reply@x.example`; a bare configuration falls through to the trimmed,
 * lower-cased value.
 */
export declare function senderAddress(from: string | null | undefined): string;
/**
 * True when `email` is exactly the address `from` sends as — case- and
 * whitespace-insensitive, never a domain or substring match. `false` when
 * either side is missing: an unconfigured mailer sends nothing and therefore
 * receives nothing from itself, and the dangerous failure of this predicate is
 * the one that drops a real customer.
 */
export declare function isOwnSender(from: string | null | undefined, email: string | null | undefined): boolean;
export declare function createMailer(config: MailerConfig): Mailer;
//# sourceMappingURL=index.d.ts.map