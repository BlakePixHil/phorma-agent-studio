import { defineConfig } from 'vitest/config';

/**
 * Engine test harness.
 *
 * The engine package stays dependency-free at runtime (Requirement 18.7): the only
 * dev dependencies are `vitest` (unit + property test runner) and `fast-check`
 * (property generators). Nothing here pulls a runtime dependency into `src/`.
 *
 * Unit and property suites live beside the modules they cover as
 * `src/**\/*.spec.ts`. The legacy `test/*.e2e.mts` scripts are standalone Node
 * programs, not Vitest suites, so they are excluded.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    exclude: ['node_modules/**', 'test/**'],
    // Property suites explore hundreds of cases per run; keep headroom over the
    // 5s default without letting a genuine hang sit forever.
    testTimeout: 30_000,
    reporters: ['default'],
  },
});
