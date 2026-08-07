import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';

import {
  MCP_LOCAL_ICON,
  MCP_OAUTH_ICON,
  MCP_PRESETS,
  MCP_TRANSPORT_LABEL,
  NODE_CATALOG,
  NODE_CATEGORY_SECTIONS,
  PHORMA_NODE_MIME,
  mcpPresetEntryId,
  mcpTransportKind,
  type McpTransportKind,
  type NodeCatalogEntry,
  type McpPreset,
} from '../../../core/node-catalog';
import { NodeDragService } from '../../../core/node-drag.service';
import { PhormaCloudIcon } from '../../../shared/icons/phorma-cloud-icon';
import { NODE_CATEGORY_COLORS, type NodeCategory } from '../../../core/workflow.model';

/** A selectable filter chip mapped to a node category. */
interface CategoryChip {
  category: NodeCategory;
  label: string;
  color: string;
}

/**
 * One rendered palette group. A category contributes its own group plus one per
 * distinct `NodeCatalogEntry.section` it declares (e.g. `flow` → Flow, Data),
 * so sub-sections keep their category accent colour.
 */
interface PaletteSection {
  /** Unique render key (`category:label`). */
  key: string;
  category: NodeCategory;
  label: string;
  color: string;
  /** True for the group that owns the MCP Servers sub-list. */
  showMcpPresets: boolean;
  entries: NodeCatalogEntry[];
}

/** MCP presets sharing a transport, rendered as a labelled sub-group. */
interface McpPresetGroup {
  kind: McpTransportKind;
  label: string;
  /** Tooltip explaining the deployment consequence of this transport. */
  title: string;
  presets: McpPreset[];
}

/**
 * The Agents palette (left panel): every node type in the catalog, grouped by
 * section (Agents / Triggers / Flow / Data / Tools), searchable, and draggable
 * onto the canvas.
 */
@Component({
  selector: 'app-agents-palette',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [PhormaCloudIcon],
  templateUrl: './agents-palette.html',
  styleUrl: './agents-palette.scss',
})
export class AgentsPalette {
  private readonly nodeDrag = inject(NodeDragService);

  protected readonly query = signal('');

  /** Currently selected category filters (inclusive OR). */
  protected readonly activeCategories = signal<Set<NodeCategory>>(new Set());

  /** Chips rendered above the grid; one per catalog section. */
  protected readonly chips: CategoryChip[] = NODE_CATEGORY_SECTIONS.map(section => ({
    category: section.category,
    label: section.label,
    color: NODE_CATEGORY_COLORS[section.category],
  }));

  /** Whether any category filter is currently active. */
  protected readonly hasActiveFilters = computed(() => this.activeCategories().size > 0);

  protected toggleCategory(category: NodeCategory): void {
    const next = new Set(this.activeCategories());
    if (next.has(category)) {
      next.delete(category);
    } else {
      next.add(category);
    }
    this.activeCategories.set(next);
  }

  protected clearFilters(): void {
    this.activeCategories.set(new Set());
  }

  /** MCP presets, filtered by the search query and active category filters. */
  protected readonly mcpPresets = computed(() => {
    const q = this.query().trim().toLowerCase();
    const active = this.activeCategories();
    // MCP presets are tools; hide them when a filter is active that excludes tools.
    if (active.size > 0 && !active.has('tool')) return [];
    return MCP_PRESETS.filter(preset => {
      if (q.length === 0) return true;
      return (
        preset.label.toLowerCase().includes(q) ||
        preset.description.toLowerCase().includes(q) ||
        preset.keywords?.some(keyword => keyword.includes(q))
      );
    });
  });

  /**
   * Matching presets split by where they run, remote first. Deployability is
   * the deciding factor when picking between two servers for the same product
   * (Jira local vs remote), so the split is the grouping, not a footnote.
   * Empty groups are dropped so a search never renders a bare heading.
   */
  protected readonly mcpGroups = computed<McpPresetGroup[]>(() => {
    const presets = this.mcpPresets();
    const order: McpTransportKind[] = ['remote', 'oauth', 'local'];
    const labels: Record<McpTransportKind, string> = {
      remote: 'Remote MCP',
      oauth: 'Sign-in (OAuth) MCP',
      local: 'Local MCP',
    };
    return order
      .map(kind => ({
        kind,
        label: labels[kind],
        title: MCP_TRANSPORT_LABEL[kind],
        presets: presets.filter(preset => mcpTransportKind(preset.transport, preset.authMode) === kind),
      }))
      .filter(group => group.presets.length > 0);
  });

  protected readonly localIcon = MCP_LOCAL_ICON;
  protected readonly oauthIcon = MCP_OAUTH_ICON;

  /** Whether any palette entries (catalog sections or presets) match the query. */
  protected readonly hasResults = computed(() => {
    const sections = this.sections();
    return sections.some(section => section.entries.length > 0) || this.mcpPresets().length > 0;
  });

  /**
   * Sections with their (filtered) entries; empty sections are dropped. Entries
   * declaring a `section` split into their own group, rendered after the
   * category's own group — which places `Data` between `Flow` and `Tools`.
   */
  protected readonly sections = computed<PaletteSection[]>(() => {
    const q = this.query().trim().toLowerCase();
    const active = this.activeCategories();
    const hasPresetMatches = this.mcpPresets().length > 0;
    const matches = (entry: NodeCatalogEntry): boolean =>
      q.length === 0 ||
      entry.label.toLowerCase().includes(q) ||
      entry.description.toLowerCase().includes(q) ||
      (entry.keywords?.some(keyword => keyword.includes(q)) ?? false);

    const result: PaletteSection[] = [];
    for (const { category, label } of NODE_CATEGORY_SECTIONS) {
      const color = NODE_CATEGORY_COLORS[category];
      // The category's own group first, then each declared sub-section in
      // catalog order.
      const groups = new Map<string, NodeCatalogEntry[]>([[label, []]]);
      for (const entry of NODE_CATALOG) {
        if (entry.category !== category) continue;
        if (active.size > 0 && !active.has(entry.category)) continue;
        if (!matches(entry)) continue;
        const groupLabel = entry.section ?? label;
        const group = groups.get(groupLabel);
        if (group) group.push(entry);
        else groups.set(groupLabel, [entry]);
      }
      for (const [groupLabel, entries] of groups) {
        const ownsPresets = category === 'tool' && groupLabel === label;
        // The MCP preset list lives inside the Tools group, so that group must
        // survive a search that matches only presets - dropping it for having
        // no catalog entries hid every preset and made searching "jira" (or any
        // server name) return nothing at all.
        if (entries.length === 0 && !(ownsPresets && hasPresetMatches)) continue;
        result.push({
          key: `${category}:${groupLabel}`,
          category,
          label: groupLabel,
          color,
          showMcpPresets: ownsPresets,
          entries,
        });
      }
    }
    return result;
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
