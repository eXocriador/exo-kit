/**
 * `@exo/kit/telemetry` — one seam for "something went wrong", so that the
 * modules which report do not have to know who listens.
 *
 * ── What importing this pulls in ──
 * Nothing. That is the point: a product may run Sentry, may run something
 * else, may run nothing, and a module that hard-imported an SDK would decide
 * that for it. teamself learned this when its support engine was lifted out of
 * a Next.js app still calling `@sentry/nextjs` — a standalone package cannot
 * drag a framework's SDK behind it.
 *
 * ── Nothing wired is the normal state ──
 * Before the DSN is set — and in every test — `captureException` reports to
 * no one, logs if a logger was given, and returns. A reporter that throws is
 * swallowed for the same reason: the telemetry must never be what takes the
 * request down.
 *
 * ── Why `reportError` is on the returned object ──
 * `createDb`, `createRedis`, `createMailer` and `createLogger` each take a
 * `reportError(err, ctx)`. Without this the product writes the same mapper
 * next to each of them; with it the wiring is `reportError: telemetry.reportError`
 * and the seam is filled in one place.
 *
 * ```ts
 * // src/lib/telemetry.ts
 * import { createTelemetry } from '@exo/kit/telemetry';
 * import { logError, logWarn } from '@/lib/log';
 *
 * export const telemetry = createTelemetry({ logError, logWarn });
 * // …later, once the SDK is loaded and configured:
 * telemetry.setReporter((err, ctx) => Sentry.captureException(err, { extra: ctx }));
 * ```
 */
import type { ErrorContext, ReportError } from '../infra/types.js';

export type TelemetryContext = Record<string, unknown>;

/** Sentry's `captureException` fits this, and so does a two-line console shim. */
export type ErrorReporter = (error: unknown, context?: TelemetryContext) => void;

export interface TelemetryConfig {
  /** Wired at boot, or later with {@link Telemetry.setReporter}. Omit for "no one listens". */
  reporter?: ErrorReporter | null;
  /**
   * The log copy of a captured exception. The event name comes from the call
   * site (`context.event`) or is `'exception'` — the kit does not name a
   * product's events. Silent when omitted.
   */
  logError?: (event: string, error: unknown, fields: TelemetryContext) => void;
  /** The log copy of a captured message. Silent when omitted. */
  logWarn?: (event: string, fields: TelemetryContext) => void;
}

export interface Telemetry {
  /**
   * Report and log an exception. `context.event`, when present, names the log
   * line and is not repeated in its fields.
   */
  captureException(error: unknown, context?: TelemetryContext): void;
  /**
   * A named event worth reporting that is not an exception — a fail-safe
   * firing, a ladder falling back. It reaches the reporter as an `Error`
   * because that is what groups in Sentry, and the log as a warning.
   */
  captureMessage(event: string, context?: TelemetryContext): void;
  /** Wire, rewire or unwire the reporter at any point in the process's life. */
  setReporter(fn: ErrorReporter | null): void;
  /** Ready to hand to any kit factory's `reportError`. */
  reportError: ReportError;
}

export function createTelemetry(config: TelemetryConfig): Telemetry {
  let reporter: ErrorReporter | null = config.reporter ?? null;

  const report = (error: unknown, context: TelemetryContext | undefined): void => {
    try {
      reporter?.(error, context);
    } catch {
      // A reporter that throws must not take the caller down with it — the
      // caller is usually a request that was already handling a failure.
    }
  };

  const captureException: Telemetry['captureException'] = (error, context) => {
    report(error, context);
    if (!config.logError) return;
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
    reportError: (err: unknown, ctx: ErrorContext) => {
      // Flattened: a reporter's context is a bag of extras, and `fields`
      // nested one level deeper is one click further away in every UI.
      captureException(err, { component: ctx.component, event: ctx.event, ...ctx.fields });
    },
  };
}
