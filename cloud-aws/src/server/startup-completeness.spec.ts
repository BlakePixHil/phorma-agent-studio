/**
 * Property test for startup contract completeness.
 *
 * Property 25: Startup refuses to serve an incomplete contract.
 * Validates: Requirements 1.9
 *
 * Feature: aws-deployment-target
 *
 * For any proper subset of the ten RUNTIME_HOST_CAPABILITIES (not all ten),
 * assertContractComplete must throw IncompleteContractError naming exactly
 * the missing capabilities. For the full set it must not throw.
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { RUNTIME_HOST_CAPABILITIES } from '../core/host-contract.js';
import {
  assertContractComplete,
  IncompleteContractError,
  type HostAdapter,
} from './startup.js';

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/** Arbitrary subset of the ten capabilities (may include all ten or be empty). */
const arbCapabilitySubset = fc.subarray(
  [...RUNTIME_HOST_CAPABILITIES],
  { minLength: 0, maxLength: RUNTIME_HOST_CAPABILITIES.length },
);

/**
 * Arbitrary proper subset - at least one capability missing.
 * This ensures the subset is NEVER the full set.
 */
const arbProperSubset = fc.subarray(
  [...RUNTIME_HOST_CAPABILITIES],
  { minLength: 0, maxLength: RUNTIME_HOST_CAPABILITIES.length - 1 },
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build an adapter implementing only the given subset of capabilities. */
function adapterFromSubset(present: readonly string[]): HostAdapter {
  const adapter: Record<string, unknown> = {};
  for (const key of RUNTIME_HOST_CAPABILITIES) {
    adapter[key] = present.includes(key) ? { __live: true } : undefined;
  }
  return adapter as HostAdapter;
}

// ---------------------------------------------------------------------------
// Property 25
// ---------------------------------------------------------------------------

describe('server/startup - Property 25: Startup refuses to serve an incomplete contract', () => {
  /**
   * **Validates: Requirements 1.9**
   *
   * For any proper subset of the ten capabilities (not all ten present),
   * assertContractComplete must throw IncompleteContractError and the error
   * must name exactly the missing capabilities.
   */
  it('throws IncompleteContractError naming exactly the missing capabilities for any proper subset', () => {
    fc.assert(
      fc.property(arbProperSubset, (presentKeys) => {
        const adapter = adapterFromSubset(presentKeys);
        const expectedMissing = RUNTIME_HOST_CAPABILITIES.filter(
          (k) => !presentKeys.includes(k),
        );

        // Must throw because this is a proper subset
        expect(expectedMissing.length).toBeGreaterThan(0);

        try {
          assertContractComplete(adapter);
          // Should never reach here
          expect.fail('assertContractComplete should have thrown IncompleteContractError');
        } catch (e) {
          expect(e).toBeInstanceOf(IncompleteContractError);
          const err = e as IncompleteContractError;

          // The error must name exactly the missing capabilities (set equality)
          const missingSet = new Set(err.missing);
          const expectedSet = new Set(expectedMissing);
          expect(missingSet).toEqual(expectedSet);
        }
      }),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 1.9**
   *
   * When all ten capabilities are present (the full set), startup must not throw.
   */
  it('does not throw when all ten capabilities are present', () => {
    fc.assert(
      fc.property(
        // Use an arbitrary truthy value for each capability to show it accepts any live impl
        fc.record(
          Object.fromEntries(
            RUNTIME_HOST_CAPABILITIES.map((k) => [
              k,
              fc.oneof(
                fc.constant({ __live: true }),
                fc.constant(() => {}),
                fc.constant('impl'),
                fc.constant(42),
              ),
            ]),
          ),
        ),
        (adapterRecord) => {
          const adapter = adapterRecord as unknown as HostAdapter;
          // Must not throw
          expect(() => assertContractComplete(adapter)).not.toThrow();
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 1.9**
   *
   * Over arbitrary subsets of the ten capabilities, the function either throws
   * (proper subset) or succeeds (full set), and the missing list is always correct.
   */
  it('correctly distinguishes complete from incomplete for arbitrary subsets', () => {
    fc.assert(
      fc.property(arbCapabilitySubset, (presentKeys) => {
        const adapter = adapterFromSubset(presentKeys);
        const expectedMissing = RUNTIME_HOST_CAPABILITIES.filter(
          (k) => !presentKeys.includes(k),
        );

        if (expectedMissing.length === 0) {
          // Full set - must not throw
          expect(() => assertContractComplete(adapter)).not.toThrow();
        } else {
          // Proper subset - must throw naming exactly the missing keys
          try {
            assertContractComplete(adapter);
            expect.fail('should have thrown for incomplete contract');
          } catch (e) {
            expect(e).toBeInstanceOf(IncompleteContractError);
            const err = e as IncompleteContractError;
            expect(new Set(err.missing)).toEqual(new Set(expectedMissing));
          }
        }
      }),
      { numRuns: 100 },
    );
  });
});
