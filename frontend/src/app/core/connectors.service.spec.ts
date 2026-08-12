import { TestBed } from '@angular/core/testing';

import { serializeConnectorBundle, type ConnectorBundle } from '@phorma/engine';

import { ConnectionsService } from './connections.service';
import { ConnectorsService } from './connectors.service';
import { connectorStepEntryId } from './connectors.model';

/**
 * Installing a connector, against the real IndexedDB (P1-14).
 *
 * Runs in Chrome under karma deliberately: the install path crosses the DB v10
 * `connectors` store and `ConnectionsService`, and those are exactly the parts a
 * pure unit test would have to fake into meaninglessness. What is asserted here
 * is the plan's decision 5 - installing grants no trust - plus the store
 * round-trip that the migration has to make work.
 */
describe('ConnectorsService install', () => {
  let connectors: ConnectorsService;
  let connections: ConnectionsService;
  const installedIds: string[] = [];
  const createdConnectionIds: string[] = [];

  function bundle(overrides: Partial<ConnectorBundle> = {}): ConnectorBundle {
    return {
      format: 1,
      id: `cx-spec-${Math.random().toString(36).slice(2, 8)}`,
      name: 'Spec connector',
      version: '1.0.0',
      connection: {
        type: 'http',
        configFields: [{ name: 'baseUrl', label: 'Base URL', required: true }],
        secretFields: [{ name: 'apiToken', label: 'API token' }],
        auth: { mode: 'bearer', secretKey: 'apiToken' },
        needsWrites: true,
      },
      steps: [
        {
          id: 'list-things',
          label: 'List things',
          kind: 'http-request',
          data: { method: 'GET', url: '/things', responseMode: 'json' },
        },
      ],
      ...overrides,
    };
  }

  beforeEach(async () => {
    TestBed.configureTestingModule({});
    connectors = TestBed.inject(ConnectorsService);
    connections = TestBed.inject(ConnectionsService);
    await connectors.refresh();
    await connections.refresh();
  });

  afterEach(async () => {
    // Leave the shared browser database as it was found.
    for (const id of installedIds.splice(0)) {
      try {
        await connectors.remove(id);
      } catch {
        /* already gone */
      }
    }
    for (const id of createdConnectionIds.splice(0)) {
      try {
        await connections.remove(id);
      } catch {
        /* already gone */
      }
    }
  });

  it('installs from file text, creating a connection that declares the secret NAMES only', async () => {
    const source = bundle();
    const result = await connectors.installFromText(serializeConnectorBundle(source), {
      config: { baseUrl: 'https://api.example.test' },
    });

    expect(result.ok).toBeTrue();
    if (!result.ok) return;
    installedIds.push(result.connector.id);
    if (result.connection) createdConnectionIds.push(result.connection.id);

    expect(result.connection).toBeTruthy();
    expect(result.connection!.secretKeys).toEqual(['apiToken']);
    expect(result.connection!.config).toEqual({ baseUrl: 'https://api.example.test' });
    // Decision 5: `needsWrites: true` in the bundle must NOT grant write access.
    expect(result.connection!.allowWrites).toBeUndefined();
  });

  it('survives a reload: the bundle round-trips through the connectors store', async () => {
    const source = bundle();
    const result = await connectors.installFromText(serializeConnectorBundle(source), {
      config: { baseUrl: 'https://api.example.test' },
    });
    expect(result.ok).toBeTrue();
    if (!result.ok) return;
    installedIds.push(result.connector.id);
    if (result.connection) createdConnectionIds.push(result.connection.id);

    await connectors.refresh();
    const stored = connectors.installed().find(entry => entry.id === source.id);
    expect(stored).toBeTruthy();
    expect(stored!.bundle).toEqual(source);
    expect(stored!.connectionId).toBe(result.connection!.id);
  });

  it('exposes the installed step to the catalog, with the connection bound', async () => {
    const source = bundle();
    const result = await connectors.installFromText(serializeConnectorBundle(source), {
      config: { baseUrl: 'https://api.example.test' },
    });
    expect(result.ok).toBeTrue();
    if (!result.ok) return;
    installedIds.push(result.connector.id);
    if (result.connection) createdConnectionIds.push(result.connection.id);

    const entryId = connectorStepEntryId(source.id, 'list-things');
    const entry = connectors.catalogEntryFor(entryId);
    expect(entry).toBeTruthy();
    expect(entry!.kind).toBe('http-request');
    expect(entry!.label).toBe('List things');

    const data = entry!.defaultData() as { connectionId?: string; url?: string };
    expect(data.connectionId).toBe(result.connection!.id);
    expect(data.url).toBe('/things');
  });

  it('refuses a bundle carrying a credential, writing nothing', async () => {
    const leaking = bundle({ description: 'token sk-ABCDEFGHIJKLMNOPQRSTUVWX' });
    const before = connectors.installed().length;

    const result = await connectors.installFromText(serializeConnectorBundle(leaking));

    expect(result.ok).toBeFalse();
    await connectors.refresh();
    expect(connectors.installed().length).toBe(before);
  });

  it('blocks an install that leaves a required config field empty', async () => {
    const result = await connectors.installFromText(serializeConnectorBundle(bundle()));

    expect(result.ok).toBeFalse();
    if (result.ok) return;
    expect(result.findings.some(finding => finding.message.includes('baseUrl'))).toBeTrue();
  });

  it('installs steps only when asked, binding no connection', async () => {
    const source = bundle();
    const result = await connectors.installFromText(serializeConnectorBundle(source), {
      skipConnection: true,
    });

    expect(result.ok).toBeTrue();
    if (!result.ok) return;
    installedIds.push(result.connector.id);
    expect(result.connection).toBeUndefined();

    const data = connectors.catalogEntryFor(connectorStepEntryId(source.id, 'list-things'))!.defaultData();
    expect('connectionId' in (data as object)).toBeFalse();
  });

  it('never removes a built-in connector', async () => {
    const builtIn = connectors.connectors().find(entry => entry.source === 'builtin');
    expect(builtIn).toBeTruthy();
    await expectAsync(connectors.remove(builtIn!.id)).toBeRejected();
  });

  it('ships built-in connectors that all pass validation', () => {
    // The runtime guard drops an invalid built-in with a console warning, so the
    // count is the observable signal that none were dropped.
    expect(connectors.connectors().filter(entry => entry.source === 'builtin').length).toBe(2);
  });
});
