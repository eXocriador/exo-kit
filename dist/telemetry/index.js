export function createTelemetry(config) {
    let reporter = config.reporter ?? null;
    const report = (error, context) => {
        try {
            reporter?.(error, context);
        }
        catch {
            // A reporter that throws must not take the caller down with it — the
            // caller is usually a request that was already handling a failure.
        }
    };
    const captureException = (error, context) => {
        report(error, context);
        if (!config.logError)
            return;
        const { event, ...fields } = context ?? {};
        config.logError(typeof event === 'string' ? event : 'exception', error, fields);
    };
    return {
        captureException,
        captureMessage: (event, context) => {
            report(new Error(event), context);
            config.logWarn?.(event, context ?? {});
        },
        setReporter: (fn) => {
            reporter = fn;
        },
        reportError: (err, ctx) => {
            // Flattened: a reporter's context is a bag of extras, and `fields`
            // nested one level deeper is one click further away in every UI.
            captureException(err, { component: ctx.component, event: ctx.event, ...ctx.fields });
        },
    };
}
//# sourceMappingURL=index.js.map