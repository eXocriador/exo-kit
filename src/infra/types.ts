/**
 * What a module reports when infrastructure it was *configured* to reach
 * misbehaves.
 *
 * There is exactly one hook, and it takes the place of two things products
 * were doing side by side: a structured warn line and a call into an error
 * reporter (Sentry, or a product's own wrapper around one). The kit cannot
 * pick between them — one product imports the SDK directly, another routes
 * through its own telemetry module, and a third has neither — so it picks
 * neither and hands the decision back with enough context to make it.
 *
 * Note what is NOT reported here: "not configured". A null URL is a supported
 * state, not a fault, and a module in that state stays silent.
 */
/** The kit's own modules — what an editor suggests for {@link ErrorContext.component}. */
export type KitComponent = 'db' | 'redis' | 'llm' | 'ai' | 'mailer' | 'notify' | 'health';

export interface ErrorContext {
  /**
   * Which module produced this: one of the kit's, or a product's own.
   *
   * Open since v0.9.0. The closed union meant a product factory (teamself's
   * `createLinear`) could not take the same `reportError` every kit factory
   * takes — `'linear'` was not a kit module, so `tsc` refused it and the
   * product wrote a wrapper whose only job was the cast. `(string & {})` keeps
   * the kit's names as suggestions without refusing anyone else's. The price:
   * a `switch` over this field is no longer checked for exhaustiveness.
   */
  component: KitComponent | (string & {});
  /** Stable dotted event name, e.g. `db.query_error`. Safe to use as a metric key. */
  event: string;
  /** Extra structured fields. Never contains a credential or a query parameter. */
  fields?: Record<string, unknown>;
}

export type ReportError = (err: unknown, ctx: ErrorContext) => void;
