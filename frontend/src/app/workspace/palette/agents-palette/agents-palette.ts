import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';

import {
  MCP_PRESETS,
  NODE_CATALOG,
  NODE_CATEGORY_SECTIONS,
  PHORMA_NODE_MIME,
  mcpPresetEntryId,
  type NodeCatalogEntry,
  type McpPreset,
} from '../../../core/node-catalog';
import { NodeDragService } from '../../../core/node-drag.service';
import { NODE_CATEGORY_COLORS } from '../../../core/workflow.model';

/**
 * The Agents palette (left panel): every node type in the catalog, grouped by
 * section (Agents / Triggers / Tools / Flow), searchable, and draggable onto
 * the canvas.
 */
@Component({
  selector: 'app-agents-palette',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './agents-palette.html',
  styleUrl: './agents-palette.scss',
})
export class AgentsPalette {
  private readonly nodeDrag = inject(NodeDragService);

  protected readonly query = signal('');

  /** MCP presets, filtered by the search query. */
  protected readonly mcpPresets = computed(() => {
    const q = this.query().trim().toLowerCase();
    if (q.length === 0) return MCP_PRESETS;
    return MCP_PRESETS.filter(
      preset =>
        preset.label.toLowerCase().includes(q) ||
        preset.description.toLowerCase().includes(q) ||
        preset.keywords?.some(keyword => keyword.includes(q)),
    );
  });

  /** Whether any palette entries (catalog sections or presets) match the query. */
  protected readonly hasResults = computed(() => {
    const sections = this.sections();
    return sections.some(section => section.entries.length > 0) || this.mcpPresets().length > 0;
  });

  /** Sections with their (filtered) entries; empty sections are dropped. */
  protected readonly sections = computed(() => {
    const q = this.query().trim().toLowerCase();
    return NODE_CATEGORY_SECTIONS.map(section => ({
      ...section,
      color: NODE_CATEGORY_COLORS[section.category],
      entries: NODE_CATALOG.filter(entry => entry.category === section.category).filter(
        entry =>
          q.length === 0 ||
          entry.label.toLowerCase().includes(q) ||
          entry.description.toLowerCase().includes(q) ||
          entry.keywords?.some(keyword => keyword.includes(q)),
      ),
    })).filter(section => section.entries.length > 0);
  });

  protected onSearchInput(event: Event): void {
    this.query.set((event.target as HTMLInputElement | null)?.value ?? '');
  }

  protected onDragStart(event: DragEvent, entry: NodeCatalogEntry): void {
    event.dataTransfer?.setData(PHORMA_NODE_MIME, entry.id);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'copy';
    this.nodeDrag.start(entry.id);
  }

  protected onDragEnd(): void {
    this.nodeDrag.stop();
  }

  /** Click-to-add: places the node at the canvas viewport centre. */
  protected onItemClick(entry: NodeCatalogEntry): void {
    this.nodeDrag.requestAdd(entry.id);
  }

  // ── MCP presets ────────────────────────────────────────────────────────────

  protected onPresetDragStart(event: DragEvent, preset: McpPreset): void {
    const entryId = mcpPresetEntryId(preset.id);
    event.dataTransfer?.setData(PHORMA_NODE_MIME, entryId);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'copy';
    this.nodeDrag.start(entryId);
  }

  protected onPresetClick(preset: McpPreset): void {
    this.nodeDrag.requestAdd(mcpPresetEntryId(preset.id));
  }
}
