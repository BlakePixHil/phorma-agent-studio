import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { deriveEgressAllowList, type EgressAllowList } from './egress.js';
import type { CapabilityValidationTarget } from './capabilities.js';
import type { ConnectionSummary, ConnectionType } from './connections.js';
import type { ModelProviderId, WorkflowGraph, WorkflowNode } from './types.js';

/**
 * Property 27: The egress allow-list is deduped, ordered, capped and honest
 * about what it cannot derive.
 *
 * Claims:
 *  1. Hosts are deduped (no duplicates case-insensitively).
 *  2. Hosts are ordered (alphabetical).
 *  3. Hosts are capped at 200 (`capped` flag is true when entries dropped).
 *  4. Undeterminable entries are honest about interpolated hostnames.
 *  5. All hosts are lower-cased.
 *
 * **Validates: Requirements 10.4, 10.5, 10.12**
 */

// ─────────────────────────────────────────────────────────────────────────────
// Generators
// ─────────────────────────────────────────────────────────────────────────────

/** A valid hostname segment (lowercase alpha + digits, 1-12 chars). */
const segmentArb = fc.stringMatching(/^[a-z0-9]{1,12}$/);

/** A realistic hostname like `api.example.com`. */
const hostnameArb = fc.tuple(segmentArb, segmentArb, segmentArb).map(
  ([sub, domain, tld]) => `${sub}.${domain}.${tld}`,
);

/** A hostname with mixed case to test case-insensitive dedup. */
const mixedCaseHostnameArb = hostnameArb.map((host) =>
  host.split('').map((c, i) => (i % 2 === 0 ? c.toUpperCase() : c)).join(''),
);

/** All providers, some with static hosts and some without. */
const ALL_PROVIDERS: ModelProviderId[] = [
  'anthropic', 'openai', 'gemini', 'openrouter', 'phorma-cloud',
  'ollama', 'lmstudio', 'bedrock',
];

const providerArb = fc.constantFrom(...ALL_PROVIDERS);

/** Build an http-request node with a static URL. */
function httpNode(id: string, url: string): WorkflowNode {
  return {
    id,
    name: `HTTP ${id}`,
    kind: 'http-request',
    category: 'data',
    icon: 'ti ti-world',
    position: { x: 0, y: 0 },
    ports: [{ id: `${id}-p0`, name: 'out', role: 'message-out' }],
    data: { url, method: 'GET' },
  };
}

/** Build an http-request node with an interpolated URL (non-determinable). */
function interpolatedHttpNode(id: string): WorkflowNode {
  return {
    id,
    name: `Interpolated ${id}`,
    kind: 'http-request',
    category: 'data',
    icon: 'ti ti-world',
    position: { x: 0, y: 0 },
    ports: [{ id: `${id}-p0`, name: 'out', role: 'message-out' }],
    data: { url: 'https://{{input.host}}/api/data', method: 'GET' },
  };
}

/** Build a sql-query node bound to a connection, for the connection egress path. */
function sqlNode(id: string, connectionId: string): WorkflowNode {
  return {
    id,
    name: `SQL ${id}`,
    kind: 'sql-query',
    category: 'data',
    icon: 'ti ti-database',
    position: { x: 0, y: 0 },
    ports: [{ id: `${id}-p0`, name: 'out', role: 'message-out' }],
    data: { connectionId, statement: 'select 1' },
  };
}

/** A non-secret connection summary, the shape the studio hands to validation. */
function connection(overrides: Partial<ConnectionSummary> = {}): ConnectionSummary {
  return {
    id: 'conn-db',
    name: 'Warehouse',
    type: 'sql' as ConnectionType,
    config: { driver: 'postgres' },
    secretKeys: [],
    secretsPresent: 0,
    auth: { mode: 'none' },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/** The derived host list for a single http node - the common assertion shape. */
function hostsFor(url: string): string[] {
  return deriveEgressAllowList({
    specs: [buildSpec([httpNode('n1', url)])],
    connections: NO_CONNECTIONS,
    providers: [],
  }).hosts;
}

/** Build a minimal graph from a set of nodes. */
function buildGraph(nodes: WorkflowNode[]): WorkflowGraph {
  return { nodes, connections: [] };
}

/** Build a CapabilityValidationTarget from nodes. */
function buildSpec(nodes: WorkflowNode[]): CapabilityValidationTarget {
  return { graph: buildGraph(nodes) };
}

/** Empty connections list. */
const NO_CONNECTIONS: ConnectionSummary[] = [];

// ─────────────────────────────────────────────────────────────────────────────
// Properties
// ─────────────────────────────────────────────────────────────────────────────

describe('deriveEgressAllowList - Property 27', () => {
  it('hosts are deduped case-insensitively', () => {
    fc.assert(
      fc.property(
        fc.array(hostnameArb, { minLength: 1, maxLength: 30 }),
        fc.array(providerArb, { minLength: 0, maxLength: 5 }),
        (hostnames, providers) => {
          // Create duplicates by adding the same host in different cases.
          const duplicated = hostnames.flatMap((h) => [h, h.toUpperCase(), h.toLowerCase()]);
          const nodes = duplicated.map((h, i) => httpNode(`n${i}`, `https://${h}/path`));
          const spec = buildSpec(nodes);

          const result = deriveEgressAllowList({
            specs: [spec],
            connections: NO_CONNECTIONS,
            providers,
          });

          // No duplicates when compared case-insensitively.
          const lowered = result.hosts.map((h) => h.toLowerCase());
          expect(new Set(lowered).size).toBe(lowered.length);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('hosts are ordered alphabetically', () => {
    fc.assert(
      fc.property(
        fc.array(hostnameArb, { minLength: 2, maxLength: 50 }),
        fc.array(providerArb, { minLength: 0, maxLength: 8 }),
        (hostnames, providers) => {
          const nodes = hostnames.map((h, i) => httpNode(`n${i}`, `https://${h}/`));
          const spec = buildSpec(nodes);

          const result = deriveEgressAllowList({
            specs: [spec],
            connections: NO_CONNECTIONS,
            providers,
          });

          const sorted = [...result.hosts].sort();
          expect(result.hosts).toEqual(sorted);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('hosts are capped at 200 and capped flag reflects overflow', () => {
    fc.assert(
      fc.property(
        // Generate between 195 and 210 unique hostnames to straddle the cap.
        fc.integer({ min: 195, max: 210 }),
        fc.array(providerArb, { minLength: 0, maxLength: 4 }),
        (count, providers) => {
          // Build unique hosts - deterministic from index to avoid dedup eating count.
          const nodes = Array.from({ length: count }, (_, i) =>
            httpNode(`n${i}`, `https://host${String(i).padStart(5, '0')}.example.com/`),
          );
          const spec = buildSpec(nodes);

          const result = deriveEgressAllowList({
            specs: [spec],
            connections: NO_CONNECTIONS,
            providers,
          });

          expect(result.hosts.length).toBeLessThanOrEqual(200);

          // How many hosts these providers contribute, taken from the function
          // itself rather than a mirrored table: a copied PROVIDER_HOSTS oracle
          // shares any bug in the real one, so it cannot detect a wrong host.
          const providerOnly = deriveEgressAllowList({
            specs: [buildSpec([])],
            connections: NO_CONNECTIONS,
            providers,
          }).hosts;
          const uniqueTotal = count + providerOnly.length;

          if (uniqueTotal > 200) {
            expect(result.capped).toBe(true);
            expect(result.hosts.length).toBe(200);
          } else {
            expect(result.capped).toBe(false);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('undeterminable entries are reported for interpolated hostnames', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 5 }),
        fc.integer({ min: 1, max: 5 }),
        (staticCount, interpolatedCount) => {
          const staticNodes = Array.from({ length: staticCount }, (_, i) =>
            httpNode(`s${i}`, `https://static${i}.example.com/`),
          );
          const interpNodes = Array.from({ length: interpolatedCount }, (_, i) =>
            interpolatedHttpNode(`i${i}`),
          );
          const spec = buildSpec([...staticNodes, ...interpNodes]);

          const result = deriveEgressAllowList({
            specs: [spec],
            connections: NO_CONNECTIONS,
            providers: [],
          });

          // At least one undeterminable entry for the interpolated nodes.
          expect(result.undeterminable.length).toBeGreaterThanOrEqual(1);

          // Each undeterminable has a message.
          for (const entry of result.undeterminable) {
            expect(entry.message.length).toBeGreaterThan(0);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('all hosts are lower-cased', () => {
    fc.assert(
      fc.property(
        fc.array(mixedCaseHostnameArb, { minLength: 1, maxLength: 30 }),
        fc.array(providerArb, { minLength: 0, maxLength: 8 }),
        (hostnames, providers) => {
          const nodes = hostnames.map((h, i) => httpNode(`n${i}`, `https://${h}/api`));
          const spec = buildSpec(nodes);

          const result = deriveEgressAllowList({
            specs: [spec],
            connections: NO_CONNECTIONS,
            providers,
          });

          for (const host of result.hosts) {
            expect(host).toBe(host.toLowerCase());
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('the empty-list case writes no hosts and capped is false', () => {
    // Providers that yield no static host (ollama, lmstudio, bedrock) plus
    // no spec nodes produces an empty list.
    fc.assert(
      fc.property(
        fc.subarray(['ollama', 'lmstudio', 'bedrock'] as ModelProviderId[], {
          minLength: 0,
          maxLength: 3,
        }),
        (providers) => {
          const result = deriveEgressAllowList({
            specs: [buildSpec([])],
            connections: NO_CONNECTIONS,
            providers,
          });

          expect(result.hosts).toEqual([]);
          expect(result.capped).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Contents of the allow-list
//
// The properties above constrain the SHAPE of the list (deduped, ordered,
// capped, lower-cased) and every one of them holds for an empty list. Nothing
// there asserts WHICH hosts a deploy is permitted to reach - so a wrong or
// hostile hostname passes them all. These cases pin the contents.
// ─────────────────────────────────────────────────────────────────────────────

describe('deriveEgressAllowList - provider endpoints', () => {
  it.each([
    ['anthropic', ['api.anthropic.com']],
    ['openai', ['api.openai.com']],
    ['openrouter', ['openrouter.ai']],
    ['gemini', ['generativelanguage.googleapis.com']],
    ['phorma-cloud', ['openrouter.ai']],
    // Local servers and VPC-endpoint providers are not internet egress.
    ['ollama', []],
    ['lmstudio', []],
    ['bedrock', []],
  ] as [ModelProviderId, string[]][])('%s contributes exactly %j', (provider, expected) => {
    const result = deriveEgressAllowList({
      specs: [buildSpec([])],
      connections: NO_CONNECTIONS,
      providers: [provider],
    });

    // Literal expectations on purpose: this list becomes a firewall rule, and a
    // hostname typo or a swapped entry is a silent hole rather than a failure.
    expect(result.hosts).toEqual(expected);
    expect(result.capped).toBe(false);
  });

  it('a local provider adds nothing even alongside a hosted one', () => {
    const result = deriveEgressAllowList({
      specs: [buildSpec([])],
      connections: NO_CONNECTIONS,
      providers: ['anthropic', 'ollama', 'lmstudio', 'bedrock'],
    });

    expect(result.hosts).toEqual(['api.anthropic.com']);
  });

  it('collapses two providers sharing one endpoint into a single host', () => {
    const result = deriveEgressAllowList({
      specs: [buildSpec([])],
      connections: NO_CONNECTIONS,
      providers: ['openrouter', 'phorma-cloud'],
    });

    expect(result.hosts).toEqual(['openrouter.ai']);
  });
});

describe('deriveEgressAllowList - the host a request will actually reach', () => {
  it('takes the hostname from a plain absolute url', () => {
    expect(hostsFor('https://api.acme.test/v1/things')).toEqual(['api.acme.test']);
  });

  it.each([
    // Userinfo decoy: the request goes to evil.test, so the allow-list must
    // name evil.test. Allow-listing the pre-@ label would authorise a host the
    // traffic never reaches while leaving the real destination undeclared.
    ['userinfo before the host', 'https://api.acme.test@evil.test/v1', 'evil.test'],
    ['an explicit port', 'https://api.acme.test:8443/v1', 'api.acme.test'],
    ['userinfo with a password and a port', 'https://user:pw@evil.test:9000/x', 'evil.test'],
    ['mixed case', 'https://API.Acme.TEST/v1', 'api.acme.test'],
    ['an ipv4 literal', 'http://203.0.113.7/metrics', '203.0.113.7'],
    // Cloud metadata: it must be DECLARED, not silently dropped, so a reviewer
    // sees it on the allow-list before the deploy goes out.
    ['the cloud metadata address', 'http://169.254.169.254/latest/meta-data/', '169.254.169.254'],
    ['an ipv6 literal', 'http://[2001:db8::1]:8080/x', '[2001:db8::1]'],
  ])('resolves %s to the real destination', (_label, url, expected) => {
    expect(hostsFor(url)).toEqual([expected]);
  });

  it.each([
    ['a scheme-less value', 'api.acme.test'],
    ['a relative path', '/v1/things'],
  ])('declares nothing for %s with no connection to resolve it against', (_label, url) => {
    // Without a connection there is no base url, so the destination genuinely
    // is not knowable at design time. It must surface as undeterminable rather
    // than be guessed at - a guessed host is a firewall rule nobody verified.
    const result = deriveEgressAllowList({
      specs: [buildSpec([httpNode('n1', url)])],
      connections: NO_CONNECTIONS,
      providers: [],
    });

    expect(result.hosts).toEqual([]);
    expect(result.undeterminable).toHaveLength(1);
  });

  it('resolves a relative node url against the connection base url', () => {
    const result = deriveEgressAllowList({
      specs: [buildSpec([httpNode('n1', '/v1/things')])],
      connections: [
        connection({
          id: 'conn-db',
          type: 'http' as ConnectionType,
          config: { baseUrl: 'https://api.billing.test/v1' },
        }),
      ],
      providers: [],
    });

    // The node in this spec names no connectionId, so nothing resolves: proves
    // the base url is reached THROUGH the binding, not from any connection.
    expect(result.hosts).toEqual([]);

    const bound = deriveEgressAllowList({
      specs: [
        buildSpec([
          {
            ...httpNode('n1', '/v1/things'),
            data: { url: '/v1/things', method: 'GET', connectionId: 'conn-http' },
          },
        ]),
      ],
      connections: [
        connection({
          id: 'conn-http',
          type: 'http' as ConnectionType,
          config: { baseUrl: 'https://api.billing.test/v1' },
        }),
      ],
      providers: [],
    });

    expect(bound.hosts).toEqual(['api.billing.test']);
    expect(bound.undeterminable).toEqual([]);
  });

  it('omits an interpolated host and says so instead of guessing one', () => {
    const result = deriveEgressAllowList({
      specs: [buildSpec([interpolatedHttpNode('i1'), httpNode('n1', 'https://api.acme.test/x')])],
      connections: NO_CONNECTIONS,
      providers: [],
    });

    expect(result.hosts).toEqual(['api.acme.test']);
    expect(result.undeterminable).toHaveLength(1);
    expect(result.undeterminable[0]?.nodeId).toBe('i1');
    expect(result.undeterminable[0]?.message).toContain('not statically determinable');
  });

  it('merges hosts across several specs and their providers', () => {
    const result = deriveEgressAllowList({
      specs: [
        buildSpec([httpNode('a', 'https://b.acme.test/1')]),
        buildSpec([httpNode('b', 'https://a.acme.test/2'), httpNode('c', 'https://b.acme.test/3')]),
      ],
      connections: NO_CONNECTIONS,
      providers: ['openai'],
    });

    expect(result.hosts).toEqual(['a.acme.test', 'api.openai.com', 'b.acme.test']);
  });
});

describe('deriveEgressAllowList - connection hosts', () => {
  it('declares the host of a sql connection a node is bound to', () => {
    const result = deriveEgressAllowList({
      specs: [buildSpec([sqlNode('s1', 'conn-db')])],
      connections: [connection({ config: { driver: 'postgres', host: 'db.internal.test' } })],
      providers: [],
    });

    expect(result.hosts).toEqual(['db.internal.test']);
  });

  it('reads the alternative host keys a connection may use', () => {
    for (const key of ['host', 'hostname', 'server'] as const) {
      const result = deriveEgressAllowList({
        specs: [buildSpec([sqlNode('s1', 'conn-db')])],
        connections: [connection({ config: { driver: 'postgres', [key]: 'db.acme.test' } })],
        providers: [],
      });
      expect(result.hosts, key).toEqual(['db.acme.test']);
    }
  });

  it('adds nothing for a connection whose host is interpolated', () => {
    const result = deriveEgressAllowList({
      specs: [buildSpec([sqlNode('s1', 'conn-db')])],
      connections: [connection({ config: { driver: 'postgres', host: '{{input.db}}' } })],
      providers: [],
    });

    expect(result.hosts).toEqual([]);
  });
});
