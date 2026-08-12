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
import { CheckboxModule } from 'primeng/checkbox';
import { InputTextModule } from 'primeng/inputtext';
import { SelectModule } from 'primeng/select';

import {
  CONNECTOR_PACKAGEABLE_KINDS,
  connectorFileName,
  packageConnectorBundle,
  serializeConnectorBundle,
  type ConnectorFinding,
} from '@phorma/engine';

import { ConnectionsService } from '../../../core/connections.service';
import { ConnectorPackageDialogService } from '../connector-package-dialog.service';
import { ToastService } from '../../../shared/toast/toast.service';
import { WorkflowService } from '../../../core/workflow.service';
import type { WorkflowNode } from '../../../core/workflow.model';

/** One packageable node in the active workflow. */
interface PackageCandidate {
  node: WorkflowNode;
  selected: boolean;
}

/**
 * "Package as connector" (P1-14) - turns data nodes that already work into a
 * shareable `.connector.json`.
 *
 * The extraction itself is `packageConnectorBundle` in the engine, so the rules
 * that matter are unit-tested rather than living in a component: no secret, no
 * config VALUES (the author's own base url identifies their install), no
 * connection id, no port ids, and mapping tables lifted to bundle level.
 *
 * The dialog refuses to export a bundle the validator rejects. That is the point
 * of the whole feature working this way round: if a node carries a hardcoded
 * credential, packaging fails loudly here instead of publishing the key.
 */
@Component({
  selector: 'app-connector-package-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, ButtonModule, CheckboxModule, InputTextModule, SelectModule],
  templateUrl: './connector-package-dialog.html',
  styleUrl: './connector-package-dialog.scss',
})
export class ConnectorPackageDialog {
  protected readonly dialog = inject(ConnectorPackageDialogService);
  private readonly workflow = inject(WorkflowService);
  private readonly connections = inject(ConnectionsService);
  private readonly toast = inject(ToastService);

  protected readonly name = signal('');
  protected readonly version = signal('1.0.0');
  protected readonly description = signal('');
  protected readonly author = signal('');
  protected readonly connectionId = signal<string | null>(null);
  protected readonly selectedIds = signal<Set<string>>(new Set());

  /** Every node of the active workflow a connector can carry. */
  protected readonly candidates = computed<PackageCandidate[]>(() => {
    const selected = this.selectedIds();
    return this.workflow
      .graph()
      .nodes.filter(node => (CONNECTOR_PACKAGEABLE_KINDS as readonly string[]).includes(node.kind))
      .map(node => ({ node, selected: selected.has(node.id) }));
  });

  /** Connections referenced by the packageable nodes, then everything else. */
  protected readonly connectionOptions = computed(() => {
    const referenced = new Set(
      this.candidates()
        .map(candidate => (candidate.node.data as { connectionId?: string }).connectionId)
        .filter((id): id is string => typeof id === 'string'),
    );
    return this.connections
      .connections()
      .map(connection => ({
        id: connection.id,
        label: referenced.has(connection.id)
          ? `${connection.name} (used here)`
          : `${connection.name} (${connection.type})`,
        used: referenced.has(connection.id),
      }))
      .sort((a, b) => Number(b.used) - Number(a.used));
  });

  /**
   * Seeds the form when the dialog opens: the workflow name, and the nodes and
   * connection already in play, so the common case is "open, click Package".
   */
  private readonly seed = effect(() => {
    const visible = this.dialog.visible();
    untracked(() => {
      if (!visible) return;
      this.name.set(this.workflow.activeName() || 'My connector');
      this.version.set('1.0.0');
      this.description.set('');
      this.author.set('');

      const preselected = this.dialog.preselectedNodeIds();
      const packageable = this.workflow
        .graph()
        .nodes.filter(node => (CONNECTOR_PACKAGEABLE_KINDS as readonly string[]).includes(node.kind));
      const chosen =
        preselected.length > 0
          ? packageable.filter(node => preselected.includes(node.id))
          : packageable;
      this.selectedIds.set(new Set(chosen.map(node => node.id)));

      const referenced = chosen
        .map(node => (node.data as { connectionId?: string }).connectionId)
        .find((id): id is string => typeof id === 'string');
      this.connectionId.set(referenced ?? this.connections.connections()[0]?.id ?? null);
    });
  });

  /** The bundle as it currently stands, with the validator's verdict. */
  protected readonly preview = computed(() => {
    const connection = this.connections.connections().find(item => item.id === this.connectionId());
    const steps = this.candidates()
      .filter(candidate => candidate.selected)
      .map(candidate => ({
        label: candidate.node.name,
        kind: candidate.node.kind,
        data: candidate.node.data as object,
        ...(candidate.node.description ? { description: candidate.node.description } : {}),
        ...(candidate.node.icon ? { icon: candidate.node.icon } : {}),
      }));
    if (!connection || steps.length === 0) return null;

    return packageConnectorBundle({
      id: bundleIdFor(this.name()),
      name: this.name().trim() || 'My connector',
      version: this.version().trim() || '1.0.0',
      ...(this.description().trim() ? { description: this.description().trim() } : {}),
      ...(this.author().trim() ? { author: this.author().trim() } : {}),
      connection,
      steps,
    });
  });

  protected readonly errors = computed<ConnectorFinding[]>(() =>
    (this.preview()?.findings ?? []).filter(finding => finding.severity === 'error'),
  );

  protected readonly selectedCount = computed(
    () => this.candidates().filter(candidate => candidate.selected).length,
  );

  protected readonly canPackage = computed(
    () => this.preview() !== null && this.errors().length === 0,
  );

  @HostListener('document:keydown.escape')
  protected onEscape(): void {
    if (this.dialog.visible()) this.dialog.close();
  }

  protected toggleNode(nodeId: string): void {
    this.selectedIds.update(current => {
      const next = new Set(current);
      if (next.has(nodeId)) next.delete(nodeId);
      else next.add(nodeId);
      return next;
    });
  }

  protected onNameInput(event: Event): void {
    this.name.set((event.target as HTMLInputElement | null)?.value ?? '');
  }

  protected onVersionInput(event: Event): void {
    this.version.set((event.target as HTMLInputElement | null)?.value ?? '');
  }

  protected onDescriptionInput(event: Event): void {
    this.description.set((event.target as HTMLInputElement | null)?.value ?? '');
  }

  protected onAuthorInput(event: Event): void {
    this.author.set((event.target as HTMLInputElement | null)?.value ?? '');
  }

  /** Downloads the packaged bundle. */
  protected download(): void {
    const result = this.preview();
    if (!result || !this.canPackage()) return;

    const blob = new Blob([serializeConnectorBundle(result.bundle)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = connectorFileName(result.bundle);
    anchor.click();
    // Deferred: revoking in the same tick can invalidate the blob before the
    // browser reads it.
    setTimeout(() => URL.revokeObjectURL(url), 0);

    this.toast.success(
      'Connector packaged',
      `${connectorFileName(result.bundle)} carries ${result.bundle.steps.length} ` +
        `${result.bundle.steps.length === 1 ? 'step' : 'steps'} and no credentials.`,
    );
    this.dialog.close();
  }
}

/** A `cx-` id derived from the connector name. */
function bundleIdFor(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return `cx-${slug || 'connector'}`;
}
