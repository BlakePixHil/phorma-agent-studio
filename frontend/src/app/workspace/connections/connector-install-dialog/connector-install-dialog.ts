import {
  ChangeDetectionStrategy,
  Component,
  HostListener,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { SelectModule } from 'primeng/select';

import {
  connectorConfigDefaults,
  missingConnectorConfig,
  type CapabilityFinding,
  type ConnectorConfigField,
} from '@phorma/engine';

import { CapabilityFindingsService } from '../../../core/capability-findings.service';
import { ConnectionsService } from '../../../core/connections.service';
import { ConnectorsService } from '../../../core/connectors.service';
import { ConnectorInstallDialogService } from '../connector-install-dialog.service';
import { ToastService } from '../../../shared/toast/toast.service';

/** How the install gets a connection. */
type ConnectionMode = 'create' | 'existing' | 'none';

/**
 * The connector install preview (P1-14).
 *
 * Answers, before anything is written: what installs, which credentials it will
 * need, where it will send traffic, whether it wants to WRITE to the target
 * system, and whether this host can run it at all.
 *
 * Egress and capability findings come from the same engine walk push-time
 * validation uses (`inspectAgainstCapabilities` over `connectorPreviewSpec`), so
 * the preview cannot drift from what actually blocks a deploy.
 *
 * No secret is collected here. The connection is created declaring secret NAMES
 * only, and the user is sent to the connection editor to fill the values - one
 * place that knows how to reach the keychain, one place to audit.
 */
@Component({
  selector: 'app-connector-install-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, ButtonModule, InputTextModule, SelectModule],
  templateUrl: './connector-install-dialog.html',
  styleUrl: './connector-install-dialog.scss',
})
export class ConnectorInstallDialog {
  protected readonly dialog = inject(ConnectorInstallDialogService);
  private readonly connectors = inject(ConnectorsService);
  private readonly connections = inject(ConnectionsService);
  private readonly capabilities = inject(CapabilityFindingsService);
  private readonly toast = inject(ToastService);

  protected readonly mode = signal<ConnectionMode>('create');
  protected readonly connectionName = signal('');
  protected readonly selectedConnectionId = signal<string | null>(null);
  protected readonly configDraft = signal<Record<string, string>>({});
  protected readonly installing = signal(false);
  protected readonly errors = signal<string[]>([]);

  /**
   * Seeds the form when a new bundle arrives. `untracked` around the writes:
   * this effect reads the bundle signal and writes several others, and the
   * repo has been bitten before by an effect that reads and writes the same
   * signal looping forever.
   */
  private readonly seed = effect(() => {
    const bundle = this.dialog.bundle();
    untracked(() => {
      this.errors.set([]);
      this.installing.set(false);
      if (!bundle) return;
      this.mode.set('create');
      this.connectionName.set(bundle.name ?? '');
      this.selectedConnectionId.set(null);
      this.configDraft.set({ ...connectorConfigDefaults(bundle.connection) });
    });
  });

  protected readonly summary = computed(() => {
    const bundle = this.dialog.bundle();
    return bundle ? this.connectors.summarize(bundle) : null;
  });

  /** Non-secret config fields the bundle declares, in declaration order. */
  protected readonly configFields = computed<ConnectorConfigField[]>(
    () => this.dialog.bundle()?.connection.configFields ?? [],
  );

  /** Existing connections of the right type, so a credential can be reused. */
  protected readonly reusableConnections = computed(() => {
    const type = this.dialog.bundle()?.connection.type;
    if (!type) return [];
    return this.connections
      .connections()
      .filter(connection => connection.type === type)
      .map(connection => ({ id: connection.id, label: `${connection.name} (${connection.type})` }));
  });

  protected readonly modeOptions = computed(() => {
    const options = [{ id: 'create' as ConnectionMode, label: 'Create a new connection' }];
    if (this.reusableConnections().length > 0) {
      options.push({ id: 'existing', label: 'Use an existing connection' });
    }
    options.push({ id: 'none', label: 'Install steps only' });
    return options;
  });

  /** Capability findings and declared egress for this bundle on THIS host. */
  protected readonly report = computed(() => {
    const bundle = this.dialog.bundle();
    if (!bundle) return null;
    const connectionId =
      this.mode() === 'existing' ? (this.selectedConnectionId() ?? undefined) : undefined;
    return this.connectors.inspect(bundle, this.capabilities.activeHostCapabilities(), connectionId);
  });

  protected readonly blockingFindings = computed<CapabilityFinding[]>(() =>
    // A missing connection is expected in a preview - the connection does not
    // exist until Install runs - so it is not shown as a blocker.
    (this.report()?.findings ?? []).filter(
      finding => finding.severity === 'error' && !finding.message.includes('is not configured'),
    ),
  );

  protected readonly egressHosts = computed(() => this.report()?.egressHosts ?? []);

  protected readonly hostLabel = computed(() => this.capabilities.activeHostCapabilities().label);

  /** Required config fields still empty, so Install can say what is missing. */
  protected readonly missingConfig = computed(() => {
    const bundle = this.dialog.bundle();
    if (!bundle || this.mode() !== 'create') return [];
    return missingConnectorConfig(bundle.connection, this.configDraft());
  });

  protected readonly canInstall = computed(() => {
    if (this.installing() || !this.dialog.bundle()) return false;
    if (this.mode() === 'existing' && !this.selectedConnectionId()) return false;
    return this.missingConfig().length === 0;
  });

  @HostListener('document:keydown.escape')
  protected onEscape(): void {
    if (this.dialog.visible() && !this.installing()) this.dialog.close();
  }

  protected onConfigInput(name: string, event: Event): void {
    const value = (event.target as HTMLInputElement | null)?.value ?? '';
    this.configDraft.update(draft => ({ ...draft, [name]: value }));
  }

  protected onNameInput(event: Event): void {
    this.connectionName.set((event.target as HTMLInputElement | null)?.value ?? '');
  }

  protected fieldId(name: string): string {
    return `cx-config-${name}`;
  }

  protected async install(): Promise<void> {
    const bundle = this.dialog.bundle();
    if (!bundle || !this.canInstall()) return;
    this.installing.set(true);
    this.errors.set([]);

    const mode = this.mode();
    const result = await this.connectors.install(bundle, {
      source: 'file',
      ...(mode === 'existing' ? { connectionId: this.selectedConnectionId() ?? undefined } : {}),
      ...(mode === 'none' ? { skipConnection: true } : {}),
      ...(mode === 'create'
        ? { connectionName: this.connectionName().trim() || bundle.name, config: this.configDraft() }
        : {}),
    });

    if (!result.ok) {
      this.installing.set(false);
      this.errors.set(result.findings.map(finding => finding.message));
      return;
    }

    const secrets = this.connectors.missingSecretKeys(result.connector);
    this.toast.success(
      'Connector installed',
      secrets.length > 0
        ? `"${bundle.name}" is ready. Add ${secrets.join(', ')} in Connections before running it.`
        : `"${bundle.name}" is ready. Its steps are in the palette under Data.`,
    );
    this.installing.set(false);
    this.dialog.close();
  }
}
