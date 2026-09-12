import { describe, it, expect, vi } from 'vitest';
import { createTelemetry } from '../src/telemetry/index.js';

/**
 * The seam teamself extracted when its support engine stopped being a Next.js
 * app: the engine reported through `@sentry/nextjs`, and a standalone product
 * must not drag a framework SDK behind it. An installation may run Sentry, may
 * run something else, may run nothing — and "nothing" has to be the default
 * that works, because that is the state every product is in before its DSN is
 * set.
 */
describe('createTelemetry', () => {
  it('captures nothing and throws nothing when no reporter is wired', () => {
    const telemetry = createTelemetry({});
    expect(() => telemetry.captureException(new Error('boom'))).not.toThrow();
    expect(() => telemetry.captureMessage('fallback_fired')).not.toThrow();
  });

  it('calls the reporter exactly once, with the context', () => {
    const reporter = vi.fn();
    const telemetry = createTelemetry({ reporter });
    const err = new Error('boom');

    telemetry.captureException(err, { userId: '7' });

    expect(reporter).toHaveBeenCalledTimes(1);
    expect(reporter).toHaveBeenCalledWith(err, { userId: '7' });
  });

  it('setReporter works after boot — the reporter is wired later than the modules that use it', () => {
    // The order at boot is: build the telemetry, hand `reportError` to the kit
    // factories, and only then load the SDK (it needs the env the same file is
    // parsing). A seam that could only be filled before first use would be no
    // seam at all.
    const telemetry = createTelemetry({});
    const reporter = vi.fn();

    telemetry.captureException(new Error('early'));
    telemetry.setReporter(reporter);
    telemetry.captureException(new Error('late'));

    expect(reporter).toHaveBeenCalledTimes(1);
    expect((reporter.mock.calls[0]![0] as Error).message).toBe('late');

    telemetry.setReporter(null);
    telemetry.captureException(new Error('after'));
    expect(reporter).toHaveBeenCalledTimes(1);
  });

  it('a reporter that throws never takes the caller down with it', () => {
    const logError = vi.fn();
    const telemetry = createTelemetry({
      reporter: () => {
        throw new Error('sentry is down');
      },
      logError,
    });

    expect(() => telemetry.captureException(new Error('boom'))).not.toThrow();
    // And the line still reaches the log, which is the whole point of logging
    // it as well as reporting it.
    expect(logError).toHaveBeenCalledTimes(1);
  });

  it('logs as well as reports — the log is the copy that survives a missing DSN', () => {
    const logError = vi.fn();
    const logWarn = vi.fn();
    const telemetry = createTelemetry({ logError, logWarn });

    const err = new Error('boom');
    telemetry.captureException(err, { conversationId: 12 });
    telemetry.captureMessage('ladder_fell_back', { step: 2 });

    expect(logError).toHaveBeenCalledWith('exception', err, { conversationId: 12 });
    expect(logWarn).toHaveBeenCalledWith('ladder_fell_back', { step: 2 });
  });

  it('an event in the context names the log line', () => {
    const logError = vi.fn();
    const telemetry = createTelemetry({ logError });
    const err = new Error('boom');

    telemetry.captureException(err, { event: 'support_error', tool: 'reply' });

    expect(logError).toHaveBeenCalledWith('support_error', err, { tool: 'reply' });
  });

  it('captureMessage reports a named event as an error object', () => {
    // Sentry groups by exception, so a fail-safe firing that is worth an alert
    // has to arrive as one. It is still not an exception to the log.
    const reporter = vi.fn();
    const telemetry = createTelemetry({ reporter });

    telemetry.captureMessage('failsafe_fired', { rule: 'refund' });

    expect(reporter).toHaveBeenCalledTimes(1);
    const [err, ctx] = reporter.mock.calls[0]!;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('failsafe_fired');
    expect(ctx).toEqual({ rule: 'refund' });
  });

  it('hands out a ReportError the kit factories take as-is', () => {
    // This is the seam's whole job: `createDb`, `createRedis`, `createMailer`
    // and `createLogger` each take a `reportError`, and without this every
    // product writes the same four-line mapper next to each of them.
    const reporter = vi.fn();
    const logError = vi.fn();
    const telemetry = createTelemetry({ reporter, logError });
    const err = new Error('connection refused');

    telemetry.reportError(err, { component: 'db', event: 'db.query_error', fields: { table: 'users' } });

    expect(reporter).toHaveBeenCalledWith(err, { component: 'db', event: 'db.query_error', table: 'users' });
    expect(logError).toHaveBeenCalledWith('db.query_error', err, { component: 'db', table: 'users' });
  });
});
