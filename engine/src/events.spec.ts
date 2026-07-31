import { describe, expect, it } from 'vitest';
import type { RunEvent, RunEventType } from './events.js';
import type { SyncSummary } from './run-record.js';

/**
 * Contract tests for the eleven data-path run events (requirements 14.1-14.3).
 *
 * The samples below are typed as `RunEvent`, so the union itself is checked at
 * compile time: a renamed field or a dropped variant fails the type check before
 * these assertions ever run.
 */

const EMPTY_SUMMARY: SyncSummary = {
  sources: {},
  considered: 0,
  changed: 0,
  written: 0,
  skipped: 0,
  failed: 0,
  targetStatuses: {},
};

/** One instance of every event type added by the deterministic data path. */
const DATA_PATH_EVENTS: RunEvent[] = [
  { type: 'http-request', runId: 'run-1', nodeId: 'n1', nodeName: 'Fetch', method: 'GET', url: 'https://api.example.com/v1/items', attempt: 1, at: 1 },
  { type: 'http-response', runId: 'run-1', nodeId: 'n1', status: 200, durationMs: 12, byteCount: 2048, at: 2 },
  { type: 'page-fetched', runId: 'run-1', nodeId: 'n1', page: 1, items: 50, hasMore: true, at: 3 },
  { type: 'sql-query', runId: 'run-1', nodeId: 'n2', nodeName: 'Query', driver: 'postgres', statement: 'select 1 where id = :id', paramCount: 1, at: 4 },
  { type: 'sql-result', runId: 'run-1', nodeId: 'n2', rowCount: 7, durationMs: 3, at: 5 },
  { type: 'state-read', runId: 'run-1', nodeId: 'n3', key: 'wf:w1:cursor', found: false, at: 6 },
  { type: 'state-written', runId: 'run-1', nodeId: 'n3', key: 'wf:w1:cursor', semantics: 'watermark', changed: true, at: 7 },
  { type: 'assert-passed', runId: 'run-1', nodeId: 'n4', nodeName: 'Guard', checked: 3, at: 8 },
  { type: 'assert-breached', runId: 'run-1', nodeId: 'n4', nodeName: 'Guard', assertion: 'rowCount > 0', message: 'No rows.', severity: 'error', routed: false, at: 9 },
  { type: 'notify-sent', runId: 'run-1', nodeId: 'n5', channel: 'email', target: 'o***@example.com', at: 10 },
  { type: 'sync-summary', runId: 'run-1', summary: EMPTY_SUMMARY, at: 11 },
];

const DATA_PATH_EVENT_TYPES: readonly RunEventType[] = [
  'http-request',
  'http-response',
  'page-fetched',
  'sql-query',
  'sql-result',
  'state-read',
  'state-written',
  'assert-passed',
  'assert-breached',
  'notify-sent',
  'sync-summary',
];

describe('data-path run events', () => {
  it('defines all eleven event types (14.1)', () => {
    expect(DATA_PATH_EVENT_TYPES).toHaveLength(11);
    expect(DATA_PATH_EVENTS.map((event) => event.type)).toEqual(DATA_PATH_EVENT_TYPES);
  });

  it('carries the run id and the emission timestamp on every type (14.1)', () => {
    for (const event of DATA_PATH_EVENTS) {
      expect(typeof event.runId).toBe('string');
      expect(typeof (event as { at: number }).at).toBe('number');
    }
  });

  it('carries the originating node id on every type except sync-summary (14.1)', () => {
    for (const event of DATA_PATH_EVENTS) {
      const hasNodeId = 'nodeId' in event;
      expect(hasNodeId).toBe(event.type !== 'sync-summary');
    }
  });

  it('declares no header, parameter-value or secret members (14.2)', () => {
    const forbidden = ['headers', 'requestHeaders', 'responseHeaders', 'params', 'parameters', 'parameterValues', 'secret', 'secrets', 'auth', 'token'];
    for (const event of DATA_PATH_EVENTS) {
      for (const key of Object.keys(event)) {
        expect(forbidden).not.toContain(key);
      }
    }
  });

  it('leaves bodies absent unless the node opted into body capture (14.2)', () => {
    const request = DATA_PATH_EVENTS[0] as Extract<RunEvent, { type: 'http-request' }>;
    const response = DATA_PATH_EVENTS[1] as Extract<RunEvent, { type: 'http-response' }>;
    expect(request.body).toBeUndefined();
    expect(response.body).toBeUndefined();
    // Opt-in shape still type-checks, post-redaction.
    const optedIn: RunEvent = { ...request, body: '{"redacted":true}' };
    expect(optedIn.type).toBe('http-request');
  });

  it('reuses node-retrying for data-node retries (14.3)', () => {
    const retry: RunEvent = {
      type: 'node-retrying',
      runId: 'run-1',
      nodeId: 'n1',
      nodeName: 'Fetch',
      attempt: 1,
      maxAttempts: 3,
      delayMs: 250,
      error: 'HTTP 429',
      at: 12,
    };
    expect(retry.type).toBe('node-retrying');
    // No data-path-specific retry type exists in the union.
    const retryTypes = DATA_PATH_EVENT_TYPES.filter((type) => type.includes('retry'));
    expect(retryTypes).toEqual([]);
  });
});
