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
export interface ErrorContext {
  /** Which kit module produced this. */
  component: 'db' | 'redis' | 'llm' | 'mailer' | 'notify' | 'health';
  /** Stable dotted event name, e.g. `db.query_error`. Safe to use as a metric key. */
  event: string;
  /** Extra structured fields. Never contains a credential or a query parameter. */
  fields?: Record<string, unknown>;
}

export type ReportError = (err: unknown, ctx: ErrorContext) => void;
