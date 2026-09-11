export function createTelegramDm(config) {
    const botToken = config.botToken ?? '';
    const chatId = config.chatId === null || config.chatId === undefined ? '' : String(config.chatId);
    const timeoutMs = config.timeoutMs ?? 10_000;
    const fetchImpl = config.fetchImpl ?? fetch;
    const enabled = Boolean(botToken && chatId);
    return {
        enabled: () => enabled,
        async send(text) {
            if (!enabled)
                return false;
            try {
                const res = await fetchImpl(`https://api.telegram.org/bot${botToken}/sendMessage`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    // Previews off: an escalation carries a link into the support tool,
                    // and a preview of that page in a chat is a leak with no reader.
                    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
                    signal: AbortSignal.timeout(timeoutMs),
                });
                if (!res.ok) {
                    config.reportError?.(new Error(`telegram responded ${res.status}`), {
                        component: 'notify',
                        event: 'notify.telegram_failed',
                        fields: { status: res.status },
                    });
                    return false;
                }
                return true;
            }
            catch (err) {
                config.reportError?.(err, { component: 'notify', event: 'notify.telegram_failed' });
                return false;
            }
        },
    };
}
export function createEscalationNotifier(config) {
    return {
        async notifyEscalation(notice) {
            const prefix = notice.shadow ? '[shadow] ' : '';
            const headline = `${prefix}Support escalation — ${notice.category}`;
            const lines = [
                headline,
                notice.reason ? `Reason: ${notice.reason}` : null,
                notice.conversationUrl ?? `Conversation #${notice.conversationId}`,
            ].filter((l) => Boolean(l));
            const text = lines.join('\n');
            if (config.telegram && (await config.telegram.send(text)))
                return;
            if (!config.sendEmail)
                return;
            try {
                await config.sendEmail({ to: notice.to, subject: headline, text });
            }
            catch (err) {
                config.reportError?.(err, {
                    component: 'notify',
                    event: 'notify.email_failed',
                    fields: { category: notice.category },
                });
            }
        },
    };
}
//# sourceMappingURL=index.js.map