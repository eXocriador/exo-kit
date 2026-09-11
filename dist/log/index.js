import pino from 'pino';
function basicAuth(oo) {
    if (oo.token)
        return `Basic ${oo.token}`;
    if (oo.email && oo.password) {
        return `Basic ${Buffer.from(`${oo.email}:${oo.password}`).toString('base64')}`;
    }
    return null;
}
export function createLogger(config) {
    const isProd = process.env['NODE_ENV'] === 'production';
    const logger = pino({
        level: config.level || (isProd ? 'info' : 'debug'),
        base: { service: config.service },
        timestamp: pino.stdTimeFunctions.isoTime,
    });
    const oo = config.openobserve ?? null;
    const auth = oo ? basicAuth(oo) : null;
    const enabled = Boolean(oo?.url) && auth !== null;
    const doFetch = config.fetchImpl ?? globalThis.fetch;
    const flushMs = oo?.flushMs ?? 2000;
    const maxBatch = oo?.maxBatch ?? 100;
    // Tiny batching buffer so we don't open a connection per log line.
    let buffer = [];
    let timer = null;
    async function flush() {
        if (!enabled || buffer.length === 0)
            return;
        const batch = buffer;
        buffer = [];
        try {
            await doFetch(`${oo.url}/api/${oo.org ?? 'default'}/${oo.stream}/_json`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: auth },
                body: JSON.stringify(batch),
                signal: AbortSignal.timeout(5000),
            });
        }
        catch {
            // Best-effort: a logging-sink failure must never affect the request path.
        }
    }
    function ship(record) {
        if (!enabled)
            return;
        buffer.push({ _timestamp: Date.now(), ...record });
        if (buffer.length >= maxBatch) {
            void flush();
            return;
        }
        if (!timer) {
            timer = setTimeout(() => {
                timer = null;
                void flush();
            }, flushMs);
            // Don't keep the event loop alive solely for a flush.
            if (typeof timer.unref === 'function')
                timer.unref();
        }
    }
    return {
        logger,
        flush,
        logDebug(event, fields = {}) {
            logger.debug({ event, ...fields });
        },
        logInfo(event, fields = {}) {
            logger.info({ event, ...fields });
            ship({ level: 'info', event, ...fields });
        },
        logWarn(event, fields = {}) {
            logger.warn({ event, ...fields });
            ship({ level: 'warn', event, ...fields });
        },
        logError(event, err, fields = {}) {
            const message = err instanceof Error ? err.message : String(err);
            const stack = err instanceof Error ? err.stack : undefined;
            logger.error({ event, err: message, stack, ...fields });
            ship({ level: 'error', event, err: message, ...fields });
        },
        logAudit(record) {
            logger.info(record);
            ship({ level: 'audit', ...record });
        },
    };
}
//# sourceMappingURL=index.js.map