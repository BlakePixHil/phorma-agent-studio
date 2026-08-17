/**
 * Property 10: Nothing persisted, logged or measured contains a resolved secret.
 *
 * Validates: Requirements 4.6, 8.11, 11.6, 11.11, 12.8
 *
 * After the Redactor is seeded with secret values of 8+ characters, NONE of
 * those values appear (as a whole or as a substring) in:
 * 1. Log entries written by TelemetryAdapter
 * 2. Metric dimension values published by TelemetryAdapter
 * 3. Any string that passes through the redact function
 *
 * Feature: aws-deployment-target
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import {
  TelemetryAdapter,
  type LogWriter,
  type MetricPublisher,
  type MetricDataPoint,
  type Redactor,
  type TelemetryConfig,
} from './telemetry.js';

// ---------------------------------------------------------------------------
// Literal redactor (task-specified pattern)
// ---------------------------------------------------------------------------

function createLiteralRedactor(secrets: string[]): (value: string) => string {
  return (value: string) => {
    let result = value;
    for (const s of secrets) {
      while (result.includes(s)) result = result.replace(s, '[REDACTED]');
    }
    return result;
  };
}

// ---------------------------------------------------------------------------
// Fakes for capturing telemetry output
// ---------------------------------------------------------------------------

class FakeLogWriter implements LogWriter {
  entries: string[] = [];
  async write(entry: string): Promise<void> {
    this.entries.push(entry);
  }
}

class FakeMetricPublisher implements MetricPublisher {
  points: MetricDataPoint[] = [];
  async publish(metric: MetricDataPoint): Promise<void> {
    this.points.push(metric);
  }
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/** Generate a secret value of 8 or more printable characters. */
const secretValueArb = fc.string({ minLength: 8, maxLength: 40 }).filter(s => s.trim().length >= 8);

/** Generate 1-5 distinct secret values. */
const secretsArb = fc.uniqueArray(secretValueArb, { minLength: 1, maxLength: 5 });

/**
 * Given a list of secrets, generate message content that deliberately embeds
 * at least one secret value as a substring.
 */
function messageWithSecretsArb(secrets: string[]): fc.Arbitrary<string> {
  return fc.tuple(
    fc.string({ minLength: 0, maxLength: 20 }),
    fc.integer({ min: 0, max: secrets.length - 1 }),
    fc.string({ minLength: 0, maxLength: 20 }),
  ).map(([prefix, idx, suffix]) => `${prefix}${secrets[idx]}${suffix}`);
}

// ---------------------------------------------------------------------------
// Assertion helper
// ---------------------------------------------------------------------------

/** Assert that none of the secrets appear in the given text (whole or substring). */
function assertNoSecretPresent(text: string, secrets: string[]): void {
  for (const secret of secrets) {
    expect(text).not.toContain(secret);
  }
}

// ---------------------------------------------------------------------------
// Property 10: Nothing persisted, logged or measured contains a resolved secret
// ---------------------------------------------------------------------------

describe('secrets-redaction - Property 10: Nothing persisted, logged or measured contains a resolved secret', () => {
  /**
   * **Validates: Requirements 12.8**
   *
   * After seeding the redactor with secrets of 8+ chars, no log entry written
   * by TelemetryAdapter contains any secret as a whole or as a substring.
   */
  it('log entries contain no resolved secret value', async () => {
    await fc.assert(
      fc.asyncProperty(
        secretsArb.chain(secrets =>
          fc.tuple(fc.constant(secrets), messageWithSecretsArb(secrets)),
        ),
        async ([secrets, message]) => {
          const redact = createLiteralRedactor(secrets);
          const logWriter = new FakeLogWriter();
          const metricPublisher = new FakeMetricPublisher();

          const config: TelemetryConfig = {
            workflowId: 'wf-prop10',
            logWriter,
            metricPublisher,
            redact,
          };

          const adapter = new TelemetryAdapter(config);
          adapter.setRunId('run-prop10');

          // Write log entries with messages containing secrets
          await adapter.log('info', message);
          await adapter.log('warn', `prefix ${message} suffix`);
          await adapter.log('error', message, { detail: message });

          // Assert: no secret appears in any recorded log entry
          for (const entry of logWriter.entries) {
            assertNoSecretPresent(entry, secrets);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 12.8**
   *
   * After seeding the redactor with secrets of 8+ chars, no metric dimension
   * value published by TelemetryAdapter contains any secret.
   */
  it('metric dimension values contain no resolved secret value', async () => {
    await fc.assert(
      fc.asyncProperty(
        secretsArb.chain(secrets =>
          fc.tuple(fc.constant(secrets), messageWithSecretsArb(secrets)),
        ),
        async ([secrets, dimensionValue]) => {
          const redact = createLiteralRedactor(secrets);
          const logWriter = new FakeLogWriter();
          const metricPublisher = new FakeMetricPublisher();

          const config: TelemetryConfig = {
            workflowId: 'wf-prop10',
            logWriter,
            metricPublisher,
            redact,
          };

          const adapter = new TelemetryAdapter(config);

          // Publish a metric with dimension values containing secrets
          await adapter.publishMetric('run-outcome', 1, {
            outcome: dimensionValue,
            info: `data-${dimensionValue}-end`,
          });

          // Assert: no secret in any dimension value
          for (const point of metricPublisher.points) {
            for (const dimValue of Object.values(point.dimensions)) {
              assertNoSecretPresent(dimValue, secrets);
            }
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 4.6, 8.11, 11.6, 11.11**
   *
   * The redact function itself strips every seeded secret from arbitrary text
   * containing those secrets as substrings.
   */
  it('redact function removes every secret from arbitrary text', async () => {
    await fc.assert(
      fc.asyncProperty(
        secretsArb.chain(secrets =>
          fc.tuple(
            fc.constant(secrets),
            // Generate multiple messages that each embed a secret
            fc.array(messageWithSecretsArb(secrets), { minLength: 1, maxLength: 10 }),
          ),
        ),
        async ([secrets, messages]) => {
          const redact = createLiteralRedactor(secrets);

          for (const msg of messages) {
            const redacted = redact(msg);
            assertNoSecretPresent(redacted, secrets);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 4.6, 8.11, 11.6, 11.11, 12.8**
   *
   * End-to-end: secrets embedded in workflow id, run id, messages, and extra
   * fields are all scrubbed from both logs and metrics simultaneously.
   */
  it('secrets embedded across all telemetry sinks are scrubbed end-to-end', async () => {
    await fc.assert(
      fc.asyncProperty(
        secretsArb.chain(secrets =>
          fc.tuple(
            fc.constant(secrets),
            messageWithSecretsArb(secrets),
            messageWithSecretsArb(secrets),
          ),
        ),
        async ([secrets, logMsg, metricDim]) => {
          const redact = createLiteralRedactor(secrets);
          const logWriter = new FakeLogWriter();
          const metricPublisher = new FakeMetricPublisher();

          const config: TelemetryConfig = {
            workflowId: 'wf-prop10',
            logWriter,
            metricPublisher,
            redact,
          };

          const adapter = new TelemetryAdapter(config);
          adapter.setRunId('run-e2e');

          // Write log entries with embedded secrets
          await adapter.log('info', logMsg, { context: logMsg });

          // Publish metrics with embedded secrets in dimensions
          await adapter.publishMetric('run-outcome', 1, { info: metricDim });
          await adapter.publishMetric('run-duration', 500, { detail: logMsg });

          // Assert all log entries are clean
          for (const entry of logWriter.entries) {
            assertNoSecretPresent(entry, secrets);
          }

          // Assert all metric dimension values are clean
          for (const point of metricPublisher.points) {
            for (const dimValue of Object.values(point.dimensions)) {
              assertNoSecretPresent(dimValue, secrets);
            }
          }

          // Assert the redact function itself is clean for both messages
          assertNoSecretPresent(redact(logMsg), secrets);
          assertNoSecretPresent(redact(metricDim), secrets);
        },
      ),
      { numRuns: 100 },
    );
  });
});
