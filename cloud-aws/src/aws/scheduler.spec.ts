/**
 * Unit tests for the SchedulerAdapter (aws/scheduler.ts).
 *
 * Validates core behaviour:
 * - Blank cron expressions are skipped (not rejected)
 * - Invalid cron expressions are rejected during validation
 * - Cap of 50 schedule-trigger nodes is enforced
 * - Deletion ordering: delete-all confirmed BEFORE first create (Req 6.2)
 * - Rollback: on create failure, roll back every schedule created (Req 6.10)
 * - Orphan schedule handling: absent spec triggers delete + metric (Req 6.11)
 *
 * Feature: aws-deployment-target
 * Requirements: 6.1, 6.2, 6.3, 6.5, 6.6, 6.7, 6.9, 6.10, 6.11
 */

import { describe, it, expect, beforeEach } from 'vitest';
import fc from 'fast-check';
import {
  SchedulerAdapter,
  ScheduleValidationError,
  SchedulePushError,
} from './scheduler.js';
import type {
  SchedulerTelemetry,
  SpecPresenceChecker,
  ScheduleTarget,
  Sleep,
} from './scheduler.js';
import { FakeSchedulerBackend } from '../test/fake-scheduler.js';
import { scheduleName, schedulePrefix } from '../core/schedule-name.js';
import { isBlankCron, translateCron } from '../core/cron.js';
import { cronExpressionEdge, scheduleTriggerNodes51 } from '../test/generators.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const TEST_GROUP = 'phorma-schedules';
const TEST_TARGET: ScheduleTarget = {
  arn: 'arn:aws:lambda:us-east-1:123456789012:function:phorma-schedule-shim',
  roleArn: 'arn:aws:iam::123456789012:role/SchedulerInvokeRole',
};

/** The AWS expression a workflow cron becomes, for assertions on stored state. */
function awsExpression(cron: string): string {
  const translated = translateCron(cron);
  if (!translated.ok) throw new Error(`"${cron}" does not translate: ${translated.reason}`);
  return translated.expression;
}

/**
 * A no-op backoff wait. The adapter's retry counts and its 30s push timeout are
 * unchanged; only the wall-clock sleep between attempts disappears, which is
 * what made the failure-injecting properties below dominate the suite runtime.
 */
const noSleep: Sleep = async () => {};

class FakeTelemetry implements SchedulerTelemetry {
  readonly published: { scheduleName?: string }[] = [];

  async publishSkippedScheduledRun(name?: string): Promise<void> {
    this.published.push({ scheduleName: name });
  }
}

function makeAdapter(
  backend: FakeSchedulerBackend,
  telemetry: FakeTelemetry,
  specPresent: SpecPresenceChecker = async () => true,
  translateCronOverride?: (cron: string) => ReturnType<typeof translateCron>,
) {
  return new SchedulerAdapter(
    backend,
    {
      groupName: TEST_GROUP,
      target: TEST_TARGET,
      ...(translateCronOverride === undefined
        ? {}
        : { translateCron: translateCronOverride }),
    },
    telemetry,
    specPresent,
    noSleep,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SchedulerAdapter', () => {
  let backend: FakeSchedulerBackend;
  let telemetry: FakeTelemetry;
  let adapter: SchedulerAdapter;

  beforeEach(() => {
    backend = new FakeSchedulerBackend();
    telemetry = new FakeTelemetry();
    adapter = makeAdapter(backend, telemetry);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // sync: validation
  // ─────────────────────────────────────────────────────────────────────────

  describe('sync - validation', () => {
    it('skips blank cron expressions without error', async () => {
      await adapter.sync('wf-1', [
        { nodeId: 'n1', cron: '' },
        { nodeId: 'n2', cron: '   ' },
        { nodeId: 'n3', cron: '\t' },
        { nodeId: 'n4', cron: '0 * * * *' },
      ]);

      // Only the valid one should be created
      expect(backend.size).toBe(1);
      const name = scheduleName('wf-1', 'n4');
      expect(backend.has(name)).toBe(true);
    });

    it('rejects invalid cron expressions before any mutation', async () => {
      await expect(
        adapter.sync('wf-1', [
          { nodeId: 'n1', cron: '0 * * * *' },
          { nodeId: 'n2', cron: 'not a cron' },
        ]),
      ).rejects.toThrow(ScheduleValidationError);

      // Nothing was created
      expect(backend.size).toBe(0);
      expect(backend.log.length).toBe(0);
    });

    it('rejects when more than 50 non-blank schedule-trigger nodes', async () => {
      const schedules = Array.from({ length: 51 }, (_, i) => ({
        nodeId: `node-${i}`,
        cron: `${i % 60} * * * *`,
      }));

      await expect(adapter.sync('wf-1', schedules)).rejects.toThrow(ScheduleValidationError);
      expect(backend.size).toBe(0);
      expect(backend.log.length).toBe(0);
    });

    it('allows exactly 50 non-blank schedules', async () => {
      const schedules = Array.from({ length: 50 }, (_, i) => ({
        nodeId: `node-${i}`,
        cron: `${i % 60} * * * *`,
      }));

      await adapter.sync('wf-1', schedules);
      expect(backend.size).toBe(50);
    });

    it('uses a custom translateCron when provided', async () => {
      const customAdapter = makeAdapter(backend, telemetry, async () => true, (cron) =>
        cron === 'custom-valid'
          ? { ok: true, expression: '0 0 * * ? *' }
          : { ok: false, reason: 'only "custom-valid" is accepted here' },
      );

      await customAdapter.sync('wf-1', [{ nodeId: 'n1', cron: 'custom-valid' }]);
      expect(backend.size).toBe(1);
      expect(backend.peek(scheduleName('wf-1', 'n1'))?.cron).toBe('0 0 * * ? *');

      backend.reset();
      await expect(
        customAdapter.sync('wf-2', [{ nodeId: 'n1', cron: '0 * * * *' }]),
      ).rejects.toThrow(ScheduleValidationError);
    });

    it('rejects a cron AWS cannot express, naming the reason', async () => {
      // Both day fields constrained. The push must fail before any mutation, and
      // the message has to carry something the operator can act on.
      await expect(
        adapter.sync('wf-1', [{ nodeId: 'n1', cron: '0 0 1 * 1' }]),
      ).rejects.toThrow(/only one/);
      expect(backend.size).toBe(0);
      expect(backend.log.length).toBe(0);
    });

    it('accepts a six-field AWS expression verbatim', async () => {
      await adapter.sync('wf-1', [{ nodeId: 'n1', cron: '15 10 ? * 6L 2022-2023' }]);
      expect(backend.peek(scheduleName('wf-1', 'n1'))?.cron).toBe('15 10 ? * 6L 2022-2023');
    });

    it('stores the translated expression, not the operator input', async () => {
      // The regression that made cron undeployable: `0 12 * * *` reached AWS
      // with `*` in both day fields.
      await adapter.sync('wf-1', [{ nodeId: 'n1', cron: '0 12 * * *' }]);
      expect(backend.peek(scheduleName('wf-1', 'n1'))?.cron).toBe('0 12 * * ? *');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // sync: deletion ordering
  // ─────────────────────────────────────────────────────────────────────────

  describe('sync - deletion ordering (Req 6.2)', () => {
    it('deletes all existing before the first create', async () => {
      // Seed existing schedules
      const existingName = scheduleName('wf-1', 'old-node');
      backend.seed(existingName, {
        name: existingName,
        groupName: TEST_GROUP,
        cron: '0 0 * * *',
        timezone: 'UTC',
        target: TEST_TARGET,
      });

      await adapter.sync('wf-1', [{ nodeId: 'new-node', cron: '*/5 * * * *' }]);

      // Find the positions of delete and create in the log
      const deleteIdx = backend.log.findIndex(
        e => e.operation === 'delete' && e.name === existingName,
      );
      const createIdx = backend.log.findIndex(e => e.operation === 'create');

      expect(deleteIdx).toBeGreaterThanOrEqual(0);
      expect(createIdx).toBeGreaterThan(deleteIdx);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // sync: rollback on failure
  // ─────────────────────────────────────────────────────────────────────────

  describe('sync - rollback on create failure (Req 6.10)', () => {
    it('rolls back all created schedules when a create fails', async () => {
      const targetName = scheduleName('wf-1', 'node-2');
      backend.setFailureInjector((op, name) => {
        // Always fail creates for the third schedule (node-2)
        if (op === 'create' && name === targetName) {
          throw new Error('Scheduler service unavailable');
        }
      });

      const schedules = Array.from({ length: 5 }, (_, i) => ({
        nodeId: `node-${i}`,
        cron: `${i * 10} * * * *`,
      }));

      await expect(adapter.sync('wf-1', schedules)).rejects.toThrow(SchedulePushError);

      // After rollback, no schedules should remain
      expect(backend.size).toBe(0);
    });

    it('succeeds after retries within budget', async () => {
      let createAttempts = 0;
      backend.setFailureInjector((op) => {
        if (op === 'create') {
          createAttempts++;
          // Fail on first attempt only (of first schedule)
          if (createAttempts === 1) {
            throw new Error('Transient error');
          }
        }
      });

      await adapter.sync('wf-1', [{ nodeId: 'n1', cron: '0 * * * *' }]);
      expect(backend.size).toBe(1);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // sync: schedule naming and timezone
  // ─────────────────────────────────────────────────────────────────────────

  describe('sync - naming and timezone (Req 6.5, 6.6)', () => {
    it('uses deterministic schedule names from scheduleName()', async () => {
      await adapter.sync('wf-1', [
        { nodeId: 'trigger-a', cron: '0 * * * *' },
        { nodeId: 'trigger-b', cron: '30 2 * * *' },
      ]);

      const nameA = scheduleName('wf-1', 'trigger-a');
      const nameB = scheduleName('wf-1', 'trigger-b');

      expect(backend.has(nameA)).toBe(true);
      expect(backend.has(nameB)).toBe(true);
    });

    it('sets UTC timezone on every schedule', async () => {
      await adapter.sync('wf-1', [{ nodeId: 'n1', cron: '0 * * * *' }]);

      const name = scheduleName('wf-1', 'n1');
      const entry = backend.peek(name);
      expect(entry?.timezone).toBe('UTC');
    });

    it('creates schedules in the configured group', async () => {
      await adapter.sync('wf-1', [{ nodeId: 'n1', cron: '0 * * * *' }]);

      const name = scheduleName('wf-1', 'n1');
      const entry = backend.peek(name);
      expect(entry?.groupName).toBe(TEST_GROUP);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // deleteAll
  // ─────────────────────────────────────────────────────────────────────────

  describe('deleteAll', () => {
    /** Seed one schedule under its real derived name. */
    function seedFor(workflowId: string, nodeId: string): string {
      const name = scheduleName(workflowId, nodeId);
      backend.seed(name, {
        name,
        groupName: TEST_GROUP,
        cron: '0 * * * ? *',
        timezone: 'UTC',
        target: TEST_TARGET,
      });
      return name;
    }

    it('removes every schedule belonging to the workflow', async () => {
      const a = seedFor('wf-1', 'n1');
      const b = seedFor('wf-1', 'n2');

      await adapter.deleteAll('wf-1');

      expect(backend.has(a)).toBe(false);
      expect(backend.has(b)).toBe(false);
      expect(backend.size).toBe(0);
    });

    it('leaves another workflow\'s schedules alone', async () => {
      const mine = seedFor('wf-1', 'n1');
      const theirs = seedFor('wf-2', 'n1');

      await adapter.deleteAll('wf-1');

      expect(backend.has(mine)).toBe(false);
      expect(backend.has(theirs)).toBe(true);
    });

    it('scopes its list to the workflow prefix', async () => {
      seedFor('wf-1', 'n1');
      await adapter.deleteAll('wf-1');

      const lists = backend.log.filter(e => e.operation === 'list');
      expect(lists.length).toBeGreaterThan(0);
      for (const entry of lists) {
        expect(entry.namePrefix).toBe(schedulePrefix('wf-1'));
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // sync: cross-workflow isolation
  // ─────────────────────────────────────────────────────────────────────────

  describe('sync - cross-workflow isolation', () => {
    it('a push for one workflow does not disturb another', async () => {
      await adapter.sync('wf-a', [{ nodeId: 'n1', cron: '0 1 * * *' }]);
      await adapter.sync('wf-b', [{ nodeId: 'n1', cron: '0 2 * * *' }]);

      // Re-pushing wf-a must leave wf-b's schedule in place. Before names were
      // workflow-scoped, this deleted wf-b entirely.
      await adapter.sync('wf-a', [{ nodeId: 'n1', cron: '0 3 * * *' }]);

      expect(backend.has(scheduleName('wf-a', 'n1'))).toBe(true);
      expect(backend.has(scheduleName('wf-b', 'n1'))).toBe(true);
      expect(backend.peek(scheduleName('wf-a', 'n1'))?.cron).toBe('0 3 * * ? *');
      expect(backend.peek(scheduleName('wf-b', 'n1'))?.cron).toBe('0 2 * * ? *');
      expect(backend.size).toBe(2);
    });

    it('an emptied spec removes only its own workflow\'s schedules', async () => {
      await adapter.sync('wf-a', [{ nodeId: 'n1', cron: '0 1 * * *' }]);
      await adapter.sync('wf-b', [{ nodeId: 'n1', cron: '0 2 * * *' }]);

      await adapter.sync('wf-a', []);

      expect(backend.has(scheduleName('wf-a', 'n1'))).toBe(false);
      expect(backend.has(scheduleName('wf-b', 'n1'))).toBe(true);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // handleScheduleFire - orphan schedules (Req 6.11)
  // ─────────────────────────────────────────────────────────────────────────

  describe('handleScheduleFire (Req 6.11)', () => {
    it('returns true when spec is present', async () => {
      const result = await adapter.handleScheduleFire('wf-1', 'node-1');
      expect(result).toBe(true);
      expect(telemetry.published.length).toBe(0);
    });

    it('deletes the schedule and publishes metric when spec is absent', async () => {
      const absentAdapter = makeAdapter(backend, telemetry, async () => false);

      // Seed the schedule that would fire
      const name = scheduleName('wf-1', 'node-1');
      backend.seed(name, {
        name,
        groupName: TEST_GROUP,
        cron: '0 * * * *',
        timezone: 'UTC',
        target: TEST_TARGET,
      });

      const result = await absentAdapter.handleScheduleFire('wf-1', 'node-1');
      expect(result).toBe(false);
      expect(backend.has(name)).toBe(false);
      expect(telemetry.published.length).toBe(1);
      expect(telemetry.published[0]!.scheduleName).toBe(name);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // sync: idempotent push
  // ─────────────────────────────────────────────────────────────────────────

  describe('sync - idempotency', () => {
    it('pushing the same spec twice yields the same schedules', async () => {
      const schedules = [
        { nodeId: 'trigger-a', cron: '0 * * * *' },
        { nodeId: 'trigger-b', cron: '30 2 * * *' },
      ];

      await adapter.sync('wf-1', schedules);
      const firstNames = backend.names.sort();

      await adapter.sync('wf-1', schedules);
      const secondNames = backend.names.sort();

      expect(secondNames).toEqual(firstNames);
      expect(backend.size).toBe(2);
    });
  });
});


// ---------------------------------------------------------------------------
// Property 17: The deployed schedule set equals the pushed spec's derived set
// Feature: aws-deployment-target
// Validates: Requirements 6.1, 6.2, 6.3, 6.5, 6.6
// ---------------------------------------------------------------------------

describe('Property 17: The deployed schedule set equals the pushed spec\'s derived set', () => {
  const TEST_GROUP = 'phorma-schedules';
  const TEST_TARGET: ScheduleTarget = {
    arn: 'arn:aws:lambda:us-east-1:123456789012:function:phorma-schedule-shim',
    roleArn: 'arn:aws:iam::123456789012:role/SchedulerInvokeRole',
  };

  // Classification comes from `core/cron.ts` itself, not from a copy of it. This
  // property previously carried a 40-line reimplementation of the old Unix
  // validator, so the test and the code agreed on a classification AWS rejected
  // and the property could not observe the defect it was meant to cover.
  const isBlank = isBlankCron;
  const isValidCron = (cron: string): boolean => translateCron(cron).ok;

  /**
   * Generator for arrays of ScheduleDefinition using the cronExpressionEdge() generator.
   * Generates between 0 and 55 entries (allows exceeding the 50 cap for edge testing).
   */
  function scheduleDefinitionArray() {
    return fc.array(
      fc.record({
        nodeId: fc.stringMatching(/^[a-z][a-z0-9-]{0,15}$/).filter(s => s.length > 0),
        cron: cronExpressionEdge(),
      }),
      { minLength: 0, maxLength: 55 },
    ).map(defs => {
      // Ensure unique nodeIds
      const seen = new Set<string>();
      return defs.filter(d => {
        if (seen.has(d.nodeId)) return false;
        seen.add(d.nodeId);
        return true;
      });
    });
  }

  it('after sync, the deployed set matches the derived set from non-blank valid crons (min 100 runs)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 16 }).filter(s => /^[a-z][a-z0-9-]*$/.test(s)),
        scheduleDefinitionArray(),
        async (workflowId, definitions) => {
          // Classify each definition
          const nonBlank = definitions.filter(d => !isBlank(d.cron));
          const allNonBlankValid = nonBlank.every(d => isValidCron(d.cron));

          // Only proceed with sync when all non-blank entries are valid AND within cap
          // (since invalid cron or >50 rejects before mutation)
          if (!allNonBlankValid || nonBlank.length > 50) return; // skip - sync would reject

          const backend = new FakeSchedulerBackend();
          const telemetry: SchedulerTelemetry = {
            async publishSkippedScheduledRun() {},
          };
          const adapter = new SchedulerAdapter(
            backend,
            { groupName: TEST_GROUP, target: TEST_TARGET },
            telemetry,
            async () => true,
            noSleep,
          );

          // Execute the sync
          await adapter.sync(workflowId, definitions);

          // 1. The set of schedule names in the backend equals the set derived from
          //    scheduleName(workflowId, nodeId) for each non-blank valid cron in the input
          const expectedNames = new Set(
            nonBlank.map(d => scheduleName(workflowId, d.nodeId)),
          );
          const actualNames = new Set(backend.names);
          expect(actualNames).toEqual(expectedNames);

          // 2. Blank cron expressions are excluded from the deployed set
          const blankDefs = definitions.filter(d => isBlank(d.cron));
          for (const def of blankDefs) {
            const name = scheduleName(workflowId, def.nodeId);
            expect(backend.has(name)).toBe(false);
          }

          // 3. The timezone is UTC on every deployed schedule
          for (const name of backend.names) {
            const entry = backend.peek(name);
            expect(entry?.timezone).toBe('UTC');
          }

          // 4. Every deployed schedule carries the TRANSLATED expression. The
          //    stored value is the AWS six-field form, never the raw operator
          //    input, because that input is what AWS refuses.
          for (const def of nonBlank) {
            const name = scheduleName(workflowId, def.nodeId);
            const entry = backend.peek(name);
            expect(entry?.cron).toBe(awsExpression(def.cron));
          }

          // 5. Exactly one day field defers on every deployed expression.
          for (const name of backend.names) {
            const fields = backend.peek(name)!.cron.split(' ');
            expect(fields).toHaveLength(6);
            expect([fields[2], fields[4]].filter(f => f === '?')).toHaveLength(1);
          }

          // 6. The deployed set is capped at 50
          expect(backend.size).toBeLessThanOrEqual(50);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 18: A schedule push is all-or-nothing
// Feature: aws-deployment-target
// Validates: Requirements 6.9, 6.10
// ---------------------------------------------------------------------------

describe('Property 18: A schedule push is all-or-nothing', () => {
  const TEST_GROUP = 'phorma-schedules';
  const TEST_TARGET: ScheduleTarget = {
    arn: 'arn:aws:lambda:us-east-1:123456789012:function:phorma-schedule-shim',
    roleArn: 'arn:aws:iam::123456789012:role/SchedulerInvokeRole',
  };

  function makeTelemetry(): SchedulerTelemetry {
    return { async publishSkippedScheduledRun() {} };
  }

  it('when validation fails (>50 non-blank schedules), no schedule is created or deleted', async () => {
    await fc.assert(
      fc.asyncProperty(
        scheduleTriggerNodes51(),
        async (nodes) => {
          const backend = new FakeSchedulerBackend();
          const adapter = new SchedulerAdapter(
            backend,
            { groupName: TEST_GROUP, target: TEST_TARGET },
            makeTelemetry(),
            async () => true,
            noSleep,
          );

          // Convert the 51 workflow nodes into ScheduleDefinitions
          const definitions = nodes.map(n => ({
            nodeId: n.id,
            cron: (n.data as { cron: string }).cron,
          }));

          // Capture pre-push state
          const sizeBefore = backend.size;
          const logLengthBefore = backend.log.length;

          // Sync must reject with a validation error
          await expect(adapter.sync('wf-atomicity', definitions))
            .rejects.toThrow(ScheduleValidationError);

          // Atomicity before mutation: no schedule was created or deleted
          expect(backend.size).toBe(sizeBefore);
          expect(backend.log.length).toBe(logLengthBefore);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('when a create fails mid-push, all created schedules are rolled back', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 2, max: 10 }),
        fc.integer({ min: 0, max: 9 }),
        async (scheduleCount, failSeed) => {
          // Constrain failPosition to valid range
          const failPosition = failSeed % scheduleCount;

          const backend = new FakeSchedulerBackend();
          const adapter = new SchedulerAdapter(
            backend,
            { groupName: TEST_GROUP, target: TEST_TARGET },
            makeTelemetry(),
            async () => true,
            noSleep,
          );

          // Generate valid schedule definitions
          const definitions = Array.from({ length: scheduleCount }, (_, i) => ({
            nodeId: `node-${i}`,
            cron: `${i % 60} * * * *`,
          }));

          // Track how many creates have been attempted (across retries)
          let createCount = 0;
          const failTargetName = scheduleName('wf-atomicity', `node-${failPosition}`);

          // Inject failure at the specified position - always fail that schedule name
          backend.setFailureInjector((op, name) => {
            if (op === 'create' && name === failTargetName) {
              throw new Error(`Injected failure at position ${failPosition}`);
            }
          });

          // Capture pre-push state (empty)
          const sizeBefore = backend.size;

          // Sync must fail with a push error
          await expect(adapter.sync('wf-atomicity', definitions))
            .rejects.toThrow(SchedulePushError);

          // After rollback, the backend returns to its pre-push state
          expect(backend.size).toBe(sizeBefore);

          // Verify no partial schedules remain from this push
          for (const def of definitions) {
            const name = scheduleName('wf-atomicity', def.nodeId);
            expect(backend.has(name)).toBe(false);
          }
        },
      ),
      { numRuns: 100 },
    );
  }, 120_000);

  it('after rollback, the backend returns to its pre-push state (no partial schedules)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 2, max: 10 }),
        fc.integer({ min: 0, max: 9 }),
        async (scheduleCount, failSeed) => {
          const failPosition = failSeed % scheduleCount;

          const backend = new FakeSchedulerBackend();
          const adapter = new SchedulerAdapter(
            backend,
            { groupName: TEST_GROUP, target: TEST_TARGET },
            makeTelemetry(),
            async () => true,
            noSleep,
          );

          // Seed schedules belonging to a DIFFERENT workflow. They must survive
          // the failed push untouched: sync's delete step is scoped to the
          // workflow being pushed, so another workflow's schedules are never in
          // scope to begin with.
          const otherNames = ['other-1', 'other-2'].map(nodeId => {
            const name = scheduleName('wf-other', nodeId);
            backend.seed(name, {
              name,
              groupName: TEST_GROUP,
              cron: '0 0 * * ? *',
              timezone: 'UTC',
              target: TEST_TARGET,
            });
            return name;
          });

          const definitions = Array.from({ length: scheduleCount }, (_, i) => ({
            nodeId: `node-${i}`,
            cron: `${i % 60} * * * *`,
          }));

          const failTargetName = scheduleName('wf-atomicity', `node-${failPosition}`);

          // Inject failure at the target position
          backend.setFailureInjector((op, name) => {
            if (op === 'create' && name === failTargetName) {
              throw new Error(`Injected failure at position ${failPosition}`);
            }
          });

          // Sync will delete existing schedules first, then fail during creates
          await expect(adapter.sync('wf-atomicity', definitions))
            .rejects.toThrow(SchedulePushError);

          // After rollback, no schedule from this push exists
          for (const def of definitions) {
            const name = scheduleName('wf-atomicity', def.nodeId);
            expect(backend.has(name)).toBe(false);
          }

          // No partial schedule from this push remains: the all-or-nothing
          // guarantee for the CREATE phase, which the rollback provides.
          const remainingNames = backend.names;
          for (const def of definitions) {
            const name = scheduleName('wf-atomicity', def.nodeId);
            expect(remainingNames).not.toContain(name);
          }

          // And the blast radius stopped at this workflow. Sync's delete step
          // never listed outside `schedulePrefix('wf-atomicity')`, so a failed
          // push cannot take another workflow's schedules down with it.
          for (const name of otherNames) {
            expect(backend.has(name)).toBe(true);
          }
        },
      ),
      { numRuns: 100 },
    );
  }, 120_000);
});
