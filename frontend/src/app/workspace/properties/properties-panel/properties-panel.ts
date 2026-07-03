import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { SelectModule } from 'primeng/select';

import { SelectionService } from '../../../core/selection.service';
import { WorkflowService } from '../../../core/workflow.service';
import { findCatalogEntryByKind, findMcpPreset, type McpEnvField } from '../../../core/node-catalog';
import { SettingsService } from '../../../core/settings.service';
import { ToastService } from '../../../shared/toast/toast.service';
import type {
  ApprovalGateData,
  HttpToolData,
  McpToolData,
  ScheduleTriggerData,
  WebhookTriggerData,
  WorkflowNode,
} from '../../../core/workflow.model';

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

/**
 * The Properties panel (right side): generic node configuration — name,
 * description — plus kind-specific fields for triggers, tools, and flow
 * nodes. Agents' prompts/models live in the Prompt panel.
 */
@Component({
  selector: 'app-properties-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, SelectModule],
  templateUrl: './properties-panel.html',
  styleUrl: './properties-panel.scss',
})
export class PropertiesPanel {
  private readonly selection = inject(SelectionService);
  private readonly workflow = inject(WorkflowService);
  private readonly settings = inject(SettingsService);
  private readonly toast = inject(ToastService);

  protected readonly httpMethods = [...HTTP_METHODS];
  protected readonly mcpTransports = [
    { id: 'stdio', label: 'Local process (stdio)' },
    { id: 'sse', label: 'Remote (SSE)' },
  ];

  protected readonly node = computed(() => this.selection.selectedNode());
  protected readonly multiSelection = computed(() => this.selection.selectedNodes().length > 1);

  /** Catalog description for the selected node's kind. */
  protected readonly kindLabel = computed(() => {
    const node = this.node();
    return node ? (findCatalogEntryByKind(node.kind)?.label ?? node.kind) : '';
  });

  // Narrowed data views for the kind-specific sections.
  protected readonly scheduleData = computed<ScheduleTriggerData | null>(() => {
    const node = this.node();
    return node?.kind === 'schedule-trigger' ? (node.data as ScheduleTriggerData) : null;
  });
  protected readonly webhookData = computed<WebhookTriggerData | null>(() => {
    const node = this.node();
    return node?.kind === 'webhook-trigger' ? (node.data as WebhookTriggerData) : null;
  });
  protected readonly httpData = computed<HttpToolData | null>(() => {
    const node = this.node();
    return node?.kind === 'http-tool' ? (node.data as HttpToolData) : null;
  });
  protected readonly mcpData = computed<McpToolData | null>(() => {
    const node = this.node();
    return node?.kind === 'mcp-tool' ? (node.data as McpToolData) : null;
  });
  protected readonly approvalData = computed<ApprovalGateData | null>(() => {
    const node = this.node();
    return node?.kind === 'approval-gate' ? (node.data as ApprovalGateData) : null;
  });

  /** The MCP preset that seeded the selected node, if any. */
  protected readonly mcpPreset = computed(() => {
    const data = this.mcpData();
    return data?.presetId ? findMcpPreset(data.presetId) ?? null : null;
  });

  /** Per-field secret input drafts, keyed by env var name. */
  protected readonly mcpSecretDrafts = signal<Record<string, string>>({});

  /** Refresh configured-secret badges whenever the selected node changes. */
  protected readonly secretFlagsRefresher = effect(() => {
    const node = this.node();
    const data = this.mcpData();
    if (!node || !data?.envKeys?.length) return;
    void this.settings.refreshMcpSecretFlags(node.id, data.envKeys);
  });

  /** Router/parallel/aggregator branch ports are editable lists. */
  protected readonly editableOutPorts = computed(() => {
    const node = this.node();
    if (!node) return null;
    if (node.kind !== 'router' && node.kind !== 'parallel' && node.kind !== 'aggregator') {
      return null;
    }
    const role = node.kind === 'aggregator' ? 'message-in' : 'message-out';
    return { role, ports: node.ports.filter(port => port.role === role) } as const;
  });

  protected onNameInput(event: Event): void {
    const node = this.node();
    if (!node) return;
    this.workflow.updateNode(node.id, {
      name: (event.target as HTMLInputElement | null)?.value ?? '',
    });
  }

  protected onDescriptionInput(event: Event): void {
    const node = this.node();
    if (!node) return;
    this.workflow.updateNode(node.id, {
      description: (event.target as HTMLTextAreaElement | null)?.value ?? '',
    });
  }

  protected patchData(patch: Record<string, unknown>): void {
    const node = this.node();
    if (!node) return;
    this.workflow.updateNodeData(node.id, patch);
  }

  protected inputValue(event: Event): string {
    return (event.target as HTMLInputElement | HTMLTextAreaElement | null)?.value ?? '';
  }

  protected renamePort(node: WorkflowNode, portId: string, event: Event): void {
    const name = this.inputValue(event);
    this.workflow.updateNodePorts(
      node.id,
      node.ports.map(port => (port.id === portId ? { ...port, name } : port)),
    );
  }

  protected addBranchPort(node: WorkflowNode, role: 'message-in' | 'message-out'): void {
    const count = node.ports.filter(port => port.role === role).length;
    const label = node.kind === 'aggregator' ? 'Input' : node.kind === 'router' ? 'Route' : 'Branch';
    const letter = String.fromCharCode(65 + count); // A, B, C…
    this.workflow.updateNodePorts(node.id, [
      ...node.ports,
      { id: `${node.id}-p${Date.now().toString(36)}`, name: `${label} ${letter}`, role },
    ]);
  }

  protected removePort(node: WorkflowNode, portId: string): void {
    this.workflow.updateNodePorts(
      node.id,
      node.ports.filter(port => port.id !== portId),
    );
  }

  // ── MCP args editor ────────────────────────────────────────────────────────

  protected onArgInput(index: number, event: Event): void {
    const data = this.mcpData();
    if (!data) return;
    const args = [...(data.args ?? [])];
    args[index] = this.inputValue(event);
    this.patchData({ args });
  }

  protected addArg(): void {
    const data = this.mcpData();
    if (!data) return;
    this.patchData({ args: [...(data.args ?? []), ''] });
  }

  protected removeArg(index: number): void {
    const data = this.mcpData();
    if (!data) return;
    const args = [...(data.args ?? [])];
    args.splice(index, 1);
    this.patchData({ args });
  }

  // ── MCP secret env vars ────────────────────────────────────────────────────

  protected secretConfigured(envKey: string): boolean {
    const node = this.node();
    return node ? !!this.settings.mcpSecretsConfigured()[`${node.id}:${envKey}`] : false;
  }

  protected onSecretInput(envKey: string, event: Event): void {
    const value = (event.target as HTMLInputElement | null)?.value ?? '';
    this.mcpSecretDrafts.update(drafts => ({ ...drafts, [envKey]: value }));
  }

  protected async saveSecret(envKey: string): Promise<void> {
    const node = this.node();
    if (!node) return;
    const draft = this.mcpSecretDrafts()[envKey];
    if (draft === undefined) return;
    try {
      await this.settings.setMcpSecret(node.id, envKey, draft);
      this.mcpSecretDrafts.update(drafts => {
        const next = { ...drafts };
        delete next[envKey];
        return next;
      });
      this.toast.success(draft.trim() ? 'Secret saved' : 'Secret removed', envKey);
    } catch (error) {
      this.toast.error('Could not save secret', error instanceof Error ? error.message : String(error));
    }
  }

  protected async clearSecret(envKey: string): Promise<void> {
    const node = this.node();
    if (!node) return;
    try {
      await this.settings.clearMcpSecret(node.id, envKey);
      this.toast.success('Secret removed', envKey);
    } catch (error) {
      this.toast.error('Could not remove secret', error instanceof Error ? error.message : String(error));
    }
  }
}
