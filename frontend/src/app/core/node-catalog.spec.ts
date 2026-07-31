import { DATA_NODE_KINDS, type PortRole, type WorkflowNodeKind } from './workflow.model';
import { NODE_CATALOG, findCatalogEntryByKind } from './node-catalog';

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
