import { Injectable, computed, inject, signal } from '@angular/core';

import {
  buildConnectorConnection,
  connectorConfigDefaults,
  connectorPreviewSpec,
  connectorSecretKeyNames,
  connectorStepNodeData,
  inspectAgainstCapabilities,
  missingConnectorConfig,
  parseConnectorBundle,
  satisfiesMinAppVersion,
  validateConnectorBundle,
  type CapabilityReport,
  type Connection,
  type ConnectorBundle,
  type ConnectorFinding,
  type ConnectorParseResult,
  type ConnectorStep,
  type HostCapabilities,
} from '@phorma/engine';

import { APP_VERSION } from './app-version';
import { BUILTIN_CONNECTOR_BUNDLES } from './connectors-builtin';
import {
  connectorInstallId,
  connectorStepEntryId,
  isBuiltInConnector,
  parseConnectorStepEntryId,
  type ConnectorInstallSummary,
  type ConnectorSource,
  type ConnectorStepEntry,
  type InstalledConnector,
} from './connectors.model';
import { ConnectionsService } from './connections.service';
import { IndexedDbStorageService } from './indexed-db-storage.service';
import {
  findCatalogEntryByKind,
  registerConnectorStepResolver,
  type NodeCatalogEntry,
} from './node-catalog';

/** What an install needs that the bundle cannot supply. */
export interface ConnectorInstallOptions {
  source?: ConnectorSource;
  /**
   * Bind the steps to an EXISTING connection instead of creating one. The type
   * must match the bundle's template; a mismatch is refused rather than coerced.
   */
  connectionId?: string;
  /** Operator label for a newly created connection. Defaults to the bundle name. */
  connectionName?: string;
  /** Values for the declared config fields. Defaults fill the rest. */
  config?: Record<string, string>;
  /**
   * Install the steps only, creating no connection. The steps land unbound and
   * the user picks a connection per node later.
   */
  skipConnection?: boolean;
}

export type ConnectorInstallResult =
  | { ok: true; connector: InstalledConnector; connection?: Connection }
  | { ok: false; findings: ConnectorFinding[] };

/**
 * `ConnectorsService` - the installed connector library (P1-14).
 *
 * Owns the IndexedDB `connectors` store and the derived read-only built-ins, and
 * performs the one act that matters: turning a bundle into a `Connection` plus a
 * set of instantiable steps.
 *
 * The invariants it upholds, all of them checkable in the code below:
 *
 * - A bundle is validated by the engine BEFORE it is stored, so an invalid or
 *   secret-carrying file never reaches IndexedDB.
 * - An install never writes a secret VALUE and never sets `allowWrites`. The
 *   connection is created with declared secret NAMES only, and the user fills
 *   the values in the connection editor afterwards.
 * - Built-ins are derived, never persisted, so `remove()` refuses them.
 *
 * DI: storage plus `ConnectionsService`. Nothing on the model-transport path, so
 * this sits well clear of the NG0200 cycle documented in the `structure`
 * steering.
 */
@Injectable({ providedIn: 'root' })
export class ConnectorsService {
  private readonly storage = inject(IndexedDbStorageService);
  private readonly connections = inject(ConnectionsService);

  private readonly installedState = signal<InstalledConnector[]>([]);

  /** Connectors compiled into the app. Derived once, read-only. */
  private readonly builtIns: readonly InstalledConnector[] = BUILTIN_CONNECTOR_BUNDLES.filter(
    bundle => {
      const findings = validateConnectorBundle(bundle);
      const errors = findings.filter(finding => finding.severity === 'error');
      if (errors.length === 0) return true;
      // A broken built-in is a build-time mistake (`connectors-builtin.spec.ts`
      // fails on it). Drop it at runtime rather than let it wedge the panel.
      console.warn(
        `Built-in connector "${bundle?.id}" is invalid and was not loaded:`,
        errors.map(finding => `${finding.path}: ${finding.message}`),
      );
      return false;
    },
  ).map(bundle => ({
    id: connectorInstallId(bundle.id, 'builtin'),
    bundle,
    installedAt: '',
    updatedAt: '',
    source: 'builtin' as const,
  }));

  /** User-installed connectors, most recently installed first. */
  readonly installed = this.installedState.asReadonly();

  /** Everything the user can reach: built-ins first, then their own installs. */
  readonly connectors = computed<InstalledConnector[]>(() => [
    ...this.builtIns,
    ...this.installedState(),
  ]);

  readonly byId = computed(() => new Map(this.connectors().map(entry => [entry.id, entry])));

  /**
   * Every step of every installed connector, flattened for the palette. Order
   * follows {@link connectors}, then declaration order within a bundle, so the
   * palette is stable across reloads.
   */
  readonly steps = computed<ConnectorStepEntry[]>(() =>
    this.connectors().flatMap(connector =>
      (connector.bundle.steps ?? []).map(step => ({
        entryId: connectorStepEntryId(connector.id, step.id),
        connectorId: connector.id,
        connectorName: connector.bundle.name,
        ...(connector.connectionId ? { connectionId: connector.connectionId } : {}),
        step,
      })),
    ),
  );

  readonly stepByEntryId = computed(() => new Map(this.steps().map(entry => [entry.entryId, entry])));

  constructor() {
    // The catalog cannot know about runtime-installed steps, so it asks. This is
    // what makes the canvas drop, click-to-add, the AI router and the test
    // harness all work for connector steps with no further changes.
    registerConnectorStepResolver(entryId => this.catalogEntryFor(entryId));
    void this.refresh();
  }

  async refresh(): Promise<void> {
    try {
      this.installedState.set(await this.storage.listConnectors());
    } catch {
      // The connector library must never break the studio - unreadable lists empty.
      this.installedState.set([]);
    }
  }

  // ── Reading a file ──────────────────────────────────────────────────────

  /**
   * Parses connector file text, adding the app-version gate the pure parser
   * cannot make (it has no idea which build it runs in).
   */
  parse(text: string): ConnectorParseResult {
    const result = parseConnectorBundle(text);
    if (!result.ok) return result;
    if (!satisfiesMinAppVersion(result.bundle, APP_VERSION)) {
      return {
        ok: false,
        findings: [
          {
            severity: 'error',
            path: 'minAppVersion',
            message:
              `"${result.bundle.name}" needs Phorma Agent Studio ` +
              `${result.bundle.minAppVersion} or newer. This build is ${APP_VERSION}.`,
          },
        ],
      };
    }
    return result;
  }

  // ── Install preview ─────────────────────────────────────────────────────

  /** What installing this bundle will create, for the preview dialog. */
  summarize(bundle: ConnectorBundle): ConnectorInstallSummary {
    return {
      stepCount: bundle.steps?.length ?? 0,
      tableCount: bundle.tables?.length ?? 0,
      workflowCount: bundle.workflows?.length ?? 0,
      secretKeys: connectorSecretKeyNames(bundle.connection),
      requiredConfig: missingConnectorConfig(bundle.connection, connectorConfigDefaults(bundle.connection)),
      needsWrites: bundle.connection?.needsWrites === true,
    };
  }

  /**
   * Capability findings and declared egress for a bundle, through the SAME walk
   * push-time validation uses. A preview that reimplemented egress collection
   * would drift from what actually blocks a deploy.
   */
  inspect(
    bundle: ConnectorBundle,
    capabilities: HostCapabilities,
    connectionId?: string,
  ): CapabilityReport {
    const summaries = this.connections.connections().map(connection => ({
      ...connection,
      secretsPresent: connection.secretKeys.length,
    }));
    return inspectAgainstCapabilities(
      connectorPreviewSpec(bundle, connectionId),
      capabilities,
      summaries,
    );
  }

  // ── Install ─────────────────────────────────────────────────────────────

  /**
   * Installs a bundle: validates it, creates or binds a connection, and stores
   * the install record.
   *
   * Never writes a secret value - the connection is created declaring secret
   * NAMES only, so the connection editor's "2 secrets needed" state is what the
   * user sees next. Never sets `allowWrites`, however loudly `needsWrites` asks:
   * that decision belongs to whoever owns the credential.
   */
  async install(
    bundle: ConnectorBundle,
    options: ConnectorInstallOptions = {},
  ): Promise<ConnectorInstallResult> {
    const findings = validateConnectorBundle(bundle);
    if (findings.some(finding => finding.severity === 'error')) return { ok: false, findings };

    const source = options.source ?? 'file';
    if (source === 'builtin') {
      return {
        ok: false,
        findings: [
          {
            severity: 'error',
            path: 'id',
            message: 'Built-in connectors are compiled into the app and are not installed.',
          },
        ],
      };
    }

    let connection: Connection | undefined;
    if (!options.skipConnection) {
      const bound = await this.resolveConnection(bundle, options);
      if (!bound.ok) return { ok: false, findings: bound.findings };
      connection = bound.connection;
    }

    const now = new Date().toISOString();
    const id = connectorInstallId(bundle.id, source);
    const existing = this.installedState().find(entry => entry.id === id);
    const connector: InstalledConnector = {
      id,
      bundle,
      installedAt: existing?.installedAt ?? now,
      updatedAt: now,
      ...(connection ? { connectionId: connection.id } : {}),
      source,
    };

    await this.storage.saveConnector(connector);
    await this.refresh();
    return connection ? { ok: true, connector, connection } : { ok: true, connector };
  }

  /** Installs from file text in one step. */
  async installFromText(
    text: string,
    options: ConnectorInstallOptions = {},
  ): Promise<ConnectorInstallResult> {
    const parsed = this.parse(text);
    if (!parsed.ok) return { ok: false, findings: parsed.findings };
    return this.install(parsed.bundle, options);
  }

  /**
   * Removes a user-installed connector. Its connection and any nodes built from
   * its steps are deliberately left alone: the nodes are ordinary data nodes and
   * the credential is the user's, not the bundle's.
   */
  async remove(id: string): Promise<void> {
    if (isBuiltInConnector(id)) {
      throw new Error('Built-in connectors cannot be removed.');
    }
    await this.storage.removeConnector(id);
    await this.refresh();
  }

  /** Points an installed connector at a different connection. */
  async rebind(id: string, connectionId: string | undefined): Promise<void> {
    const current = this.installedState().find(entry => entry.id === id);
    if (!current) throw new Error(`Connector "${id}" is not installed.`);
    const next: InstalledConnector = {
      ...current,
      ...(connectionId ? { connectionId } : {}),
      updatedAt: new Date().toISOString(),
    };
    if (!connectionId) delete next.connectionId;
    await this.storage.saveConnector(next);
    await this.refresh();
  }

  // ── Instantiation ───────────────────────────────────────────────────────

  /**
   * Node data for one step, ready for the canvas: the packaged configuration
   * with the install's connection bound and any mapping tables inlined.
   * `null` when the entry id names a step that is no longer installed.
   */
  nodeDataFor(entryId: string): { step: ConnectorStep; data: object } | null {
    const parsed = parseConnectorStepEntryId(entryId);
    if (!parsed) return null;
    const connector = this.byId().get(parsed.connectorId);
    const step = connector?.bundle.steps?.find(candidate => candidate.id === parsed.stepId);
    if (!connector || !step) return null;
    return { step, data: connectorStepNodeData(connector.bundle, step, connector.connectionId) };
  }

  /**
   * A transient catalog entry for one connector step, so the existing
   * palette-to-canvas path instantiates it with no special case.
   *
   * Ports, category and the fallback icon come from the step's KIND, taken
   * straight from `NODE_CATALOG`. That is deliberate: a connector step must land
   * as an ordinary data node, port for port, or the canvas would grow a second
   * kind of http-request node that only looks the same.
   */
  catalogEntryFor(entryId: string): NodeCatalogEntry | undefined {
    const resolved = this.nodeDataFor(entryId);
    if (!resolved) return undefined;
    const { step, data } = resolved;
    const base = findCatalogEntryByKind(step.kind);
    if (!base) return undefined;
    return {
      id: entryId,
      label: step.label,
      description: step.description ?? base.description,
      icon: step.icon ?? base.icon,
      category: base.category,
      kind: base.kind,
      ...(step.keywords ? { keywords: step.keywords } : {}),
      section: base.section,
      defaultName: step.label,
      ports: base.ports,
      // A fresh clone per instantiation: `connectorStepNodeData` already returns
      // one, but `defaultData` may be called more than once per drop.
      defaultData: () =>
        (this.nodeDataFor(entryId)?.data ?? data) as ReturnType<NodeCatalogEntry['defaultData']>,
    };
  }

  /** Secret names an installed connector still needs values for. */
  missingSecretKeys(connector: InstalledConnector): string[] {
    if (!connector.connectionId) return connectorSecretKeyNames(connector.bundle.connection);
    const connection = this.connections
      .connections()
      .find(candidate => candidate.id === connector.connectionId);
    if (!connection) return connectorSecretKeyNames(connector.bundle.connection);
    // Presence of a VALUE is a keychain question the connection editor answers.
    // What is knowable here is which declared names the connection carries.
    return connectorSecretKeyNames(connector.bundle.connection).filter(
      name => !connection.secretKeys.includes(name),
    );
  }

  // ── Internals ───────────────────────────────────────────────────────────

  /** Creates the bundle's connection, or validates the one the caller picked. */
  private async resolveConnection(
    bundle: ConnectorBundle,
    options: ConnectorInstallOptions,
  ): Promise<{ ok: true; connection: Connection } | { ok: false; findings: ConnectorFinding[] }> {
    if (options.connectionId) {
      const existing = this.connections
        .connections()
        .find(candidate => candidate.id === options.connectionId);
      if (!existing) {
        return {
          ok: false,
          findings: [
            {
              severity: 'error',
              path: 'connection',
              message: `Connection "${options.connectionId}" was not found.`,
            },
          ],
        };
      }
      if (existing.type !== bundle.connection.type) {
        return {
          ok: false,
          findings: [
            {
              severity: 'error',
              path: 'connection.type',
              message:
                `"${existing.name}" is a ${existing.type} connection, but this connector ` +
                `needs a ${bundle.connection.type} one.`,
            },
          ],
        };
      }
      // Declare any secret names the bundle needs that the connection does not
      // carry yet, so the editor prompts for them. Values are never touched.
      const missing = connectorSecretKeyNames(bundle.connection).filter(
        name => !existing.secretKeys.includes(name),
      );
      if (missing.length === 0) return { ok: true, connection: existing };
      const updated = await this.connections.update(existing.id, {
        secretKeys: [...existing.secretKeys, ...missing],
      });
      return { ok: true, connection: updated };
    }

    const missingConfig = missingConnectorConfig(bundle.connection, {
      ...connectorConfigDefaults(bundle.connection),
      ...(options.config ?? {}),
    });
    if (missingConfig.length > 0) {
      return {
        ok: false,
        findings: missingConfig.map(name => ({
          severity: 'error' as const,
          path: `connection.configFields.${name}`,
          message: `"${name}" is required before this connector can be installed.`,
        })),
      };
    }

    // Built through the engine so the "no allowWrites, declared keys only" rules
    // live in one property-tested place, then persisted by the connections
    // service, which owns the store and the id format.
    const blueprint = buildConnectorConnection(bundle, {
      id: 'conn-placeholder',
      nowIso: new Date().toISOString(),
      ...(options.connectionName ? { name: options.connectionName } : {}),
      ...(options.config ? { config: options.config } : {}),
    });
    const created = await this.connections.create({
      name: blueprint.name,
      type: blueprint.type,
      config: blueprint.config,
      secretKeys: blueprint.secretKeys,
      auth: blueprint.auth,
      ...(blueprint.limits ? { limits: blueprint.limits } : {}),
    });
    return { ok: true, connection: created };
  }
}
