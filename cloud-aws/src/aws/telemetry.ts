/**
 * Structured telemetry: logs and metrics for AWS_Host.
 *
 * The adapter holds decisions only: it accepts a `LogWriter` and a
 * `MetricPublisher` from `./ports.js` and imports no `@aws-sdk/*` package
 * itself. The Server_Entry wires the production writers -
 * `./stdout-log-writer.js` for logs and `./metric-publisher.js` for metrics -
 * and tests supply fakes against the same two ports (Req 8.2).
 *
 * Logs: single-line JSON entries carrying workflow id, level, ISO 8601 UTC
 * timestamp, and (while a run is in flight) the run id.
 *
 * Metrics: six named data points, each within 60 seconds of the event it
 * measures, carrying the workflow id as a dimension.
 *
 * Every log entry and metric dimension is routed through the same Redactor
 * instance that secrets.ts seeds, so no secret value can leak.
 *
 * When metric publication fails after 3 attempts, the run continues and a
 * log entry names the metric that could not be published (Req 12.10).
 *
 * Feature: aws-deployment-target, aws-byo-deploy
 * Requirements: 2.8, 8.2, 12.1, 12.2, 12.8, 12.9, 12.10
 */

import { RETRY_BUDGETS } from '../core/retry.js';
import type { LogWriter, MetricPublisher } from './ports.js';

// ---------------------------------------------------------------------------
// Injected transport interfaces
// ---------------------------------------------------------------------------

/**
 * `LogWriter` and `MetricPublisher` are declared once, in `./ports.js`. They are
 * re-exported here so existing importers keep resolving, while each port has a
 * single declaration site (Req 8.2).
 */
export type { LogWriter, MetricPublisher };

/**
 * Redactor function - strips secret values from strings.
 * Provided by the ConnectionStore seed step in secrets.ts.
 */
export type Redactor = (value: string) => string;

// ---------------------------------------------------------------------------
// Metric names - the six required data points (Req 12.2)
// ---------------------------------------------------------------------------

export type MetricName =
  | 'run-outcome'
  | 'run-duration'
  | 'node-retry-count'
  | 'lease-takeover'
  | 'skipped-scheduled-run'
  | 'dropped-audit-write';

export const METRIC_NAMES: readonly MetricName[] = Object.freeze([
  'run-outcome',
  'run-duration',
  'node-retry-count',
  'lease-takeover',
  'skipped-scheduled-run',
  'dropped-audit-write',
]);

// ---------------------------------------------------------------------------
// Data shapes
// ---------------------------------------------------------------------------

export type LogLevel = 'info' | 'warn' | 'error' | 'debug';

export interface LogEntry {
  workflowId: string;
  level: LogLevel;
  timestamp: string;
  runId?: string;
  message: string;
  [key: string]: unknown;
}

export interface MetricDataPoint {
  name: MetricName;
  value: number;
  dimensions: Record<string, string>;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface TelemetryConfig {
  workflowId: string;
  logWriter: LogWriter;
  metricPublisher: MetricPublisher;
  redact: Redactor;
}

// ---------------------------------------------------------------------------
// Telemetry adapter
// ---------------------------------------------------------------------------

/**
 * Telemetry adapter for a single workflow.
 *
 * Constructed once per runner lifecycle. Call `setRunId` when a run starts
 * and `clearRunId` when it settles, so log entries carry the run id only
 * while a run is in flight (Req 12.1).
 */
export class TelemetryAdapter {
  private readonly workflowId: string;
  private readonly logWriter: LogWriter;
  private readonly metricPublisher: MetricPublisher;
  private readonly redact: Redactor;
  private runId: string | undefined;

  constructor(config: TelemetryConfig) {
    this.workflowId = config.workflowId;
    this.logWriter = config.logWriter;
    this.metricPublisher = config.metricPublisher;
    this.redact = config.redact;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Run scope
  // ─────────────────────────────────────────────────────────────────────────

  /** Set the run id so subsequent log entries carry it (Req 12.1). */
  setRunId(runId: string): void {
    this.runId = runId;
  }

  /** Clear the run id after run settles. */
  clearRunId(): void {
    this.runId = undefined;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Logging (Req 12.1, 12.8, 12.9)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Write a structured log entry. The entry is a single-line JSON object
   * carrying workflow id, level, ISO 8601 UTC timestamp, and - when a run
   * is in flight - the run id. Every field value is routed through the
   * Redactor (Req 12.8).
   */
  async log(level: LogLevel, message: string, extra?: Record<string, unknown>): Promise<void> {
    const entry: LogEntry = {
      workflowId: this.workflowId,
      level,
      timestamp: new Date().toISOString(),
      message,
      ...extra,
    };

    if (this.runId) {
      entry.runId = this.runId;
    }

    // Route every string field through the Redactor (Req 12.8)
    const redacted = this.redactEntry(entry);
    const line = JSON.stringify(redacted);

    await this.logWriter.write(line);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Metrics (Req 12.2, 12.8, 12.10)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Publish a metric data point carrying the workflow id as a dimension.
   * Retries up to 3 attempts on failure. When all attempts fail, continues
   * the run and writes a log entry naming the metric (Req 12.10).
   */
  async publishMetric(
    name: MetricName,
    value: number,
    extraDimensions?: Record<string, string>,
  ): Promise<void> {
    const dimensions: Record<string, string> = {
      workflowId: this.workflowId,
      ...extraDimensions,
    };

    // Route every dimension value through the Redactor (Req 12.8)
    const redactedDimensions = this.redactDimensions(dimensions);

    const dataPoint: MetricDataPoint = {
      name,
      value,
      dimensions: redactedDimensions,
      timestamp: new Date().toISOString(),
    };

    const budget = RETRY_BUDGETS['metric'];
    const maxAttempts = budget?.maxAttempts ?? 3;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await this.metricPublisher.publish(dataPoint);
        return; // Success
      } catch {
        if (attempt === maxAttempts) {
          // All attempts exhausted - continue the run, log the failure (Req 12.10)
          await this.log('error', `metric publication failed after ${maxAttempts} attempts`, {
            metric: name,
            attempts: maxAttempts,
          });
          return;
        }
        // Retry on next iteration
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Convenience metric publishers for the six named metrics
  // ─────────────────────────────────────────────────────────────────────────

  /** Publish run outcome metric (Req 12.2). */
  async publishRunOutcome(outcome: string): Promise<void> {
    await this.publishMetric('run-outcome', 1, { outcome });
  }

  /** Publish run duration metric in milliseconds (Req 12.2). */
  async publishRunDuration(durationMs: number): Promise<void> {
    await this.publishMetric('run-duration', durationMs);
  }

  /** Publish node retry count metric (Req 12.2). */
  async publishNodeRetryCount(nodeId: string, retryCount: number): Promise<void> {
    await this.publishMetric('node-retry-count', retryCount, { nodeId });
  }

  /** Publish lease takeover metric (Req 2.8, 12.2). */
  async publishLeaseTakeover(supersededFence: number, newFence: number): Promise<void> {
    await this.publishMetric('lease-takeover', 1, {
      supersededFence: String(supersededFence),
      newFence: String(newFence),
    });
  }

  /** Publish skipped scheduled run metric (Req 12.2). */
  async publishSkippedScheduledRun(scheduleName?: string): Promise<void> {
    const extra: Record<string, string> = {};
    if (scheduleName) extra.scheduleName = scheduleName;
    await this.publishMetric('skipped-scheduled-run', 1, extra);
  }

  /** Publish dropped audit write metric (Req 12.2). */
  async publishDroppedAuditWrite(runId: string, category: string): Promise<void> {
    await this.publishMetric('dropped-audit-write', 1, { runId, category });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Redaction helpers (Req 12.8)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Route every string value in a log entry through the Redactor.
   */
  private redactEntry(entry: LogEntry): LogEntry {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(entry)) {
      if (typeof value === 'string') {
        result[key] = this.redact(value);
      } else {
        result[key] = value;
      }
    }
    return result as LogEntry;
  }

  /**
   * Route every dimension value through the Redactor.
   */
  private redactDimensions(dimensions: Record<string, string>): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(dimensions)) {
      result[key] = this.redact(value);
    }
    return result;
  }
}
