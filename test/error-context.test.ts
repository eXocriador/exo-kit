import { describe, it, expect } from 'vitest';
import type { ErrorContext, KitComponent, ReportError } from '../src/infra/types.js';

/**
 * B1-teamself (§10): `createLinear` could not take `telemetry.reportError`,
 * because `component` was a closed union of the kit's module names and
 * `'linear'` is not one. The product wrapped the reporter to cast. The half of
 * this that matters is a type, so `npm run typecheck` — which covers `test/` —
 * is what actually runs it; the assertions below only keep vitest honest about
 * the file existing.
 */
describe('ErrorContext.component', () => {
  it("takes a product's own component name, so one reporter serves the kit and the product", () => {
    const seen: string[] = [];
    const report: ReportError = (_err, ctx) => {
      seen.push(ctx.component);
    };

    // A product factory handed the very same reporter a kit factory gets.
    const createLinear = (options: { reportError: ReportError }) => ({
      fail: () => options.reportError(new Error('502'), { component: 'linear', event: 'linear.request_failed' }),
    });
    createLinear({ reportError: report }).fail();
    report(new Error('gone'), { component: 'db', event: 'db.query_error' });

    expect(seen).toEqual(['linear', 'db']);
  });

  it("keeps the kit's own names as a type, and a component is still a string", () => {
    const kit: KitComponent = 'health';
    const widened: ErrorContext['component'] = kit;
    // @ts-expect-error a component is a name, not a number
    const wrong: ErrorContext = { component: 42, event: 'x' };
    expect([widened, wrong.event]).toEqual(['health', 'x']);
  });
});
