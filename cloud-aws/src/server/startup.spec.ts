/**
 * Unit tests for the AWS_Host startup contract completeness assertion.
 *
 * Verifies that assertContractComplete:
 * - Passes when all ten capabilities are live
 * - Throws IncompleteContractError naming each missing capability
 * - Rejects null and undefined as non-live
 * - Validates against the frozen RUNTIME_HOST_CAPABILITIES array
 *
 * Property 14 below extends that to the whole subset space and to the operator-
 * facing report `startHost` writes before it exits (Req 7.3).
 *
 * Feature: aws-deployment-target, aws-byo-deploy
 * Requirements: 1.9, 7.3
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  RUNTIME_HOST_CAPABILITIES,
  type RuntimeHostCapability,
} from '../core/host-contract.js';
import { FakeDocumentTableClient } from '../test/fake-document-table-client.js';
import { FakeMonitorBackend } from '../test/fake-monitor.js';
import { FakeSchedulerBackend } from '../test/fake-scheduler.js';
import { FakeSecretsManager } from '../test/fake-secrets-manager.js';
import type { LogWriter, MetricPublisher } from '../aws/ports.js';
import type { ServerEnv } from './env.js';
import {
  assertContractComplete,
  composeHostAdapter,
  reportIncompleteContract,
  startHost,
  EXIT_INCOMPLETE_CONTRACT,
  IncompleteContractError,
  type HostAdapter,
  type HostFactories,
  type StartupErrorSink,
} from './startup.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a fully-implemented adapter with a truthy value for every key. */
function fullAdapter(): HostAdapter {
  const adapter: Record<string, unknown> = {};
  for (const key of RUNTIME_HOST_CAPABILITIES) {
    adapter[key] = { __capability: key };
  }
  return adapter as HostAdapter;
}

/** Build an adapter missing the specified keys. */
function adapterMissing(...keys: string[]): HostAdapter {
  const adapter = fullAdapter() as Record<string, unknown>;
  for (const key of keys) {
    adapter[key] = undefined;
  }
  return adapter as HostAdapter;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('server/startup - assertContractComplete', () => {
  it('passes when all ten capabilities are live', () => {
    expect(() => assertContractComplete(fullAdapter())).not.toThrow();
  });

  it('validates against the frozen ten-key array', () => {
    // The frozen array must have exactly 10 keys
    expect(RUNTIME_HOST_CAPABILITIES).toHaveLength(10);
    expect(Object.isFrozen(RUNTIME_HOST_CAPABILITIES)).toBe(true);
  });

  it('throws IncompleteContractError when a single capability is missing', () => {
    const adapter = adapterMissing('lease');
    expect(() => assertContractComplete(adapter)).toThrow(IncompleteContractError);
    try {
      assertContractComplete(adapter);
    } catch (e) {
      const err = e as IncompleteContractError;
      expect(err.missing).toEqual(['lease']);
      expect(err.message).toContain('lease');
    }
  });

  it('throws naming ALL missing capabilities, not just the first', () => {
    const adapter = adapterMissing('spec', 'journal', 'monitor');
    try {
      assertContractComplete(adapter);
      expect.fail('should have thrown');
    } catch (e) {
      const err = e as IncompleteContractError;
      expect(err.missing).toContain('spec');
      expect(err.missing).toContain('journal');
      expect(err.missing).toContain('monitor');
      expect(err.missing).toHaveLength(3);
    }
  });

  it('treats null as non-live', () => {
    const adapter = fullAdapter() as Record<string, unknown>;
    adapter['connections'] = null;
    expect(() => assertContractComplete(adapter as HostAdapter)).toThrow(
      IncompleteContractError,
    );
  });

  it('treats undefined as non-live', () => {
    const adapter = fullAdapter() as Record<string, unknown>;
    adapter['workflowState'] = undefined;
    expect(() => assertContractComplete(adapter as HostAdapter)).toThrow(
      IncompleteContractError,
    );
  });

  it('accepts any truthy value as a live implementation', () => {
    const adapter: Record<string, unknown> = {};
    for (const key of RUNTIME_HOST_CAPABILITIES) {
      // Various truthy values - objects, functions, non-empty strings
      adapter[key] = key.length % 2 === 0 ? {} : () => {};
    }
    expect(() => assertContractComplete(adapter as HostAdapter)).not.toThrow();
  });

  it('error message names the module and all missing capabilities', () => {
    const adapter = adapterMissing('lease', 'schedules');
    try {
      assertContractComplete(adapter);
      expect.fail('should have thrown');
    } catch (e) {
      const err = e as IncompleteContractError;
      expect(err.message).toMatch(/AWS_Host startup failed/);
      expect(err.message).toContain('lease');
      expect(err.message).toContain('schedules');
      expect(err.name).toBe('IncompleteContractError');
    }
  });
});

// ---------------------------------------------------------------------------
// Feature: aws-byo-deploy, Property 14: Startup names every unsatisfied capability
// Validates: Requirements 7.3
//
// For any subset of the ten Runtime_Host_Contract capabilities left
// unimplemented, startup fails and the reported names equal that subset
// exactly - no extra name, none dropped, and never truncated to the first one.
//
// The subset space is only 1024 wide, so it is enumerated exhaustively as well
// as sampled by the property. `assertContractComplete` treats a capability as
// unimplemented when its value is nullish, so "left unimplemented" is generated
// three ways: the key absent, the key set to `undefined`, and the key set to
// `null`. All three are what a half-finished composition actually produces.
//
// The second half of the property drives `startHost` itself, because Req 7.3 is
// about what the operator reads in `aws logs tail`: one capability name per
// line, then a non-zero exit, with no listener ever created.
// ---------------------------------------------------------------------------

/** How a capability can be left unimplemented. All three read as nullish. */
type NullishMode = 'absent' | 'undefined' | 'null';

const NULLISH_MODES: readonly NullishMode[] = ['absent', 'undefined', 'null'];

/**
 * Build an adapter where every capability is live except `missing`, each of
 * those left unimplemented the way `modeOf` says.
 */
function adapterLeaving(
  missing: readonly RuntimeHostCapability[],
  modeOf: (capability: RuntimeHostCapability) => NullishMode,
): HostAdapter {
  const adapter: Record<string, unknown> = {};
  for (const capability of RUNTIME_HOST_CAPABILITIES) {
    if (!missing.includes(capability)) {
      adapter[capability] = { __capability: capability };
      continue;
    }
    switch (modeOf(capability)) {
      case 'absent':
        break; // the key is simply not there
      case 'undefined':
        adapter[capability] = undefined;
        break;
      case 'null':
        adapter[capability] = null;
        break;
    }
  }
  return adapter as HostAdapter;
}

/** The subset in `RUNTIME_HOST_CAPABILITIES` order, which is report order. */
function inContractOrder(
  missing: readonly RuntimeHostCapability[],
): RuntimeHostCapability[] {
  return RUNTIME_HOST_CAPABILITIES.filter((capability) => missing.includes(capability));
}

/** Every subset of the ten capabilities, all 1024 of them. */
function allCapabilitySubsets(): RuntimeHostCapability[][] {
  const names = [...RUNTIME_HOST_CAPABILITIES];
  const subsets: RuntimeHostCapability[][] = [];
  for (let mask = 0; mask < 1 << names.length; mask += 1) {
    subsets.push(names.filter((_, i) => (mask & (1 << i)) !== 0));
  }
  return subsets;
}

// --- Composition without AWS credentials -----------------------------------

/** A task-definition environment shaped like the real one. No client uses it. */
function fakeEnv(): ServerEnv {
  return {
    region: 'eu-west-1',
    runTableName: 'phorma-runs',
    monitorEndpoint: 'https://monitor.example.com',
    secretPrefix: 'phorma/test',
    metricNamespace: 'Phorma/Test',
    scheduleGroup: 'phorma-schedules',
    scheduleTargetArn: 'arn:aws:lambda:eu-west-1:123456789012:function:phorma-schedule-shim',
    scheduleRoleArn: 'arn:aws:iam::123456789012:role/phorma-scheduler',
    runnerId: 'runner-test',
    port: 8080,
  };
}

const silentLogWriter: LogWriter = { write: async () => {} };
const silentMetricPublisher: MetricPublisher = { publish: async () => {} };

/**
 * The six factories, all fakes. This is the whole point of the injection seam:
 * composition runs with no AWS credentials, so the assertion at the end of
 * `composeHostAdapter` is exercised against the real capability record.
 */
function fakeFactories(): HostFactories {
  return {
    createDocumentTableClient: () => new FakeDocumentTableClient(),
    createMonitorBackend: () => new FakeMonitorBackend(),
    createSecretsBackend: () => new FakeSecretsManager(),
    createSchedulerBackend: () => new FakeSchedulerBackend(),
    createMetricPublisher: () => silentMetricPublisher,
    createStdoutLogWriter: () => silentLogWriter,
  };
}

/**
 * Fakes, except that building the log writer raises the `IncompleteContractError`
 * the real assertion would raise for `missing`.
 *
 * The real composition cannot leave an arbitrary subset unimplemented - seven of
 * the ten capabilities share one Run_Table adapter - so the error is produced by
 * calling `assertContractComplete` on a fabricated adapter and surfaced through
 * the factory seam. What is under test is the layer above: `startHost` catching
 * it, reporting every name, and exiting. That layer sees the same error object
 * either way.
 */
function factoriesFailingContract(
  missing: readonly RuntimeHostCapability[],
  modeOf: (capability: RuntimeHostCapability) => NullishMode,
): HostFactories {
  return {
    ...fakeFactories(),
    createStdoutLogWriter: () => {
      assertContractComplete(adapterLeaving(missing, modeOf));
      throw new Error('unreachable: a non-empty subset always fails the assertion');
    },
  };
}

// --- Recording the report and the exit -------------------------------------

type StartupEvent = { kind: 'write'; chunk: string } | { kind: 'exit'; code: number };

interface StartupRecorder {
  readonly events: StartupEvent[];
  readonly stderr: StartupErrorSink;
  exit(code: number): void;
  /** Everything written, concatenated as the stream would receive it. */
  text(): string;
  /** Each written line, with the trailing empty element dropped. */
  lines(): string[];
  exitCodes(): number[];
}

function createStartupRecorder(): StartupRecorder {
  const events: StartupEvent[] = [];
  return {
    events,
    stderr: {
      write(chunk: string) {
        events.push({ kind: 'write', chunk });
        return true;
      },
    },
    exit(code: number) {
      events.push({ kind: 'exit', code });
    },
    text() {
      return events
        .filter((e): e is { kind: 'write'; chunk: string } => e.kind === 'write')
        .map((e) => e.chunk)
        .join('');
    },
    lines() {
      const parts = this.text().split('\n');
      // Every write ends in a newline, so the split leaves one empty tail.
      if (parts[parts.length - 1] === '') parts.pop();
      return parts;
    },
    exitCodes() {
      return events
        .filter((e): e is { kind: 'exit'; code: number } => e.kind === 'exit')
        .map((e) => e.code);
    },
  };
}

// --- Generators ------------------------------------------------------------

/** Any subset of the ten capabilities, including the empty and the full set. */
const arbMissing = fc.subarray([...RUNTIME_HOST_CAPABILITIES], {
  minLength: 0,
  maxLength: RUNTIME_HOST_CAPABILITIES.length,
});

/** A non-empty subset: the failing side of the property. */
const arbMissingNonEmpty = fc.subarray([...RUNTIME_HOST_CAPABILITIES], {
  minLength: 1,
  maxLength: RUNTIME_HOST_CAPABILITIES.length,
});

/** One nullish mode per capability, so a single case mixes all three. */
const arbNullishModes = fc.record(
  Object.fromEntries(
    RUNTIME_HOST_CAPABILITIES.map((capability) => [
      capability,
      fc.constantFrom(...NULLISH_MODES),
    ]),
  ),
) as fc.Arbitrary<Record<RuntimeHostCapability, NullishMode>>;

// ---------------------------------------------------------------------------
// Property 14
// ---------------------------------------------------------------------------

describe('server/startup - Property 14: Startup names every unsatisfied capability', () => {
  /**
   * **Validates: Requirements 7.3**
   *
   * The reported set equals the unimplemented subset exactly, in contract order,
   * whichever way each capability is left nullish. The empty subset must not
   * throw.
   */
  it('reports exactly the unimplemented subset, however each is left nullish', () => {
    fc.assert(
      fc.property(arbMissing, arbNullishModes, (missing, modes) => {
        const adapter = adapterLeaving(missing, (capability) => modes[capability]);

        if (missing.length === 0) {
          expect(() => assertContractComplete(adapter)).not.toThrow();
          return;
        }

        try {
          assertContractComplete(adapter);
          expect.fail(`should have thrown for unimplemented: ${missing.join(', ')}`);
        } catch (e) {
          expect(e).toBeInstanceOf(IncompleteContractError);
          const err = e as IncompleteContractError;
          // Set equality: no extra name, none dropped.
          expect(new Set(err.missing)).toEqual(new Set(missing));
          // Never truncated, and always in RUNTIME_HOST_CAPABILITIES order.
          expect(err.missing).toEqual(inContractOrder(missing));
          for (const capability of err.missing) {
            expect(err.message).toContain(capability);
          }
        }
      }),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 7.3**
   *
   * What the operator reads: the message line, then one capability name per line,
   * then a non-zero exit with no host handed back - so `main()` never reaches
   * `http.createServer(...).listen(...)` and the NLB target never goes healthy.
   */
  it('writes each unimplemented capability on its own line, then exits non-zero', () => {
    fc.assert(
      fc.property(arbMissingNonEmpty, arbNullishModes, (missing, modes) => {
        const recorder = createStartupRecorder();
        const expected = inContractOrder(missing);

        let thrown: unknown;
        try {
          startHost(fakeEnv(), {
            factories: factoriesFailingContract(missing, (c) => modes[c]),
            stderr: recorder.stderr,
            exit: (code) => recorder.exit(code),
          });
        } catch (e) {
          thrown = e;
        }

        // No ComposedHost escapes, so no listener is ever created.
        expect(thrown).toBeInstanceOf(IncompleteContractError);

        const lines = recorder.lines();
        expect(lines[0]).toContain('AWS_Host startup failed');
        // One name per line, in contract order, and nothing else on those lines.
        expect(lines.slice(1)).toEqual(expected);

        // The report is complete before the process ends.
        expect(recorder.events[recorder.events.length - 1]?.kind).toBe('exit');
        expect(recorder.exitCodes()).toEqual([EXIT_INCOMPLETE_CONTRACT]);
        expect(recorder.exitCodes()[0]).not.toBe(0);
      }),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 7.3**
   *
   * The subset space is only 1024 wide, so enumerate it exhaustively alongside
   * the property. Each pass leaves the subset unimplemented one way.
   */
  it.each(NULLISH_MODES)(
    'reports exactly the unimplemented subset for all 1024 subsets (%s)',
    (mode) => {
      for (const missing of allCapabilitySubsets()) {
        const adapter = adapterLeaving(missing, () => mode);
        if (missing.length === 0) {
          expect(() => assertContractComplete(adapter)).not.toThrow();
          continue;
        }
        try {
          assertContractComplete(adapter);
          expect.fail(`should have thrown for unimplemented: ${missing.join(', ')}`);
        } catch (e) {
          expect(e).toBeInstanceOf(IncompleteContractError);
          expect((e as IncompleteContractError).missing).toEqual(inContractOrder(missing));
        }
      }
    },
  );
});

// ---------------------------------------------------------------------------
// The empty subset: real composition, no AWS credentials
// ---------------------------------------------------------------------------

describe('server/startup - composition satisfies the contract', () => {
  /**
   * **Validates: Requirements 7.3**
   *
   * The production composition leaves nothing unimplemented, so startup reports
   * nothing, exits never, and hands back a host.
   */
  it('composes a complete ten-capability adapter from fake clients', () => {
    const host = composeHostAdapter(fakeEnv(), { factories: fakeFactories() });

    expect(Object.keys(host.capabilities).sort()).toEqual([...RUNTIME_HOST_CAPABILITIES].sort());
    for (const capability of RUNTIME_HOST_CAPABILITIES) {
      expect(host.capabilities[capability]).not.toBeNull();
      expect(host.capabilities[capability]).not.toBeUndefined();
    }
    expect(() => assertContractComplete(host.capabilities)).not.toThrow();
  });

  it('startHost writes nothing and exits never when the contract is complete', () => {
    const recorder = createStartupRecorder();

    const host = startHost(fakeEnv(), {
      factories: fakeFactories(),
      stderr: recorder.stderr,
      exit: (code) => recorder.exit(code),
    });

    expect(host.capabilities).toBeDefined();
    expect(recorder.events).toEqual([]);
  });

  it('rethrows a non-contract composition failure without reporting or exiting', () => {
    const recorder = createStartupRecorder();
    const boom = new Error('client construction failed');

    expect(() =>
      startHost(fakeEnv(), {
        factories: {
          ...fakeFactories(),
          createMetricPublisher: () => {
            throw boom;
          },
        },
        stderr: recorder.stderr,
        exit: (code) => recorder.exit(code),
      }),
    ).toThrow(boom);

    // Not a contract gap, so it must not be dressed up as one.
    expect(recorder.events).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// reportIncompleteContract examples
// ---------------------------------------------------------------------------

describe('server/startup - reportIncompleteContract', () => {
  it('writes the message line, then one capability per line', () => {
    const recorder = createStartupRecorder();

    reportIncompleteContract(new IncompleteContractError(['journal', 'lease']), recorder.stderr);

    expect(recorder.lines()).toEqual([
      'AWS_Host startup failed: unimplemented capabilities: journal, lease',
      'journal',
      'lease',
    ]);
  });

  it('ends every write with a newline, so no two names share a line', () => {
    const recorder = createStartupRecorder();

    reportIncompleteContract(
      new IncompleteContractError([...RUNTIME_HOST_CAPABILITIES]),
      recorder.stderr,
    );

    for (const event of recorder.events) {
      expect(event.kind).toBe('write');
      expect((event as { chunk: string }).chunk.endsWith('\n')).toBe(true);
    }
    expect(recorder.lines()).toHaveLength(RUNTIME_HOST_CAPABILITIES.length + 1);
  });
});
