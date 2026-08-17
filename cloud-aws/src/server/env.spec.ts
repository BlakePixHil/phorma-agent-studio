/**
 * Property and unit tests for the Server_Entry environment contract.
 *
 * Property 15: Startup names every missing environment variable.
 * Validates: Requirements 7.9
 *
 * Feature: aws-byo-deploy, Property 15: Startup names every missing environment variable
 *
 * For any subset of REQUIRED_ENV_NAMES omitted, `readServerEnv` throws
 * `MissingEnvError` and the reported names equal that subset exactly - no extra
 * names and none dropped. Omission is generated three ways because all three are
 * real task-definition mistakes: the key absent entirely, the key present with
 * `''`, and the key present with whitespace only.
 *
 * The example tests below pin the behaviour `readServerEnv` layers on top of the
 * absence scan: `PORT` parsing and defaulting, `PHORMA_RUNNER_ID` defaulting, and
 * value trimming.
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  DEFAULT_PORT,
  InvalidEnvError,
  MissingEnvError,
  REQUIRED_ENV_NAMES,
  readServerEnv,
  type RequiredEnvName,
  type ServerEnv,
} from './env.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** How a required variable can be omitted. All three occur in real task definitions. */
type OmissionMode = 'absent' | 'empty' | 'whitespace';

const OMISSION_MODES: readonly OmissionMode[] = ['absent', 'empty', 'whitespace'];

/** Which resolved `ServerEnv` field each required name feeds. */
const FIELD_OF: Record<RequiredEnvName, keyof ServerEnv> = {
  AWS_REGION: 'region',
  PHORMA_RUN_TABLE: 'runTableName',
  PHORMA_MONITOR_ENDPOINT: 'monitorEndpoint',
  PHORMA_SECRET_PREFIX: 'secretPrefix',
  PHORMA_SCHEDULE_GROUP: 'scheduleGroup',
  PHORMA_METRIC_NAMESPACE: 'metricNamespace',
  PHORMA_SCHEDULE_TARGET_ARN: 'scheduleTargetArn',
  PHORMA_SCHEDULE_ROLE_ARN: 'scheduleRoleArn',
};

/**
 * Build an environment where every required name carries a usable value except
 * the omitted ones, each omitted the way `modeOf` says.
 */
function envWithOmissions(
  omitted: readonly RequiredEnvName[],
  modeOf: (name: RequiredEnvName) => OmissionMode,
  valueOf: (name: RequiredEnvName) => string = (name) => `value-for-${name}`,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const name of REQUIRED_ENV_NAMES) {
    if (!omitted.includes(name)) {
      env[name] = valueOf(name);
      continue;
    }
    switch (modeOf(name)) {
      case 'absent':
        break; // the key is simply not set
      case 'empty':
        env[name] = '';
        break;
      case 'whitespace':
        env[name] = '   ';
        break;
    }
  }
  return env;
}

/** Every subset of `REQUIRED_ENV_NAMES`, all 256 of them. */
function allSubsets(): RequiredEnvName[][] {
  const names = [...REQUIRED_ENV_NAMES];
  const subsets: RequiredEnvName[][] = [];
  for (let mask = 0; mask < 1 << names.length; mask += 1) {
    subsets.push(names.filter((_, i) => (mask & (1 << i)) !== 0));
  }
  return subsets;
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/** Any subset of the required names, including the empty set and the full set. */
const arbOmittedNames = fc.subarray([...REQUIRED_ENV_NAMES], {
  minLength: 0,
  maxLength: REQUIRED_ENV_NAMES.length,
});

/** One omission mode per required name, so a single case mixes all three. */
const arbModes = fc.record(
  Object.fromEntries(
    REQUIRED_ENV_NAMES.map((name) => [name, fc.constantFrom(...OMISSION_MODES)]),
  ),
) as fc.Arbitrary<Record<RequiredEnvName, OmissionMode>>;

/** A value that survives the blank check: non-blank once trimmed. */
const arbNonBlank = fc
  .string({ minLength: 1, maxLength: 24 })
  .filter((s) => s.trim().length > 0);

/** Insignificant padding the reader must strip. */
const arbPadding = fc.stringMatching(/^[ \t\r\n]{0,3}$/);

/** A raw value: non-blank content with arbitrary surrounding whitespace. */
const arbRawValue = fc
  .tuple(arbPadding, arbNonBlank, arbPadding)
  .map(([before, body, after]) => `${before}${body}${after}`);

/** A raw value per required name. */
const arbValues = fc.record(
  Object.fromEntries(REQUIRED_ENV_NAMES.map((name) => [name, arbRawValue])),
) as fc.Arbitrary<Record<RequiredEnvName, string>>;

// ---------------------------------------------------------------------------
// Property 15
// ---------------------------------------------------------------------------

describe('server/env - Property 15: Startup names every missing environment variable', () => {
  /**
   * **Validates: Requirements 7.9**
   *
   * For any omitted subset, the report equals that subset exactly. The empty
   * subset must resolve instead of throwing.
   */
  it('reports exactly the omitted subset, however each name is omitted', () => {
    fc.assert(
      fc.property(arbOmittedNames, arbModes, arbValues, (omitted, modes, values) => {
        const env = envWithOmissions(
          omitted,
          (name) => modes[name],
          (name) => values[name],
        );

        if (omitted.length === 0) {
          const resolved = readServerEnv(env);
          for (const name of REQUIRED_ENV_NAMES) {
            expect(resolved[FIELD_OF[name]]).toBe(values[name].trim());
          }
          expect(resolved.port).toBe(DEFAULT_PORT);
          expect(resolved.runnerId.length).toBeGreaterThan(0);
          return;
        }

        try {
          readServerEnv(env);
          expect.fail(`readServerEnv should have thrown for omitted: ${omitted.join(', ')}`);
        } catch (e) {
          expect(e).toBeInstanceOf(MissingEnvError);
          const err = e as MissingEnvError;
          // Set equality: no extra names, none dropped.
          expect(new Set(err.missing)).toEqual(new Set(omitted));
          // Never truncated, and always in REQUIRED_ENV_NAMES order.
          expect(err.missing).toEqual(REQUIRED_ENV_NAMES.filter((n) => omitted.includes(n)));
          // Every reported name appears in the operator-facing message.
          for (const name of err.missing) {
            expect(err.message).toContain(name);
          }
        }
      }),
      { numRuns: 200 },
    );
  });

  /**
   * **Validates: Requirements 7.9**
   *
   * The subset space is only 256 wide, so enumerate it exhaustively alongside the
   * property. Each pass uses a different omission mode.
   */
  it.each(OMISSION_MODES)('reports exactly the omitted subset for all 256 subsets (%s)', (mode) => {
    for (const omitted of allSubsets()) {
      const env = envWithOmissions(omitted, () => mode);
      if (omitted.length === 0) {
        expect(() => readServerEnv(env)).not.toThrow();
        continue;
      }
      try {
        readServerEnv(env);
        expect.fail(`readServerEnv should have thrown for omitted: ${omitted.join(', ')}`);
      } catch (e) {
        expect(e).toBeInstanceOf(MissingEnvError);
        expect((e as MissingEnvError).missing).toEqual(
          REQUIRED_ENV_NAMES.filter((n) => omitted.includes(n)),
        );
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Examples: PORT, PHORMA_RUNNER_ID, trimming
// ---------------------------------------------------------------------------

describe('server/env - readServerEnv examples', () => {
  /** A complete environment, so each example varies exactly one thing. */
  function completeEnv(
    extra: Record<string, string | undefined> = {},
  ): Record<string, string | undefined> {
    return { ...envWithOmissions([], () => 'absent'), ...extra };
  }

  it('defaults PORT when absent', () => {
    expect(readServerEnv(completeEnv()).port).toBe(DEFAULT_PORT);
  });

  it('defaults PORT when blank', () => {
    expect(readServerEnv(completeEnv({ PORT: '' })).port).toBe(DEFAULT_PORT);
    expect(readServerEnv(completeEnv({ PORT: '  \t ' })).port).toBe(DEFAULT_PORT);
  });

  it('parses a valid PORT, including its boundaries', () => {
    expect(readServerEnv(completeEnv({ PORT: '3000' })).port).toBe(3000);
    expect(readServerEnv(completeEnv({ PORT: ' 8080 ' })).port).toBe(8080);
    expect(readServerEnv(completeEnv({ PORT: '1' })).port).toBe(1);
    expect(readServerEnv(completeEnv({ PORT: '65535' })).port).toBe(65535);
  });

  it.each(['abc', '80.5', '8080x', '0', '65536', '-1'])(
    'throws InvalidEnvError for PORT=%s',
    (value) => {
      try {
        readServerEnv(completeEnv({ PORT: value }));
        expect.fail(`PORT="${value}" should have been rejected`);
      } catch (e) {
        expect(e).toBeInstanceOf(InvalidEnvError);
        const err = e as InvalidEnvError;
        expect(err.variable).toBe('PORT');
        expect(err.value).toBe(value);
      }
    },
  );

  it('reports the missing names when PORT is garbled AND required names are absent', () => {
    const env = envWithOmissions(['AWS_REGION', 'PHORMA_RUN_TABLE'], () => 'absent');
    env['PORT'] = 'not-a-port';

    try {
      readServerEnv(env);
      expect.fail('readServerEnv should have thrown');
    } catch (e) {
      // Absence is the larger problem, so it is reported first and in full.
      expect(e).toBeInstanceOf(MissingEnvError);
      expect((e as MissingEnvError).missing).toEqual(['AWS_REGION', 'PHORMA_RUN_TABLE']);
    }
  });

  it('generates a non-empty runner id when PHORMA_RUNNER_ID is absent', () => {
    const first = readServerEnv(completeEnv()).runnerId;
    const second = readServerEnv(completeEnv()).runnerId;
    expect(first.length).toBeGreaterThan(0);
    // The id is a lease holder identity, so two tasks must not share one.
    expect(first).not.toBe(second);
  });

  it('uses PHORMA_RUNNER_ID verbatim when present, and defaults when blank', () => {
    expect(readServerEnv(completeEnv({ PHORMA_RUNNER_ID: 'runner-7' })).runnerId).toBe('runner-7');
    expect(readServerEnv(completeEnv({ PHORMA_RUNNER_ID: '   ' })).runnerId.length).toBeGreaterThan(
      0,
    );
    expect(readServerEnv(completeEnv({ PHORMA_RUNNER_ID: '   ' })).runnerId).not.toBe('   ');
  });

  it('trims accepted values', () => {
    const resolved = readServerEnv(
      completeEnv({
        AWS_REGION: '  eu-west-1\n',
        PHORMA_RUN_TABLE: '\tphorma-runs ',
        PHORMA_RUNNER_ID: ' runner-9 ',
      }),
    );
    expect(resolved.region).toBe('eu-west-1');
    expect(resolved.runTableName).toBe('phorma-runs');
    expect(resolved.runnerId).toBe('runner-9');
  });
});
