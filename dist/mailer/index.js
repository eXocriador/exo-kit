/**
 * What `send` throws. `status` is the provider's HTTP status when the request
 * was answered and `null` when it never was (not configured, or transport).
 * The response body is deliberately not carried: it can echo the address.
 */
export class MailSendError extends Error {
    status;
    reason;
    constructor(reason, status, options) {
        super(reason === 'not_configured'
            ? 'mailer is not configured'
            : reason === 'refused'
                ? `mail provider responded ${status}`
                : 'mail provider unreachable', options);
        this.name = 'MailSendError';
        this.reason = reason;
        this.status = status;
    }
}
const ENDPOINT = 'https://api.resend.com/emails';
/**
 * The bare address out of a `From` mailbox. `'"Support" <no-reply@x.example>'`
 * → `no-reply@x.example`; a bare configuration falls through to the trimmed,
 * lower-cased value.
 */
export function senderAddress(from) {
    const raw = from ?? '';
    const angled = raw.match(/<([^>]+)>/);
    return (angled ? angled[1] : raw).trim().toLowerCase();
}
/**
 * True when `email` is exactly the address `from` sends as — case- and
 * whitespace-insensitive, never a domain or substring match. `false` when
 * either side is missing: an unconfigured mailer sends nothing and therefore
 * receives nothing from itself, and the dangerous failure of this predicate is
 * the one that drops a real customer.
 */
export function isOwnSender(from, email) {
    const own = senderAddress(from);
    if (!own || !email)
        return false;
    return email.trim().toLowerCase() === own;
}
export function createMailer(config) {
    const apiKey = config.apiKey ?? '';
    const from = config.from ?? '';
    const timeoutMs = config.timeoutMs ?? 10_000;
    const fetchImpl = config.fetchImpl ?? fetch;
    const enabled = Boolean(apiKey && from);
    // The one request. Answers the provider's status, or throws whatever the
    // transport threw; the two public methods differ only in what they do with
    // that.
    async function post(msg) {
        const res = await fetchImpl(ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
            body: JSON.stringify({
                from,
                to: [msg.to],
                subject: msg.subject,
                text: msg.text,
                ...(msg.html ? { html: msg.html } : {}),
            }),
            signal: AbortSignal.timeout(timeoutMs),
        });
        return res.status;
    }
    async function send(msg) {
        if (!enabled)
            throw new MailSendError('not_configured', null);
        let status;
        try {
            status = await post(msg);
        }
        catch (err) {
            throw new MailSendError('transport', null, { cause: err });
        }
        if (status < 200 || status >= 300)
            throw new MailSendError('refused', status);
    }
    async function sendEmail(msg) {
        if (!enabled)
            return false;
        try {
            await send(msg);
            return true;
        }
        catch (err) {
            const status = err instanceof MailSendError ? err.status : null;
            // `subject` is safe to log and is what makes the line actionable; the
            // recipient is a person's address and stays out.
            config.reportError?.(err, {
                component: 'mailer',
                event: 'mailer.send_failed',
                fields: { subject: msg.subject, ...(status === null ? {} : { status }) },
            });
            return false;
        }
    }
    return {
        mailerEnabled: () => enabled,
        sendEmail,
        send,
        senderAddress: () => senderAddress(from),
        isOwnSender: (email) => isOwnSender(from, email),
    };
}
//# sourceMappingURL=index.js.map