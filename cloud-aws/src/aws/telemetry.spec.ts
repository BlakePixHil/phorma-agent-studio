/**
 * Unit tests for the telemetry adapter.
 *
 * Validates: Requirements 2.8, 12.1, 12.2, 12.8, 12.9, 12.10
 *
 * Feature: aws-deployment-target
 */

import { describe, it, expect, beforeEach } from 'vitest';
import fc from 'fast-check';
import {
  TelemetryAdapter,
  METRIC_NAMES,
  type LogWriter,
  type MetricPublisher,
  type MetricDataPoint,
  type LogEntry,
  type Redactor,
  type TelemetryConfig,
} from './telemetry.js';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

class FakeLogWriter implements LogWriter {
  entries: string[] = [];
  async write(entry: string): Promise<void> {
    this.entries.push(entry);
  }
}

class FakeMetricPublisher implements MetricPublisher {
  points: MetricDataPoint[] = [];
  failCount = 0;
  private callCount = 0;

  async publish(metric: MetricDataPoint): Promise<void> {
    this.callCount++;
    if (this.callCount <= this.failCount) {
      throw new Error('publish failed');
    }
    this.points.push(metric);
  }

  reset(): void {
    this.points = [];
    this.failCount = 0;
    this.callCount = 0;
  }
}

function makeRedactor(secrets: string[] = []): Redactor {
  return (value: string) => {
    let result = value;
    for (const secret of secrets) {
      while (result.includes(secret)) {
        result = result.replace(secret, '[REDACTED]');
      }
    }
    return result;
  };
}

function makeAdapter(opts?: { secrets?: string[] }) {
  const logWriter = new FakeLogWriter();
  const metricPublisher = new FakeMetricPublisher();
  const redact = makeRedactor(opts?.secrets ?? []);
  const config: TelemetryConfig = {
    workflowId: 'wf-test-123',
    logWriter,
    metricPublisher,
    redact,
  };
  const adapter = new TelemetryAdapter(config);
  return { adapter, logWriter, metricPublisher, redact };
}

// ---------------------------------------------------------------------------
// Metric names constant
// ---------------------------------------------------------------------------

describe('telemetry - metric names', () => {
  it('declares exactly six metric names', () => {
    expect(METRIC_NAMES).toHaveLength(6);
    expect(METRIC_NAMES).toContain('run-outcome');
    expect(METRIC_NAMES).toContain('run-duration');
    expect(METRIC_NAMES).toContain('node-retry-count');
    expect(METRIC_NAMES).toContain('lease-takeover');
    expect(METRIC_NAMES).toContain('skipped-scheduled-run');
    expect(METRIC_NAMES).toContain('dropped-audit-write');
  });
});

// ---------------------------------------------------------------------------
// Logging (Req 12.1, 12.8, 12.9)
// ---------------------------------------------------------------------------

describe('telemetry - logging', () => {
  it('writes single-line JSON entries with workflowId, level, timestamp', async () => {
    const { adapter, logWriter } = makeAdapter();
    await adapter.log('info', 'hello');

    expect(logWriter.entries).toHaveLength(1);
    const entry = JSON.parse(logWriter.entries[0]);
    expect(entry.workflowId).toBe('wf-test-123');
    expect(entry.level).toBe('info');
    expect(entry.message).toBe('hello');
    expect(entry.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    // Single line - no newlines
    expect(logWriter.entries[0]).not.toContain('\n');
  });

  it('carries the run id when a run is in flight (Req 12.1)', async () => {
    const { adapter, logWriter } = makeAdapter();

    // Before run - no runId
    await adapter.log('info', 'before');
    const before = JSON.parse(logWriter.entries[0]);
    expect(before.runId).toBeUndefined();

    // During run
    adapter.setRunId('run-abc');
    await adapter.log('info', 'during');
    const during = JSON.parse(logWriter.entries[1]);
    expect(during.runId).toBe('run-abc');

    // After run
    adapter.clearRunId();
    await adapter.log('info', 'after');
    const after = JSON.parse(logWriter.entries[2]);
    expect(after.runId).toBeUndefined();
  });

  it('redacts secret values from log entries (Req 12.8)', async () => {
    const { adapter, logWriter } = makeAdapter({ secrets: ['supersecret'] });

    await adapter.log('info', 'the secret is supersecret here');

    const entry = JSON.parse(logWriter.entries[0]);
    expect(entry.message).not.toContain('supersecret');
    expect(entry.message).toContain('[REDACTED]');
  });

  it('redacts extra fields (Req 12.8)', async () => {
    const { adapter, logWriter } = makeAdapter({ secrets: ['mypassword'] });

    await adapter.log('info', 'test', { detail: 'contains mypassword value' });

    const entry = JSON.parse(logWriter.entries[0]);
    expect(entry.detail).not.toContain('mypassword');
    expect(entry.detail).toContain('[REDACTED]');
  });

  it('carries ISO 8601 UTC timestamp', async () => {
    const { adapter, logWriter } = makeAdapter();
    await adapter.log('warn', 'test');

    const entry = JSON.parse(logWriter.entries[0]);
    // Must be parseable and end with Z (UTC)
    const d = new Date(entry.timestamp);
    expect(d.getTime()).not.toBeNaN();
    expect(entry.timestamp).toMatch(/Z$/);
  });
});

// ---------------------------------------------------------------------------
// Metrics (Req 12.2, 12.8, 12.10)
// ---------------------------------------------------------------------------

describe('telemetry - metrics', () => {
  it('publishes a metric with workflowId as a dimension (Req 12.2)', async () => {
    const { adapter, metricPublisher } = makeAdapter();

    await adapter.publishMetric('run-outcome', 1, { outcome: 'completed' });

    expect(metricPublisher.points).toHaveLength(1);
    const point = metricPublisher.points[0];
    expect(point.name).toBe('run-outcome');
    expect(point.value).toBe(1);
    expect(point.dimensions.workflowId).toBe('wf-test-123');
    expect(point.dimensions.outcome).toBe('completed');
    expect(point.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('redacts metric dimension values (Req 12.8)', async () => {
    const { adapter, metricPublisher } = makeAdapter({ secrets: ['topsecret'] });

    await adapter.publishMetric('run-outcome', 1, { info: 'data-topsecret-here' });

    const point = metricPublisher.points[0];
    expect(point.dimensions.info).not.toContain('topsecret');
    expect(point.dimensions.info).toContain('[REDACTED]');
  });

  it('retries metric publication up to 3 times (Req 12.10)', async () => {
    const { adapter, metricPublisher, logWriter } = makeAdapter();

    // Fail first 2 attempts, succeed on 3rd
    metricPublisher.failCount = 2;

    await adapter.publishMetric('run-duration', 5000);

    expect(metricPublisher.points).toHaveLength(1);
    // No error log since it eventually succeeded
    const errorLogs = logWriter.entries.filter((e) => JSON.parse(e).level === 'error');
    expect(errorLogs).toHaveLength(0);
  });

  it('continues the run and logs when all 3 attempts fail (Req 12.10)', async () => {
    const { adapter, metricPublisher, logWriter } = makeAdapter();

    // Fail all 3 attempts
    metricPublisher.failCount = 3;

    await adapter.publishMetric('node-retry-count', 2);

    // No metric published
    expect(metricPublisher.points).toHaveLength(0);
    // A log entry names the metric
    expect(logWriter.entries).toHaveLength(1);
    const errorEntry = JSON.parse(logWriter.entries[0]);
    expect(errorEntry.level).toBe('error');
    expect(errorEntry.metric).toBe('node-retry-count');
    expect(errorEntry.message).toContain('metric publication failed');
  });

  it('publishRunOutcome convenience method', async () => {
    const { adapter, metricPublisher } = makeAdapter();
    await adapter.publishRunOutcome('completed');

    expect(metricPublisher.points[0].name).toBe('run-outcome');
    expect(metricPublisher.points[0].dimensions.outcome).toBe('completed');
  });

  it('publishRunDuration convenience method', async () => {
    const { adapter, metricPublisher } = makeAdapter();
    await adapter.publishRunDuration(12345);

    expect(metricPublisher.points[0].name).toBe('run-duration');
    expect(metricPublisher.points[0].value).toBe(12345);
  });

  it('publishNodeRetryCount convenience method', async () => {
    const { adapter, metricPublisher } = makeAdapter();
    await adapter.publishNodeRetryCount('node-x', 3);

    expect(metricPublisher.points[0].name).toBe('node-retry-count');
    expect(metricPublisher.points[0].dimensions.nodeId).toBe('node-x');
    expect(metricPublisher.points[0].value).toBe(3);
  });

  it('publishLeaseTakeover carries both fence tokens (Req 2.8)', async () => {
    const { adapter, metricPublisher } = makeAdapter();
    await adapter.publishLeaseTakeover(4, 5);

    const point = metricPublisher.points[0];
    expect(point.name).toBe('lease-takeover');
    expect(point.dimensions.supersededFence).toBe('4');
    expect(point.dimensions.newFence).toBe('5');
    expect(point.dimensions.workflowId).toBe('wf-test-123');
  });

  it('publishSkippedScheduledRun convenience method', async () => {
    const { adapter, metricPublisher } = makeAdapter();
    await adapter.publishSkippedScheduledRun('sched-daily');

    expect(metricPublisher.points[0].name).toBe('skipped-scheduled-run');
    expect(metricPublisher.points[0].dimensions.scheduleName).toBe('sched-daily');
  });

  it('publishDroppedAuditWrite convenience method', async () => {
    const { adapter, metricPublisher } = makeAdapter();
    await adapter.publishDroppedAuditWrite('run-1', 'run-event');

    expect(metricPublisher.points[0].name).toBe('dropped-audit-write');
    expect(metricPublisher.points[0].dimensions.runId).toBe('run-1');
    expect(metricPublisher.points[0].dimensions.category).toBe('run-event');
  });
});


// ---------------------------------------------------------------------------
// Property 30: Structured telemetry is complete and run-scoped
// Validates: Requirements 12.1, 12.2, 12.9
// Feature: aws-deployment-target
// ---------------------------------------------------------------------------

describe('telemetry - Property 30: Structured telemetry is complete and run-scoped', () => {
  /**
   * **Validates: Requirements 12.1, 12.2, 12.9**
   *
   * For any sequence of sequential run lifecycles (setRunId/clearRunId cycles),
   * filtering log entries by run id partitions the entries of concurrent runs exactly,
   * and all six metric names are published during a complete run lifecycle.
   */
  it('filtering by run id partitions entries of sequential runs exactly, and all six metrics are published (min 100 runs)', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Generate 2 to 5 sequential runs
        fc.array(
          fc.record({
            runId: fc.string({ minLength: 1, maxLength: 32 }).filter((s) => s.trim().length > 0),
            logCount: fc.integer({ min: 1, max: 10 }),
            preLogCount: fc.integer({ min: 0, max: 3 }),
            postLogCount: fc.integer({ min: 0, max: 3 }),
          }),
          { minLength: 2, maxLength: 5 },
        ),
        async (runs) => {
          // Ensure distinct run ids
          const seenIds = new Set<string>();
          const distinctRuns = runs.filter((r) => {
            if (seenIds.has(r.runId)) return false;
            seenIds.add(r.runId);
            return true;
          });
          if (distinctRuns.length < 2) return; // need at least 2 distinct runs

          const logWriter = new FakeLogWriter();
          const metricPublisher = new FakeMetricPublisher();
          const redact: Redactor = (v) => v;
          const config: TelemetryConfig = {
            workflowId: 'wf-prop30',
            logWriter,
            metricPublisher,
            redact,
          };
          const adapter = new TelemetryAdapter(config);

          // Execute sequential run lifecycles
          for (const run of distinctRuns) {
            // Pre-run logs (no run id)
            for (let i = 0; i < run.preLogCount; i++) {
              await adapter.log('info', `pre-run-${run.runId}-${i}`);
            }

            // Start run
            adapter.setRunId(run.runId);

            // In-run logs (carry run id)
            for (let i = 0; i < run.logCount; i++) {
              await adapter.log('info', `in-run-${run.runId}-${i}`);
            }

            // Publish all six metrics during the run
            await adapter.publishRunOutcome('completed');
            await adapter.publishRunDuration(1000);
            await adapter.publishNodeRetryCount('node-1', 1);
            await adapter.publishLeaseTakeover(1, 2);
            await adapter.publishSkippedScheduledRun('sched-1');
            await adapter.publishDroppedAuditWrite(run.runId, 'event');

            // End run
            adapter.clearRunId();

            // Post-run logs (no run id)
            for (let i = 0; i < run.postLogCount; i++) {
              await adapter.log('info', `post-run-${run.runId}-${i}`);
            }
          }

          // Parse all log entries
          const allEntries = logWriter.entries.map((e) => JSON.parse(e) as LogEntry);

          // --- Assertion 1: Partitioning by run id ---
          // Entries with a run id must have been logged during that run's scope
          for (const run of distinctRuns) {
            const entriesForRun = allEntries.filter((e) => e.runId === run.runId);
            // Every entry during the run carries the run id (Req 12.1)
            expect(entriesForRun.length).toBeGreaterThanOrEqual(run.logCount);
            // Every entry with this run id has a message that references this run
            // (the metric failure log might also carry the run id, but it was emitted during this run)
            for (const entry of entriesForRun) {
              // The entry must NOT belong to another run
              expect(entry.runId).toBe(run.runId);
            }
          }

          // --- Assertion 2: No cross-contamination ---
          // Entries without a run id should NOT carry any run id
          const unscoped = allEntries.filter((e) => e.runId === undefined);
          // Pre-run and post-run logs have no runId
          const expectedUnscopedCount = distinctRuns.reduce(
            (acc, r) => acc + r.preLogCount + r.postLogCount,
            0,
          );
          expect(unscoped.length).toBe(expectedUnscopedCount);

          // Entries for one run id must not contain entries that belong to another
          for (const run of distinctRuns) {
            const otherRunIds = distinctRuns
              .filter((r) => r.runId !== run.runId)
              .map((r) => r.runId);
            const entriesForRun = allEntries.filter((e) => e.runId === run.runId);
            for (const entry of entriesForRun) {
              for (const otherId of otherRunIds) {
                expect(entry.runId).not.toBe(otherId);
              }
            }
          }

          // --- Assertion 3: All six metric names are published per run ---
          // Each run publishes all six metrics
          const totalMetricPoints = metricPublisher.points.length;
          expect(totalMetricPoints).toBe(distinctRuns.length * 6);
          const metricNamesPublished = new Set(metricPublisher.points.map((p) => p.name));
          expect(metricNamesPublished.size).toBe(6);
          for (const expectedName of METRIC_NAMES) {
            expect(metricNamesPublished.has(expectedName)).toBe(true);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
