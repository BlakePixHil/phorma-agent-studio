/**
 * Unit and property tests for schedule-name derivation.
 *
 * Requirements: 6.5
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { scheduleName, schedulePrefix } from './schedule-name.js';

/** Allowed characters in an EventBridge Scheduler schedule name. */
const ALLOWED_CHARS = /^[a-zA-Z0-9_.\-]+$/;

/** Iterations per property. The repo floor is 100; these are pure and cheap. */
const RUNS = 100;

describe('scheduleName', () => {
  it('produces a name at most 64 characters', () => {
    const name = scheduleName('workflow-123', 'node-abc');
    expect(name.length).toBeLessThanOrEqual(64);
  });

  it('uses only allowed EventBridge characters', () => {
    const name = scheduleName('wf-test', 'nd-test');
    expect(name).toMatch(ALLOWED_CHARS);
  });

  it('is deterministic - same inputs produce the same output', () => {
    const a = scheduleName('wf-1', 'nd-1');
    const b = scheduleName('wf-1', 'nd-1');
    expect(a).toBe(b);
  });

  it('is injective - distinct pairs produce distinct names', () => {
    const a = scheduleName('wf-1', 'nd-1');
    const b = scheduleName('wf-1', 'nd-2');
    const c = scheduleName('wf-2', 'nd-1');
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
    expect(b).not.toBe(c);
  });

  it('starts with the sched- prefix', () => {
    const name = scheduleName('wf', 'nd');
    expect(name.startsWith('sched-')).toBe(true);
  });

  it('handles long workflowId and nodeId within the 64-char limit', () => {
    const longWf = 'a'.repeat(200);
    const longNd = 'b'.repeat(200);
    const name = scheduleName(longWf, longNd);
    expect(name.length).toBeLessThanOrEqual(64);
    expect(name).toMatch(ALLOWED_CHARS);
  });

  describe('property: deterministic, injective and bounded (Requirement 6.5)', () => {
    const workflowIdArb = fc.string({ minLength: 1, maxLength: 100 });
    const nodeIdArb = fc.string({ minLength: 1, maxLength: 100 });

    it('always at most 64 characters and only allowed characters', () => {
      fc.assert(
        fc.property(workflowIdArb, nodeIdArb, (wfId, ndId) => {
          const name = scheduleName(wfId, ndId);
          expect(name.length).toBeLessThanOrEqual(64);
          expect(name).toMatch(ALLOWED_CHARS);
        }),
        { numRuns: RUNS },
      );
    });

    it('deterministic: same inputs always produce the same name', () => {
      fc.assert(
        fc.property(workflowIdArb, nodeIdArb, (wfId, ndId) => {
          const a = scheduleName(wfId, ndId);
          const b = scheduleName(wfId, ndId);
          expect(a).toBe(b);
        }),
        { numRuns: RUNS },
      );
    });

    it('injective: distinct pairs produce distinct names', () => {
      fc.assert(
        fc.property(
          workflowIdArb,
          nodeIdArb,
          workflowIdArb,
          nodeIdArb,
          (wfA, ndA, wfB, ndB) => {
            // Skip when inputs are the same pair
            fc.pre(wfA !== wfB || ndA !== ndB);
            const nameA = scheduleName(wfA, ndA);
            const nameB = scheduleName(wfB, ndB);
            expect(nameA).not.toBe(nameB);
          },
        ),
        { numRuns: RUNS },
      );
    });

    it('injective for pairs that share a common prefix/suffix boundary', () => {
      // This tests the separator guarantees: "ab" + "cd" vs "a" + "bcd"
      fc.assert(
        fc.property(
          fc.string({ minLength: 1, maxLength: 50 }),
          fc.string({ minLength: 1, maxLength: 50 }),
          fc.string({ minLength: 1, maxLength: 50 }),
          (prefix, middle, suffix) => {
            // workflowId="prefix+middle", nodeId="suffix" vs
            // workflowId="prefix", nodeId="middle+suffix"
            const nameA = scheduleName(prefix + middle, suffix);
            const nameB = scheduleName(prefix, middle + suffix);
            // Only equal if the pairs are actually the same
            if (prefix + middle !== prefix || suffix !== middle + suffix) {
              expect(nameA).not.toBe(nameB);
            }
          },
        ),
        { numRuns: RUNS },
      );
    });
  });
});

// ---------------------------------------------------------------------------
// Property: a schedule name is scoped to its workflow
// Feature: aws-byo-deploy
//
// This is the regression guard for the cross-workflow deletion bug. One schedule
// group holds every workflow's schedules, so "replace workflow X's schedules"
// is only implementable if X's names are identifiable. Before this, names were a
// single opaque digest and a spec push deleted the whole group.
// ---------------------------------------------------------------------------

describe('Property: schedule names are scoped to their workflow', () => {
  const workflowIdArb = fc.string({ minLength: 1, maxLength: 100 });
  const nodeIdArb = fc.string({ minLength: 1, maxLength: 100 });

  it('every name begins with its own workflow prefix (min 100 runs)', () => {
    fc.assert(
      fc.property(workflowIdArb, nodeIdArb, (wfId, ndId) => {
        expect(scheduleName(wfId, ndId).startsWith(schedulePrefix(wfId))).toBe(true);
      }),
      { numRuns: RUNS },
    );
  });

  it('no name matches a different workflow prefix (min 100 runs)', () => {
    fc.assert(
      fc.property(workflowIdArb, workflowIdArb, nodeIdArb, (wfA, wfB, ndId) => {
        fc.pre(wfA !== wfB);
        fc.pre(schedulePrefix(wfA) !== schedulePrefix(wfB));
        expect(scheduleName(wfA, ndId).startsWith(schedulePrefix(wfB))).toBe(false);
      }),
      { numRuns: RUNS },
    );
  });

  it('the prefix is stable and ends at a separator', () => {
    const prefix = schedulePrefix('wf-1');
    expect(prefix).toBe(schedulePrefix('wf-1'));
    expect(prefix.endsWith('-')).toBe(true);
    expect(prefix.startsWith('sched-')).toBe(true);
    // The trailing separator is what stops one workflow's prefix from matching
    // another whose hash merely starts with the same digits.
    expect(prefix).toMatch(/^sched-[0-9a-f]{16}-$/);
  });

  it('the node segment differs for distinct nodes within one workflow', () => {
    const prefix = schedulePrefix('wf-1');
    const a = scheduleName('wf-1', 'node-a').slice(prefix.length);
    const b = scheduleName('wf-1', 'node-b').slice(prefix.length);
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[0-9a-f]{40}$/);
  });
});
