import { BUILTIN_CONNECTOR_PREFIX } from '@phorma/engine';

import { BUILTIN_CONNECTOR_BUNDLES } from './connectors-builtin';
import {
  CONNECTOR_STEP_PREFIX,
  connectorInstallId,
  connectorStepEntryId,
  isBuiltInConnector,
  parseConnectorStepEntryId,
} from './connectors.model';
import {
  buildNodeFromCatalog,
  findCatalogEntry,
  findCatalogEntryByKind,
  registerConnectorStepResolver,
} from './node-catalog';

/**
 * Connector step identity and the catalog resolver seam (P1-14, plan
 * `docs/connector-packaging-plan.md` decision 2).
 *
 * The seam is what lets a runtime-installed step be dropped, clicked, added by
 * the AI or built by the test harness without any of those paths knowing
 * connectors exist - and without a DI edge from `WorkflowService` into
 * `ConnectorsService`, which would close a cycle through `ConnectionsService`.
 * If this breaks, connector steps silently stop instantiating, so it is pinned
 * here rather than left to the browser.
 */

describe('connector step entry ids', () => {
  it('round-trips a connector id and step id', () => {
    const entryId = connectorStepEntryId('cx-acme', 'list-invoices');
    expect(entryId).toBe(`${CONNECTOR_STEP_PREFIX}cx-acme:list-invoices`);
    expect(parseConnectorStepEntryId(entryId)).toEqual({
      connectorId: 'cx-acme',
      stepId: 'list-invoices',
    });
  });

  it('round-trips a BUILT-IN connector id, which itself contains a colon', () => {
    const connectorId = connectorInstallId('cx-rest-api', 'builtin');
    expect(connectorId).toBe(`${BUILTIN_CONNECTOR_PREFIX}cx-rest-api`);
    const parsed = parseConnectorStepEntryId(connectorStepEntryId(connectorId, 'list-records'));
    expect(parsed).toEqual({ connectorId, stepId: 'list-records' });
    expect(isBuiltInConnector(parsed!.connectorId)).toBe(true);
  });

  it('rejects anything that is not a connector step id', () => {
    for (const value of ['', 'data-http-request', 'mcp-preset:xero', `${CONNECTOR_STEP_PREFIX}cx-acme`]) {
      expect(parseConnectorStepEntryId(value)).withContext(value).toBeNull();
    }
  });

  it('treats a user-installed id as not built in', () => {
    expect(isBuiltInConnector(connectorInstallId('cx-acme', 'file'))).toBe(false);
  });
});

describe('findCatalogEntry connector-step seam', () => {
  afterEach(() => registerConnectorStepResolver(undefined));

  it('returns undefined for a connector step when no resolver is registered', () => {
    expect(findCatalogEntry(connectorStepEntryId('cx-acme', 'list'))).toBeUndefined();
  });

  it('asks the registered resolver, and leaves ordinary catalog ids alone', () => {
    const base = findCatalogEntryByKind('http-request')!;
    const asked: string[] = [];
    registerConnectorStepResolver(entryId => {
      asked.push(entryId);
      return { ...base, id: entryId, label: 'List invoices', defaultName: 'List invoices' };
    });

    const entryId = connectorStepEntryId('cx-acme', 'list-invoices');
    expect(findCatalogEntry(entryId)?.label).toBe('List invoices');
    expect(asked).toEqual([entryId]);

    // A real catalog id must never reach the resolver.
    expect(findCatalogEntry('data-http-request')?.kind).toBe('http-request');
    expect(asked.length).toBe(1);
  });

  it('instantiates a connector step as an ordinary data node', () => {
    const bundle = BUILTIN_CONNECTOR_BUNDLES[0]!;
    const step = bundle.steps[0]!;
    const base = findCatalogEntryByKind(step.kind)!;
    registerConnectorStepResolver(entryId => ({
      ...base,
      id: entryId,
      label: step.label,
      defaultName: step.label,
      defaultData: () => ({ ...(step.data as object), connectionId: 'conn-test' }) as never,
    }));

    const entry = findCatalogEntry(connectorStepEntryId('cx-rest-api', step.id))!;
    const node = buildNodeFromCatalog(entry, { x: 0, y: 0 });

    expect(node.kind).toBe(step.kind);
    expect(node.name).toBe(step.label);
    // Port for port identical to a palette-dropped node of the same kind: a
    // connector step must not become a second species of http-request node.
    expect(node.ports.map(port => ({ name: port.name, role: port.role }))).toEqual(
      base.ports.map(port => ({ name: port.name, role: port.role })),
    );
    expect((node.data as { connectionId?: string }).connectionId).toBe('conn-test');
  });
});
