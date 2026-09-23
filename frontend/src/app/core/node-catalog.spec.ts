import { DATA_NODE_KINDS, type PortRole, type WorkflowNodeKind } from './workflow.model';
import {
  MCP_PRESETS,
  NODE_CATALOG,
  findCatalogEntryByKind,
  findMcpPreset,
  mcpTransportKind,
} from './node-catalog';

/**
 * Requirement 19.1: exactly one palette entry per Data_Node kind, each
 * carrying a non-empty label, a non-empty description, an icon, at least
 * three search keywords, a default node name, a port blueprint identical to
 * the ports Requirement 1 criterion 3 declares for that kind, and default
 * data in which every non-optional field of that kind's node data holds a
 * value.
 */

/** Requirement 1 criterion 3: the exact port blueprint per Data_Node kind. */
const EXPECTED_PORTS: Record<WorkflowNodeKind, { name: string; role: PortRole }[]> = {
  'http-request': [
    { name: 'In', role: 'message-in' },
    { name: 'Response', role: 'message-out' },
    { name: 'On error', role: 'message-out' },
  ],
  'sql-query': [
    { name: 'In', role: 'message-in' },
    { name: 'Rows', role: 'message-out' },
    { name: 'On error', role: 'message-out' },
  ],
  transform: [
    { name: 'In', role: 'message-in' },
    { name: 'Out', role: 'message-out' },
  ],
  aggregate: [
    { name: 'In', role: 'message-in' },
    { name: 'Out', role: 'message-out' },
  ],
  assert: [
    { name: 'In', role: 'message-in' },
    { name: 'Passed', role: 'message-out' },
    { name: 'Failed', role: 'message-out' },
  ],
  'state-get': [
    { name: 'In', role: 'message-in' },
    { name: 'Out', role: 'message-out' },
  ],
  'state-set': [
    { name: 'In', role: 'message-in' },
    { name: 'Out', role: 'message-out' },
  ],
  notify: [
    { name: 'In', role: 'message-in' },
    { name: 'Sent', role: 'message-out' },
    { name: 'On error', role: 'message-out' },
  ],
  decide: [
    { name: 'In', role: 'message-in' },
    { name: 'Decided', role: 'message-out' },
    { name: 'On error', role: 'message-out' },
  ],
  // Non-data kinds are unused by this test but keep the record total.
  agent: [],
  'manual-trigger': [],
  'schedule-trigger': [],
  'webhook-trigger': [],
  'portal-trigger': [],
  'http-tool': [],
  'web-search-tool': [],
  'mcp-tool': [],
  router: [],
  parallel: [],
  aggregator: [],
  'approval-gate': [],
  'for-each': [],
  'wait-event': [],
  'ask-user': [],
  'execute-workflow': [],
  'error-handler': [],
};

/** Non-optional (required) node-data fields per Data_Node kind. */
const REQUIRED_FIELDS: Record<string, string[]> = {
  'http-request': ['method', 'url'],
  'sql-query': ['statement'],
  transform: ['fields'],
  aggregate: ['op'],
  assert: ['assertions'],
  'state-get': ['key'],
  'state-set': ['key', 'valueExpression'],
  notify: ['channel'],
  decide: ['questions'],
};

describe('node-catalog: Data section completeness (Requirement 19.1)', () => {
  it('declares exactly one palette entry per Data_Node kind', () => {
    for (const kind of DATA_NODE_KINDS) {
      const matches = NODE_CATALOG.filter(entry => entry.kind === kind);
      expect(matches.length).withContext(`entries for kind "${kind}"`).toBe(1);
    }
  });

  it('gives every Data_Node entry a non-empty label, description, icon and default name', () => {
    for (const kind of DATA_NODE_KINDS) {
      const entry = findCatalogEntryByKind(kind);
      expect(entry).withContext(kind).toBeTruthy();
      expect(entry!.label.trim().length).withContext(`${kind} label`).toBeGreaterThan(0);
      expect(entry!.description.trim().length).withContext(`${kind} description`).toBeGreaterThan(0);
      expect(entry!.icon.trim().length).withContext(`${kind} icon`).toBeGreaterThan(0);
      expect(entry!.defaultName.trim().length).withContext(`${kind} defaultName`).toBeGreaterThan(0);
    }
  });

  it('gives every Data_Node entry at least three search keywords', () => {
    for (const kind of DATA_NODE_KINDS) {
      const entry = findCatalogEntryByKind(kind);
      expect(entry?.keywords?.length ?? 0).withContext(`${kind} keywords`).toBeGreaterThanOrEqual(3);
    }
  });

  it('gives every Data_Node entry the exact port blueprint Requirement 1.3 declares', () => {
    for (const kind of DATA_NODE_KINDS) {
      const entry = findCatalogEntryByKind(kind);
      const ports = entry?.ports.map(port => ({ name: port.name, role: port.role })) ?? [];
      expect(ports).withContext(`${kind} ports`).toEqual(EXPECTED_PORTS[kind]);
    }
  });

  it('gives every Data_Node entry default data with every non-optional field populated', () => {
    for (const kind of DATA_NODE_KINDS) {
      const entry = findCatalogEntryByKind(kind);
      const data = entry?.defaultData() as Record<string, unknown> | undefined;
      expect(data).withContext(`${kind} defaultData`).toBeTruthy();
      for (const field of REQUIRED_FIELDS[kind] ?? []) {
        const value = data![field];
        expect(value === undefined || value === null)
          .withContext(`${kind}.${field} should hold a value`)
          .toBeFalse();
      }
    }
  });

  it('renders every Data_Node entry under the Data section', () => {
    for (const kind of DATA_NODE_KINDS) {
      const entry = findCatalogEntryByKind(kind);
      expect(entry?.section).withContext(`${kind} section`).toBe('Data');
      // Requirement 1.7: the accent stays `flow` even though the section differs.
      expect(entry?.category).withContext(`${kind} category`).toBe('flow');
    }
  });
});

/**
 * `remoteAlternativeId` is what turns "this node cannot be deployed" into an
 * actionable instruction, so a dangling or still-local target silently
 * downgrades the deploy warning back to a dead end.
 */
describe('node-catalog: MCP preset remote alternatives', () => {
  it('points every remoteAlternativeId at an existing, cloud-capable preset', () => {
    for (const preset of MCP_PRESETS) {
      if (!preset.remoteAlternativeId) continue;
      const alternative = findMcpPreset(preset.remoteAlternativeId);
      expect(alternative)
        .withContext(`${preset.id} → ${preset.remoteAlternativeId} must exist`)
        .toBeTruthy();
      expect(alternative!.transport)
        .withContext(`${preset.id}'s alternative must not itself be local`)
        .toBe('sse');
      expect(alternative!.url?.trim().length ?? 0)
        .withContext(`${preset.id}'s alternative needs a server URL`)
        .toBeGreaterThan(0);
    }
  });

  it('only declares remoteAlternativeId on local (stdio) presets', () => {
    for (const preset of MCP_PRESETS) {
      if (!preset.remoteAlternativeId) continue;
      expect(preset.transport ?? 'stdio')
        .withContext(`${preset.id} is already remote, so an alternative is meaningless`)
        .toBe('stdio');
    }
  });

  it('gives every remote preset a URL and every local preset a command', () => {
    for (const preset of MCP_PRESETS) {
      if ((preset.transport ?? 'stdio') === 'sse') {
        // `remote-mcp-oauth` is the deliberate exception: the user supplies it.
        if (preset.id !== 'remote-mcp-oauth') {
          expect(preset.url?.trim().length ?? 0).withContext(`${preset.id} url`).toBeGreaterThan(0);
        }
      } else {
        expect(preset.command?.trim().length ?? 0)
          .withContext(`${preset.id} command`)
          .toBeGreaterThan(0);
      }
    }
  });

  it('classifies transport the same way defaultData() does', () => {
    // `stdio` is the default, so an absent transport must read as local -
    // getting this backwards would silently mark every generic MCP node as
    // cloud-deployable.
    expect(mcpTransportKind(undefined)).toBe('local');
    expect(mcpTransportKind('stdio')).toBe('local');
    expect(mcpTransportKind('sse')).toBe('remote');
    // An OAuth session never reaches a deployed worker, so it is its own
    // kind - "remote" must mean "deployable", not merely "over the network".
    expect(mcpTransportKind('sse', 'oauth')).toBe('oauth');
    expect(mcpTransportKind('sse', 'bearer')).toBe('remote');
  });

  it('keeps transport out of preset labels now that an icon carries it', () => {
    for (const preset of MCP_PRESETS) {
      expect(preset.label.toLowerCase())
        .withContext(`${preset.id} label should not spell out its transport`)
        .not.toMatch(/\((local|remote)\b/);
    }
  });
});

/**
 * The Settings → Integrations list is the target of the canvas warning's
 * "Configure in Settings" deep-link, so any preset that can carry a warning
 * must be listed there. An OAuth preset has an EMPTY `envSchema` (its
 * credential is a session, not a pasted value), which is exactly what made it
 * invisible and the deep-link a dead end.
 */
describe('node-catalog: presets that need a Settings entry', () => {
  const listed = (preset: (typeof MCP_PRESETS)[number]): boolean =>
    preset.envSchema.length > 0 || preset.authMode === 'oauth';

  it('lists every OAuth preset', () => {
    const oauthPresets = MCP_PRESETS.filter(preset => preset.authMode === 'oauth');
    expect(oauthPresets.length).toBeGreaterThan(0);
    for (const preset of oauthPresets) {
      expect(listed(preset)).withContext(`${preset.id} must appear in Integrations`).toBeTrue();
    }
  });

  it('lists the remote alternative of every local preset that names one', () => {
    for (const preset of MCP_PRESETS) {
      if (!preset.remoteAlternativeId) continue;
      const alternative = findMcpPreset(preset.remoteAlternativeId)!;
      expect(listed(alternative))
        .withContext(`${alternative.id} is offered as a fix, so it must be configurable`)
        .toBeTrue();
    }
  });
});
