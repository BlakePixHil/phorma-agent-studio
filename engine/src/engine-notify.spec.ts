/**
 * Unit tests for the `notify` executor as the engine actually runs it
 * (design §5.7).
 *
 * Every case drives `startRun` over a small graph with a SCRIPTED `DataFetcher`:
 * one entry per expected delivery, so an unexpected request fails the run loudly
 * instead of passing silently.
 */

import { describe, expect, it } from 'vitest';

import type { ResolvedConnection } from './connections.js';
import type { ConnectionStore, DataFetcher, DataRequest, DataResponse } from './data-host.js';
import { startRun } from './engine.js';
import type { RunEvent } from './events.js';
import type { ModelClient } from './model.js';
import type { NotifyNodeData, WorkflowGraph, WorkflowNode } from './types.js';

const RUN_ID = 'run-1';

const NEVER_CALLED_MODEL: ModelClient = {
  async *stream() {
    throw new Error('No model call is expected in these scripted runs.');
  },
};

type ScriptStep = Partial<DataResponse> | Error;

interface ScriptedFetcher {
  readonly fetch: DataFetcher;
  readonly requests: DataRequest[];
}

function scripted(script: readonly ScriptStep[]): ScriptedFetcher {
  const requests: DataRequest[] = [];
  let index = 0;
  return {
    requests,
    fetch: async (request: DataRequest): Promise<DataResponse> => {
      requests.push(request);
      const step = script[index++];
      if (step === undefined) throw new Error(`Unscripted request ${index} to ${request.url}.`);
      if (step instanceof Error) throw step;
      return { status: 200, headers: {}, body: '', byteCount: 0, durationMs: 3, ...step };
    },
  };
}

function port(id: string, role: 'message-in' | 'message-out') {
  return { id, name: id, role };
}

function connect(id: string, outputId: string, inputId: string) {
  return { id, outputId, inputId, kind: 'handoff' as const };
}

function trigger(): WorkflowNode {
  return {
    id: 'trigger',
    name: 'Manual',
    kind: 'manual-trigger',
    category: 'trigger',
    icon: 'pi-play',
    position: { x: 0, y: 0 },
    ports: [port('trigger-out-1', 'message-out')],
    data: {},
  };
}

function notifyNode(data: Partial<NotifyNodeData>): WorkflowNode {
  return {
    id: 'notify-1',
    name: 'Alert',
    kind: 'notify',
    category: 'flow',
    icon: 'ti ti-bell',
    position: { x: 200, y: 0 },
    ports: [
      port('notify-1-in-1', 'message-in'),
      port('notify-1-out-1', 'message-out'),
      port('notify-1-err-1', 'message-out'),
    ],
    data: { channel: 'webhook', ...data } as NotifyNodeData,
  };
}

/**
 * A pass-through marker. `router` with a single out-port always matches that
 * port and returns the payload byte-identically (unlike `transform`, which
 * requires at least one field to execute at all).
 */
function marker(id: string): WorkflowNode {
  return {
    id,
    name: id,
    kind: 'router',
    category: 'data',
    icon: 'pi-sliders-h',
    position: { x: 400, y: 0 },
    ports: [port(`${id}-in-1`, 'message-in'), port(`${id}-out-1`, 'message-out')],
    data: {},
  };
}

interface Setup {
  readonly data: Partial<NotifyNodeData>;
  readonly fetcher?: ScriptedFetcher;
  readonly input?: string;
  readonly connection?: ResolvedConnection;
  /** Omits `dataFetch` from the run options entirely. */
  readonly noDataFetch?: boolean;
}

interface Result {
  readonly events: RunEvent[];
  readonly requests: DataRequest[];
  readonly output: string | undefined;
  readonly failure: string | undefined;
  readonly downstreamRan: boolean;
}

function eventsOf<T extends RunEvent['type']>(
  events: readonly RunEvent[],
  type: T,
): Extract<RunEvent, { type: T }>[] {
  return events.filter((event): event is Extract<RunEvent, { type: T }> => event.type === type);
}

function graphFor(setup: Setup): WorkflowGraph {
  return {
    nodes: [trigger(), notifyNode(setup.data), marker('next')],
    connections: [
      connect('c1', 'trigger-out-1', 'notify-1-in-1'),
      connect('c2', 'notify-1-out-1', 'next-in-1'),
    ],
  };
}

async function runNotify(setup: Setup): Promise<Result> {
  const events: RunEvent[] = [];
  const fetcher = setup.fetcher ?? scripted([]);
  const connections: ConnectionStore | undefined = setup.connection
    ? {
        resolve: async (id: string) => {
          if (id !== setup.connection!.id) throw new Error(`Unknown connection "${id}".`);
          return setup.connection!;
        },
        list: async () => [],
      }
    : undefined;

  const handle = startRun({
    runId: RUN_ID,
    graph: graphFor(setup),
    input: setup.input ?? '{"failed":3}',
    workflowId: 'wf-1',
    model: NEVER_CALLED_MODEL,
    emit: event => events.push(event),
    requestApproval: async () => true,
    requestInput: async () => '',
    ...(setup.noDataFetch ? {} : { dataFetch: fetcher.fetch }),
    ...(connections ? { connections } : {}),
  });
  await handle.done;

  const completed = eventsOf(events, 'node-completed').find(e => e.nodeId === 'notify-1');
  const failed = eventsOf(events, 'node-failed').find(e => e.nodeId === 'notify-1');
  return {
    events,
    requests: fetcher.requests,
    output: completed?.output,
    failure: failed?.error,
    downstreamRan: eventsOf(events, 'node-started').some(e => e.nodeId === 'next'),
  };
}

const emailConnection: ResolvedConnection = {
  id: 'conn-mail',
  type: 'http',
  config: { baseUrl: 'https://api.mailer.test', notifyPath: '/v1/send' },
  secrets: { token: 'super-secret-token' },
  auth: { mode: 'bearer', secretKey: 'token' },
  allowWrites: true,
};

// ── delivery and pass-through (13.1, 13.2, 13.4) ─────────────────────────────

describe('notify delivery', () => {
  it('posts the interpolated message and returns the payload unchanged', async () => {
    const fetcher = scripted([{ status: 202 }]);
    const run = await runNotify({
      data: {
        channel: 'webhook',
        to: 'https://hooks.test/services/T0/B0/secret-part',
        subject: 'Sync {{failed}} failed',
        body: 'Failures: {{failed}} and {{missing}}',
      },
      fetcher,
    });

    expect(run.failure).toBeUndefined();
    // Pass-through: no field added, none removed.
    expect(run.output).toBe('{"failed":3}');
    expect(run.downstreamRan).toBe(true);

    expect(run.requests).toHaveLength(1);
    const request = run.requests[0]!;
    expect(request.method).toBe('POST');
    expect(request.url).toBe('https://hooks.test/services/T0/B0/secret-part');
    expect(request.timeoutMs).toBe(30_000);
    expect(JSON.parse(request.body ?? '')).toEqual({
      to: 'https://hooks.test/services/T0/B0/secret-part',
      subject: 'Sync 3 failed',
      // An unresolved token is left verbatim (13.2).
      body: 'Failures: 3 and {{missing}}',
    });

    const sent = eventsOf(run.events, 'notify-sent');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ nodeId: 'notify-1', channel: 'webhook' });
    // Masked target, and neither the subject nor the body rides along (13.4).
    expect(sent[0]!.target).toBe('https://hooks.test/***');
    expect(JSON.stringify(sent[0])).not.toContain('Sync 3 failed');
    expect(JSON.stringify(sent[0])).not.toContain('Failures: 3');
  });

  it('defaults the body to the whole incoming payload', async () => {
    const fetcher = scripted([{ status: 200 }]);
    const run = await runNotify({
      data: { channel: 'chat-webhook', to: 'https://chat.test/hook' },
      input: '{"rows":2}',
      fetcher,
    });

    expect(run.failure).toBeUndefined();
    expect(JSON.parse(run.requests[0]?.body ?? '')).toMatchObject({ body: '{"rows":2}' });
  });

  it('sends email through the connection provider API with connection auth applied', async () => {
    const fetcher = scripted([{ status: 200 }]);
    const run = await runNotify({
      data: {
        channel: 'email',
        connectionId: 'conn-mail',
        to: 'ops@example.com',
        subject: 'Nightly sync',
      },
      connection: emailConnection,
      fetcher,
    });

    expect(run.failure).toBeUndefined();
    // The provider endpoint, never the recipient address (13.5).
    expect(run.requests[0]?.url).toBe('https://api.mailer.test/v1/send');
    expect(run.requests[0]?.headers['Authorization']).toBe('Bearer super-secret-token');
    expect(eventsOf(run.events, 'notify-sent')[0]?.target).toBe('o***@example.com');
  });
});

// ── failures (13.3, 13.8, 13.9) ──────────────────────────────────────────────

describe('notify failures', () => {
  it('fails the node on a non-2xx status, emits no notify-sent and keeps the payload', async () => {
    const fetcher = scripted([
      { status: 500, body: 'upstream exploded' },
      { status: 500, body: 'upstream exploded' },
    ]);
    const run = await runNotify({
      data: { channel: 'webhook', to: 'https://hooks.test/hook', retry: { maxAttempts: 2, backoffMs: 1 } },
      fetcher,
    });

    expect(run.failure).toContain('500');
    expect(eventsOf(run.events, 'notify-sent')).toHaveLength(0);
    expect(run.downstreamRan).toBe(false);
  });

  it.each([[undefined], ['sms'], ['']])('rejects channel %s before any request', async channel => {
    const fetcher = scripted([]);
    const run = await runNotify({
      data: { channel: channel as NotifyNodeData['channel'], to: 'https://hooks.test/hook' },
      fetcher,
    });

    expect(run.failure).toContain('notification channel');
    expect(run.requests).toHaveLength(0);
    expect(eventsOf(run.events, 'notify-sent')).toHaveLength(0);
  });

  it('rejects an email with no connection and an email with an empty recipient', async () => {
    const noConnection = await runNotify({
      data: { channel: 'email', to: 'ops@example.com' },
      fetcher: scripted([]),
    });
    expect(noConnection.failure).toContain('no connection selected');
    expect(noConnection.requests).toHaveLength(0);

    const empty = await runNotify({
      data: { channel: 'email', connectionId: 'conn-mail', to: '   ' },
      connection: emailConnection,
      fetcher: scripted([]),
    });
    expect(empty.failure).toContain('recipient rendered empty');
    expect(empty.requests).toHaveLength(0);
  });

  it('fails without dataFetch before issuing any request', async () => {
    const run = await runNotify({
      data: { channel: 'webhook', to: 'https://hooks.test/hook' },
      noDataFetch: true,
    });

    expect(run.failure).toContain('dataFetch');
    expect(eventsOf(run.events, 'notify-sent')).toHaveLength(0);
    expect(run.downstreamRan).toBe(false);
  });
});
