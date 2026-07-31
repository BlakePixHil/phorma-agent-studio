import { describe, expect, it } from 'vitest';
import {
  BROWSER_CAPABILITIES,
  CLOUDFLARE_CAPABILITIES,
  TAURI_DESKTOP_CAPABILITIES,
  collectEgressHosts,
  inspectAgainstCapabilities,
  validateAgainstCapabilities,
  type CapabilityValidationTarget,
} from './capabilities.js';
import type { ConnectionSummary, ConnectionType } from './connections.js';
import type { WorkflowConnection, WorkflowGraph, WorkflowNode } from './types.js';

/**
 * Finding messages and egress collection (Requirements 17.13, 17.14, 17.15).
 *
 * The messages ARE the product here: an operator reads them at push time and
 * has to learn which node, which host and which unsupported thing caused the
 * block without opening the spec. These cases pin the named parts of each
 * message rather than the whole string, so wording can improve while the facts
 * stay present.
 */

// ── fixtures ─────────────────────────────────────────────────────────────────

function node(kind: string, data: object, overrides: Partial<WorkflowNode> = {}): WorkflowNode {
  const id = overrides.id ?? `n-${kind}`;
  return {
    id,
    name: overrides.name ?? `${kind} step`,
    kind,
    category: 'flow',
    icon: 'pi pi-cog',
    position: { x: 0, y: 0 },
    ports: overrides.ports ?? [{ id: `${id}-p`, name: 'In', role: 'message-in' }],
    data,
    ...overrides,
  };
}

function graph(nodes: WorkflowNode[], connections: WorkflowConnection[] = []): WorkflowGraph {
  return { nodes, connections };
}

function spec(g: WorkflowGraph, subWorkflows?: CapabilityValidationTarget['subWorkflows']) {
  return subWorkflows ? { graph: g, subWorkflows } : { graph: g };
}

function connection(overrides: Partial<ConnectionSummary> = {}): ConnectionSummary {
  return {
    id: 'conn-api',
    name: 'Billing API',
    type: 'http' as ConnectionType,
    config: {},
    secretKeys: [],
    secretsPresent: 0,
    auth: { mode: 'none' },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/** The single finding for a one-node spec, so each case reads as one assertion. */
function onlyFinding(
  g: WorkflowGraph,
  capabilities = TAURI_DESKTOP_CAPABILITIES,
  connections: ConnectionSummary[] = [],
) {
  const findings = validateAgainstCapabilities(spec(g), capabilities, connections);
  expect(findings).toHaveLength(1);
  return findings[0]!;
}

// ── unsupported node kind ────────────────────────────────────────────────────

describe('unsupported node kind findings', () => {
  it('names the node, the kind and the host label', () => {
    const found = onlyFinding(
      graph([node('sql-query', { statement: 'select 1', driver: 'postgres' })]),
      BROWSER_CAPABILITIES,
    );

    expect(found.severity).toBe('error');
    expect(found.nodeId).toBe('n-sql-query');
    expect(found.nodeName).toBe('sql-query step');
    expect(found.message).toContain('"sql-query step"');
    expect(found.message).toContain('sql-query');
    expect(found.message).toContain(BROWSER_CAPABILITIES.label);
  });

  it('reports an unrecognised kind and stops before the remaining rules', () => {
    const found = onlyFinding(graph([node('teleport', { url: 'not-an-expression(' })]));

    expect(found.message).toContain('unrecognised node kind "teleport"');
    expect(found.message).toContain(TAURI_DESKTOP_CAPABILITIES.label);
  });

  it('reports an absent kind and falls back to the node id when unnamed', () => {
    const bare = node('', {}, { name: '' });
    const found = onlyFinding(graph([bare]));

    expect(found.message).toContain('Node n-');
    expect(found.message).toContain('declares no node kind');
  });

  it('names the sub-workflow as well as the node for a nested finding', () => {
    const findings = validateAgainstCapabilities(
      spec(graph([]), {
        'sub-1': {
          id: 'sub-1',
          name: 'Nightly load',
          graph: graph([node('sql-query', { driver: 'postgres', statement: 'select 1' })]),
        },
      }),
      BROWSER_CAPABILITIES,
      [],
    );

    expect(findings).toHaveLength(1);
    expect(findings[0]!.subWorkflowId).toBe('sub-1');
    expect(findings[0]!.subWorkflowName).toBe('Nightly load');
    expect(findings[0]!.message).toContain('Sub-workflow "Nightly load"');
    expect(findings[0]!.message).toContain('"sql-query step"');
  });
});

// ── unsupported SQL driver ───────────────────────────────────────────────────

describe('SQL driver findings', () => {
  it('names the driver, the host and the supported drivers', () => {
    const found = onlyFinding(
      graph([node('sql-query', { driver: 'mssql', statement: 'select 1' })]),
      CLOUDFLARE_CAPABILITIES,
    );

    expect(found.severity).toBe('error');
    expect(found.message).toContain('mssql');
    expect(found.message).toContain(CLOUDFLARE_CAPABILITIES.label);
    expect(found.message).toContain('postgres, mysql');
  });

  it('falls back to the connection config driver when the node declares none', () => {
    const findings = validateAgainstCapabilities(
      spec(graph([node('sql-query', { connectionId: 'conn-db', statement: 'select 1' })])),
      CLOUDFLARE_CAPABILITIES,
      [connection({ id: 'conn-db', name: 'Warehouse', type: 'sql', config: { driver: 'mssql' } })],
    );

    expect(findings).toHaveLength(1);
    expect(findings[0]!.message).toContain('mssql');
  });

  it('accepts a driver the host declares', () => {
    expect(
      validateAgainstCapabilities(
        spec(graph([node('sql-query', { driver: 'postgres', statement: 'select 1' })])),
        CLOUDFLARE_CAPABILITIES,
        [],
      ),
    ).toEqual([]);
  });

  it('reports an absent driver with the supported list', () => {
    const found = onlyFinding(graph([node('sql-query', { statement: 'select 1' })]));

    expect(found.message).toContain('declares no SQL driver');
    expect(found.message).toContain('mssql');
  });
});

// ── connections ──────────────────────────────────────────────────────────────

describe('connection findings', () => {
  it('names an unknown connection and the host', () => {
    const found = onlyFinding(
      graph([node('http-request', { url: 'https://api.example.com/v1', connectionId: 'conn-gone' })]),
    );

    expect(found.severity).toBe('error');
    expect(found.message).toContain('conn-gone');
    expect(found.message).toContain('not configured');
    expect(found.message).toContain(TAURI_DESKTOP_CAPABILITIES.label);
  });

  it('names a connection type the host cannot hold', () => {
    const found = onlyFinding(
      graph([node('http-request', { url: 'https://api.example.com/v1', connectionId: 'conn-api' })]),
      BROWSER_CAPABILITIES,
      [connection()],
    );

    expect(found.message).toContain('Billing API');
    expect(found.message).toContain('http');
    expect(found.message).toContain(BROWSER_CAPABILITIES.label);
  });

  it('names the absent secret keys when the store holds fewer than declared', () => {
    const found = onlyFinding(
      graph([node('http-request', { url: 'https://api.example.com/v1', connectionId: 'conn-api' })]),
      TAURI_DESKTOP_CAPABILITIES,
      [connection({ secretKeys: ['clientId', 'clientSecret'], secretsPresent: 1 })],
    );

    expect(found.severity).toBe('error');
    expect(found.message).toContain('missing 1 of 2');
    expect(found.message).toContain('clientId, clientSecret');
    expect(found.message).toContain(TAURI_DESKTOP_CAPABILITIES.label);
  });

  it('raises nothing when every declared secret is present', () => {
    expect(
      validateAgainstCapabilities(
        spec(graph([node('http-request', { url: 'https://a.example.com', connectionId: 'conn-api' })])),
        TAURI_DESKTOP_CAPABILITIES,
        [connection({ secretKeys: ['token'], secretsPresent: 1 })],
      ),
    ).toEqual([]);
  });

  it('reports a connection reference that is not a string', () => {
    const found = onlyFinding(
      graph([node('http-request', { url: 'https://api.example.com', connectionId: 42 })]),
    );

    expect(found.message).toContain('not a connection id');
  });
});

// ── expressions ──────────────────────────────────────────────────────────────

describe('expression findings', () => {
  it('names the transform field and the failing expression position', () => {
    const found = onlyFinding(
      graph([
        node('transform', {
          fields: [{ target: 'total', expression: 'input.amount +' }],
        }),
      ]),
    );

    expect(found.severity).toBe('error');
    expect(found.message).toContain('field "total"');
    expect(found.message).toContain('"transform step"');
    expect(found.message).toMatch(/position \d+/);
  });

  it('names an assert assertion, a state-set value expression and a sql parameter', () => {
    const findings = validateAgainstCapabilities(
      spec(
        graph([
          node('assert', { assertions: [{ name: 'rows present', expression: 'count(' }] }, { id: 'a' }),
          node('state-set', { key: 'k', valueExpression: '*' }, { id: 'b' }),
          node(
            'sql-query',
            { driver: 'postgres', statement: 'select 1', params: [{ name: 'since', expression: '(' }] },
            { id: 'c' },
          ),
        ]),
      ),
      TAURI_DESKTOP_CAPABILITIES,
      [],
    );

    expect(findings.map((f) => f.nodeId)).toEqual(['a', 'b', 'c']);
    expect(findings[0]!.message).toContain('assertion "rows present"');
    expect(findings[1]!.message).toContain('the value expression');
    expect(findings[2]!.message).toContain('parameter ":since"');
    expect(findings.every((f) => f.severity === 'error')).toBe(true);
  });

  it('reports an absent expression instead of throwing', () => {
    const found = onlyFinding(graph([node('state-set', { key: 'k' })]));

    expect(found.severity).toBe('error');
    expect(found.message).toContain('the value expression');
  });

  it('accepts every expression the evaluator accepts', () => {
    expect(
      validateAgainstCapabilities(
        spec(
          graph([
            node('transform', { fields: [{ target: 'total', expression: 'input.amount * 2' }] }),
          ]),
        ),
        TAURI_DESKTOP_CAPABILITIES,
        [],
      ),
    ).toEqual([]);
  });
});

// ── egress collection ────────────────────────────────────────────────────────

describe('declared egress collection', () => {
  it('collects distinct hosts, lower-cased, in first-occurrence order', () => {
    const hosts = collectEgressHosts(
      spec(
        graph([
          node('http-request', { url: 'https://API.Example.com/v1/items' }, { id: 'h1' }),
          node('http-request', { url: 'https://api.example.com:8443/v2/items' }, { id: 'h2' }),
          node('http-request', { url: 'https://user:pw@other.example.org/hook' }, { id: 'h3' }),
        ]),
      ),
      TAURI_DESKTOP_CAPABILITIES,
      [],
    );

    expect(hosts).toEqual(['api.example.com', 'other.example.org']);
  });

  it('resolves a relative url through the connection base url', () => {
    const hosts = collectEgressHosts(
      spec(graph([node('http-request', { url: '/v1/items', connectionId: 'conn-api' })])),
      TAURI_DESKTOP_CAPABILITIES,
      [connection({ config: { baseUrl: 'https://billing.example.com/api' } })],
    );

    expect(hosts).toEqual(['billing.example.com']);
  });

  it('collects the SQL host from the connection configuration', () => {
    const hosts = collectEgressHosts(
      spec(
        graph([
          node('sql-query', {
            driver: 'postgres',
            statement: 'select 1',
            connectionId: 'conn-db',
          }),
        ]),
      ),
      TAURI_DESKTOP_CAPABILITIES,
      [
        connection({
          id: 'conn-db',
          type: 'sql',
          config: { driver: 'postgres', host: 'DB.internal.example.com', port: '5432' },
        }),
      ],
    );

    expect(hosts).toEqual(['db.internal.example.com']);
  });

  it('collects nothing from nodes that declare no outbound host', () => {
    expect(
      collectEgressHosts(
        spec(
          graph([
            node('transform', { fields: [] }, { id: 't' }),
            node('state-get', { key: 'wm' }, { id: 's' }),
          ]),
        ),
        TAURI_DESKTOP_CAPABILITIES,
        [],
      ),
    ).toEqual([]);
  });

  it('warns and omits the host when a url is not statically determinable', () => {
    const report = inspectAgainstCapabilities(
      spec(
        graph([
          node('http-request', { url: 'https://{{input.tenant}}.example.com/v1' }, { id: 'tpl' }),
          node('http-request', { url: '/v1/items' }, { id: 'rel' }),
        ]),
      ),
      TAURI_DESKTOP_CAPABILITIES,
      [],
    );

    expect(report.egressHosts).toEqual([]);
    expect(report.findings).toHaveLength(2);
    for (const found of report.findings) {
      expect(found.severity).toBe('warning');
      expect(found.message).toContain('not statically determinable');
      expect(found.message).toContain('omitted from the declared egress list');
    }
    expect(report.findings.map((f) => f.nodeId)).toEqual(['tpl', 'rel']);
  });

  it('returns warnings without any error, so a run is not blocked (Requirement 17.15)', () => {
    const findings = validateAgainstCapabilities(
      spec(graph([node('http-request', { url: '{{input.url}}' })])),
      TAURI_DESKTOP_CAPABILITIES,
      [],
    );

    expect(findings.some((f) => f.severity === 'error')).toBe(false);
    expect(findings.map((f) => f.severity)).toEqual(['warning']);
  });

  it('collects egress and findings in one walk, agreeing with both thin views', () => {
    const target = spec(
      graph([
        node('http-request', { url: 'https://api.example.com/v1' }, { id: 'ok' }),
        node('sql-query', { driver: 'mssql', statement: 'select 1' }, { id: 'bad' }),
      ]),
    );
    const report = inspectAgainstCapabilities(target, CLOUDFLARE_CAPABILITIES, []);

    expect(report.findings).toEqual(
      validateAgainstCapabilities(target, CLOUDFLARE_CAPABILITIES, []),
    );
    expect(report.egressHosts).toEqual(collectEgressHosts(target, CLOUDFLARE_CAPABILITIES, []));
    expect(report.egressHosts).toEqual(['api.example.com']);
    expect(report.findings).toHaveLength(1);
  });
});
