import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { MenubarModule } from 'primeng/menubar';
import { ButtonModule } from 'primeng/button';
import { TooltipModule } from 'primeng/tooltip';
import type { MenuItem } from 'primeng/api';
import { ThemeService } from '../../core/theme.service';
import { CanvasStateService } from '../../core/canvas-state.service';
import { PanelRegistryService } from '../../core/panel-registry.service';
import { WorkflowService } from '../../core/workflow.service';
import { TauriService } from '../../core/tauri.service';
import { TerminalOutputService } from '../../core/terminal-output.service';
import { HistoryService } from '../../core/history.service';
import { ClipboardService } from '../../core/clipboard.service';
import { SelectionService } from '../../core/selection.service';
import { RunControllerService } from '../../core/run-controller.service';
import { CloudService } from '../../core/cloud.service';
import { CloudDialogService } from '../../workspace/cloud/cloud-dialog.service';
import { SettingsDialogService } from '../../workspace/settings/settings-dialog.service';
import { ToastService } from '../../shared/toast/toast.service';

/**
 * Sleek top application toolbar.
 *
 * Hosts the primary application menus (File, Edit, Selection, Arrange, View)
 * on the left, the run controls in the centre (wired to the engine in
 * Phase 3), and window/theme controls on the right.
 */
@Component({
  selector: 'app-toolbar',
  imports: [MenubarModule, ButtonModule, TooltipModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './toolbar.html',
  styleUrl: './toolbar.scss',
  host: {
    '(document:keydown)': 'onKeyDown($event)',
  },
})
export class Toolbar {
  protected readonly theme = inject(ThemeService);
  protected readonly workflow = inject(WorkflowService);
  protected readonly canvasState = inject(CanvasStateService);
  protected readonly terminal = inject(TerminalOutputService);
  protected readonly runController = inject(RunControllerService);
  protected readonly cloud = inject(CloudService);
  private readonly cloudDialog = inject(CloudDialogService);
  private readonly settingsDialog = inject(SettingsDialogService);
  private readonly tauri = inject(TauriService);
  private readonly panels = inject(PanelRegistryService);
  private readonly history = inject(HistoryService);
  private readonly clipboard = inject(ClipboardService);
  private readonly selection = inject(SelectionService);
  private readonly toast = inject(ToastService);

  /** Whether a run is in flight (run controls swap to Stop). */
  protected readonly running = this.runController.running;
  protected readonly paused = this.runController.paused;
  protected readonly canReset = this.runController.canReset;

  // ── Right-cluster icon computeds (signals keep OnPush templates in sync) ─
  protected readonly themeIcon = computed(() =>
    this.theme.mode() === 'dark' ? 'ti ti-sun' : 'ti ti-moon',
  );
  protected readonly gridSnapTooltip = computed(() =>
    this.canvasState.gridSnap() ? 'Disable grid snapping' : 'Enable grid snapping',
  );

  // ── Keyboard shortcut bindings ──────────────────────────────────────────

  protected onKeyDown(e: KeyboardEvent): void {
    const ctrl  = e.ctrlKey || e.metaKey;
    const shift = e.shiftKey;
    const key   = e.key.toLowerCase();

    // ── Run controls (F5 / Shift+F5 / F6 / F10) — debugger-style. ─────────
    if (key === 'f5' && !ctrl) {
      e.preventDefault();
      if (shift) this.runController.stop();
      else if (this.paused()) this.runController.pauseOrResume();
      else if (!this.running()) this.runController.start();
      return;
    }
    if (key === 'f6' && !ctrl && !shift) {
      e.preventDefault();
      this.runController.pauseOrResume();
      return;
    }
    if (key === 'f10' && !ctrl && !shift) {
      e.preventDefault();
      this.runController.step();
      return;
    }

    // ── Save (Ctrl/Cmd+S) ───────────────────────────────────────────────────
    // Handled before the text-editing guard so it works while focused in the
    // prompt editor. Always prevent the browser's native "Save page".
    if (ctrl && !shift && key === 's') {
      e.preventDefault();
      void this.saveWorkflow();
      return;
    }
    // New workflow (Ctrl+N).
    if (ctrl && !shift && key === 'n') {
      e.preventDefault();
      this.workflow.newWorkflow();
      return;
    }

    // ── Edit menu hotkeys ──────────────────────────────────────────────────
    // Skip when the user is typing in an input/textarea/contenteditable so
    // browser-native undo/redo and text copy/paste keep working there.
    // Also skip when the user has an active text selection inside a
    // `.selectable` region — native Ctrl+C should copy the highlighted text,
    // not canvas nodes.
    if (this.isTextEditingTarget(e.target) || this.hasSelectableTextSelection()) {
      // Text editing owns these keys; fall through to the app-level ones below.
    } else if (ctrl && !shift && key === 'z') {
      e.preventDefault();
      this.history.undo();
      return;
    } else if (ctrl && (key === 'y' || (shift && key === 'z'))) {
      e.preventDefault();
      this.history.redo();
      return;
    } else if (ctrl && !shift && key === 'x') {
      e.preventDefault();
      this.clipboard.cut();
      return;
    } else if (ctrl && !shift && key === 'c') {
      e.preventDefault();
      this.clipboard.copy();
      return;
    } else if (ctrl && !shift && key === 'v') {
      e.preventDefault();
      this.clipboard.paste();
      return;
    } else if (ctrl && !shift && key === 'a') {
      e.preventDefault();
      this.selection.selectAll();
      return;
    } else if (!ctrl && !e.metaKey && !e.altKey && key === 'escape') {
      this.selection.deselect();
      return;
    }

    if (ctrl && !shift && key === '=') { e.preventDefault(); this.canvasState.zoomCommand.set('in'); }
    if (ctrl && !shift && key === '-') { e.preventDefault(); this.canvasState.zoomCommand.set('out'); }
    if (ctrl && !shift && key === '0') { e.preventDefault(); this.canvasState.zoomCommand.set('reset'); }
    if (ctrl &&  shift && key === 'f') { e.preventDefault(); this.canvasState.zoomCommand.set('fit'); }

    // Arrange > Auto-arrange nodes — Ctrl+Shift+L.
    if (ctrl && shift && key === 'l') {
      e.preventDefault();
      this.selection.arrangeNodes();
      return;
    }

    if (ctrl && !shift && key === 'b') {
      e.preventDefault();
      this.panels.collapsedLeft() ? this.panels.expandLeft() : this.panels.collapseLeft();
    }
    if (ctrl && shift && key === 'b') {
      e.preventDefault();
      this.panels.collapsedRight() ? this.panels.expandRight() : this.panels.collapseRight();
    }
    if (ctrl && key === '`') {
      e.preventDefault();
      this.terminal.toggle();
    }
    // App > Settings — Ctrl+, (VS Code-style).
    if (ctrl && !shift && key === ',') {
      e.preventDefault();
      this.settingsDialog.open();
    }
    if (ctrl && !shift && key === 'g') {
      e.preventDefault();
      this.canvasState.gridVisible.update(v => !v);
    }
    // Grid snapping toggle — Alt+G (Ctrl+G is already grid visibility).
    if (e.altKey && !ctrl && !e.metaKey && key === 'g') {
      e.preventDefault();
      this.canvasState.gridSnap.update(v => !v);
    }
  }

  protected readonly menuItems = computed<MenuItem[]>(() => [
    {
      label: 'File',
      items: [
        {
          label: 'New Workflow',
          icon: 'ti ti-plus',
          shortcut: 'Ctrl+N',
          command: () => this.workflow.newWorkflow(),
        },
        {
          label: 'Open Workflow',
          icon: 'ti ti-folder-open',
          items: this.savedWorkflowItems(),
        },
        { separator: true },
        {
          label: 'Save',
          icon: 'ti ti-device-floppy',
          shortcut: 'Ctrl+S',
          command: () => void this.saveWorkflow(),
        },
        { separator: true },
        {
          label: 'Import…',
          icon: 'ti ti-file-import',
          command: () => void this.importWorkflow(),
        },
        {
          label: 'Export…',
          icon: 'ti ti-file-export',
          command: () => void this.exportWorkflow(),
        },
      ],
    },
    {
      label: 'Edit',
      items: [
        {
          label: 'Undo',
          icon: 'ti ti-arrow-back-up',
          shortcut: 'Ctrl+Z',
          disabled: !this.history.canUndo(),
          command: () => this.history.undo(),
        },
        {
          label: 'Redo',
          icon: 'ti ti-arrow-forward-up',
          shortcut: 'Ctrl+Y',
          disabled: !this.history.canRedo(),
          command: () => this.history.redo(),
        },
        { separator: true },
        {
          label: 'Cut',
          icon: 'ti ti-cut',
          shortcut: 'Ctrl+X',
          command: () => this.clipboard.cut(),
        },
        {
          label: 'Copy',
          icon: 'ti ti-copy',
          shortcut: 'Ctrl+C',
          command: () => this.clipboard.copy(),
        },
        {
          label: 'Paste',
          icon: 'ti ti-clipboard',
          shortcut: 'Ctrl+V',
          disabled: !this.clipboard.hasContent(),
          command: () => this.clipboard.paste(),
        },
      ],
    },
    {
      label: 'Selection',
      items: [
        {
          label: 'Select All',
          icon: 'ti ti-select-all',
          shortcut: 'Ctrl+A',
          command: () => this.selection.selectAll(),
        },
        {
          label: 'Deselect',
          icon: 'ti ti-deselect',
          shortcut: 'Esc',
          command: () => this.selection.deselect(),
        },
      ],
    },
    {
      label: 'Arrange',
      items: [
        {
          label: 'Auto-arrange Nodes',
          icon: 'ti ti-layout-distribute-horizontal',
          shortcut: 'Ctrl+Shift+L',
          command: () => this.selection.arrangeNodes(),
        },
        { separator: true },
        {
          label: 'Fit to Screen',
          icon: 'ti ti-maximize',
          shortcut: 'Ctrl+Shift+F',
          command: () => this.canvasState.zoomCommand.set('fit'),
        },
      ],
    },
    {
      label: 'View',
      items: [
        {
          label: 'Zoom In',
          icon: 'ti ti-zoom-in',
          shortcut: 'Ctrl+=',
          command: () => this.canvasState.zoomCommand.set('in'),
        },
        {
          label: 'Zoom Out',
          icon: 'ti ti-zoom-out',
          shortcut: 'Ctrl+-',
          command: () => this.canvasState.zoomCommand.set('out'),
        },
        {
          label: 'Reset Zoom',
          icon: 'ti ti-zoom-reset',
          shortcut: 'Ctrl+0',
          command: () => this.canvasState.zoomCommand.set('reset'),
        },
        {
          label: 'Fit to Screen',
          icon: 'ti ti-maximize',
          shortcut: 'Ctrl+Shift+F',
          command: () => this.canvasState.zoomCommand.set('fit'),
        },
        { separator: true },
        {
          label: 'Toggle Grid',
          icon: 'ti ti-grid-4x4',
          shortcut: 'Ctrl+G',
          command: () => this.canvasState.gridVisible.update(v => !v),
        },
        {
          label: this.canvasState.gridSnap() ? 'Disable Grid Snapping' : 'Enable Grid Snapping',
          icon: 'ti ti-magnet',
          shortcut: 'Alt+G',
          command: () => this.toggleGridSnap(),
        },
        {
          label: 'Toggle Theme',
          icon: 'ti ti-brightness-half',
          command: () => this.theme.toggle(),
        },
        { separator: true },
        {
          label: this.canvasState.minimapVisible() ? 'Hide Minimap' : 'Show Minimap',
          icon: 'ti ti-map',
          command: () => this.canvasState.minimapVisible.update(v => !v),
        },
        { separator: true },
        {
          label: 'Panels',
          icon: 'ti ti-layout-sidebar',
          items: [
            {
              label: 'Toggle Left',
              icon: 'ti ti-layout-sidebar-left-collapse',
              shortcut: 'Ctrl+B',
              command: () =>
                this.panels.collapsedLeft()
                  ? this.panels.expandLeft()
                  : this.panels.collapseLeft(),
            },
            {
              label: 'Toggle Right',
              icon: 'ti ti-layout-sidebar-right-collapse',
              shortcut: 'Ctrl+Shift+B',
              command: () =>
                this.panels.collapsedRight()
                  ? this.panels.expandRight()
                  : this.panels.collapseRight(),
            },
            { separator: true },
            {
              label: 'Collapse Both Panels',
              icon: 'ti ti-arrows-minimize',
              command: () => this.panels.collapseAll(),
            },
            {
              label: 'Expand Both Panels',
              icon: 'ti ti-arrows-maximize',
              command: () => this.panels.expandAll(),
            },
            { separator: true },
            {
              label: 'Reset Panel Layout',
              icon: 'ti ti-refresh',
              command: () => this.panels.resetPanels(),
            },
          ],
        },
        { separator: true },
        {
          label: this.terminal.collapsed() ? 'Show Console' : 'Hide Console',
          icon: 'ti ti-terminal-2',
          shortcut: 'Ctrl+`',
          command: () => this.terminal.toggle(),
        },
      ],
    },
    {
      label: 'App',
      items: [
        {
          label: 'Settings',
          icon: 'ti ti-settings',
          shortcut: 'Ctrl+,',
          command: () => this.settingsDialog.open(),
        },
      ],
    },
  ]);

  /** Run controls — delegate to the run controller. */
  protected toggleRun(): void {
    if (this.running()) this.runController.stop();
    else this.runController.start();
  }

  protected pauseRun(): void {
    this.runController.pauseOrResume();
  }

  protected stepRun(): void {
    this.runController.step();
  }

  protected resetRun(): void {
    this.runController.reset();
  }

  /** Opens the cloud deploy/monitor dialog. */
  protected openCloud(): void {
    this.cloudDialog.open();
  }

  /** Toggles grid snapping on/off (toolbar icon button + View menu). */
  protected toggleGridSnap(): void {
    this.canvasState.gridSnap.update(v => !v);
  }

  private async saveWorkflow(): Promise<void> {
    const saved = await this.workflow.saveActive();
    if (saved) this.toast.success(`Workflow “${saved.name}” saved`);
  }

  private async exportWorkflow(): Promise<void> {
    const spec = this.workflow.exportActiveSpec();
    if (!spec) return;
    try {
      const path = await this.tauri.saveWorkflowFileDialog(spec);
      if (path) this.toast.success('Workflow exported', path);
    } catch (error) {
      this.toast.error('Export failed', error instanceof Error ? error.message : String(error));
    }
  }

  private async importWorkflow(): Promise<void> {
    try {
      const result = await this.tauri.openWorkflowFileDialog();
      if (!result) return;
      this.workflow.importSpec(result.spec);
      this.toast.success('Workflow imported', result.spec.name);
    } catch (error) {
      this.toast.error('Import failed', error instanceof Error ? error.message : String(error));
    }
  }

  private isTextEditingTarget(target: EventTarget | null): boolean {
    const element = target as HTMLElement | null;
    if (!element) return false;
    return !!element.closest('input, textarea, select, [contenteditable="true"]');
  }

  /**
   * True when the user has an active text selection inside a `.selectable`
   * region (e.g. the prompt preview). In that case Ctrl+C should perform the
   * browser's native copy of the highlighted text rather than copying canvas
   * nodes — the user explicitly selected text to copy it.
   */
  private hasSelectableTextSelection(): boolean {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
      return false;
    }
    const anchor = selection.anchorNode;
    if (!anchor) return false;
    const element = anchor.nodeType === Node.ELEMENT_NODE
      ? (anchor as Element)
      : anchor.parentElement;
    return !!element?.closest('.selectable');
  }

  private savedWorkflowItems(): MenuItem[] {
    const specs = this.workflow.library();
    if (specs.length === 0) {
      return [{ label: 'No Saved Workflows', disabled: true }];
    }
    return specs.map(spec => ({
      label: spec.name,
      icon: 'ti ti-topology-star-3',
      command: () => this.workflow.openWorkflow(spec.id),
    }));
  }
}
