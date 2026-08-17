/**
 * Tests for the Schedule_Shim.
 *
 * The retry classification is the part worth being careful about. A 409 means
 * "already running", which is a normal outcome with a skip record behind it; if
 * the shim threw on it, every concurrent-run skip would raise the Lambda error
 * metric and page an operator over correct behaviour.
 *
 * Feature: aws-byo-deploy
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import {
  REGION_ENV,
  TRIGGER_API_URL_ENV,
  mintRunId,
  parseScheduleFireEvent,
  readShimEnv,
  runShim,
  type ShimDeps,
  type TriggerOutcome,
} from './schedule-shim.js';

const ENV = Object.freeze({
  [TRIGGER_API_URL_ENV]: 'https://abc123.execute-api.eu-west-1.amazonaws.com',
  [REGION_ENV]: 'eu-west-1',
});

const EVENT = Object.freeze({ workflowId: 'wf-1', nodeId: 'node-1', source: 'schedule' });

/** Record what the shim sent, and answer with a fixed status. */
function recorder(status: number, body = '{}') {
  const calls: { url: string; method: string; body: string; region: string }[] = [];
  const send = async (
    url: string,
    method: string,
    requestBody: string,
    region: string,
  ): Promise<TriggerOutcome> => {
    calls.push({ url, method, body: requestBody, region });
    return { status, body };
  };
  return { calls, send };
}

function deps(status: number, body = '{}'): ShimDeps & { calls: ReturnType<typeof recorder>['calls'] } {
  const { calls, send } = recorder(status, body);
  return { env: { ...ENV }, send, runId: () => 'run-fixed', log: () => {}, calls };
}

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

describe('readShimEnv', () => {
  it('reads both variables', () => {
    const env = readShimEnv({ ...ENV });
    expect(env.triggerApiUrl).toBe('https://abc123.execute-api.eu-west-1.amazonaws.com');
    expect(env.region).toBe('eu-west-1');
  });

  it('strips a trailing slash so the route path cannot double up', () => {
    // `https://host//workflows/x/trigger` is a different route to API Gateway,
    // and it answers 404 for it.
    const env = readShimEnv({ ...ENV, [TRIGGER_API_URL_ENV]: 'https://host/' });
    expect(env.triggerApiUrl).toBe('https://host');
  });

  it('names every absent variable, not just the first', () => {
    expect(() => readShimEnv({})).toThrow(
      new RegExp(`${TRIGGER_API_URL_ENV}.*${REGION_ENV}`),
    );
  });

  it('treats a blank value as absent', () => {
    expect(() => readShimEnv({ ...ENV, [REGION_ENV]: '   ' })).toThrow(REGION_ENV);
  });
});

// ---------------------------------------------------------------------------
// Event parsing
// ---------------------------------------------------------------------------

describe('parseScheduleFireEvent', () => {
  it('accepts the input SchedulerAdapter stores', () => {
    expect(parseScheduleFireEvent(EVENT)).toEqual({
      workflowId: 'wf-1',
      nodeId: 'node-1',
      source: 'schedule',
    });
  });

  it('rejects a non-object, a missing field and a blank field', () => {
    expect(() => parseScheduleFireEvent(null)).toThrow('JSON object');
    expect(() => parseScheduleFireEvent([])).toThrow('JSON object');
    expect(() => parseScheduleFireEvent({ nodeId: 'n' })).toThrow('workflowId');
    expect(() => parseScheduleFireEvent({ workflowId: 'w' })).toThrow('nodeId');
    expect(() => parseScheduleFireEvent({ workflowId: '  ', nodeId: 'n' })).toThrow('workflowId');
  });
});

// ---------------------------------------------------------------------------
// Run ids
// ---------------------------------------------------------------------------

describe('mintRunId', () => {
  it('mints a distinct id per call', () => {
    const ids = new Set(Array.from({ length: 200 }, () => mintRunId()));
    // A schedule's stored input is fixed at push time, so the id cannot come
    // from there - it has to be fresh on every fire.
    expect(ids.size).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// The request
// ---------------------------------------------------------------------------

describe('runShim - the request it sends', () => {
  it('posts to the trigger route for the fired workflow', async () => {
    const d = deps(202);
    await runShim(EVENT, d);

    expect(d.calls).toHaveLength(1);
    expect(d.calls[0]!.url).toBe(
      'https://abc123.execute-api.eu-west-1.amazonaws.com/workflows/wf-1/trigger',
    );
    expect(d.calls[0]!.method).toBe('POST');
    expect(d.calls[0]!.region).toBe('eu-west-1');
  });

  it('carries a runId, the schedule source and the node id', async () => {
    const d = deps(202);
    await runShim(EVENT, d);

    expect(JSON.parse(d.calls[0]!.body)).toEqual({
      workflowId: 'wf-1',
      runId: 'run-fixed',
      source: 'schedule',
      nodeId: 'node-1',
    });
  });

  it('percent-encodes a workflow id with path-significant characters', async () => {
    const d = deps(202);
    await runShim({ workflowId: 'wf/../admin', nodeId: 'n' }, d);
    expect(d.calls[0]!.url).toContain('/workflows/wf%2F..%2Fadmin/trigger');
  });
});

// ---------------------------------------------------------------------------
// Retry classification
// ---------------------------------------------------------------------------

describe('runShim - retry classification', () => {
  it('treats 2xx as started', async () => {
    for (const status of [200, 201, 202, 204]) {
      const result = await runShim(EVENT, deps(status));
      expect(result.outcome).toBe('started');
      expect(result.status).toBe(status);
    }
  });

  it('treats 409 as already running and does NOT throw', async () => {
    // The lease is held by another Runner and a skip record is already written.
    // Throwing here would turn correct contention handling into an alarm.
    const result = await runShim(EVENT, deps(409));
    expect(result.outcome).toBe('already-running');
  });

  it('treats 404 as not deployed and does NOT throw', async () => {
    // The runtime has already deleted the orphan schedule, so there is nothing
    // a retry could achieve.
    const result = await runShim(EVENT, deps(404));
    expect(result.outcome).toBe('not-deployed');
  });

  it('throws on 5xx so Scheduler retries', async () => {
    await expect(runShim(EVENT, deps(503, 'lease indeterminate'))).rejects.toThrow(/503/);
  });

  it('throws on 400 and 403, which are real faults', async () => {
    await expect(runShim(EVENT, deps(400))).rejects.toThrow(/400/);
    await expect(runShim(EVENT, deps(403))).rejects.toThrow(/403/);
  });

  it('names the workflow and node when it throws', async () => {
    await expect(runShim(EVENT, deps(500))).rejects.toThrow(/wf-1[\s\S]*node-1/);
  });

  it('caps the reported body so a large error page cannot flood the log', async () => {
    const d = deps(500, 'x'.repeat(5000));
    const error = await runShim(EVENT, d).then(
      () => undefined,
      (err: unknown) => err as Error,
    );
    expect(error).toBeDefined();
    expect(error!.message.length).toBeLessThan(1024);
  });
});

// ---------------------------------------------------------------------------
// Property: exactly the two terminal statuses resolve, everything else throws
// Feature: aws-byo-deploy
// ---------------------------------------------------------------------------

describe('Property: the shim retries exactly the statuses a retry could fix', () => {
  it('resolves for 2xx, 409 and 404 and throws for every other status (min 100 runs)', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 100, max: 599 }), async (status) => {
        const expectResolve = (status >= 200 && status < 300) || status === 409 || status === 404;

        if (expectResolve) {
          const result = await runShim(EVENT, deps(status));
          expect(result.status).toBe(status);
        } else {
          await expect(runShim(EVENT, deps(status))).rejects.toThrow();
        }
      }),
      { numRuns: 100 },
    );
  });

  it('always sends exactly one request per fire (min 100 runs)', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 100, max: 599 }), async (status) => {
        const d = deps(status);
        await runShim(EVENT, d).catch(() => undefined);
        // A schedule fire is one trigger attempt. Retrying is Scheduler's job,
        // so a second call from inside one invocation would double-count.
        expect(d.calls).toHaveLength(1);
      }),
      { numRuns: 100 },
    );
  });

  it('mints a fresh run id for every fire of the same schedule (min 100 runs)', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 2, max: 20 }), async (fires) => {
        const seen = new Set<string>();
        for (let i = 0; i < fires; i++) {
          const { send } = recorder(202);
          const result = await runShim(EVENT, { env: { ...ENV }, send, log: () => {} });
          seen.add(result.runId);
        }
        expect(seen.size).toBe(fires);
      }),
      { numRuns: 100 },
    );
  });
});
