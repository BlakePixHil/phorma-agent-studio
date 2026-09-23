import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  ALL_NODE_KINDS,
  AWS_CAPABILITIES,
  BROWSER_CAPABILITIES,
  CLOUDFLARE_CAPABILITIES,
  HOST_CAPABILITIES,
  TAURI_DESKTOP_CAPABILITIES,
  validateAgainstCapabilities,
  type CapabilityFinding,
  type CapabilityValidationTarget,
} from './capabilities.js';
import type { ConnectionSummary, ConnectionType } from './connections.js';
import type { HostCapabilities } from './data-host.js';
import { DATA_NODE_KINDS, type SqlDriver, type WorkflowGraph, type WorkflowNode } from './types.js';

/**
 * Host capability declarations (Requirements 17.1, 17.2, 17.3).
 *
 * These records are the single source of truth for what each host can run, so
 * the shape of every record and the deliberate omissions (browser SQL, worker
 * MSSQL) are worth pinning: a silent widening here is a run that fails at 3am.
 */

const FEATURE_FLAGS = [
  'cron',
  'durableState',
  'fixtures',
  'privateNetworkEgress',
  'stdioMcp',
  'mcpOAuth',
  'decisions',
] as const;

const RECORDS: ReadonlyArray<readonly [string, HostCapabilities]> = [
  ['desktop', TAURI_DESKTOP_CAPABILITIES],
  ['browser', BROWSER_CAPABILITIES],
  ['worker', CLOUDFLARE_CAPABILITIES],
  ['aws', AWS_CAPABILITIES],
];

describe('host capability records', () => {
  it('declares exactly one record per host with distinct ids', () => {
    expect(Object.keys(HOST_CAPABILITIES).sort()).toEqual([
      'aws-fargate',
      'browser',
      'cloudflare-worker',
      'tauri-desktop',
    ]);
    expect(new Set(RECORDS.map(([, record]) => record.id)).size).toBe(4);
  });

  it.each(RECORDS)('%s declares an id, a label and every feature flag', (_name, record) => {
    expect(record.id.length).toBeGreaterThan(0);
    expect(record.label.length).toBeGreaterThan(0);
    expect(Object.keys(record.features).sort()).toEqual([...FEATURE_FLAGS].sort());
    for (const flag of FEATURE_FLAGS) {
      expect(typeof record.features[flag]).toBe('boolean');
    }
  });

  it.each(RECORDS)('%s declares only known node kinds', (_name, record) => {
    for (const kind of record.nodeKinds) {
      expect(ALL_NODE_KINDS as readonly string[]).toContain(kind);
    }
  });

  it('gives the desktop host every node kind, every driver and every connection type', () => {
    expect([...TAURI_DESKTOP_CAPABILITIES.nodeKinds]).toEqual([...ALL_NODE_KINDS]);
    expect([...TAURI_DESKTOP_CAPABILITIES.sqlDrivers].sort()).toEqual([
      'mssql',
      'mysql',
      'postgres',
      'sqlite',
    ]);
    expect([...TAURI_DESKTOP_CAPABILITIES.connectionTypes].sort()).toEqual([
      'aws-sigv4',
      'http',
      'oauth2',
      'smtp',
      'sql',
    ]);
  });

  it('excludes only sql-query from the browser host and gives it no credentials', () => {
    expect(BROWSER_CAPABILITIES.nodeKinds).not.toContain('sql-query');
    expect([...BROWSER_CAPABILITIES.nodeKinds]).toEqual(
      ALL_NODE_KINDS.filter((kind) => kind !== 'sql-query'),
    );
    expect(BROWSER_CAPABILITIES.sqlDrivers).toEqual([]);
    expect(BROWSER_CAPABILITIES.connectionTypes).toEqual([]);
    // Every other data node still runs in preview.
    for (const kind of DATA_NODE_KINDS.filter((k) => k !== 'sql-query')) {
      expect(BROWSER_CAPABILITIES.nodeKinds).toContain(kind);
    }
  });

  it('declares exactly postgres and mysql for the worker, and mssql for the desktop and AWS only', () => {
    expect([...CLOUDFLARE_CAPABILITIES.sqlDrivers]).toEqual(['postgres', 'mysql']);
    expect([...CLOUDFLARE_CAPABILITIES.nodeKinds]).toEqual([...ALL_NODE_KINDS]);
    const withMssql = RECORDS.filter(([, record]) => record.sqlDrivers.includes('mssql'));
    expect(withMssql.map(([name]) => name).sort()).toEqual(['aws', 'desktop']);
  });

  it('makes cron a deployed-host feature only', () => {
    expect(CLOUDFLARE_CAPABILITIES.features.cron).toBe(true);
    expect(AWS_CAPABILITIES.features.cron).toBe(true);
    expect(TAURI_DESKTOP_CAPABILITIES.features.cron).toBe(false);
    expect(BROWSER_CAPABILITIES.features.cron).toBe(false);
  });

  it('makes mcpOAuth false on deployed hosts - an OAuth session never leaves the device that signed in', () => {
    expect(TAURI_DESKTOP_CAPABILITIES.features.mcpOAuth).toBe(true);
    expect(BROWSER_CAPABILITIES.features.mcpOAuth).toBe(true);
    expect(CLOUDFLARE_CAPABILITIES.features.mcpOAuth).toBe(false);
    expect(AWS_CAPABILITIES.features.mcpOAuth).toBe(false);
  });

  it('AWS_CAPABILITIES declares every field correctly (Requirement 16.7)', () => {
    expect(AWS_CAPABILITIES.id).toBe('aws-fargate');
    expect(AWS_CAPABILITIES.label).toBe('AWS (ECS Fargate)');
    expect([...AWS_CAPABILITIES.nodeKinds]).toEqual([...ALL_NODE_KINDS]);
    expect([...AWS_CAPABILITIES.sqlDrivers]).toEqual(['postgres', 'mysql', 'mssql', 'sqlite']);
    expect([...AWS_CAPABILITIES.connectionTypes].sort()).toEqual([
      'aws-sigv4',
      'http',
      'oauth2',
      'smtp',
      'sql',
    ]);
    expect(AWS_CAPABILITIES.connectionSecretScheme).toBe('aws-secrets-manager');
    expect(AWS_CAPABILITIES.features).toEqual({
      cron: true,
      durableState: true,
      fixtures: true,
      privateNetworkEgress: true,
      stdioMcp: false,
      mcpOAuth: false,
      decisions: true,
    });
  });

  it('secretRemedy for aws-secrets-manager names the exact Secrets Manager entry to create', () => {
    // Build a minimal spec with one node referencing a connection whose secret is missing.
    const spec = {
      graph: {
        nodes: [
          {
            id: 'n1',
            name: 'Fetch data',
            kind: 'http-request',
            category: 'data',
            icon: 'ti ti-world',
            position: { x: 0, y: 0 },
            ports: [],
            data: { connectionId: 'conn-test-123', url: 'https://example.com/api' },
          },
        ],
        connections: [],
      },
      subWorkflows: {},
    };

    const inventory: ConnectionSummary[] = [
      {
        id: 'conn-test-123',
        name: 'My API',
        type: 'http',
        config: {},
        secretKeys: ['apiKey', 'authToken'],
        secretsPresent: 0,
        missingSecretKeys: ['apiKey', 'authToken'],
        auth: { mode: 'none' },
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ];

    const findings = validateAgainstCapabilities(spec, AWS_CAPABILITIES, inventory);
    const secretFinding = findings.find((f) => f.message.includes('missing'));
    expect(secretFinding).toBeDefined();
    // The remedy names the Secrets Manager entry path
    expect(secretFinding!.message).toContain('AWS Secrets Manager');
    expect(secretFinding!.message).toContain('phorma/conn/conn-test-123/apiKey');
    expect(secretFinding!.message).toContain('phorma/conn/conn-test-123/authToken');
    // The remedy includes an AWS CLI command
    expect(secretFinding!.message).toContain(
      'aws secretsmanager create-secret --name phorma/conn/conn-test-123/apiKey',
    );
  });
});


// ─────────────────────────────────────────────────────────────────────────────
// Property 32 (validator half): Capability findings gate a push identically
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Property 32: Capability findings gate a push identically on both sides
 * (validator half)
 *
 * The gating rule is: error findings present = blocked, no error findings =
 * allowed. Warnings never gate. This test generates arbitrary workflow specs and
 * connection inventories, runs `validateAgainstCapabilities` against
 * `AWS_CAPABILITIES`, and asserts that the gating decision follows exclusively
 * from the presence or absence of error-severity findings.
 *
 * **Validates: Requirements 16.3, 16.4, 16.5, 16.6, 16.8**
 */

// ── Generators for Property 32 ──────────────────────────────────────────────

const CONNECTION_TYPES_P32: readonly ConnectionType[] = ['http', 'oauth2', 'sql', 'aws-sigv4', 'smtp'];
const SQL_DRIVERS_P32: readonly SqlDriver[] = ['postgres', 'mysql', 'mssql', 'sqlite'];

/** Generate a minimal valid WorkflowNode with the given kind and data. */
function makeNode(
  id: string,
  kind: string,
  data: Record<string, unknown> = {},
): WorkflowNode {
  return {
    id,
    name: `${kind} node`,
    kind,
    category: 'flow',
    icon: 'ti ti-box',
    position: { x: 0, y: 0 },
    ports: [{ id: `${id}-p`, name: 'In', role: 'message-in' }],
    data,
  };
}

/** Generates a ConnectionSummary with the given type and optional missing secrets. */
function makeConnectionSummary(
  id: string,
  type: ConnectionType,
  secretKeyCount: number,
  missingCount: number,
): ConnectionSummary {
  const secretKeys = Array.from({ length: secretKeyCount }, (_, i) => `key${i}`);
  const missingSecretKeys = secretKeys.slice(0, missingCount);
  return {
    id,
    name: `Connection ${id}`,
    type,
    config: { baseUrl: 'https://api.example.com' },
    secretKeys,
    secretsPresent: Math.max(0, secretKeyCount - missingCount),
    missingSecretKeys,
    auth: { mode: 'none' },
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
  };
}

/** Arbitrary for node kinds. Includes a non-existent kind to produce errors. */
const nodeKindArb: fc.Arbitrary<string> = fc.oneof(
  { weight: 8, arbitrary: fc.constantFrom<string>(...ALL_NODE_KINDS) },
  { weight: 1, arbitrary: fc.constant('nonexistent-kind') },
);

/** Arbitrary for SQL drivers, including one excluded from some hosts. */
const sqlDriverArb: fc.Arbitrary<SqlDriver | undefined> = fc.oneof(
  { weight: 3, arbitrary: fc.constantFrom<SqlDriver>(...SQL_DRIVERS_P32) },
  { weight: 2, arbitrary: fc.constant(undefined) },
);

/** Arbitrary for connection types. */
const connectionTypeArb: fc.Arbitrary<ConnectionType> = fc.constantFrom(...CONNECTION_TYPES_P32);

/**
 * Arbitrary for a connection reference: either referencing an existing connection,
 * referencing an unknown id, or no reference at all.
 */
type ConnRef = 'none' | 'unknown' | number;
const connRefArb: fc.Arbitrary<ConnRef> = fc.oneof(
  { weight: 4, arbitrary: fc.constant<ConnRef>('none') },
  { weight: 2, arbitrary: fc.constant<ConnRef>('unknown') },
  { weight: 3, arbitrary: fc.nat({ max: 3 }) },
);

/** Arbitrary generating a spec that may or may not trigger error findings. */
const specPlanArb = fc.record({
  nodeCount: fc.integer({ min: 1, max: 5 }),
  kinds: fc.array(nodeKindArb, { minLength: 1, maxLength: 5 }),
  drivers: fc.array(sqlDriverArb, { minLength: 1, maxLength: 5 }),
  connRefs: fc.array(connRefArb, { minLength: 1, maxLength: 5 }),
  connectionPlans: fc.array(
    fc.record({
      type: connectionTypeArb,
      secretKeyCount: fc.integer({ min: 0, max: 3 }),
      missingCount: fc.integer({ min: 0, max: 3 }),
    }),
    { minLength: 0, maxLength: 3 },
  ),
});

/** Build the spec and inventory from a plan, then validate against AWS_CAPABILITIES. */
function validatePlan(plan: typeof specPlanArb extends fc.Arbitrary<infer T> ? T : never): {
  findings: CapabilityFinding[];
  spec: CapabilityValidationTarget;
  inventory: ConnectionSummary[];
} {
  // Build inventory
  const inventory: ConnectionSummary[] = plan.connectionPlans.map((cp, i) =>
    makeConnectionSummary(`conn-c${i}`, cp.type, cp.secretKeyCount, cp.missingCount),
  );

  // Build nodes
  const nodes: WorkflowNode[] = [];
  for (let i = 0; i < plan.nodeCount; i++) {
    const kind = plan.kinds[i % plan.kinds.length];
    const driver = plan.drivers[i % plan.drivers.length];
    const connRef = plan.connRefs[i % plan.connRefs.length];

    const data: Record<string, unknown> = {};
    if (kind === 'sql-query' && driver) {
      data['driver'] = driver;
    }
    if (kind === 'http-request') {
      data['url'] = 'https://example.com/api';
    }
    // Wire up connection reference
    if (connRef === 'unknown') {
      data['connectionId'] = 'conn-never-configured';
    } else if (typeof connRef === 'number' && inventory.length > 0) {
      data['connectionId'] = inventory[connRef % inventory.length].id;
    }
    nodes.push(makeNode(`n${i}`, kind, data));
  }

  const spec: CapabilityValidationTarget = {
    graph: { nodes, connections: [] },
  };

  const findings = validateAgainstCapabilities(spec, AWS_CAPABILITIES, inventory);
  return { findings, spec, inventory };
}

/** The gating decision: a push is blocked exactly when error findings are present. */
function isBlocked(findings: readonly CapabilityFinding[]): boolean {
  return findings.some((f) => f.severity === 'error');
}

describe('Property 32 (validator half): capability findings gate a push', () => {
  /**
   * The three plan conditions that MUST stop a push to an AWS host. Each is a
   * separate one-directional claim keyed off the plan the test built, not off
   * the findings it is checking.
   *
   * The previous version of this block asserted
   * `expect(isBlocked(findings)).toBe(findings.some(f => f.severity === 'error'))`
   * with `isBlocked` defined as exactly that `some(...)` call - 190 lines of
   * generators feeding `x === x`. It held for a validator that returned no
   * findings at all, which is the one outcome that must never be accepted from
   * a deploy gate.
   */
  it('blocks a push when a node references a connection that is not configured', () => {
    fc.assert(
      fc.property(specPlanArb, (plan) => {
        // Kinds pinned to a supported one so the unknown reference is the ONLY
        // possible cause and the message can be asserted, not just the outcome.
        const { findings } = validatePlan({
          ...plan,
          kinds: ['http-request'],
          connRefs: ['unknown'],
        });

        expect(isBlocked(findings)).toBe(true);
        const unknownRef = findings.filter(
          (f) => f.severity === 'error' && f.message.includes('conn-never-configured'),
        );
        expect(unknownRef.length).toBeGreaterThan(0);
      }),
      { numRuns: 100 },
    );
  });

  it('blocks a push when a referenced connection is missing a secret', () => {
    fc.assert(
      fc.property(specPlanArb, (plan) => {
        // One connection, every declared secret absent, and every node bound to
        // it: a deploy that proceeded here would fail at first run instead.
        const { findings } = validatePlan({
          ...plan,
          kinds: ['http-request'],
          connRefs: [0],
          connectionPlans: [{ type: 'http', secretKeyCount: 2, missingCount: 2 }],
        });

        expect(isBlocked(findings)).toBe(true);
        expect(
          findings.some((f) => f.severity === 'error' && f.message.includes('missing 2 of 2')),
        ).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it('blocks a push containing a node kind no host declares', () => {
    fc.assert(
      fc.property(specPlanArb, (plan) => {
        const { findings } = validatePlan({ ...plan, kinds: ['nonexistent-kind'] });

        expect(isBlocked(findings)).toBe(true);
        expect(findings.some((f) => f.severity === 'error')).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it('does NOT block on a warning alone', () => {
    // An interpolated url is genuinely unknowable at design time: it earns a
    // warning (the host is omitted from the egress list) and must still deploy.
    const spec: CapabilityValidationTarget = {
      graph: {
        nodes: [makeNode('n0', 'http-request', { url: 'https://{{input.host}}/api' })],
        connections: [],
      },
    };
    const findings = validateAgainstCapabilities(spec, AWS_CAPABILITIES, []);

    expect(findings.length).toBeGreaterThan(0);
    expect(findings.every((f) => f.severity === 'warning')).toBe(true);
    expect(isBlocked(findings)).toBe(false);
  });

  it('every finding carries exactly error or warning severity', () => {
    fc.assert(
      fc.property(specPlanArb, (plan) => {
        const { findings } = validatePlan(plan);
        for (const f of findings) {
          expect(['error', 'warning']).toContain(f.severity);
        }
      }),
      { numRuns: 100 },
    );
  });

  it('the gating decision is deterministic for a given spec and inventory', () => {
    fc.assert(
      fc.property(specPlanArb, (plan) => {
        const { findings: first } = validatePlan(plan);
        const { findings: second } = validatePlan(plan);
        expect(isBlocked(first)).toBe(isBlocked(second));
        // Findings themselves are identical
        expect(first).toEqual(second);
      }),
      { numRuns: 100 },
    );
  });
});
