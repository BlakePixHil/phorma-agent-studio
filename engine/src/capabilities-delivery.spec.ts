/**
 * Capability findings for the document-delivery primitives and workflow
 * variables (Requirements 1.7, 2.10, 3.5, 4.8, 6, 7.3, 9.3).
 */

import { describe, expect, it } from 'vitest';

import {
  BROWSER_CAPABILITIES,
  CLOUDFLARE_CAPABILITIES,
  collectEgressHosts,
  validateAgainstCapabilities,
  type CapabilityValidationTarget,
} from './capabilities.js';
import type { ConnectionSummary } from './connections.js';
import type { HostCapabilities } from './data-host.js';
import type { WorkflowNode, WorkflowVariable } from './types.js';

function node(kind: string, data: object, id = 'n1'): WorkflowNode {
  return {
    id,
    name: 'Step',
    kind,
    category: 'flow',
    icon: '',
    position: { x: 0, y: 0 },
    ports: [
      { id: `${id}-in`, name: 'In', role: 'message-in' },
      { id: `${id}-out`, name: 'Out', role: 'message-out' },
    ],
    data,
  };
}

function spec(nodes: WorkflowNode[], variables?: WorkflowVariable[]): CapabilityValidationTarget {
  return { graph: { nodes, connections: [] }, ...(variables ? { settings: { variables } } : {}) };
}

const messages = (
  target: CapabilityValidationTarget,
  host: HostCapabilities = CLOUDFLARE_CAPABILITIES,
  connections: ConnectionSummary[] = [],
) => validateAgainstCapabilities(target, host, connections).map(finding => finding.message);

const NO_ARTIFACTS: HostCapabilities = {
  ...CLOUDFLARE_CAPABILITIES,
  features: { ...CLOUDFLARE_CAPABILITIES.features, artifacts: false },
};

describe('render-document', () => {
  it('is valid with markdown and a file name', () => {
    expect(messages(spec([node('render-document', { markdown: '# x', fileName: 'x' })]))).toEqual([]);
  });

  it('reports missing fields, a bad layout and a host without artifacts', () => {
    const found = messages(
      spec([node('render-document', { markdown: '', fileName: '', layout: { marginMm: 99 } })]),
      NO_ARTIFACTS,
    ).join('\n');
    expect(found).toMatch(/no markdown/);
    expect(found).toMatch(/no file name/);
    expect(found).toMatch(/margin/);
    expect(found).toMatch(/artifact storage/);
  });
});

describe('notify email extensions', () => {
  const resend: ConnectionSummary = {
    id: 'conn-a',
    name: 'Mail',
    type: 'http',
    config: { emailProvider: 'smtp-direct' },
    secretKeys: [],
    auth: { mode: 'none' },
    secretsPresent: 0,
    createdAt: '',
    updatedAt: '',
  } as unknown as ConnectionSummary;

  it('refuses attachments on a webhook and an unknown provider', () => {
    expect(messages(spec([node('notify', { channel: 'webhook', attachments: ['doc'] })])).join()).toMatch(
      /only the email channel/,
    );
    expect(
      messages(spec([node('notify', { channel: 'email', connectionId: 'conn-a' })]), CLOUDFLARE_CAPABILITIES, [
        resend,
      ]).join(),
    ).toMatch(/not one of generic-json, resend/);
  });
});

describe('multipart http-request', () => {
  it('needs parts, a body method and artifact storage', () => {
    const found = messages(
      spec([
        node('http-request', {
          method: 'GET',
          url: 'https://x.test/up',
          bodyMode: 'multipart',
          multipart: { files: [{ name: 'f', artifact: '' }] },
        }),
      ]),
      NO_ARTIFACTS,
    ).join('\n');
    expect(found).toMatch(/use POST or PUT/);
    expect(found).toMatch(/needs a part name and an artifact payload path/);
    expect(found).toMatch(/artifact storage/);
  });
});

describe('state-list', () => {
  it('refuses an empty or reserved prefix and an out-of-range limit', () => {
    expect(messages(spec([node('state-list', { prefix: '' })])).join()).toMatch(/no key prefix/);
    expect(messages(spec([node('state-list', { prefix: 'idem:' })])).join()).toMatch(/reserved/);
    expect(messages(spec([node('state-list', { prefix: 'a:', limit: 5000 })])).join()).toMatch(/limit/);
    expect(messages(spec([node('state-list', { prefix: 'a:', limit: 50 })]))).toEqual([]);
  });
});

describe('expression router', () => {
  it('compiles the route expression', () => {
    expect(messages(spec([node('router', { mode: 'expression', expression: '$.x ==' })])).join()).toMatch(
      /Expression error in the route expression/,
    );
    expect(messages(spec([node('router', { mode: 'expression', expression: "$.x == 'a' ? 'A' : 'B'" })]))).toEqual(
      [],
    );
  });
});

describe('workflow variables', () => {
  it('reports declaration problems and undefined references', () => {
    const found = messages(
      spec(
        [
          node('transform', { fields: [{ target: 'x', expression: 'vars.limit + vars.missing' }] }),
          node('notify', { channel: 'webhook', body: '{{vars.ghost}} {{vars.limit}}' }, 'n2'),
        ],
        [
          { name: 'limit', type: 'number', value: 3 },
          { name: 'apiKey', type: 'text', value: 'x' },
        ],
      ),
    ).join('\n');
    expect(found).toMatch(/named like a credential/);
    expect(found).toMatch(/"missing", which is not defined/);
    expect(found).toMatch(/"ghost", which is not defined/);
    expect(found).not.toMatch(/"limit", which is not defined/);
  });

  it('resolves a url host built from variables and tolerates a templated path', () => {
    const target = spec(
      [
        node('http-request', { method: 'GET', url: '{{vars.base}}/items' }),
        node('http-request', { method: 'GET', url: 'https://boards.example.test/v1/{{slug}}/items' }, 'n2'),
      ],
      [{ name: 'base', type: 'text', value: 'https://api.example.test' }],
    );
    expect(messages(target)).toEqual([]);
    expect(collectEgressHosts(target, CLOUDFLARE_CAPABILITIES, [])).toEqual([
      'api.example.test',
      'boards.example.test',
    ]);
  });

  it('every host declares artifact support', () => {
    expect(BROWSER_CAPABILITIES.features.artifacts).toBe(true);
  });
});
