import {
  ChangeDetectionStrategy,
  Component,
  ContentChildren,
  QueryList,
  input,
  inject,
  signal,
  computed,
  WritableSignal,
  AfterContentInit,
  OnInit,
  OnDestroy,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { CdkDragDrop, CdkDrag, CdkDropList, CdkDragPlaceholder } from '@angular/cdk/drag-drop';
import { TabsModule } from 'primeng/tabs';
import { ButtonModule } from 'primeng/button';
import { TooltipModule } from 'primeng/tooltip';
import { PanelRegistryService, PanelTab, DEFAULT_PANEL_WIDTH } from '../../core/panel-registry.service';
import { SidePanelPane } from './side-panel-pane.directive';

/**
 * Resizable, tabbed side panel.
 *
 * Each `side="left"|"right"` instance reads its tabs from `PanelRegistryService`.
 * Tabs can be dragged within the tab strip to reorder, and a "→ / ←" icon on
 * each tab header sends the tab to the opposite side.
 *
 * Width is resizable via a drag handle on the inner edge.
 */
@Component({
  selector: 'app-sidebar',
  imports: [CommonModule, TabsModule, ButtonModule, TooltipModule, CdkDrag, CdkDropList, CdkDragPlaceholder],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './sidebar.html',
  styleUrl: './sidebar.scss',
})
export class Sidebar implements OnInit, AfterContentInit, OnDestroy {
  /** Which edge of the workspace this sidebar is docked to. */
  readonly side = input<'left' | 'right'>('left');

  protected readonly registry = inject(PanelRegistryService);

  /** True only while the user is actively dragging the resize handle. */
  protected readonly resizing = signal(false);

  /**
   * Collapsed state is stored in the registry so the View menu can also
   * collapse/expand panels. We read from the registry and write back to it.
   */
  protected readonly collapsed = computed(() => {
    // A side with no visible tabs (e.g. the right panel in code mode, where
    // only the left-side Files tab is shown) collapses to zero width so it
    // doesn't leave an empty panel.
    const tabs = this.side() === 'left' ? this.registry.leftTabs() : this.registry.rightTabs();
    if (tabs.length === 0) return true;
    return this.side() === 'left'
      ? this.registry.collapsedLeft()
      : this.registry.collapsedRight();
  });

  /**
   * Width controlled by the resize handle (px). Hydrated from the registry's
   * persisted width (clamped into range) in `ngOnInit` — the earliest point
   * where the `side` input is bound — so the user's layout survives restarts.
   */
  protected readonly panelWidth = signal(DEFAULT_PANEL_WIDTH);

  /** Minimum & maximum widths in px. */
  protected readonly MIN_WIDTH = 220;
  protected readonly MAX_WIDTH = 640;

  /** Width before collapsing, restored on expand. */
  private widthBeforeCollapse = DEFAULT_PANEL_WIDTH;

  private resizeFrameId: number | null = null;
  private pendingPanelWidth: number | null = null;
  private stopResize?: () => void;

  /** Projected pane components keyed by tabId. */
  @ContentChildren(SidePanelPane) panes!: QueryList<SidePanelPane>;

  /** Map of tabId → projected pane (populated after content init). */
  protected paneMap = new Map<string, SidePanelPane>();

  ngOnInit(): void {
    // Hydrate the width from the persisted registry value (clamped into
    // range). Runs after inputs are bound, so `side()` is reliable, and
    // BEFORE ngAfterContentInit writes the width back to the registry.
    const saved = this.side() === 'left' ? this.registry.leftWidth() : this.registry.rightWidth();
    const clamped = Math.min(this.MAX_WIDTH, Math.max(this.MIN_WIDTH, saved || DEFAULT_PANEL_WIDTH));
    this.panelWidth.set(clamped);
    this.widthBeforeCollapse = clamped;
  }

  ngAfterContentInit(): void {
    this.registry.setPanelWidth(this.side(), this.panelWidth());
    this.paneMap.clear();
    this.panes.forEach(p => this.paneMap.set(p.tabId(), p));
    this.panes.changes.subscribe(() => {
      this.paneMap.clear();
      this.panes.forEach(p => this.paneMap.set(p.tabId(), p));
    });
  }

  ngOnDestroy(): void {
    this.stopResize?.();
    if (this.resizeFrameId !== null) {
      cancelAnimationFrame(this.resizeFrameId);
    }
  }

  /** Tabs for this side. */
  protected sideTabs = computed(() =>
    this.side() === 'left' ? this.registry.leftTabs() : this.registry.rightTabs()
  );

  /** Active tab id for this side. */
  protected activeTabId = computed(() =>
    this.side() === 'left' ? this.registry.activeLeft() : this.registry.activeRight()
  );

  protected setActive(tabId: string): void {
    this.registry.setActive(this.side(), tabId);
  }

  /**
   * CDK DragDrop handler for tab reordering. Supports both same-strip
   * reordering and cross-panel moves (dragging a tab from one sidebar
   * to the other) via the shared `cdkDropListGroup`.
   */
  protected onTabDrop(event: CdkDragDrop<PanelTab[]>): void {
    const tab: PanelTab = event.item.data;

    // Cross-container drop → move to the other side.
    if (event.previousContainer !== event.container) {
      const targetSide: 'left' | 'right' = this.side();
      this.registry.moveTab(tab.id, targetSide, event.currentIndex);
      return;
    }

    // Same-container reorder.
    if (event.previousIndex === event.currentIndex) return;
    this.registry.reorderTab(tab.id, event.currentIndex);
  }

  // ── Resize handle ────────────────────────────────────────────────────────

  protected onResizeStart(event: PointerEvent): void {
    if (event.target instanceof HTMLElement && event.target.closest('.phorma-collapse-btn')) {
      return;
    }

    event.preventDefault();
    const startX = event.clientX;
    const startW = this.panelWidth();
    const isLeft = this.side() === 'left';

    const colSignal: WritableSignal<boolean> =
      isLeft ? this.registry.collapsedLeft : this.registry.collapsedRight;

    this.stopResize?.();
    this.resizing.set(true);
    colSignal.set(false);

    const handle = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
    handle?.setPointerCapture(event.pointerId);

    const commitPendingWidth = () => {
      this.resizeFrameId = null;
      if (this.pendingPanelWidth === null) return;
      this.panelWidth.set(this.pendingPanelWidth);
      this.registry.setPanelWidth(this.side(), this.pendingPanelWidth);
      this.pendingPanelWidth = null;
    };

    const onMove = (e: PointerEvent) => {
      e.preventDefault();
      const x = e.clientX;
      const delta = isLeft ? x - startX : startX - x;
      this.pendingPanelWidth = Math.min(this.MAX_WIDTH, Math.max(this.MIN_WIDTH, startW + delta));
      if (this.resizeFrameId === null) {
        this.resizeFrameId = requestAnimationFrame(commitPendingWidth);
      }
    };

    const onUp = (e: PointerEvent) => {
      if (this.resizeFrameId !== null) {
        cancelAnimationFrame(this.resizeFrameId);
        commitPendingWidth();
      }
      handle?.releasePointerCapture(e.pointerId);
      this.stopResize?.();
      this.stopResize = undefined;
      this.resizing.set(false);
    };

    window.addEventListener('pointermove', onMove, { passive: false });
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);

    this.stopResize = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }

  protected toggleCollapse(): void {
    const colSignal: WritableSignal<boolean> =
      this.side() === 'left' ? this.registry.collapsedLeft : this.registry.collapsedRight;
    if (this.collapsed()) {
      this.panelWidth.set(this.widthBeforeCollapse);
      this.registry.setPanelWidth(this.side(), this.widthBeforeCollapse);
      colSignal.set(false);
    } else {
      this.widthBeforeCollapse = this.panelWidth();
      colSignal.set(true);
    }
  }
}
