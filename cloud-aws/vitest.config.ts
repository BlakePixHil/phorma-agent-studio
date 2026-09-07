import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

/**
 * cloud-aws test harness.
 *
 * Property tests cover `src/core/` - pure decision logic with no AWS SDK.
 * The E2E scripts in `test/*.e2e.mts` run separately via tsx.
 *
 * `scripts/**` is in `include` because the Check_Pipeline guards live there and
 * each one carries its own property test beside it
 * (`scripts/check-adapter-real.spec.ts`, `scripts/check-imports-declared.spec.ts`).
 * Those specs stay OUT of `tsconfig.json`'s `include` on purpose: they import a
 * `.mjs` guard and use `node:fs`, and this package installs no `@types/node`, so
 * `tsc --noEmit` cannot check them. vitest transpiles without type-checking, so
 * they run. `npm run check` narrows to `vitest --run src/infra` and is unaffected.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@phorma/engine': resolve(__dirname, '../engine/src/index.ts'),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.spec.ts', 'scripts/**/*.spec.ts'],
    exclude: ['node_modules/**', 'test/**'],
    // The first `src/infra` test to synthesize pays for the whole stack: the
    // Docker image asset fingerprints the repository context and the
    // Schedule_Shim asset is staged and hashed. That cold synth has been measured
    // at around 20 seconds on a warm checkout and more on a cold one, so 30s sat
    // close enough to the edge to flake. This is a ceiling for a known-slow
    // setup, not cover for a slow test.
    testTimeout: 90_000,
    // `testTimeout` does NOT cover a `beforeAll`, and vitest's `hookTimeout`
    // defaults to 10s - which is why the three `src/infra` suites that synthesize
    // in a hook each pass an explicit value. Setting it here too means a new
    // synthesizing suite inherits the right ceiling instead of failing at 10s and
    // reading as a broken assertion. Raised from an effective 30s after
    // `iam-assertions.spec.ts` timed out reproducibly on Windows/Node 24 while
    // every one of its 25 assertions passed given room to run.
    hookTimeout: 90_000,
    reporters: ['default'],
  },
});
