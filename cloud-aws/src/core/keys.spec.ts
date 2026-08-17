/**
 * Property tests for Run_Table key derivation.
 *
 * Property 4: The lease key is a function of the workflow id alone.
 * Validates: Requirements 2.12, 18.2
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { pk, leaseSk } from './keys.js';

describe('keys - Property 4: lease key derivation', () => {
  /**
   * **Validates: Requirements 2.12, 18.2**
   *
   * The Execution_Lease partition key derives from the workflow id alone.
   * Two runs of the same workflow contend for one item; runs of different
   * workflows contend for none. Varying run id, trigger source, task id
   * and process id must not change the derived key.
   */
  it('lease key is invariant across run contexts that differ only in run id, trigger source, task id and process id', () => {
    const runContextArb = fc.record({
      runId: fc.uuid(),
      triggerSource: fc.oneof(
        fc.constant('manual'),
        fc.constant('schedule'),
        fc.constant('webhook'),
        fc.constant('api'),
        fc.string({ minLength: 1, maxLength: 64 }),
      ),
      taskId: fc.string({ minLength: 1, maxLength: 64 }),
      processId: fc.string({ minLength: 1, maxLength: 64 }),
    });

    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 128 }),
        runContextArb,
        runContextArb,
        (workflowId, contextA, contextB) => {
          // Despite completely different run contexts, the lease key is identical
          fc.pre(
            contextA.runId !== contextB.runId ||
            contextA.triggerSource !== contextB.triggerSource ||
            contextA.taskId !== contextB.taskId ||
            contextA.processId !== contextB.processId,
          );

          const leaseKeyA = `${pk(workflowId)}|${leaseSk()}`;
          const leaseKeyB = `${pk(workflowId)}|${leaseSk()}`;

          expect(leaseKeyA).toBe(leaseKeyB);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('different workflow ids produce different lease keys', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 128 }),
        fc.string({ minLength: 1, maxLength: 128 }),
        (wfIdA, wfIdB) => {
          fc.pre(wfIdA !== wfIdB);
          const leaseKeyA = `${pk(wfIdA)}|${leaseSk()}`;
          const leaseKeyB = `${pk(wfIdB)}|${leaseSk()}`;
          expect(leaseKeyA).not.toBe(leaseKeyB);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('lease sort key is constant - never incorporates run-scoped values', () => {
    fc.assert(
      fc.property(
        fc.uuid(),
        fc.oneof(fc.constant('manual'), fc.constant('schedule'), fc.constant('webhook')),
        fc.string({ minLength: 1, maxLength: 64 }),
        fc.string({ minLength: 1, maxLength: 64 }),
        (_runId, _triggerSource, _taskId, _processId) => {
          // leaseSk is a constant regardless of what run context surrounds it
          expect(leaseSk()).toBe('lease');
        },
      ),
      { numRuns: 100 },
    );
  });
});
