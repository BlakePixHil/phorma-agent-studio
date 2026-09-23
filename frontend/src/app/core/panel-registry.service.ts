import { effect, inject, Injectable, signal, computed } from '@angular/core';
import type { CapabilityLevel } from './capabilities';
import { CapabilityService } from './capability.service';
import { loadLayout, saveLayout } from './layout-storage';
import { counterName } from './telemetry-catalog';
import { TelemetryService } from './telemetry.service';

export interface PanelTab {
  id: string;
  label: string;
  icon: string;
  /** Which side this tab currently lives on */
  side: 'left' | 'right';
  /** Display order within its side */
  order: number;
  /** Whether the tab is shown in its sidebar. Hidden tabs can be reopened via the Window menu. */
  visible: boolean;
  /**
   * The minimum Capability_Level this tab requires, if it requires one.
   *
   * DATA, not a decision (Requirement 7.5): the comparison happens once, in the
   * `leftTabs` / `rightTabs` computeds, through `CapabilityService.allows`. An
   * absent value means the tab needs no particular level, and that default lives
   * inside the capability module rather than here - see `allows`.
   *
   * Not persisted in any meaningful sense: `loadTabs` takes `side`, `order` and
   * `visible` off the saved layout and everything else off `DEFAULT_TABS`, so a
   * minimum changed in a later release is adopted rather than restored stale.
   */
  minLevel?: CapabilityLevel;
}

/** Default width for each side panel (px) when no saved width exists. */
export const DEFAULT_PANEL_WIDTH = 320;

/**
 * Bump when the default tab layout changes in a way existing installs should
 * adopt. Persisted under `phorma.layout.layoutVersion`; a missing/older value
 * triggers a one-time migration that applies the new default visibility while
 * preserving the user's side/order customizations.
 */
export const LAYOUT_VERSION = 2;

/**
 * Default tab layout — used for fresh installs and when resetting panels.
 * First-run keeps the workspace focused: Agents/Workflows/Runs on the left,
 * Prompt/Properties on the right. Everything else opens via the Window menu.
 *
 * `minLevel` is declared where a tab is a BUILDER surface: Skills, Connections,
 * Evals and Portal each configure how workflows are built and shipped rather than
 * showing what a run did. Everything else is absent, which reads as "no particular
 * level" inside `CapabilityService.allows`.
 */
const DEFAULT_TABS: PanelTab[] = [
  { id: 'agents',     label: 'Agents',     icon: 'ti ti-robot',      side: 'left',  order: 0, visible: true },
  { id: 'workflows',  label: 'Workflows',  icon: 'ti ti-topology-star-3', side: 'left', order: 1, visible: true },
  { id: 'runs',       label: 'Runs',       icon: 'ti ti-history',    side: 'left',  order: 2, visible: true },
  { id: 'skills',     label: 'Skills',     icon: 'ti ti-books',      side: 'left',  order: 3, visible: false, minLevel: 'builder' },
  { id: 'connections', label: 'Connections', icon: 'ti ti-plug-connected', side: 'left', order: 4, visible: false, minLevel: 'builder' },
  { id: 'prompt',     label: 'Prompt',     icon: 'ti ti-message-2',  side: 'right', order: 0, visible: true },
  { id: 'properties', label: 'Properties', icon: 'ti ti-adjustments', side: 'right', order: 1, visible: true },
  { id: 'usage',      label: 'Usage',      icon: 'ti ti-chart-bar',  side: 'right', order: 2, visible: false },
  { id: 'evals',      label: 'Evals',      icon: 'ti ti-flask',      side: 'right', order: 3, visible: false, minLevel: 'builder' },
  { id: 'assistant',  label: 'Assistant',  icon: 'ti ti-sparkles',   side: 'right', order: 4, visible: false },
  { id: 'portal',     label: 'Portal',     icon: 'ti ti-world-share', side: 'right', order: 5, visible: false, minLevel: 'builder' },
];

/**
 * Tracks which panel tabs exist, their current side assignment, and which tab
 * is active on each side. Supports moving tabs between left/right sides
 * (the VS Code–style configurable panel model).
 */
@Injectable({ providedIn: 'root' })
export class PanelRegistryService {
  // Safe DI direction: `TelemetryService` is a leaf that injects only
  // `TauriService`, so this edge cannot pull a service back into the layout
  // shell that reads this registry at startup.
  private readonly telemetry = inject(TelemetryService);
  // Same justification, and `scripts/check-capability-isolation.mjs` keeps it
  // true: `CapabilityService` injects NOTHING at all, so it cannot pull a member
  // of the NG0200 run/model/cloud cycle into this registry's injector.
  private readonly capability = inject(CapabilityService);

  private readonly _tabs = signal<PanelTab[]>(this.loadTabs());

  private readonly _activeLeft  = signal<string>(loadLayout('activeLeft', 'agents'));
  private readonly _activeRight = signal<string>(loadLayout('activeRight', 'prompt'));
  // Default panel width. Roomier than the original 270 so panels are readable
  // out-of-the-box; a saved value always wins via loadLayout.
  private readonly _leftWidth = signal(loadLayout('leftWidth', DEFAULT_PANEL_WIDTH));
  private readonly _rightWidth = signal(loadLayout('rightWidth', DEFAULT_PANEL_WIDTH));

  /** Whether each side is collapsed */
  readonly collapsedLeft  = signal(loadLayout('collapsedLeft', false));
  readonly collapsedRight = signal(loadLayout('collapsedRight', false));

  /**
   * All registered tabs, capability filter and visibility included.
   *
   * Read by callers that only need "which side hosts X": the registry is the
   * record of the user's arrangement, and that record is unchanged by the level.
   * A surface that OFFERS a tab to the user wants {@link allowedTabs} instead.
   */
  readonly tabs = this._tabs.asReadonly();

  /**
   * Every tab this session's Capability_Level permits, visible or hidden.
   *
   * The list a menu offers. `leftTabs` / `rightTabs` subtract hidden tabs too, so
   * they cannot answer "what could this user reopen" - and a Window-menu entry
   * that shows a tab the sidebar then filters out is a control that does nothing.
   */
  readonly allowedTabs = computed(() =>
    this._tabs().filter(t => this.capability.allows(t.minLevel))
  );

  /** Current measured panel widths, used by floating chrome such as the console. */
  readonly leftWidth = this._leftWidth.asReadonly();
  readonly rightWidth = this._rightWidth.asReadonly();

  /**
   * Visible tabs belonging to the left side, sorted by order.
   *
   * The capability filter is SUBTRACTIVE and lives HERE rather than in `_tabs`
   * (Requirement 7.3). That distinction is load-bearing: `loadTabs()` merges the
   * saved side, order and visibility onto `DEFAULT_TABS` and a constructor
   * `effect` persists `_tabs`, so dropping an entry from `_tabs` would delete it
   * from the user's saved layout - and a member later promoted to builder would
   * find their arrangement gone. Filtering in the computed makes a promotion a
   * single signal write that puts every tab back where the user left it.
   *
   * `allows(t.minLevel)` and never `atLeastLevel(t.minLevel ?? 'operator')`: the
   * absent-means-no-minimum default belongs inside the capability module, or this
   * line carries a level literal Requirement 7.4 forbids.
   */
  readonly leftTabs = computed(() =>
    this._tabs()
      .filter(t => t.side === 'left' && t.visible && this.capability.allows(t.minLevel))
      .sort((a, b) => a.order - b.order)
  );

  /** Visible tabs belonging to the right side, sorted by order */
  readonly rightTabs = computed(() =>
    this._tabs()
      .filter(t => t.side === 'right' && t.visible && this.capability.allows(t.minLevel))
      .sort((a, b) => a.order - b.order)
  );

  /**
   * Active tab id on the left side.
   *
   * Derived rather than raw, for the same reason the tab lists are: the stored
   * choice is the USER's and survives a level change untouched, while what the
   * sidebar renders has to be a tab that side is actually showing. Without the
   * fallback, an account demoted below `builder` whose last active right-hand tab
   * was Portal would open onto a tab strip that does not contain it and a pane
   * that renders nothing.
   */
  readonly activeLeft = computed(() => this.resolveActive(this._activeLeft(), this.leftTabs()));

  /** Active tab id on the right side */
  readonly activeRight = computed(() => this.resolveActive(this._activeRight(), this.rightTabs()));

  constructor() {
    // Persist collapse + width state so the layout survives app restarts.
    effect(() => saveLayout('collapsedLeft', this.collapsedLeft()));
    effect(() => saveLayout('collapsedRight', this.collapsedRight()));
    effect(() => saveLayout('leftWidth', this._leftWidth()));
    effect(() => saveLayout('rightWidth', this._rightWidth()));

    // Persist tab side/order assignments + the active tab per side, so a
    // user's panel arrangement (their "workspace") is restored on reopen.
    effect(() => saveLayout('panelTabs', this._tabs()));
    effect(() => saveLayout('activeLeft', this._activeLeft()));
    effect(() => saveLayout('activeRight', this._activeRight()));
  }

  /**
   * The id a side should render: the stored choice when that side is showing it,
   * otherwise the first tab it is showing. Falls back to the stored choice when a
   * side is showing nothing at all, because the sidebar collapses to zero width in
   * that case and no pane is rendered either way.
   */
  private resolveActive(stored: string, shown: readonly PanelTab[]): string {
    if (shown.length === 0) return stored;
    return shown.some(t => t.id === stored) ? stored : shown[0].id;
  }

  setActive(side: 'left' | 'right', tabId: string): void {
    // Auto-show a hidden tab when a feature targets it (e.g. a run starting
    // reveals Runs) so activation never points at an invisible tab.
    const tab = this._tabs().find(t => t.id === tabId);
    if (tab && !tab.visible) this.showTab(tabId);
    const previous = side === 'left' ? this._activeLeft() : this._activeRight();
    if (side === 'left') this._activeLeft.set(tabId);
    else this._activeRight.set(tabId);
    // This is the one seam where a tab BECOMES active on a side, so it is where
    // an open is counted. Re-activating the tab that is already active on this
    // side changes nothing, so it is a render, not an open, and is skipped.
    // An unknown id is discarded by `count` (3.1, 3.2).
    if (previous !== tabId) this.telemetry.count(counterName('panel.opened', tabId));
  }

  /** Show a hidden tab in its sidebar. */
  showTab(tabId: string): void {
    this._tabs.update(tabs =>
      tabs.map(t => (t.id === tabId ? { ...t, visible: true } : t))
    );
  }

  /** Whether the tab can be hidden — the last visible tab on a side must stay. */
  canHide(tabId: string): boolean {
    const tab = this._tabs().find(t => t.id === tabId);
    if (!tab || !tab.visible) return false;
    return this._tabs().some(t => t.id !== tabId && t.side === tab.side && t.visible);
  }

  /**
   * Hide a tab from its sidebar (reopen via the Window menu). If it was the
   * active tab on its side, activates the first remaining visible tab.
   */
  hideTab(tabId: string): void {
    if (!this.canHide(tabId)) return;
    const tab = this._tabs().find(t => t.id === tabId)!;
    this._tabs.update(tabs =>
      tabs.map(t => (t.id === tabId ? { ...t, visible: false } : t))
    );
    const active = tab.side === 'left' ? this._activeLeft() : this._activeRight();
    if (active === tabId) {
      const remaining = this._tabs().find(t => t.side === tab.side && t.visible);
      if (remaining) this.setActive(tab.side, remaining.id);
    }
  }

  setPanelWidth(side: 'left' | 'right', width: number): void {
    if (side === 'left') this._leftWidth.set(width);
    else this._rightWidth.set(width);
  }

  /**
   * Move a tab to the opposite side (or explicitly to a named side).
   * Reorders remaining tabs to fill the gap.
   */
  moveTab(tabId: string, toSide: 'left' | 'right', atIndex?: number): void {
    this._tabs.update(tabs => {
      const tab = tabs.find(t => t.id === tabId);
      if (!tab || tab.side === toSide) return tabs;

      // Target-side tabs (without the moved tab) — insert at atIndex or end.
      const targetTabs = tabs
        .filter(t => t.side === toSide && t.id !== tabId)
        .sort((a, b) => a.order - b.order);
      const insertAt = atIndex == null ? targetTabs.length
        : Math.max(0, Math.min(atIndex, targetTabs.length));
      targetTabs.splice(insertAt, 0, { ...tab, side: toSide });

      // Re-number target side.
      const renumberedTarget = targetTabs.map((t, i) => ({ ...t, order: i }));

      // Re-number source side.
      const sourceTabs = tabs
        .filter(t => t.side !== toSide && t.id !== tabId)
        .sort((a, b) => a.order - b.order)
        .map((t, i) => ({ ...t, order: i }));

      const updated = tabs.map(t => {
        if (t.id === tabId) {
          const nt = renumberedTarget.find(x => x.id === tabId);
          return nt ?? t;
        }
        const src = sourceTabs.find(s => s.id === t.id)
          ?? renumberedTarget.find(s => s.id === t.id);
        return src ?? t;
      });

      return updated;
    });

    // Switch active tab on target side to the newly moved tab
    this.setActive(toSide, tabId);

    // If the tab was active on the source side, switch source to first available
    const fromSide: 'left' | 'right' = toSide === 'left' ? 'right' : 'left';
    const currentActive = fromSide === 'left' ? this._activeLeft() : this._activeRight();
    if (currentActive === tabId) {
      const remaining = this._tabs().filter(t => t.side === fromSide);
      if (remaining.length > 0) {
        this.setActive(fromSide, remaining[0].id);
      }
    }
  }

  /** Reorder tabs within the same side via drag-and-drop */
  reorderTab(tabId: string, newIndex: number): void {
    this._tabs.update(tabs => {
      const tab = tabs.find(t => t.id === tabId);
      if (!tab) return tabs;
      const sideTabs = tabs
        .filter(t => t.side === tab.side)
        .sort((a, b) => a.order - b.order);

      const oldIdx = sideTabs.findIndex(t => t.id === tabId);
      if (oldIdx === newIndex) return tabs;

      sideTabs.splice(oldIdx, 1);
      sideTabs.splice(newIndex, 0, tab);

      const reordered = sideTabs.map((t, i) => ({ ...t, order: i }));
      return tabs.map(t => reordered.find(r => r.id === t.id) ?? t);
    });
  }

  // ── Panel-level commands (used by the View menu) ──────────────────────

  collapseLeft():  void { this.collapsedLeft.set(true); }
  collapseRight(): void { this.collapsedRight.set(true); }
  expandLeft():    void { this.collapsedLeft.set(false); }
  expandRight():   void { this.collapsedRight.set(false); }

  collapseAll(): void {
    this.collapsedLeft.set(true);
    this.collapsedRight.set(true);
  }

  expandAll(): void {
    this.collapsedLeft.set(false);
    this.collapsedRight.set(false);
  }

  /** Restore tabs to the default sides/visibility and expand both panels. */
  resetPanels(): void {
    this._tabs.set(DEFAULT_TABS.map(t => ({ ...t })));
    this._activeLeft.set('agents');
    this._activeRight.set('prompt');
    this._leftWidth.set(DEFAULT_PANEL_WIDTH);
    this._rightWidth.set(DEFAULT_PANEL_WIDTH);
    this.collapsedLeft.set(false);
    this.collapsedRight.set(false);
  }

  /**
   * Loads persisted tab side/order/visibility assignments, merged onto the
   * defaults so tabs added in future versions still appear. Each known tab
   * adopts its saved `side` + `order` + `visible`; unknown saved ids are
   * ignored.
   *
   * Migration: installs from before tab visibility existed have a persisted
   * layout but no `layoutVersion` — adopt the new default visibility for any
   * tab that predates the change (preserving the user's side/order), then
   * stamp the version so this runs once.
   */
  private loadTabs(): PanelTab[] {
    const saved = loadLayout<PanelTab[] | null>('panelTabs', null);
    if (!saved || !Array.isArray(saved)) {
      saveLayout('layoutVersion', LAYOUT_VERSION);
      return DEFAULT_TABS.map(t => ({ ...t }));
    }
    const version = loadLayout('layoutVersion', 1);
    const migrateVisibility = version < LAYOUT_VERSION;
    const tabs = DEFAULT_TABS.map(def => {
      const match = saved.find(s => s.id === def.id);
      if (!match) return { ...def };
      return {
        ...def,
        side: match.side,
        order: match.order,
        // Pre-visibility installs saved no `visible` flag — apply the new
        // default (hiding Skills/Usage/Evals/Assistant/Portal) rather than
        // leaving all ten tabs open.
        visible: migrateVisibility || match.visible == null ? def.visible : match.visible,
      };
    });
    if (migrateVisibility) saveLayout('layoutVersion', LAYOUT_VERSION);
    return tabs;
  }
}
