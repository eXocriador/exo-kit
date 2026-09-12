class CheckTimeout extends Error {
    constructor(name, ms) {
        super(`health check '${name}' did not answer in ${ms}ms`);
        this.name = 'CheckTimeout';
    }
}
// A fresh Response every time: a body is single-use, and a cached one would
// throw "Body is unusable" on the second container healthcheck.
function json(body, status) {
    return Response.json(body, {
        status,
        // Not that anything caches a 503, but a 200 sitting in a proxy is a
        // readiness answer from the past, which is the one thing this must not be.
        headers: { 'cache-control': 'no-store' },
    });
}
export function createHealth(config) {
    const { version, checks, required, timeoutMs = 3000, reportError } = config;
    for (const name of required) {
        if (!Object.hasOwn(checks, name)) {
            throw new Error(`health: required check '${name}' is not one of the checks (${Object.keys(checks).join(', ') || 'none'})`);
        }
    }
    const isRequired = new Set(required);
    async function run(name, check) {
        let timer;
        try {
            const result = await Promise.race([
                Promise.resolve(check()),
                new Promise((_, reject) => {
                    timer = setTimeout(() => reject(new CheckTimeout(name, timeoutMs)), timeoutMs);
                }),
            ]);
            return result === true ? 'ok' : result === false ? 'fail' : result;
        }
        catch (err) {
            reportError?.(err, {
                component: 'health',
                event: err instanceof CheckTimeout ? 'health.check_timeout' : 'health.check_failed',
                fields: err instanceof CheckTimeout ? { check: name, timeoutMs } : { check: name },
            });
            return 'fail';
        }
        finally {
            // Without this the timer holds the event loop open for `timeoutMs` after
            // every probe — once per monitor interval, forever.
            clearTimeout(timer);
        }
    }
    return {
        live: () => json({ status: 'ok', version, checks: {} }, 200),
        ready: async () => {
            const names = Object.keys(checks);
            // Concurrently: serial probes add up past the monitor's timeout as soon
            // as a product has four of them.
            const states = await Promise.all(names.map((name) => run(name, checks[name])));
            const result = {};
            let ok = true;
            names.forEach((name, i) => {
                const state = states[i];
                result[name] = state;
                if (state === 'fail' && isRequired.has(name))
                    ok = false;
            });
            return json({ status: ok ? 'ok' : 'fail', version, checks: result }, ok ? 200 : 503);
        },
    };
}
//# sourceMappingURL=index.js.map