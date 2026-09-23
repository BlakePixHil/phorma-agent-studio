import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal, untracked } from '@angular/core';

import { DecisionTransportService } from '../../../core/decision-transport.service';
import { NODE_CATALOG } from '../../../core/node-catalog';
import { NodeDragService } from '../../../core/node-drag.service';
import { SelectionService } from '../../../core/selection.service';
import type { AssistEntry, AssistSuggestion } from '../../../core/studio-assist';
import { WorkflowService } from '../../../core/workflow.service';

/** Catalog entries as the assists see them (triggers never follow a step). */
const ENTRIES: AssistEntry[] = NODE_CATALOG.map(entry => ({
  id: entry.id,
  label: entry.label,
  description: entry.description,
}));
const FOLLOWER_ENTRIES: AssistEntry[] = NODE_CATALOG.filter(entry => entry.category !== 'trigger').map(
  entry => ({ id: entry.id, label: entry.label, description: entry.description }),
);

/** Horizontal gap for a node added after the selection. */
const NEXT_NODE_OFFSET_X = 300;

type AssistState = 'idle' | 'loading' | 'done' | 'failed';

/**
 * System One assists in the palette: find a building block by meaning when
 * the literal search finds nothing, and suggest what comes after the selected
 * node. Both are explicit clicks (each is one small, metered call) and both
 * degrade to a quiet message on failure. Deferred by the palette and only
 * rendered when a decision backend is configured.
 */
@Component({
  selector: 'app-palette-assist',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './palette-assist.html',
  styleUrl: './palette-assist.scss',
})
export class PaletteAssist {
  private readonly decisions = inject(DecisionTransportService);
  private readonly selection = inject(SelectionService);
  private readonly workflow = inject(WorkflowService);
  private readonly nodeDrag = inject(NodeDragService);

  /** The palette's current search text. */
  readonly query = input<string>('');
  /** True when the literal search matched nothing. */
  readonly noResults = input<boolean>(false);

  protected readonly searchState = signal<AssistState>('idle');
  protected readonly searchResults = signal<AssistSuggestion[]>([]);
  protected readonly nextState = signal<AssistState>('idle');
  protected readonly nextResults = signal<AssistSuggestion[]>([]);

  /** The single selected node that can hand off onward. */
  protected readonly anchor = computed(() => {
    const node = this.selection.selectedNode();
    if (!node || !node.ports.some(port => port.role === 'message-out')) return null;
    return node;
  });

  protected readonly showSearch = computed(() => this.noResults() && this.query().trim().length >= 3);

  constructor() {
    // A new query or selection invalidates the previous answer.
    effect(() => {
      this.query();
      untracked(() => {
        this.searchState.set('idle');
        this.searchResults.set([]);
      });
    });
    effect(() => {
      this.anchor();
      untracked(() => {
        this.nextState.set('idle');
        this.nextResults.set([]);
      });
    });
  }

  protected percent(value: number): string {
    return `${Math.round(value * 100)}%`;
  }

  protected async askSearch(): Promise<void> {
    const client = this.decisions.create();
    const query = this.query().trim();
    if (!client || !query) return;
    this.searchState.set('loading');
    try {
      const { suggestNodesForQuery } = await import('../../../core/studio-assist');
      const results = await suggestNodesForQuery(client, this.decisions.defaultModel(), query, ENTRIES);
      if (this.query().trim() !== query) return;
      this.searchResults.set(results);
      this.searchState.set('done');
    } catch {
      this.searchState.set('failed');
    }
  }

  protected async askNext(): Promise<void> {
    const client = this.decisions.create();
    const node = this.anchor();
    if (!client || !node) return;
    this.nextState.set('loading');
    try {
      const { suggestNextNodes } = await import('../../../core/studio-assist');
      const graph = this.workflow.graph();
      const results = await suggestNextNodes(
        client,
        this.decisions.defaultModel(),
        {
          workflowName: this.workflow.activeDoc()?.name ?? 'Untitled workflow',
          selected: `${node.name} (${node.kind})${node.description ? `: ${node.description}` : ''}`,
          existing: graph.nodes.map(item => `${item.name} (${item.kind})`),
        },
        FOLLOWER_ENTRIES,
      );
      if (this.anchor()?.id !== node.id) return;
      this.nextResults.set(results);
      this.nextState.set('done');
    } catch {
      this.nextState.set('failed');
    }
  }

  /** Adds a search suggestion like a palette click does. */
  protected addFromSearch(suggestion: AssistSuggestion): void {
    this.nodeDrag.requestAdd(suggestion.id);
  }

  /** Adds a suggested next node to the right of the selection and wires it in. */
  protected addNext(suggestion: AssistSuggestion): void {
    const anchor = this.anchor();
    if (!anchor) return;
    const added = this.workflow.addNodeFromCatalog(suggestion.id, {
      x: anchor.position.x + NEXT_NODE_OFFSET_X,
      y: anchor.position.y,
    });
    if (!added) return;
    const out = anchor.ports.find(port => port.role === 'message-out');
    const into = added.ports.find(port => port.role === 'message-in');
    if (out && into) this.workflow.addConnection(`${out.id}-out`, `${into.id}-in`);
    this.selection.selectNode(added.id);
  }
}
