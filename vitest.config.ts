import { defineConfig } from 'vitest/config';

/**
 * Node only. Nothing in the kit renders, and a module that reaches for
 * `window` would be a bug — the missing global is what says so.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
