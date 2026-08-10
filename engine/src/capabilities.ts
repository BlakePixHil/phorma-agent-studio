/**
 * Host capability matrix (P2-10, shared with Phase 1 — design §12).
 *
 * One `HostCapabilities` record per host the studio can run a workflow on.
 * These records are the single source of truth consulted by the palette, the
 * properties panel, the local run path and push-time validation, so an
 * operator learns a workflow cannot run somewhere at design time rather than
 * at 3am.
 *
 * Pure declaration: no I/O, no host imports. The engine never learns which
 * host it is running on — the host passes its own record on `RunOptions`.
 */

import { workerSecretName, type ConnectionSummary, type ConnectionType } from './connections.js';
import type { HostCapabilities } from './data-host.js';
import { validateExpression } from './expr.js';
import type {
  EmbeddedWorkflow,
  SqlDriver,
  WorkflowGraph,
  WorkflowNode,
  WorkflowNodeKind,
  WorkflowSpec,
} from './types.js';
import { DATA_IO_KINDS, portBaseId, rejectsToolLink } from './types.js';

/**
 * Every node kind the engine understands, in `WorkflowNodeKind` declaration
 * order. Capability records are expressed as subsets of this list so adding a
 * kind to the union forces a decision here rather than silently widening every
 * host.
 */
export const ALL_NODE_KINDS = [
  'agent',
  'manual-trigger',
  'schedule-trigger',
  'webhook-trigger',
  'portal-trigger',
  'http-tool',
  'web-search-tool',
  'mcp-tool',
  'router',
  'parallel',
  'aggregator',
  'approval-gate',
  'for-each',
  'wait-event',
  'ask-user',
  'execute-workflow',
  'error-handler',
  // ── Phase 1: deterministic data path ────────────────────────────────────────
  'http-request',
  'sql-query',
  'transform',
  'aggregate',
  'assert',
  'state-get',
  'state-set',
  'notify',
] as const satisfies readonly WorkflowNodeKind[];

/**
 * Compile-time guard: fails to typecheck when a `WorkflowNodeKind` is added to
 * the union without being listed in {@link ALL_NODE_KINDS}.
 */
type UnlistedNodeKind = Exclude<WorkflowNodeKind, (typeof ALL_NODE_KINDS)[number]>;
const _allNodeKindsListed: UnlistedNodeKind[] = [];
void _allNodeKindsListed;

/** Every SQL driver family the desktop host can reach. */
const DESKTOP_SQL_DRIVERS: readonly SqlDriver[] = ['postgres', 'mysql', 'mssql', 'sqlite'];

/** Every credential family a host with a real secret store can hold. */
const ALL_CONNECTION_TYPES: readonly ConnectionType[] = [
  'http',
  'oauth2',
  'sql',
  'aws-sigv4',
  'smtp',
];

/**
 * Desktop (Tauri): the only host with a keychain, arbitrary SQL drivers and
 * private-network egress. `cron` is false because scheduling on a laptop is not
 * dependable — a schedule trigger needs a deployed worker.
 */
export const TAURI_DESKTOP_CAPABILITIES: HostCapabilities = {
  id: 'tauri-desktop',
  label: 'Desktop (this machine)',
  nodeKinds: [...ALL_NODE_KINDS],
  sqlDrivers: [...DESKTOP_SQL_DRIVERS],
  connectionTypes: [...ALL_CONNECTION_TYPES],
  connectionSecretScheme: 'os-keychain',
  features: {
    cron: false,
    durableState: true,
    fixtures: true,
    privateNetworkEgress: true,
    stdioMcp: true,
    mcpOAuth: true,
  },
};

/**
 * Browser preview: no trustworthy secret store, therefore zero connection
 * types, and no SQL client at all, therefore `sql-query` is excluded outright.
 * Durable state and fixtures still work — both live in IndexedDB.
 */
export const BROWSER_CAPABILITIES: HostCapabilities = {
  id: 'browser',
  label: 'Browser preview',
  nodeKinds: ALL_NODE_KINDS.filter((kind) => kind !== 'sql-query'),
  sqlDrivers: [],
  connectionTypes: [],
  connectionSecretScheme: 'none',
  features: {
    cron: false,
    durableState: true,
    fixtures: true,
    privateNetworkEgress: false,
    stdioMcp: false,
    mcpOAuth: true,
  },
};

/**
 * Cloudflare Worker: the scheduled host. Runs every node kind and holds real
 * secrets in `CONN_*` env vars, but cannot reach a private network and cannot
 * spawn a stdio MCP server.
 */
export const CLOUDFLARE_CAPABILITIES: HostCapabilities = {
  id: 'cloudflare-worker',
  label: 'Cloudflare Worker',
  nodeKinds: [...ALL_NODE_KINDS],
  /**
   * MSSQL is ABSENT deliberately. The claim that no TDS driver works in a
   * Worker is assumed, not verified — declaring it unsupported is the honest
   * default, and this list is the one place to change if someone proves
   * otherwise.
   */
  sqlDrivers: ['postgres', 'mysql'],
  connectionTypes: [...ALL_CONNECTION_TYPES],
  connectionSecretScheme: 'cloudflare-worker-env',
  features: {
    cron: true,
    durableState: true,
    fixtures: true,
    privateNetworkEgress: false,
    stdioMcp: false,
    mcpOAuth: false,
  },
};

/** Every declared host record, keyed by `HostCapabilities.id`. */
export const HOST_CAPABILITIES: Readonly<Record<string, HostCapabilities>> = {
  [TAURI_DESKTOP_CAPABILITIES.id]: TAURI_DESKTOP_CAPABILITIES,
  [BROWSER_CAPABILITIES.id]: BROWSER_CAPABILITIES,
  [CLOUDFLARE_CAPABILITIES.id]: CLOUDFLARE_CAPABILITIES,
};

// ─────────────────────────────────────────────────────────────────────────────
// `CapabilityFinding` and `validateAgainstCapabilities` (design §12)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One problem found by {@link validateAgainstCapabilities}.
 *
 * `error` blocks a local run, a push and a worker deployment; `warning` never
 * blocks anything (Requirement 17.15). `subWorkflowId` / `subWorkflowName` are
 * present exactly when the finding concerns a node of an embedded sub-workflow,
 * which is what lets the UI name both the sub-workflow and the node
 * (Requirement 17.5) — the message says so too, so a plain-text list is enough.
 */
export interface CapabilityFinding {
  severity: 'error' | 'warning';
  nodeId?: string;
  nodeName?: string;
  message: string;
  /** Key of the embedded sub-workflow the node belongs to, when nested. */
  subWorkflowId?: string;
  /** Display name of that sub-workflow, when nested and readable. */
  subWorkflowName?: string;
  /**
   * Set by callers that validate against a DEPLOY target rather than the host
   * the workflow is running on now, so the UI can say "blocks deployment"
   * instead of "blocks this run". Never set by
   * {@link validateAgainstCapabilities} itself.
   */
  deployOnly?: boolean;
}

/**
 * What {@link validateAgainstCapabilities} needs from a spec: the top-level
 * graph plus the flat embedded registry. Structurally satisfied by
 * `WorkflowSpec`, so callers can pass one straight through.
 */
export type CapabilityValidationTarget = Pick<WorkflowSpec, 'graph' | 'subWorkflows'>;

/**
 * The full result of one capability walk: the findings, plus the declared
 * egress hosts collected on the way (Requirement 17.13).
 */
export interface CapabilityReport {
  findings: CapabilityFinding[];
  /**
   * Distinct outbound host names, lower-cased, in first-occurrence order.
   * Sourced from statically determinable `http-request` urls and from the SQL
   * configuration of the connections `sql-query` nodes reference. A url whose
   * host cannot be determined without running the workflow is omitted and
   * raises a `warning` finding instead.
   */
  egressHosts: string[];
}

/**
 * Validates a spec against one host's declared capabilities (design §12).
 *
 * Pure and total: it reads the spec, the capability record and the connection
 * inventory, and returns findings. It never throws — a malformed node yields an
 * error finding and the walk continues (Requirement 17.7) — because this runs on
 * every keystroke in the properties panel as well as at push time.
 *
 * Ordering is fixed (Requirement 17.6): the top-level graph in node order, then
 * each sub-workflow in ascending key order, and within one node the rule order
 * is kind → SQL driver → connection → expressions → egress → `tool-link`.
 *
 * Returns `[]` when the host can run every node of the spec. The only findings
 * that do not indicate an unrunnable workflow are the `warning` ones
 * (Requirement 17.15).
 */
export function validateAgainstCapabilities(
  spec: CapabilityValidationTarget,
  capabilities: HostCapabilities,
  connections: readonly ConnectionSummary[],
): CapabilityFinding[] {
  return inspectAgainstCapabilities(spec, capabilities, connections).findings;
}

/**
 * The declared egress host list for a spec (Requirement 17.13): every distinct
 * outbound host, compared without regard to letter case, that the spec can be
 * shown to reach without running it.
 */
export function collectEgressHosts(
  spec: CapabilityValidationTarget,
  capabilities: HostCapabilities,
  connections: readonly ConnectionSummary[],
): string[] {
  return inspectAgainstCapabilities(spec, capabilities, connections).egressHosts;
}

/**
 * One walk, both by-products. {@link validateAgainstCapabilities} and
 * {@link collectEgressHosts} are thin views over this so a caller that wants
 * both (push-time validation) pays for the traversal once.
 */
export function inspectAgainstCapabilities(
  spec: CapabilityValidationTarget,
  capabilities: HostCapabilities,
  connections: readonly ConnectionSummary[],
): CapabilityReport {
  const findings: CapabilityFinding[] = [];
  const egress = new Set<string>();
  const inventory = indexConnections(connections);

  for (const scope of graphScopes(spec, findings)) {
    validateGraph(scope, capabilities, inventory, findings, egress);
  }

  return { findings, egressHosts: [...egress] };
}

// ── walk ─────────────────────────────────────────────────────────────────────

/** One graph to validate, with the sub-workflow identity to attribute it to. */
interface GraphScope {
  graph: WorkflowGraph;
  subWorkflowId?: string;
  subWorkflowName?: string;
}

/**
 * The top-level graph first, then every embedded sub-workflow in ascending key
 * order. A sub-workflow whose graph cannot be read yields a finding here rather
 * than an exception later.
 */
function graphScopes(spec: CapabilityValidationTarget, findings: CapabilityFinding[]): GraphScope[] {
  const scopes: GraphScope[] = [];
  const topLevel = readRecord(spec)?.['graph'];

  if (isGraph(topLevel)) {
    scopes.push({ graph: topLevel });
  } else {
    findings.push({ severity: 'error', message: 'The workflow graph could not be read.' });
  }

  const registry = readRecord(readRecord(spec)?.['subWorkflows']);
  for (const key of Object.keys(registry ?? {}).sort()) {
    const embedded = readRecord(registry?.[key]) as Partial<EmbeddedWorkflow> | undefined;
    const name = typeof embedded?.name === 'string' ? embedded.name : undefined;
    if (isGraph(embedded?.graph)) {
      scopes.push({ graph: embedded.graph, subWorkflowId: key, subWorkflowName: name });
      continue;
    }
    findings.push({
      severity: 'error',
      subWorkflowId: key,
      subWorkflowName: name,
      message: `Sub-workflow "${name ?? key}": the workflow graph could not be read.`,
    });
  }

  return scopes;
}

/** Applies every rule to every node of one graph, in node order. */
function validateGraph(
  scope: GraphScope,
  capabilities: HostCapabilities,
  inventory: ReadonlyMap<string, ConnectionSummary>,
  findings: CapabilityFinding[],
  egress: Set<string>,
): void {
  const toolLinked = toolLinkedNodeIds(scope.graph);

  for (const raw of scope.graph.nodes) {
    const node = readRecord(raw) as WorkflowNode | undefined;
    if (!node) {
      findings.push(finding(scope, undefined, 'A node in this workflow could not be read.'));
      continue;
    }

    const report = (message: string, severity: 'error' | 'warning' = 'error') =>
      findings.push(finding(scope, node, message, severity));

    // Rule 1: the kind must be known, and declared for this host.
    if (typeof node.kind !== 'string' || node.kind.length === 0) {
      report(`${label(node)} declares no node kind, so it cannot run on ${capabilities.label}.`);
      continue;
    }
    if (!(ALL_NODE_KINDS as readonly string[]).includes(node.kind)) {
      report(
        `${label(node)} has an unrecognised node kind "${node.kind}", ` +
          `so it cannot run on ${capabilities.label}.`,
      );
      continue;
    }
    if (!capabilities.nodeKinds.includes(node.kind)) {
      report(`${label(node)} (${node.kind}) cannot run on ${capabilities.label}.`);
      continue;
    }

    const data = readRecord(node.data);
    if (!data) {
      report(
        `${label(node)} (${node.kind}) has node data that could not be read, ` +
          `so it cannot be validated against ${capabilities.label}.`,
      );
      // Topology is still readable, so the tool-link rule below still applies.
    }

    const summary = data ? resolveConnection(node, data, capabilities, inventory, report) : undefined;

    // Rule 2: the SQL driver must be declared for this host.
    if (node.kind === 'sql-query' && data) {
      validateSqlDriver(label(node), data, summary, capabilities, report);
    }

    // An `mcp-tool` node with a local (stdio) server needs a host that can
    // actually spawn one - only the desktop capability record declares
    // `stdioMcp` (Requirement 17.3). Catching this here turns a runtime
    // `CloudToolHost` crash (at trigger time, from any trigger source) into a
    // push-time Problems console entry.
    if (node.kind === 'mcp-tool' && data && data['transport'] === 'stdio' && !capabilities.features.stdioMcp) {
      report(
        `${label(node)} (mcp-tool) uses a local (stdio) server, which cannot run on ` +
          `${capabilities.label}. Use a remote MCP server URL instead.`,
      );
    }

    // An `mcp-tool` node authenticated via interactive OAuth stores its session
    // on the device that signed in (desktop keychain / browser localStorage) -
    // a deployed worker's `CloudToolHost` only ever resolves a static bearer
    // token, never an OAuth session. Without this rule the node passes
    // validation and fails at run time with an unhelpful HTTP 401 from the MCP
    // server instead of a push-time explanation.
    if (node.kind === 'mcp-tool' && data && data['authMode'] === 'oauth' && !capabilities.features.mcpOAuth) {
      report(
        `${label(node)} (mcp-tool) uses interactive OAuth sign-in, which cannot run on ` +
          `${capabilities.label} - the signed-in session never reaches the deployed worker.`,
      );
    }

    // Rule 4: every expression in the node must compile.
    if (data) {
      for (const expression of expressionsOf(node.kind, data)) {
        const result = safeValidateExpression(expression.source);
        if (!result.ok) {
          report(`Expression error in ${expression.label} of ${label(node)}: ${result.error}`);
        }
      }
    }

    // Rule 5: collect declared egress, warning about a url we cannot resolve.
    if (data && (DATA_IO_KINDS as readonly string[]).includes(node.kind)) {
      collectNodeEgress(label(node), node.kind, data, summary, egress, report);
    }

    // Rule 6: a data node is never an agent's tool (Requirement 1.4).
    if (rejectsToolLink(node) && toolLinked.has(node.id)) {
      report(
        `${label(node)} (${node.kind}): Data nodes cannot be attached to an agent as a tool.`,
      );
    }
  }
}

// ── rules ────────────────────────────────────────────────────────────────────

/** Reporter bound to one node, so each rule reads as a single statement. */
type Report = (message: string, severity?: 'error' | 'warning') => void;

/**
 * Rule 3: a referenced connection must exist in the inventory, be of a type the
 * host can hold, and have every declared secret present (Requirement 17.4).
 * Returns the summary when one was found, so the SQL and egress rules can reuse
 * its config without a second lookup.
 */
function resolveConnection(
  node: WorkflowNode,
  data: Readonly<Record<string, unknown>>,
  capabilities: HostCapabilities,
  inventory: ReadonlyMap<string, ConnectionSummary>,
  report: Report,
): ConnectionSummary | undefined {
  const reference = data['connectionId'];
  if (reference === undefined || reference === null || reference === '') return undefined;
  if (typeof reference !== 'string') {
    report(`${label(node)} declares a connection reference that is not a connection id.`);
    return undefined;
  }

  const summary = inventory.get(reference);
  if (!summary) {
    report(`Connection "${reference}" is not configured on ${capabilities.label}.`);
    return undefined;
  }

  if (!capabilities.connectionTypes.includes(summary.type as ConnectionType)) {
    report(
      `Connection "${summary.name}" is of type ${summary.type}, ` +
        `which is not available on ${capabilities.label}.`,
    );
  }

  const declared = Array.isArray(summary.secretKeys) ? summary.secretKeys : [];
  const present = typeof summary.secretsPresent === 'number' ? summary.secretsPresent : 0;
  if (present < declared.length) {
    // A host that reports WHICH names are absent lets the message name the
    // exact store entry to create; one that only counts falls back to listing
    // every declared name.
    const missing = Array.isArray(summary.missingSecretKeys)
      ? summary.missingSecretKeys.filter((key) => declared.includes(key))
      : declared;
    report(
      `Connection "${summary.name}" is missing ${declared.length - present} of ` +
        `${declared.length} secret values on ${capabilities.label} ` +
        `(secret keys: ${missing.join(', ')}).` +
        secretRemedy(summary.id, missing, capabilities),
    );
  }

  return summary;
}

/**
 * The actionable half of the missing-secret finding: where this host expects
 * the value to live, named exactly. Empty when the host declares no scheme, so
 * a future host cannot accidentally inherit Cloudflare's instructions.
 */
function secretRemedy(
  connectionId: unknown,
  missing: readonly string[],
  capabilities: HostCapabilities,
): string {
  const id = typeof connectionId === 'string' ? connectionId : '';
  const first = missing[0];
  if (id.length === 0 || first === undefined) return '';

  switch (capabilities.connectionSecretScheme) {
    case 'cloudflare-worker-env': {
      const names = missing.map((key) => workerSecretName(id, key));
      const shown = names.length > 2 ? `${names.slice(0, 2).join(', ')}, ...` : names.join(', ');
      return (
        ` Store ${names.length === 1 ? 'it' : 'them'} on the deployed worker as ${shown}` +
        ` - use the cloud button beside the secret in Connections, or ` +
        `\`npx wrangler secret put ${names[0]}\` - then push again.`
      );
    }
    case 'os-keychain':
      return ` Enter ${missing.length === 1 ? 'it' : 'them'} in Connections to store ${
        missing.length === 1 ? 'it' : 'them'
      } in this machine's keychain.`;
    default:
      return '';
  }
}

/** Rule 2: `sql-query` needs a driver this host actually ships. */
function validateSqlDriver(
  nodeLabel: string,
  data: Readonly<Record<string, unknown>>,
  summary: ConnectionSummary | undefined,
  capabilities: HostCapabilities,
  report: Report,
): void {
  const declared = data['driver'] ?? readRecord(summary?.config)?.['driver'];
  const supported = capabilities.sqlDrivers.join(', ') || 'none';

  if (typeof declared !== 'string' || declared.length === 0) {
    report(
      `${nodeLabel} (sql-query) declares no SQL driver, so it cannot run on ` +
        `${capabilities.label} (supported drivers: ${supported}).`,
    );
    return;
  }
  if (!capabilities.sqlDrivers.includes(declared as SqlDriver)) {
    report(
      `SQL driver ${declared} is not available on ${capabilities.label} ` +
        `(supported drivers: ${supported}). Run this workflow on the desktop host.`,
    );
  }
}

/** One expression found in node data, with a caller-facing label. */
interface ExpressionRef {
  label: string;
  source: unknown;
}

/**
 * Every expression a node kind carries, in a fixed order. Templates
 * (`{{path}}` interpolation) are NOT expressions and are deliberately absent —
 * only the fields the engine compiles with `compileExpression` appear here.
 */
function expressionsOf(kind: string, data: Readonly<Record<string, unknown>>): ExpressionRef[] {
  const refs: ExpressionRef[] = [];

  switch (kind) {
    case 'transform': {
      const fields = Array.isArray(data['fields']) ? data['fields'] : [];
      fields.forEach((raw, index) => {
        const field = readRecord(raw);
        const target = typeof field?.['target'] === 'string' ? field['target'] : `#${index + 1}`;
        refs.push({ label: `field "${target}"`, source: field?.['expression'] });
      });
      break;
    }
    case 'aggregate': {
      const metrics = readRecord(data['group'])?.['metrics'];
      (Array.isArray(metrics) ? metrics : []).forEach((raw, index) => {
        const metric = readRecord(raw);
        if (metric?.['where'] === undefined || metric['where'] === '') return;
        const name = typeof metric['name'] === 'string' ? metric['name'] : `#${index + 1}`;
        refs.push({ label: `metric "${name}" predicate`, source: metric['where'] });
      });
      break;
    }
    case 'assert': {
      const assertions = Array.isArray(data['assertions']) ? data['assertions'] : [];
      assertions.forEach((raw, index) => {
        const assertion = readRecord(raw);
        const name = typeof assertion?.['name'] === 'string' ? assertion['name'] : `#${index + 1}`;
        refs.push({ label: `assertion "${name}"`, source: assertion?.['expression'] });
      });
      break;
    }
    case 'state-set':
      refs.push({ label: 'the value expression', source: data['valueExpression'] });
      break;
    case 'sql-query': {
      const params = Array.isArray(data['params']) ? data['params'] : [];
      params.forEach((raw, index) => {
        const param = readRecord(raw);
        const name = typeof param?.['name'] === 'string' ? param['name'] : `#${index + 1}`;
        refs.push({ label: `parameter ":${name}"`, source: param?.['expression'] });
      });
      break;
    }
    default:
      break;
  }

  return refs;
}

/**
 * `validateExpression` is documented as throwing for no input at all, so the
 * one call site that must never throw wraps it (Requirement 17.7).
 */
function safeValidateExpression(source: unknown): { ok: true } | { ok: false; error: string } {
  try {
    const result = validateExpression(source as string);
    if (result.ok) return { ok: true };
    const position = result.position === undefined ? '' : ` (position ${result.position})`;
    return { ok: false, error: `${result.error}${position}` };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Rule 5: the declared egress list (Requirement 17.13). An `http-request` host
 * comes from an absolute url, or from the connection's `baseUrl` when the url is
 * a path; a `sql-query` host comes from the connection config. A url whose host
 * depends on the payload is omitted with a warning rather than guessed.
 */
function collectNodeEgress(
  nodeLabel: string,
  kind: string,
  data: Readonly<Record<string, unknown>>,
  summary: ConnectionSummary | undefined,
  egress: Set<string>,
  report: Report,
): void {
  if (kind === 'sql-query') {
    const config = readRecord(summary?.config);
    const host = firstString(config?.['host'], config?.['hostname'], config?.['server']);
    const resolved = staticHost(host);
    if (resolved) egress.add(resolved);
    return;
  }

  if (kind !== 'http-request') return;

  const url = typeof data['url'] === 'string' ? data['url'].trim() : '';
  const baseUrl = firstString(readRecord(summary?.config)?.['baseUrl']) ?? '';
  const candidate = ABSOLUTE_URL.test(url) ? url : baseUrl;
  const host = staticHost(candidate);

  if (host) {
    egress.add(host);
    return;
  }
  report(
    `The url of ${nodeLabel} (http-request) is not statically determinable, ` +
      `so its outbound host is omitted from the declared egress list.`,
    'warning',
  );
}

/** `scheme://` prefix test, used to tell an absolute url from a path. */
const ABSOLUTE_URL = /^[a-z][a-z0-9+.\-]*:\/\//i;

/**
 * The lower-cased host of an absolute url, or `undefined` when the value is
 * absent, relative, templated, or otherwise not resolvable without running the
 * workflow. Deliberately hand-rolled: `URL` is available on every host, but it
 * accepts and normalises far more than "is this host knowable at design time".
 */
function staticHost(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.includes('{{')) return undefined;

  const match = ABSOLUTE_URL.test(trimmed)
    ? /^[a-z][a-z0-9+.\-]*:\/\/([^/?#]*)/i.exec(trimmed)
    : /^([^/?#\s]+)$/.exec(trimmed);
  const authority = match?.[1];
  if (!authority) return undefined;

  const afterUserInfo = authority.slice(authority.lastIndexOf('@') + 1);
  const host = afterUserInfo.startsWith('[')
    ? afterUserInfo.slice(0, afterUserInfo.indexOf(']') + 1)
    : afterUserInfo.split(':')[0];

  return host && host.length > 0 ? host.toLowerCase() : undefined;
}

// ── helpers ──────────────────────────────────────────────────────────────────

/** Connection inventory by id, ignoring entries without a usable id. */
function indexConnections(
  connections: readonly ConnectionSummary[],
): ReadonlyMap<string, ConnectionSummary> {
  const index = new Map<string, ConnectionSummary>();
  for (const summary of Array.isArray(connections) ? connections : []) {
    if (typeof summary?.id === 'string' && !index.has(summary.id)) index.set(summary.id, summary);
  }
  return index;
}

/**
 * Node ids that either end of a `tool-link` edge resolves to (Requirement 1.4
 * rejects both directions). Built once per graph so the per-node check is O(1).
 */
function toolLinkedNodeIds(graph: WorkflowGraph): ReadonlySet<string> {
  const owners = new Map<string, string>();
  for (const raw of graph.nodes) {
    const node = readRecord(raw) as WorkflowNode | undefined;
    if (!node || typeof node.id !== 'string') continue;
    for (const port of Array.isArray(node.ports) ? node.ports : []) {
      const portId = readRecord(port)?.['id'];
      if (typeof portId === 'string') owners.set(portId, node.id);
    }
  }

  const linked = new Set<string>();
  for (const raw of Array.isArray(graph.connections) ? graph.connections : []) {
    const edge = readRecord(raw);
    if (edge?.['kind'] !== 'tool-link') continue;
    for (const connector of [edge['outputId'], edge['inputId']]) {
      if (typeof connector !== 'string') continue;
      const owner = owners.get(portBaseId(connector));
      if (owner !== undefined) linked.add(owner);
    }
  }
  return linked;
}

/** `"Name"`, or a stable stand-in when the name is missing. */
function label(node: WorkflowNode): string {
  if (typeof node.name === 'string' && node.name.length > 0) return `"${node.name}"`;
  if (typeof node.id === 'string' && node.id.length > 0) return `Node ${node.id}`;
  return 'An unnamed node';
}

/** Builds a finding, attributing it to its node and sub-workflow. */
function finding(
  scope: GraphScope,
  node: WorkflowNode | undefined,
  message: string,
  severity: 'error' | 'warning' = 'error',
): CapabilityFinding {
  const result: CapabilityFinding = {
    severity,
    message: scope.subWorkflowId
      ? `Sub-workflow "${scope.subWorkflowName ?? scope.subWorkflowId}": ${message}`
      : message,
  };
  if (typeof node?.id === 'string') result.nodeId = node.id;
  if (typeof node?.name === 'string') result.nodeName = node.name;
  if (scope.subWorkflowId !== undefined) result.subWorkflowId = scope.subWorkflowId;
  if (scope.subWorkflowName !== undefined) result.subWorkflowName = scope.subWorkflowName;
  return result;
}

/** A readable plain object, or `undefined` for anything else (never throws). */
function readRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

/** A graph is usable when its node list is readable. */
function isGraph(value: unknown): value is WorkflowGraph {
  return Array.isArray(readRecord(value)?.['nodes']);
}

/** The first non-empty string among `values`. */
function firstString(...values: readonly unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return undefined;
}
