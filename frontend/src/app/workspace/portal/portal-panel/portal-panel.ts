import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';

import { ConfirmDialogService } from '../../../shared/confirm-dialog/confirm-dialog.service';
import { PanelRegistryService } from '../../../core/panel-registry.service';
import { PortalService } from '../../../core/portal.service';
import { SelectionService } from '../../../core/selection.service';
import { SettingsDialogService } from '../../settings/settings-dialog.service';
import { ToastService } from '../../../shared/toast/toast.service';
import { WorkflowService } from '../../../core/workflow.service';
import type { PortalToken } from '../../../core/portal.model';
import type { RunRecordSummary } from '@phorma/engine';

/**
 * The Portal panel (EPIC 9, right sidebar): publish state for the active
 * workflow's public endpoint.
 *
 * Shows the publish checklist, the live address, access keys, recent visitor
 * runs, and the unpublish action. Editing WHAT the portal looks like happens on
 * the canvas (the Portal trigger's Properties) - this panel is the deploy
 * lifecycle, deliberately kept separate so the canvas stays the source of truth.
 */
@Component({
  selector: 'app-portal-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, FormsModule, ButtonModule, InputTextModule],
  templateUrl: './portal-panel.html',
  styleUrl: './portal-panel.scss',
})
export class PortalPanel {
  protected readonly portal = inject(PortalService);
  private readonly workflow = inject(WorkflowService);
  private readonly panels = inject(PanelRegistryService);
  private readonly selection = inject(SelectionService);
  private readonly settingsDialog = inject(SettingsDialogService);
  private readonly confirmDialog = inject(ConfirmDialogService);
  private readonly toast = inject(ToastService);

  /** Draft label for a new access key. */
  protected readonly tokenLabel = signal('');

  protected readonly workflowName = computed(
    () => this.workflow.activeDoc()?.name ?? 'this workflow',
  );

  /** Human-readable reason the publish button is unavailable. */
  protected readonly blockerMessage = computed(() => {
    switch (this.portal.blocker()) {
      case 'no-provider':
        return 'Choose where to deploy in Settings → Cloud first.';
      case 'no-worker-url':
        return 'Add your worker URL in Settings → Cloud first.';
      case 'read-only':
        return 'This is a historical preview. Restore it before publishing.';
      case 'unsaved':
        return 'Save this workflow before publishing it.';
      case 'invalid':
        return 'Fix the problems below, then publish.';
      default:
        return null;
    }
  });

  protected readonly errors = computed(() => this.portal.validation()?.errors ?? []);
  protected readonly warnings = computed(() => this.portal.validation()?.warnings ?? []);

  constructor() {
    // Load whenever the active workflow changes, so switching tabs shows the
    // right portal. `untracked` keeps the signal writes inside refresh() from
    // re-triggering this effect.
    effect(() => {
      const workflowId = this.workflow.activeDoc()?.workflowId;
      untracked(() => {
        this.portal.record.set(null);
        this.portal.remoteValidation.set(null);
        if (workflowId) void this.portal.refresh();
      });
    });
  }

  // ── Actions ────────────────────────────────────────────────────────────────

  protected refresh(): void {
    void this.portal.refresh();
  }

  protected publish(): void {
    void this.portal.publish();
  }

  protected openCloudSettings(): void {
    this.settingsDialog.open('cloud');
  }

  /** Selects the Portal trigger so its Properties open for editing. */
  protected editPortalNode(): void {
    const node = this.workflow.graph().nodes.find(candidate => candidate.kind === 'portal-trigger');
    if (!node) return;
    this.selection.selectNode(node.id);
    this.panels.setActive('right', 'properties');
  }

  /** Focuses the node an issue refers to, so a warning is actionable. */
  protected focusIssueNode(nodeId: string | undefined): void {
    if (!nodeId) return;
    this.selection.selectNode(nodeId);
    this.panels.setActive('right', 'properties');
  }

  protected openPortal(): void {
    const url = this.portal.url();
    if (url) window.open(url, '_blank', 'noopener');
  }

  protected async copyUrl(): Promise<void> {
    const url = this.portal.url();
    if (url) await this.copy(url, 'Address copied');
  }

  protected async copyMintedSecret(): Promise<void> {
    const secret = this.portal.mintedSecret();
    if (secret) await this.copy(secret, 'Access key copied');
  }

  /**
   * The one-line script tag an owner pastes into their site. Derived from the
   * portal's own address so a custom domain is picked up automatically.
   */
  protected readonly embedSnippet = computed(() => {
    const record = this.portal.record();
    const url = this.portal.url();
    if (!record || !url) return '';
    const origin = new URL(url).origin;
    const label = record.embedLabel?.trim();
    const attrs = [
      `src="${origin}/portal-embed.js"`,
      `data-slug="${record.slug}"`,
      label ? `data-label="${label}"` : '',
      'defer',
    ].filter(Boolean);
    return `<script ${attrs.join(' ')}></script>`;
  });

  protected async copyEmbedSnippet(): Promise<void> {
    const snippet = this.embedSnippet();
    if (snippet) await this.copy(snippet, 'Embed snippet copied');
  }

  protected dismissSecret(): void {
    this.portal.dismissMintedSecret();
  }

  protected async mintToken(): Promise<void> {
    await this.portal.mintToken(this.tokenLabel().trim() || 'Access key');
    this.tokenLabel.set('');
  }

  protected revokeToken(token: PortalToken, event: Event): void {
    event.stopPropagation();
    void this.confirmDialog
      .confirm({
        title: 'Revoke this access key?',
        message: `Anything using "${token.label}" will stop working immediately. This cannot be undone.`,
        confirmLabel: 'Revoke',
      })
      .then(confirmed => {
        if (confirmed) void this.portal.revokeToken(token.id);
      });
  }

  protected unpublish(): void {
    void this.confirmDialog
      .confirm({
        title: 'Take this portal offline?',
        message:
          'The address stops working straight away and becomes available for another workflow. Access keys are removed too.',
        confirmLabel: 'Take offline',
      })
      .then(confirmed => {
        if (confirmed) void this.portal.unpublish();
      });
  }

  // ── Display helpers ────────────────────────────────────────────────────────

  protected runStatusIcon(summary: RunRecordSummary): string {
    switch (summary.status) {
      case 'completed':
        return 'ti ti-circle-check';
      case 'failed':
        return 'ti ti-circle-x';
      case 'stopped':
        return 'ti ti-player-stop';
      default:
        return 'ti ti-loader-2';
    }
  }

  /**
   * A portal run's input is the JSON envelope, which reads terribly in a list.
   * Show the visitor's actual message instead.
   */
  protected runPreview(summary: RunRecordSummary): string {
    try {
      const envelope = JSON.parse(summary.input) as { message?: string };
      const message = envelope.message?.trim();
      if (message) return message;
    } catch {
      // Not an envelope (older run) - fall through.
    }
    return summary.input.trim() || '(no message)';
  }

  private async copy(text: string, title: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      this.toast.success(title, text);
    } catch {
      this.toast.error('Could not copy', 'Select the text and copy it manually.');
    }
  }
}
