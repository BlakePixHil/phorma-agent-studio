import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  ALL_NODE_KINDS,
  BROWSER_CAPABILITIES,
  CLOUDFLARE_CAPABILITIES,
  TAURI_DESKTOP_CAPABILITIES,
  validateAgainstCapabilities,
  type CapabilityFinding,
  type CapabilityValidationTarget,
} from './capabilities.js';
import type { ConnectionSummary, ConnectionType } from './connections.js';
import type { HostCapabilities } from './data-host.js';
import { validateExpression } from './expr.js';
import { DATA_NODE_KINDS, type EmbeddedWorkflow, type SqlDriver, type WorkflowConnection, type WorkflowGraph, type WorkflowNode } from './types.js';
import { expressionSourceArb } from './test/generators.js';

/**
 * Property 11: Capability validation is sound across nested workflows
 * (design §12) — claims 51, 52, 53 and 54:
 *
 *  51. **Soundness.** ∀ spec `s`, ∀ host `h`: if `validateAgainstCapabilities(s, h, …)`
 *      returns `[]`, then no node in `s` (including in `subWorkflows`) uses a
 *      kind, driver, connection or expression `h` cannot execute.
 *  52. **Nesting completeness.** ∀ spec whose `subWorkflows` contain an
 *      unsupported node: at least one error finding is returned.
 *  53. **Determinism.** ∀ `s`, `h`: repeated calls return findings in identical
 *      order.
 *  54. **Tool-link rejection.** ∀ graph containing a `tool-link` edge that
 *      terminates on a data node: an error finding is returned.
 *
 * Specs are generated from a small PLAN model (one {@link NodePlan} per node)
 * rather than from raw arbitrary node data, so the soundness oracle can decide
 * whether a node is runnable straight from the plan instead of re-implementing
 * the walk. Requirement 17.4 states the rule as an "if and only if", so claim 51
 * is asserted in both directions: empty findings ⇔ every node runnable.
 *
 * The one rule the oracle borrows from production code is expression
 * compilation, because Requirement 17.4 *defines* it as "compiles under
 * `validateExpression`". Everything else (kinds, drivers, connection inventory,
 * tool links) is decided independently from the plan.
 *
 * Generated `http-request` nodes always carry a statically determinable url, so
 * the walk emits no egress `warning` and "no finding" and "no error finding"
 * coincide. The warning path belongs to the sibling unit-test task.
 *
 * **Validates: Requirements 1.4, 17.4, 17.5, 17.6**
 */

// ─────────────────────────────────────────────────────────────────────────────
// Plan model
// ─────────────────────────────────────────────────────────────────────────────

const HOSTS: readonly HostCapabilities[] = [
  TAURI_DESKTOP_CAPABILITIES,
  BROWSER_CAPABILITIES,
  CLOUDFLARE_CAPABILITIES,
];

const CONNECTION_TYPES: readonly ConnectionType[] = [
  'http',
  'oauth2',
  'sql',
  'aws-sigv4',
  'smtp',
];

const SQL_DRIVERS: readonly SqlDriver[] = ['postgres', 'mysql', 'mssql', 'sqlite'];

/** A `connectionId` that is deliberately absent from every generated inventory. */
const UNKNOWN_CONNECTION_ID = 'conn-never-configured';

/** A node kind outside `WorkflowNodeKind`, for the unrecognised-kind rule. */
const UNRECOGNISED_KIND = 'quantum-flux';

/** How a node references the connection inventory. */
type ConnectionRef = 'none' | 'unknown' | { readonly index: number };

/** Which direction a `tool-link` edge runs, when the node has one. */
type ToolLink = 'none' | 'agent-to-node' | 'node-to-agent';

/** Everything the generators vary about one node, and all the oracle reads. */
interface NodePlan {
  readonly kind: string;
  readonly connection: ConnectionRef;
  /** `'none'` means the node data declares no `driver` at all. */
  readonly driver: SqlDriver | 'none';
  /** `'none'` means the node data declares no expression at all. */
  readonly expression: string | 'none';
  readonly toolLink: ToolLink;
}

/** One entry of the supplied connection inventory. */
interface ConnectionPlan {
  readonly type: ConnectionType;
  readonly secretKeyCount: number;
  /** How many of the declared secret keys are absent from the host's store. */
  readonly missingSecrets: number;
}

/** A whole spec: the top-level graph plus the embedded registry. */
interface SpecPlan {
  readonly connections: readonly ConnectionPlan[];
  readonly top: readonly NodePlan[];
  readonly subs: readonly { readonly key: string; readonly name: string; readonly nodes: readonly NodePlan[] }[];
}

function plan(overrides: Partial<NodePlan> = {}): NodePlan {
  return { kind: 'transform', connection: 'none', driver: 'none', expression: 'none', toolLink: 'none', ...overrides };
}

// ─────────────────────────────────────────────────────────────────────────────
// Materialisation: plan → spec
// ─────────────────────────────────────────────────────────────────────────────

const connectionId = (index: number): string => `conn-c${index}`;

function buildConnections(plans: readonly ConnectionPlan[]): ConnectionSummary[] {
  return plans.map((entry, index) => {
    const secretKeys = Array.from({ length: entry.secretKeyCount }, (_, i) => `key${i}`);
    return {
      id: connectionId(index),
      name: `Connection ${index}`,
      type: entry.type,
      config: { baseUrl: 'https://api.example.com', host: 'db.internal' },
      secretKeys,
      secretsPresent: Math.max(0, secretKeys.length - entry.missingSecrets),
      auth: { mode: 'none' },
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    } satisfies ConnectionSummary;
  });
}

/** The `connectionId` a plan resolves to, or `undefined` for no reference. */
function referencedConnectionId(ref: ConnectionRef, inventory: number): string | undefined {
  if (ref === 'none') return undefined;
  if (ref === 'unknown') return UNKNOWN_CONNECTION_ID;
  return inventory === 0 ? UNKNOWN_CONNECTION_ID : connectionId(ref.index % inventory);
}

/** The inventory entry a plan resolves to, or `undefined` when unresolvable. */
function referencedConnection(
  ref: ConnectionRef,
  connections: readonly ConnectionSummary[],
): ConnectionSummary | undefined {
  if (ref === 'none' || ref === 'unknown') return undefined;
  return connections.length === 0 ? undefined : connections[ref.index % connections.length];
}

/** Node data for one plan, placing the expression where the walk looks for it. */
function nodeData(entry: NodePlan, inventory: number): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  const reference = referencedConnectionId(entry.connection, inventory);
  if (reference !== undefined) data['connectionId'] = reference;
  const source = entry.expression;

  switch (entry.kind) {
    case 'http-request':
      // Always statically determinable, so the egress rule emits no warning.
      data['url'] = 'https://api.example.com/v1/items';
      data['method'] = 'GET';
      break;
    case 'sql-query':
      data['statement'] = 'select 1';
      if (entry.driver !== 'none') data['driver'] = entry.driver;
      if (source !== 'none') data['params'] = [{ name: 'p1', expression: source }];
      break;
    case 'transform':
      if (source !== 'none') data['fields'] = [{ target: 'total', expression: source }];
      break;
    case 'aggregate':
      if (source !== 'none') {
        data['group'] = { by: ['group'], metrics: [{ name: 'total', op: 'sum', field: 'amount', where: source }] };
      }
      break;
    case 'assert':
      if (source !== 'none') data['assertions'] = [{ name: 'guard', expression: source }];
      break;
    case 'state-set':
      data['key'] = 'items/{{id}}';
      if (source !== 'none') data['valueExpression'] = source;
      break;
    case 'render-document':
      // Well-formed by construction: the document rules have their own specs.
      data['markdown'] = '# {{title}}';
      data['fileName'] = 'report';
      break;
    case 'state-list':
      data['prefix'] = 'items/';
      break;
    default:
      break;
  }
  return data;
}

function buildNode(entry: NodePlan, id: string, inventory: number): WorkflowNode {
  return {
    id,
    name: `Node ${id}`,
    kind: entry.kind,
    category: 'flow',
    icon: 'pi pi-cog',
    position: { x: 0, y: 0 },
    ports: [
      { id: `${id}-in`, name: 'In', role: 'message-in' },
      { id: `${id}-out`, name: 'Out', role: 'message-out' },
    ],
    data: nodeData(entry, inventory),
  };
}

/** The agent every generated graph carries, so a `tool-link` edge has an end. */
function buildAgent(id: string): WorkflowNode {
  return {
    id,
    name: 'Agent',
    kind: 'agent',
    category: 'agent',
    icon: 'pi pi-user',
    position: { x: 0, y: 0 },
    ports: [
      { id: `${id}-in`, name: 'In', role: 'message-in' },
      { id: `${id}-out`, name: 'Out', role: 'message-out' },
      { id: `${id}-tools`, name: 'Tools', role: 'tools' },
    ],
    data: {},
  };
}

const nodeId = (prefix: string, index: number): string => `${prefix}-n${index}`;

function buildGraph(plans: readonly NodePlan[], prefix: string, inventory: number): WorkflowGraph {
  const agentId = `${prefix}-agent`;
  const nodes = plans.map((entry, index) => buildNode(entry, nodeId(prefix, index), inventory));
  nodes.push(buildAgent(agentId));

  const connections: WorkflowConnection[] = [];
  plans.forEach((entry, index) => {
    if (entry.toolLink === 'none') return;
    const id = nodeId(prefix, index);
    connections.push(
      entry.toolLink === 'agent-to-node'
        ? { id: `${id}-tl`, outputId: `${agentId}-tools-out`, inputId: `${id}-in-in`, kind: 'tool-link' }
        : { id: `${id}-tl`, outputId: `${id}-out-out`, inputId: `${agentId}-tools-in`, kind: 'tool-link' },
    );
  });

  return { nodes, connections };
}

function buildSpec(spec: SpecPlan): CapabilityValidationTarget {
  const inventory = spec.connections.length;
  const subWorkflows: Record<string, EmbeddedWorkflow> = {};
  for (const sub of spec.subs) {
    subWorkflows[sub.key] = {
      id: sub.key,
      name: sub.name,
      graph: buildGraph(sub.nodes, sub.key, inventory),
    };
  }
  return { graph: buildGraph(spec.top, 'top', inventory), subWorkflows };
}

// ─────────────────────────────────────────────────────────────────────────────
// Oracle: is this node runnable on this host? (Requirement 17.4)
// ─────────────────────────────────────────────────────────────────────────────

/** Requirement 17.4's own definition of a usable expression. */
function compiles(source: unknown): boolean {
  try {
    return validateExpression(source as string).ok;
  } catch {
    return false;
  }
}

/**
 * The expression sources the walk finds in a plan's node data. `undefined` means
 * the kind carries an expression slot that the plan left empty, which is itself
 * an expression the host cannot compile.
 */
function expressionSourcesOf(entry: NodePlan): (string | undefined)[] {
  const source = entry.expression === 'none' ? undefined : entry.expression;
  switch (entry.kind) {
    case 'state-set':
      // `valueExpression` is unconditional: an absent one is still validated.
      return [source];
    case 'transform':
    case 'aggregate':
    case 'assert':
    case 'sql-query':
      // These slots live in arrays, so an empty plan yields no expression.
      return source === undefined ? [] : [source];
    default:
      return [];
  }
}

function isRunnable(
  entry: NodePlan,
  host: HostCapabilities,
  connections: readonly ConnectionSummary[],
): boolean {
  if (!(ALL_NODE_KINDS as readonly string[]).includes(entry.kind)) return false;
  if (!host.nodeKinds.includes(entry.kind as (typeof ALL_NODE_KINDS)[number])) return false;

  if (entry.connection !== 'none') {
    const summary = referencedConnection(entry.connection, connections);
    if (!summary) return false;
    if (!host.connectionTypes.includes(summary.type)) return false;
    if (summary.secretsPresent < summary.secretKeys.length) return false;
  }

  if (entry.kind === 'sql-query') {
    if (entry.driver === 'none') return false;
    if (!host.sqlDrivers.includes(entry.driver)) return false;
  }

  for (const source of expressionSourcesOf(entry)) {
    if (!compiles(source)) return false;
  }

  if (entry.toolLink !== 'none' && (DATA_NODE_KINDS as readonly string[]).includes(entry.kind)) {
    return false;
  }

  return true;
}

/** Every node of the spec, top level first, then sub-workflows by key order. */
function allNodePlans(spec: SpecPlan): NodePlan[] {
  const sorted = [...spec.subs].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return [...spec.top, ...sorted.flatMap((sub) => sub.nodes)];
}

// ─────────────────────────────────────────────────────────────────────────────
// Arbitraries
// ─────────────────────────────────────────────────────────────────────────────

const hostArb: fc.Arbitrary<HostCapabilities> = fc.constantFrom(...HOSTS);

/** Sources that do not parse, mixed in with the well-formed generator. */
const BROKEN_EXPRESSIONS: readonly string[] = ['$.amount +', '((', 'upper(', '1 +* 2', '$.'];

const expressionArb: fc.Arbitrary<string> = fc.oneof(
  { weight: 3, arbitrary: expressionSourceArb({ maxDepth: 2 }) },
  { weight: 2, arbitrary: fc.constantFrom(...BROKEN_EXPRESSIONS) },
);

const connectionRefArb: fc.Arbitrary<ConnectionRef> = fc.oneof(
  { weight: 4, arbitrary: fc.constant<ConnectionRef>('none') },
  { weight: 1, arbitrary: fc.constant<ConnectionRef>('unknown') },
  { weight: 3, arbitrary: fc.nat({ max: 5 }).map((index) => ({ index })) },
);

const nodePlanArb: fc.Arbitrary<NodePlan> = fc.record({
  kind: fc.oneof(
    { weight: 9, arbitrary: fc.constantFrom<string>(...ALL_NODE_KINDS) },
    { weight: 1, arbitrary: fc.constantFrom(UNRECOGNISED_KIND, '') },
  ),
  connection: connectionRefArb,
  driver: fc.oneof(
    { weight: 5, arbitrary: fc.constantFrom<SqlDriver | 'none'>(...SQL_DRIVERS) },
    { weight: 1, arbitrary: fc.constant<SqlDriver | 'none'>('none') },
  ),
  expression: fc.oneof(
    { weight: 5, arbitrary: expressionArb },
    { weight: 1, arbitrary: fc.constant<string | 'none'>('none') },
  ),
  toolLink: fc.constantFrom<ToolLink>('none', 'none', 'agent-to-node', 'node-to-agent'),
});

const connectionPlanArb: fc.Arbitrary<ConnectionPlan> = fc.record({
  type: fc.constantFrom(...CONNECTION_TYPES),
  secretKeyCount: fc.integer({ min: 0, max: 3 }),
  missingSecrets: fc.integer({ min: 0, max: 3 }),
});

const SUB_KEYS: readonly string[] = ['sub-alpha', 'sub-beta', 'sub-gamma'];

function subsArb(nodes: fc.Arbitrary<NodePlan>): fc.Arbitrary<SpecPlan['subs']> {
  return fc
    .uniqueArray(
      fc.record({
        key: fc.constantFrom(...SUB_KEYS),
        name: fc.constantFrom('Fetch orders', 'Push rows', 'Reconcile'),
        nodes: fc.array(nodes, { maxLength: 3 }),
      }),
      { maxLength: 3, selector: (sub) => sub.key },
    )
    .map((subs) => subs as SpecPlan['subs']);
}

const specPlanArb: fc.Arbitrary<SpecPlan> = fc.record({
  connections: fc.array(connectionPlanArb, { minLength: 1, maxLength: 3 }),
  top: fc.array(nodePlanArb, { maxLength: 4 }),
  subs: subsArb(nodePlanArb),
});

/**
 * A node plan that is runnable on `host` by construction. `canReference` allows
 * a reference to inventory entry 0, which callers only set when that entry is
 * known to be of a type `host` can hold with every secret present.
 */
function runnableNodePlanArb(host: HostCapabilities, canReference = false): fc.Arbitrary<NodePlan> {
  const kinds = host.nodeKinds.filter((kind) => kind !== 'sql-query' || host.sqlDrivers.length > 0);
  const drivers: (SqlDriver | 'none')[] =
    host.sqlDrivers.length > 0 ? [...host.sqlDrivers] : ['none'];
  const connection: fc.Arbitrary<ConnectionRef> = canReference
    ? fc.constantFrom<ConnectionRef>('none', { index: 0 })
    : fc.constant<ConnectionRef>('none');
  return fc
    .record({
      kind: fc.constantFrom<string>(...kinds),
      driver: fc.constantFrom<SqlDriver | 'none'>(...drivers),
      connection,
    })
    .map(({ kind, driver, connection: reference }) =>
      plan({ kind, driver, connection: reference, expression: '$.amount + 1' }),
    );
}

/** A spec every node of which `host` can run, references included. */
const runnableSpecArb: fc.Arbitrary<{ host: HostCapabilities; specPlan: SpecPlan }> = hostArb.chain(
  (host) => {
    const canReference = host.connectionTypes.length > 0;
    const inventory: ConnectionPlan[] = [
      { type: host.connectionTypes[0] ?? 'http', secretKeyCount: 2, missingSecrets: 0 },
    ];
    const nodes = runnableNodePlanArb(host, canReference);
    return fc
      .record({ top: fc.array(nodes, { maxLength: 4 }), subs: subsArb(nodes) })
      .map(({ top, subs }) => ({ host, specPlan: { connections: inventory, top, subs } }));
  },
);

/** A node plan that `host` cannot run, whatever else the spec contains. */
function unsupportedNodePlanArb(host: HostCapabilities): fc.Arbitrary<NodePlan> {
  const options: fc.Arbitrary<NodePlan>[] = [
    fc.constant(plan({ kind: UNRECOGNISED_KIND })),
    fc.constant(plan({ kind: 'http-request', connection: 'unknown' })),
    fc.constant(plan({ kind: 'transform', expression: BROKEN_EXPRESSIONS[0] })),
  ];

  const excludedKinds = ALL_NODE_KINDS.filter((kind) => !host.nodeKinds.includes(kind));
  if (excludedKinds.length > 0) {
    options.push(fc.constantFrom(...excludedKinds).map((kind) => plan({ kind })));
  }

  const excludedDrivers = SQL_DRIVERS.filter((driver) => !host.sqlDrivers.includes(driver));
  if (host.nodeKinds.includes('sql-query') && excludedDrivers.length > 0) {
    options.push(fc.constantFrom(...excludedDrivers).map((driver) => plan({ kind: 'sql-query', driver })));
  }

  return fc.oneof(...options);
}

// ─────────────────────────────────────────────────────────────────────────────
// Claim 51: soundness
// ─────────────────────────────────────────────────────────────────────────────

describe('Property 11: capability validation is sound across nested workflows', () => {

  it('51. returns no finding exactly when every node of the spec is runnable on the host', () => {
    fc.assert(
      fc.property(specPlanArb, hostArb, (specPlan, host) => {
        const connections = buildConnections(specPlan.connections);
        const findings = validateAgainstCapabilities(buildSpec(specPlan), host, connections);
        const unrunnable = allNodePlans(specPlan).filter(
          (entry) => !isRunnable(entry, host, connections),
        );

        // Soundness: an empty list means nothing in the spec is unrunnable.
        expect(findings.length === 0).toBe(unrunnable.length === 0);
        // …and every finding of a rejecting walk carries a severity.
        for (const found of findings) {
          expect(['error', 'warning']).toContain(found.severity);
        }
      }),
    );

    // The same claim from the other side, with the empty branch reached by
    // construction rather than by luck: a spec built entirely from kinds,
    // drivers, connections and expressions the host declares returns nothing.
    fc.assert(
      fc.property(runnableSpecArb, ({ host, specPlan }) => {
        const connections = buildConnections(specPlan.connections);
        expect(allNodePlans(specPlan).every((entry) => isRunnable(entry, host, connections))).toBe(
          true,
        );
        expect(validateAgainstCapabilities(buildSpec(specPlan), host, connections)).toEqual([]);
      }),
    );
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Claim 52: nesting completeness
  // ───────────────────────────────────────────────────────────────────────────

  it('52. raises an error finding naming the sub-workflow and node for a nested unsupported node', () => {
    fc.assert(
      fc.property(
        hostArb.chain((host) =>
          fc.record({
            host: fc.constant(host),
            connections: fc.array(connectionPlanArb, { minLength: 1, maxLength: 2 }),
            top: fc.array(runnableNodePlanArb(host), { maxLength: 3 }),
            subs: subsArb(runnableNodePlanArb(host)).filter((subs) => subs.length > 0),
            offender: unsupportedNodePlanArb(host),
            slot: fc.nat({ max: 5 }),
          }),
        ),
        ({ host, connections, top, subs, offender, slot }) => {
          // Drop the offender into one sub-workflow, leaving every other node runnable.
          const target = subs[slot % subs.length];
          const withOffender: SpecPlan['subs'] = subs.map((sub) =>
            sub.key === target.key ? { ...sub, nodes: [...sub.nodes, offender] } : sub,
          );
          const specPlan: SpecPlan = { connections, top, subs: withOffender };
          const offenderId = nodeId(target.key, target.nodes.length);

          const findings = validateAgainstCapabilities(
            buildSpec(specPlan),
            host,
            buildConnections(connections),
          );
          const errors = findings.filter((found) => found.severity === 'error');

          expect(errors.length).toBeGreaterThan(0);
          // Requirement 17.5: the finding names both the sub-workflow and the node.
          const attributed = errors.filter(
            (found) => found.subWorkflowId === target.key && found.nodeId === offenderId,
          );
          expect(attributed.length).toBeGreaterThan(0);
          for (const found of attributed) {
            expect(found.subWorkflowName).toBe(target.name);
            expect(found.nodeName).toBe(`Node ${offenderId}`);
            expect(found.message).toContain(target.name || target.key);
          }
        },
      ),
    );
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Claim 53: determinism and ordering (Requirement 17.6)
  // ───────────────────────────────────────────────────────────────────────────

  it('53. returns identical findings in identical order for repeated calls', () => {
    fc.assert(
      fc.property(specPlanArb, hostArb, (specPlan, host) => {
        const spec = buildSpec(specPlan);
        const connections = buildConnections(specPlan.connections);

        const first = validateAgainstCapabilities(spec, host, connections);
        const second = validateAgainstCapabilities(spec, host, connections);
        const third = validateAgainstCapabilities(buildSpec(specPlan), host, buildConnections(specPlan.connections));

        expect(second).toEqual(first);
        expect(third).toEqual(first);
        // Ordering: top-level graph in node order, then sub-workflows by key.
        expect(isOrdered(first, specPlan)).toBe(true);
      }),
    );
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Claim 54: tool-link rejection (Requirement 1.4)
  // ───────────────────────────────────────────────────────────────────────────

  it('54. raises an error finding for every tool-link edge that terminates on a data node', () => {
    fc.assert(
      fc.property(
        hostArb.chain((host) =>
          fc.record({
            host: fc.constant(host),
            kind: fc.constantFrom(...DATA_NODE_KINDS.filter((kind) => host.nodeKinds.includes(kind))),
            direction: fc.constantFrom<ToolLink>('agent-to-node', 'node-to-agent'),
            nested: fc.boolean(),
          }),
        ),
        ({ host, kind, direction, nested }) => {
          const linked = plan({
            kind,
            driver: host.sqlDrivers[0] ?? 'none',
            expression: '$.amount + 1',
            toolLink: direction,
          });
          const specPlan: SpecPlan = {
            connections: [{ type: 'http', secretKeyCount: 0, missingSecrets: 0 }],
            top: nested ? [] : [linked],
            subs: nested ? [{ key: 'sub-alpha', name: 'Nested', nodes: [linked] }] : [],
          };
          const prefix = nested ? 'sub-alpha' : 'top';

          const findings = validateAgainstCapabilities(
            buildSpec(specPlan),
            host,
            buildConnections(specPlan.connections),
          );
          const toolLinkErrors = findings.filter(
            (found) =>
              found.severity === 'error' &&
              found.nodeId === nodeId(prefix, 0) &&
              found.message.includes('Data nodes cannot be attached to an agent as a tool.'),
          );

          expect(toolLinkErrors.length).toBe(1);
        },
      ),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Ordering oracle (Requirement 17.6)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * True when `findings` never move backwards: the scope index (top level, then
 * sub-workflows in ascending key order) is non-decreasing, and within one scope
 * the node index follows graph node order.
 */
function isOrdered(findings: readonly CapabilityFinding[], specPlan: SpecPlan): boolean {
  const scopes = ['', ...[...specPlan.subs].map((sub) => sub.key).sort()];
  let previous: [number, number] = [-1, -1];

  for (const found of findings) {
    const scopeIndex = scopes.indexOf(found.subWorkflowId ?? '');
    if (scopeIndex < 0) return false;
    const prefix = found.subWorkflowId ?? 'top';
    const nodeIndex = indexOfNode(found.nodeId, prefix);
    const position: [number, number] = [scopeIndex, nodeIndex];
    if (position[0] < previous[0]) return false;
    if (position[0] === previous[0] && position[1] < previous[1]) return false;
    previous = position;
  }
  return true;
}

/** Position of a generated node id inside its graph, from the id itself. */
function indexOfNode(id: string | undefined, prefix: string): number {
  if (id === undefined) return -1;
  const match = new RegExp(`^${prefix}-n(\\d+)$`).exec(id);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}
