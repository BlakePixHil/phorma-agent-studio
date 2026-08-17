/**
 * The production `MetricPublisher`: CloudWatch `PutMetricData` into the
 * configured namespace.
 *
 * Thin translation only. One `MetricDataPoint` from `./telemetry.js` becomes one
 * `MetricDatum` and one `PutMetricData` call. The publisher holds no retry
 * policy and no failure policy: `TelemetryAdapter.publishMetric` owns the three
 * attempt budget from `core/retry.ts` and owns the decision to continue the run
 * and log the metric name when the attempts are exhausted (Req 12.10). A retry
 * here would multiply that budget silently.
 *
 * No client is constructed at module load. The Check_Pipeline runs with no AWS
 * credentials present, so credential resolution happens inside
 * `createMetricPublisher`, which the Server_Entry calls after `readServerEnv`
 * succeeds.
 *
 * Two translations are not identity, and both are deliberate:
 *
 * - The metric name. `MetricName` is kebab-case because it is a Phorma domain
 *   name; a CloudWatch metric name is PascalCase by convention, and
 *   `ObservabilityConstruct` already declares its two alarms against
 *   `LeaseTakeover` and `FailedScheduledRun`. `CLOUDWATCH_METRIC_NAMES` is an
 *   exhaustive `Record<MetricName, string>`, so adding a metric name to
 *   `telemetry.ts` fails the type-check here until it is mapped, and the
 *   `lease-takeover` alarm resolves against the metric this publisher writes.
 * - The unit. `run-duration` carries milliseconds; every other data point is a
 *   count. CloudWatch stores the unit alongside the value, so getting it wrong
 *   makes a dashboard lie.
 *
 * Feature: aws-byo-deploy
 * Requirements: 8.1, 8.2, 8.3
 */

import { CloudWatchClient, PutMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import type { MetricDatum } from '@aws-sdk/client-cloudwatch';

import type { MetricPublisher } from './ports.js';
import type { MetricDataPoint, MetricName } from './telemetry.js';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface MetricPublisherOptions {
  /** The region the estate lives in - `AWS_REGION` on the task definition. */
  region: string;
  /**
   * The metric namespace - `PHORMA_METRIC_NAMESPACE` on the task definition,
   * which `ObservabilityConstruct` sets to `Phorma/{namePrefix}`. The
   * Runtime_Identity's `PutMetricData` grant is conditioned on exactly this
   * namespace, so a mismatch is an access denial rather than a silent write.
   */
  namespace: string;
}

// ---------------------------------------------------------------------------
// Name and unit maps
// ---------------------------------------------------------------------------

/**
 * The CloudWatch metric name for each Phorma metric name. Exhaustive by type,
 * so a new `MetricName` cannot reach CloudWatch unnamed.
 */
export const CLOUDWATCH_METRIC_NAMES: Readonly<Record<MetricName, string>> = Object.freeze({
  'run-outcome': 'RunOutcome',
  'run-duration': 'RunDuration',
  'node-retry-count': 'NodeRetryCount',
  'lease-takeover': 'LeaseTakeover',
  'skipped-scheduled-run': 'SkippedScheduledRun',
  'dropped-audit-write': 'DroppedAuditWrite',
});

/** The CloudWatch unit for each Phorma metric name. */
export const CLOUDWATCH_METRIC_UNITS: Readonly<Record<MetricName, 'Count' | 'Milliseconds'>> =
  Object.freeze({
    'run-outcome': 'Count',
    'run-duration': 'Milliseconds',
    'node-retry-count': 'Count',
    'lease-takeover': 'Count',
    'skipped-scheduled-run': 'Count',
    'dropped-audit-write': 'Count',
  });

// ---------------------------------------------------------------------------
// Translation
// ---------------------------------------------------------------------------

/**
 * Translate one `MetricDataPoint` into one `MetricDatum`.
 *
 * Two shapes CloudWatch rejects are handled here rather than at the call site:
 *
 * - A dimension carrying an empty value. `PutMetricData` requires 1 to 255
 *   characters, so an empty value fails the whole call and loses every datum in
 *   it. Such a dimension carries no information, so it is dropped.
 * - An unparseable timestamp. Omitting `Timestamp` makes CloudWatch stamp the
 *   datum at receipt time, which keeps the data point inside the 60 second
 *   window Req 12.2 asks for instead of discarding it.
 */
export function toMetricDatum(metric: MetricDataPoint): MetricDatum {
  const dimensions = Object.entries(metric.dimensions)
    .filter(([, value]) => value.length > 0)
    .map(([Name, Value]) => ({ Name, Value }));

  const at = new Date(metric.timestamp);
  const stampable = !Number.isNaN(at.getTime());

  return {
    MetricName: CLOUDWATCH_METRIC_NAMES[metric.name],
    Value: metric.value,
    Unit: CLOUDWATCH_METRIC_UNITS[metric.name],
    ...(dimensions.length > 0 ? { Dimensions: dimensions } : {}),
    ...(stampable ? { Timestamp: at } : {}),
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build the production `MetricPublisher` for one namespace.
 *
 * Credentials come from the default provider chain, which resolves the
 * Runtime_Identity task role on Fargate. Calling this function is the first
 * point at which a client exists.
 */
export function createMetricPublisher(options: MetricPublisherOptions): MetricPublisher {
  const { region, namespace } = options;
  const client = new CloudWatchClient({ region });

  return {
    publish: async (metric) => {
      await client.send(
        new PutMetricDataCommand({
          Namespace: namespace,
          MetricData: [toMetricDatum(metric)],
        }),
      );
    },
  };
}
