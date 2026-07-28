import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';

import { ExpandedPanelDialog } from '../../../shared/expanded-panel-dialog/expanded-panel-dialog';
import { PanelExpandService } from '../../../core/panel-expand.service';
import { PropertiesForm } from '../properties-form/properties-form';
import { SelectionService } from '../../../core/selection.service';
import { ToastService } from '../../../shared/toast/toast.service';
import { WorkflowService } from '../../../core/workflow.service';
import { findCatalogEntryByKind } from '../../../core/node-catalog';
import {
  NODE_CATEGORY_COLORS,
  findNodeForConnector,
  portBaseId,
  type WorkflowNode,
} from '../../../core/workflow.model';

/** A wired neighbour of the selected node, shown in the header card. */
interface Neighbour {
  node: WorkflowNode;
  /** Connection kind, for the icon (`tool-link`, `handoff`, …). */
  kind: string;
}

/**
 * The expanded Properties panel.
 *
 * Renders the SAME {@link PropertiesForm} as the sidebar, but flowed into
 * multiple columns so nothing is cramped, and adds the context the narrow
 * panel has no room for: a node header card with ids and wiring, and a raw
 * `node.data` inspector.
 */
@Component({
  selector: 'app-properties-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ExpandedPanelDialog, PropertiesForm],
  templateUrl: './properties-dialog.html',
  styleUrl: './properties-dialog.scss',
})
export class PropertiesDialog {
  private readonly expand = inject(PanelExpandService);
  private readonly selection = inject(SelectionService);
  private readonly workflow = inject(WorkflowService);
  private readonly toast = inject(ToastService);

  protected readonly visible = computed(() => this.expand.isOpen('properties'));

  protected readonly node = computed(() => this.selection.selectedNode());

  protected readonly selectedNodes = computed(() => this.selection.selectedNodes());

  protected readonly multiSelection = computed(() => this.selectedNodes().length > 1);

  protected readonly kindLabel = computed(() => {
    const node = this.node();
    return node ? (findCatalogEntryByKind(node.kind)?.label ?? node.kind) : '';
  });

  /** Category accent colour, matching the node's colour on the canvas. */
  protected readonly categoryColor = computed(() => {
    const node = this.node();
    if (!node) return 'transparent';
    const category = findCatalogEntryByKind(node.kind)?.category;
    return category ? NODE_CATEGORY_COLORS[category] : 'transparent';
  });

  protected readonly subtitle = computed(() => {
    if (this.multiSelection()) return `${this.selectedNodes().length} nodes selected`;
    const node = this.node();
    return node ? `${node.name} · ${this.kindLabel()}` : 'Workflow settings';
  });

  // ── Wiring summary ──────────────────────────────────────────────────────

  /** Nodes feeding into the selected node. */
  protected readonly inbound = computed<Neighbour[]>(() => {
    const node = this.node();
    if (!node) return [];
    const graph = this.workflow.graph();
    const ownPorts = new Set(node.ports.map(port => port.id));
    return graph.connections
      .filter(conn => ownPorts.has(portBaseId(conn.inputId)))
      .flatMap(conn => {
        const source = findNodeForConnector(graph, conn.outputId);
        return source && source.node.id !== node.id
          ? [{ node: source.node, kind: conn.kind ?? 'flow' }]
          : [];
      });
  });

  /** Nodes the selected node feeds into. */
  protected readonly outbound = computed<Neighbour[]>(() => {
    const node = this.node();
    if (!node) return [];
    const graph = this.workflow.graph();
    const ownPorts = new Set(node.ports.map(port => port.id));
    return graph.connections
      .filter(conn => ownPorts.has(portBaseId(conn.outputId)))
      .flatMap(conn => {
        const target = findNodeForConnector(graph, conn.inputId);
        return target && target.node.id !== node.id
          ? [{ node: target.node, kind: conn.kind ?? 'flow' }]
          : [];
      });
  });

  protected neighbourIcon(kind: string): string {
    if (kind === 'tool-link') return 'ti ti-tool';
    if (kind === 'handoff') return 'ti ti-arrow-right';
    return 'ti ti-arrow-narrow-right';
  }

  // ── Raw data inspector ──────────────────────────────────────────────────

  protected readonly showJson = signal(false);

  protected toggleJson(): void {
    this.showJson.update(value => !value);
  }

  /** Pretty-printed `node.data`, for inspection and copying. */
  protected readonly dataJson = computed(() => {
    const node = this.node();
    if (!node) return '{}';
    try {
      return JSON.stringify(node.data ?? {}, null, 2);
    } catch {
      // Cyclic or otherwise unserialisable data must not blank the dialog.
      return '/* This node\'s data could not be serialized. */';
    }
  });

  protected async copyJson(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.dataJson());
      this.toast.success('Copied', 'Node data copied as JSON.');
    } catch {
      this.toast.error('Could not copy', 'Clipboard access was denied.');
    }
  }

  protected async copyId(): Promise<void> {
    const node = this.node();
    if (!node) return;
    try {
      await navigator.clipboard.writeText(node.id);
      this.toast.success('Copied', node.id);
    } catch {
      this.toast.error('Could not copy', 'Clipboard access was denied.');
    }
  }

  /** Reveals a node on the canvas by selecting it. */
  protected select(node: WorkflowNode): void {
    this.selection.selectNode(node.id);
  }
}
