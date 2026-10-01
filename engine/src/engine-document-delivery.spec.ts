/**
 * Executor tests for the document-delivery primitives as `startRun` runs them:
 * render-document and run artifacts (Requirements 2, 3), email adapters and
 * idempotent sends (4, 5), multipart uploads (6), state-list (7), agent
 * resultKey (8), the expression router (9) and workflow variables (1).
 */

import { describe, expect, it } from 'vitest';

import { decodeBase64 } from './artifacts.js';
import type { ResolvedConnection } from './connections.js';
import { DataTransportError, type DataRequest, type DataResponse } from './data-host.js';
import { startRun, type RunOptions } from './engine.js';
import type { RunEvent } from './events.js';
import type { ModelClient } from './model.js';
import { MemoryArtifactStore } from './test/fake-host.js';
import { MemoryStateStore } from './test/memory-state-store.js';
import { inspectPdf } from './test/pdf-reader.js';
import type { WorkflowGraph, WorkflowNode } from './types.js';

const NEVER_CALLED_MODEL: ModelClient = {
  async *stream() {
    throw new Error('No model call is expected.');
  },
};

function step(id: string, kind: string, data: object, outs = 1): WorkflowNode {
  return {
    id,
    name: id,
    kind,
    category: 'flow',
    icon: '',
    position: { x: 0, y: 0 },
    ports: [
      { id: `${id}-in`, name: 'In', role: 'message-in' },
      ...Array.from({ length: outs }, (_, index) => ({
        id: `${id}-out${index}`,
        name: `out${index}`,
        role: 'message-out' as const,
      })),
    ],
    data,
  };
}

/** A linear graph: manual trigger, then each node out0 -> next in. */
function chain(...nodes: WorkflowNode[]): WorkflowGraph {
  const trigger: WorkflowNode = {
    id: 'start',
    name: 'start',
    kind: 'manual-trigger',
    category: 'trigger',
    icon: '',
    position: { x: 0, y: 0 },
    ports: [{ id: 'start-out', name: 'Out', role: 'message-out' }],
    data: {},
  };
  const all = [trigger, ...nodes];
  const connections = nodes.map((node, index) => ({
    id: `c${index}`,
    outputId: `${index === 0 ? 'start-out' : `${all[index]!.id}-out0`}-out`,
    inputId: `${node.id}-in-in`,
    kind: 'handoff' as const,
  }));
  return { nodes: all, connections };
}

interface Outcome {
  events: RunEvent[];
  requests: DataRequest[];
  final: string | undefined;
  error: string | undefined;
}

async function run(
  graph: WorkflowGraph,
  input: string,
  extra: Partial<RunOptions> & { responses?: (Partial<DataResponse> | Error)[] } = {},
): Promise<Outcome> {
  const events: RunEvent[] = [];
  const requests: DataRequest[] = [];
  const responses = [...(extra.responses ?? [])];
  const { responses: _unused, ...options } = extra;
  const handle = startRun({
    runId: 'run-1',
    graph,
    input,
    workflowId: 'wf-1',
    model: NEVER_CALLED_MODEL,
    emit: event => events.push(event),
    requestApproval: async () => true,
    requestInput: async () => '',
    dataFetch: async request => {
      requests.push(request);
      const next = responses.shift() ?? {};
      if (next instanceof Error) throw next;
      return { status: 200, headers: {}, body: '{}', byteCount: 2, durationMs: 1, ...next };
    },
    ...options,
  });
  await handle.done;
  const done = events.find(event => event.type === 'run-completed');
  const failed = events.find(event => event.type === 'run-failed');
  return {
    events,
    requests,
    final: done?.type === 'run-completed' ? done.output : undefined,
    error: failed?.type === 'run-failed' ? failed.error : undefined,
  };
}

const resend: ResolvedConnection = {
  id: 'conn-resend',
  type: 'http',
  config: { emailProvider: 'resend', defaultFrom: 'Reports <reports@example.test>' },
  secrets: { token: 're_secretsecretsecret' },
  auth: { mode: 'bearer', secretKey: 'token' },
  allowWrites: true,
};

const connections = (conn: ResolvedConnection) => ({
  resolve: async (id: string) => {
    if (id !== conn.id) throw new Error(`Unknown connection "${id}".`);
    return conn;
  },
});

const render = step('render', 'render-document', {
  markdown: '# {{name}}\n\nTotal **{{total}}**.',
  fileName: 'Report {{name}}',
  resultKey: 'pdf',
});

describe('render-document and artifacts (Requirements 2, 3)', () => {
  it('stores a PDF artifact and merges only its reference', async () => {
    const artifacts = new MemoryArtifactStore();
    const { events, final, error } = await run(chain(render), '{"name":"Acme","total":42}', { artifacts });
    expect(error).toBeUndefined();
    const out = JSON.parse(final!);
    expect(out.name).toBe('Acme');
    expect(out.pdf).toMatchObject({ name: 'Report Acme.pdf', mimeType: 'application/pdf' });
    const stored = artifacts.all();
    expect(stored).toHaveLength(1);
    expect(out.pdf.sizeBytes).toBe(stored[0]!.bytes.length);
    const pdf = inspectPdf(stored[0]!.bytes);
    expect(pdf.text).toContain('Acme');
    expect(pdf.text).toContain('42');
    const created = events.filter(event => event.type === 'artifact-created');
    expect(created).toHaveLength(1);
    expect(JSON.stringify(created)).not.toContain('%PDF');
  });

  it('fails naming the capability on a host without an artifact store', async () => {
    const { error } = await run(chain(render), '{"name":"A"}');
    expect(error).toMatch(/"artifacts" capability/);
  });

  it('enforces the per-run count cap read from the store (Requirement 2.4)', async () => {
    const artifacts = new MemoryArtifactStore();
    for (let i = 0; i < 200; i += 1) {
      await artifacts.put('run-1', {
        ref: { id: `art-0000000${i % 10}-0000${String(i).padStart(4, '0')}`, name: `f${i}`, mimeType: 'text/plain', sizeBytes: 1 },
        nodeId: 'x',
        createdAt: 0,
        bytes: new Uint8Array([1]),
      });
    }
    const { error } = await run(chain(render), '{"name":"A"}', { artifacts });
    expect(error).toMatch(/200-file limit/);
  });
});

describe('email with attachments (Requirements 4, 5)', () => {
  const email = (extra: object) =>
    step('mail', 'notify', {
      channel: 'email',
      connectionId: 'conn-resend',
      to: '{{to}}',
      subject: 'Hello {{name}}',
      body: 'Dear {{name}},\n\nSee attached.',
      bodyFormat: 'text',
      replyTo: 'me@example.test',
      cc: 'a@example.test, b@example.test',
      attachments: ['pdf'],
      idempotencyKey: 'send:{{name}}',
      ...extra,
    });

  it('posts the Resend shape with a base64 attachment and the idempotency header', async () => {
    const artifacts = new MemoryArtifactStore();
    const state = new MemoryStateStore();
    const { requests, events, error } = await run(chain(render, email({})), '{"name":"Acme","to":"x@example.test"}', {
      artifacts,
      state,
      connections: connections(resend),
    });
    expect(error).toBeUndefined();
    expect(requests).toHaveLength(1);
    const [request] = requests;
    expect(request!.url).toBe('https://api.resend.com/emails');
    expect(request!.headers['Authorization']).toBe('Bearer re_secretsecretsecret');
    expect(request!.headers['Idempotency-Key']).toBe('send:Acme');
    const body = JSON.parse(request!.body!);
    expect(body).toMatchObject({
      from: 'Reports <reports@example.test>',
      to: ['x@example.test'],
      cc: ['a@example.test', 'b@example.test'],
      reply_to: 'me@example.test',
      subject: 'Hello Acme',
      text: 'Dear Acme,\n\nSee attached.',
    });
    expect(body.html).toBeUndefined();
    expect(body.attachments).toHaveLength(1);
    expect(body.attachments[0].filename).toBe('Report Acme.pdf');
    expect(new TextDecoder().decode(decodeBase64(body.attachments[0].content).slice(0, 4))).toBe('%PDF');
    expect(events.find(event => event.type === 'notify-sent')).toMatchObject({ attachments: 1 });
  });

  it('a second execution with the same key is skipped and sends nothing (Requirement 5.2)', async () => {
    const artifacts = new MemoryArtifactStore();
    const state = new MemoryStateStore();
    const input = '{"name":"Acme","to":"x@example.test"}';
    const options = { artifacts, state, connections: connections(resend) };
    expect((await run(chain(render, email({})), input, options)).requests).toHaveLength(1);
    const second = await run(chain(render, email({})), input, options);
    expect(second.requests).toHaveLength(0);
    expect(second.error).toBeUndefined();
  });

  it('every retry attempt reuses the key; a provable refusal releases it (Requirements 5.3, 5.6)', async () => {
    const artifacts = new MemoryArtifactStore();
    const state = new MemoryStateStore();
    const input = '{"name":"Acme","to":"x@example.test"}';
    const graph = chain(render, email({ retry: { maxAttempts: 2, backoffMs: 1, idempotent: true } }));
    const first = await run(graph, input, {
      artifacts,
      state,
      connections: connections(resend),
      responses: [{ status: 503 }, { status: 422, body: '{"message":"bad from"}' }],
    });
    expect(first.error).toMatch(/422/);
    expect(first.requests.map(request => request.headers['Idempotency-Key'])).toEqual(['send:Acme', 'send:Acme']);
    // Released: the next run sends again.
    const retry = await run(graph, input, { artifacts, state, connections: connections(resend) });
    expect(retry.requests).toHaveLength(1);
  });

  it('a possibly-delivered failure keeps the claim (Requirement 5.6)', async () => {
    const artifacts = new MemoryArtifactStore();
    const state = new MemoryStateStore();
    const input = '{"name":"Acme","to":"x@example.test"}';
    const graph = chain(render, email({}));
    const first = await run(graph, input, {
      artifacts,
      state,
      connections: connections(resend),
      responses: [{ status: 500 }],
    });
    expect(first.error).toMatch(/500/);
    const next = await run(graph, input, { artifacts, state, connections: connections(resend) });
    expect(next.requests).toHaveLength(0);
  });

  it('a transport failure that never sent releases the claim', async () => {
    const state = new MemoryStateStore();
    const artifacts = new MemoryArtifactStore();
    const input = '{"name":"Acme","to":"x@example.test"}';
    const graph = chain(render, email({ retry: { maxAttempts: 1 } }));
    const first = await run(graph, input, {
      artifacts,
      state,
      connections: connections(resend),
      responses: [new DataTransportError('connect', 'refused')],
    });
    expect(first.error).toMatch(/refused/);
    const next = await run(graph, input, { artifacts, state, connections: connections(resend) });
    expect(next.requests).toHaveLength(1);
  });

  it('truncates attachments over the cap only when asked (Requirement 4.6)', async () => {
    const artifacts = new MemoryArtifactStore();
    const big = { id: 'art-00000000-00000001', name: 'big.bin', mimeType: 'application/octet-stream', sizeBytes: 6_000_000 };
    for (const ref of [big, { ...big, id: 'art-00000000-00000002' }]) {
      await artifacts.put('run-1', { ref, nodeId: 'x', createdAt: 0, bytes: new Uint8Array(ref.sizeBytes) });
    }
    const input = JSON.stringify({ files: [big, { ...big, id: 'art-00000000-00000002' }], to: 'x@example.test', name: 'A' });
    const strict = await run(chain(email({ attachments: ['files'], idempotencyKey: '' })), input, {
      artifacts,
      connections: connections(resend),
    });
    expect(strict.error).toMatch(/truncate/);
    expect(strict.requests).toHaveLength(0);
    const lenient = await run(
      chain(email({ attachments: ['files'], attachmentLimit: 'truncate', idempotencyKey: '' })),
      input,
      { artifacts, connections: connections(resend) },
    );
    expect(lenient.error).toBeUndefined();
    expect(JSON.parse(lenient.requests[0]!.body!).attachments).toHaveLength(1);
    expect(lenient.events.find(event => event.type === 'notify-sent')).toMatchObject({ omittedAttachments: 1 });
  });

  it('generic-json stays byte-identical when no new field is set (Requirement 4.3)', async () => {
    const generic: ResolvedConnection = { ...resend, id: 'conn-generic', config: { baseUrl: 'https://hooks.test' } };
    const plain = step('mail', 'notify', { channel: 'email', connectionId: 'conn-generic', to: 'a@b.test', subject: 'S', body: 'B' });
    const { requests } = await run(chain(plain), '{}', { connections: connections(generic) });
    expect(requests[0]!.body).toBe('{"to":"a@b.test","subject":"S","body":"B"}');
    expect(requests[0]!.headers['Idempotency-Key']).toBeUndefined();
  });
});

describe('multipart upload (Requirement 6)', () => {
  it('sends a base64-encoded multipart body built from an artifact', async () => {
    const artifacts = new MemoryArtifactStore();
    const upload = step('upload', 'http-request', {
      method: 'POST',
      url: 'https://upload.example.test/files',
      bodyMode: 'multipart',
      multipart: {
        fields: [{ name: 'title', value: '{{name}}' }],
        files: [{ name: 'file', artifact: 'pdf' }],
      },
      idempotencyKey: 'upload:{{name}}',
    });
    const { requests, error } = await run(chain(render, upload), '{"name":"Acme"}', {
      artifacts,
      state: new MemoryStateStore(),
    });
    expect(error).toBeUndefined();
    const request = requests[0]!;
    expect(request.bodyEncoding).toBe('base64');
    expect(request.headers['Content-Type']).toMatch(/^multipart\/form-data; boundary=/);
    expect(request.headers['Idempotency-Key']).toBe('upload:Acme');
    const body = [...decodeBase64(request.body!)].map(byte => String.fromCharCode(byte)).join('');
    expect(body).toContain('name="title"\r\n\r\nAcme\r\n');
    expect(body).toContain('filename="Report Acme.pdf"');
    expect(body).toContain('%PDF-1.4');
  });
});

describe('state-list (Requirement 7)', () => {
  it('lists user entries with ISO dates and hides reserved namespaces', async () => {
    const state = new MemoryStateStore({ now: () => Date.parse('2026-01-01T00:00:00Z') });
    await state.set('wf-1::done:a', '{"n":1}', { ttlSec: 86_400 });
    await state.set('wf-1::done:b', 'plain');
    await state.set('wf-1::idem:done:x', 'claimed');
    await state.set('wf-2::done:other', '{}');
    const list = step('list', 'state-list', { prefix: 'done:', resultKey: 'ledger' });
    const { final } = await run(chain(list), '{"keep":true}', { state });
    const out = JSON.parse(final!);
    expect(out.keep).toBe(true);
    expect(out.ledger).toEqual([
      { key: 'done:a', value: { n: 1 }, updatedAt: '2026-01-01T00:00:00.000Z', expiresAt: '2026-01-02T00:00:00.000Z' },
      { key: 'done:b', value: 'plain', updatedAt: '2026-01-01T00:00:00.000Z', expiresAt: null },
    ]);
  });

  it('refuses a reserved prefix', async () => {
    const { error } = await run(chain(step('list', 'state-list', { prefix: 'idem:' })), '{}', {
      state: new MemoryStateStore(),
    });
    expect(error).toMatch(/reserved/);
  });
});

describe('expression router (Requirement 9) and agent resultKey (Requirement 8)', () => {
  const mark = (id: string) => step(id, 'transform', { fields: [{ target: 'via', expression: `'${id}'` }] });

  function routed(expression: string, unsure = false): WorkflowGraph {
    const router: WorkflowNode = {
      ...step('route', 'router', { mode: 'expression', expression, ...(unsure ? { unsurePortId: 'route-out2' } : {}) }, 3),
    };
    router.ports[1]!.name = 'Email';
    router.ports[2]!.name = 'api';
    router.ports[3]!.name = 'other';
    const graph = chain(router);
    graph.nodes.push(mark('a'), mark('b'), mark('c'));
    graph.connections.push(
      { id: 'r0', outputId: 'route-out0-out', inputId: 'a-in-in', kind: 'handoff' },
      { id: 'r1', outputId: 'route-out1-out', inputId: 'b-in-in', kind: 'handoff' },
      { id: 'r2', outputId: 'route-out2-out', inputId: 'c-in-in', kind: 'handoff' },
    );
    return graph;
  }

  it('takes the route whose name equals the value, case-insensitively', async () => {
    expect(JSON.parse((await run(routed('$.method'), '{"method":" email "}')).final!).via).toBe('a');
    expect(JSON.parse((await run(routed("vars.on ? 'API' : 'email'"), '{}', { variables: { on: true } })).final!).via).toBe('b');
  });

  it('falls back to the unsure route, else fails naming the value', async () => {
    expect(JSON.parse((await run(routed('$.method', true), '{"method":"fax"}')).final!).via).toBe('c');
    expect((await run(routed('$.method'), '{"method":"fax"}')).error).toMatch(/"fax"/);
  });

  it('merges a fenced JSON reply under resultKey and keeps the payload', async () => {
    const model: ModelClient = {
      async *stream() {
        yield { type: 'text', text: 'Here you go:\n```json\n{"score": 80}\n```' };
      },
    };
    const agent: WorkflowNode = {
      ...step('agent', 'agent', { prompt: 'Score {{title}}', resultKey: 'fit', provider: 'openai', model: 'm' }),
      category: 'agent',
    };
    const { final } = await run(chain(agent), '{"title":"T"}', { model });
    expect(JSON.parse(final!)).toEqual({ title: 'T', fit: { score: 80 } });
  });
});

describe('workflow variables in requests (Requirement 1)', () => {
  it('renders {{vars.x}} in an http-request url and query', async () => {
    const fetch = step('fetch', 'http-request', {
      method: 'GET',
      url: 'https://api.example.test/{{vars.board}}/items',
      query: [{ key: 'q', value: '{{vars.term}}' }],
    });
    const { requests } = await run(chain(fetch), '{"vars":{"board":"evil"}}', {
      variables: { board: 'acme', term: 'remote' },
    });
    expect(requests[0]!.url).toBe('https://api.example.test/acme/items?q=remote');
  });
});
