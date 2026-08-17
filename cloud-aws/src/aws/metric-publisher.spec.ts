/**
 * Unit tests for the production `MetricPublisher`.
 *
 * The Check_Pipeline runs with no AWS credentials present and this file is part
 * of it, so the factory assertions double as the credential-free construction
 * check: importing the module builds no client, and calling the factory resolves
 * no credentials and reaches no network.
 *
 * The translation is covered directly through `toMetricDatum`, which is where
 * every non-identity decision lives.
 *
 * Feature: aws-byo-deploy
 * Requirements: 8.1, 8.2, 8.3
 */

import { describe, expect, it } from 'vitest';

import {
  CLOUDWATCH_METRIC_NAMES,
  CLOUDWATCH_METRIC_UNITS,
  createMetricPublisher,
  toMetricDatum,
} from './metric-publisher.js';
import { METRIC_NAMES, type MetricDataPoint, type MetricName } from './telemetry.js';

function point(overrides: Partial<MetricDataPoint> = {}): MetricDataPoint {
  return {
    name: 'run-outcome',
    value: 1,
    dimensions: { workflowId: 'wf-1' },
    timestamp: '2026-08-15T10:20:30.400Z',
    ...overrides,
  };
}

describe('metric name and unit maps', () => {
  it('names every metric, with no entry for anything else', () => {
    expect(Object.keys(CLOUDWATCH_METRIC_NAMES).sort()).toEqual([...METRIC_NAMES].sort());
    expect(Object.keys(CLOUDWATCH_METRIC_UNITS).sort()).toEqual([...METRIC_NAMES].sort());
  });

  it('uses PascalCase CloudWatch names derived from the kebab-case metric names', () => {
    for (const name of METRIC_NAMES) {
      const expected = name
        .split('-')
        .map((part) => part[0].toUpperCase() + part.slice(1))
        .join('');
      expect(CLOUDWATCH_METRIC_NAMES[name]).toBe(expected);
    }
  });

  it('matches the LeaseTakeover alarm ObservabilityConstruct declares', () => {
    expect(CLOUDWATCH_METRIC_NAMES['lease-takeover']).toBe('LeaseTakeover');
  });

  it('counts every metric except run duration, which is milliseconds', () => {
    expect(CLOUDWATCH_METRIC_UNITS['run-duration']).toBe('Milliseconds');
    for (const name of METRIC_NAMES.filter((n) => n !== 'run-duration')) {
      expect(CLOUDWATCH_METRIC_UNITS[name]).toBe('Count');
    }
  });
});

describe('toMetricDatum', () => {
  it('carries the name, value, unit, dimensions and timestamp', () => {
    const datum = toMetricDatum(
      point({
        name: 'run-duration',
        value: 12_345,
        dimensions: { workflowId: 'wf-1', outcome: 'completed' },
      }),
    );

    expect(datum.MetricName).toBe('RunDuration');
    expect(datum.Value).toBe(12_345);
    expect(datum.Unit).toBe('Milliseconds');
    expect(datum.Dimensions).toEqual([
      { Name: 'workflowId', Value: 'wf-1' },
      { Name: 'outcome', Value: 'completed' },
    ]);
    expect(datum.Timestamp?.toISOString()).toBe('2026-08-15T10:20:30.400Z');
  });

  it('drops a dimension carrying an empty value, which PutMetricData rejects', () => {
    const datum = toMetricDatum(point({ dimensions: { workflowId: 'wf-1', nodeId: '' } }));

    expect(datum.Dimensions).toEqual([{ Name: 'workflowId', Value: 'wf-1' }]);
  });

  it('omits Dimensions entirely when nothing survives', () => {
    const datum = toMetricDatum(point({ dimensions: { nodeId: '' } }));

    expect(datum.Dimensions).toBeUndefined();
  });

  it('omits an unparseable timestamp rather than sending a bad date', () => {
    const datum = toMetricDatum(point({ timestamp: 'not-a-date' }));

    expect(datum.Timestamp).toBeUndefined();
    expect(datum.MetricName).toBe('RunOutcome');
  });

  it('translates every metric name without throwing', () => {
    for (const name of METRIC_NAMES) {
      const datum = toMetricDatum(point({ name: name as MetricName, value: 0 }));
      expect(datum.MetricName).toBe(CLOUDWATCH_METRIC_NAMES[name]);
      expect(datum.Value).toBe(0);
    }
  });
});

describe('createMetricPublisher', () => {
  it('exposes exactly the MetricPublisher operation', () => {
    const publisher = createMetricPublisher({ region: 'eu-west-1', namespace: 'Phorma/test' });

    expect(typeof publisher.publish).toBe('function');
    expect(Object.keys(publisher)).toEqual(['publish']);
  });

  it('builds an independent publisher per call', () => {
    const first = createMetricPublisher({ region: 'eu-west-1', namespace: 'Phorma/test' });
    const second = createMetricPublisher({ region: 'us-east-1', namespace: 'Phorma/test' });

    expect(second).not.toBe(first);
    expect(second.publish).not.toBe(first.publish);
  });
});
