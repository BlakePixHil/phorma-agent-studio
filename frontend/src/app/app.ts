import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { CdkDropListGroup } from '@angular/cdk/drag-drop';

import { Toolbar } from './layout/toolbar/toolbar';
import { Sidebar } from './layout/sidebar/sidebar';
import { SidePanelPane } from './layout/sidebar/side-panel-pane.directive';
import { DocumentTabs } from './layout/document-tabs/document-tabs';
import { GraphCanvas } from './workspace/canvas/graph-canvas';
import { TauriService } from './core/tauri.service';
import { WorkflowService } from './core/workflow.service';
import { PanelRegistryService } from './core/panel-registry.service';
import { BottomTerminal } from './layout/terminal/bottom-terminal';
import { TerminalOutputService } from './core/terminal-output.service';
import { AgentsPalette } from './workspace/palette/agents-palette/agents-palette';
import { WorkflowsPanel } from './workspace/workflows/workflows-panel/workflows-panel';
import { PromptPanel } from './workspace/prompt/prompt-panel/prompt-panel';
import { PropertiesPanel } from './workspace/properties/properties-panel/properties-panel';
import { RunsPanel } from './workspace/runs/runs-panel/runs-panel';
import { SettingsDialog } from './workspace/settings/settings-dialog/settings-dialog';
import { CloudDialog } from './workspace/cloud/cloud-dialog/cloud-dialog';
import { ConfirmDialog } from './shared/confirm-dialog/confirm-dialog';
import { Toast } from './shared/toast/toast';

/**
 * Root application shell.
 *
 * Lays out the desktop chrome: a top toolbar, the Agents/Workflows and
 * Prompt/Properties/Runs side rails, and the central infinite canvas.
 */
@Component({
  selector: 'app-root',
  imports: [
    CdkDropListGroup,
    Toolbar,
    Sidebar,
    SidePanelPane,
    DocumentTabs,
    GraphCanvas,
    BottomTerminal,
    AgentsPalette,
    WorkflowsPanel,
    PromptPanel,
    PropertiesPanel,
    RunsPanel,
    SettingsDialog,
    CloudDialog,
    ConfirmDialog,
    Toast,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App {
  private readonly tauri = inject(TauriService);
  protected readonly workflow = inject(WorkflowService);
  protected readonly terminal = inject(TerminalOutputService);
  private readonly panels = inject(PanelRegistryService);

  protected readonly title = signal('Phorma Agent Studio');

  /** True when running inside the Tauri desktop runtime. */
  protected readonly isDesktop = this.tauri.isDesktop;

  /** Toolbar height (px) — the tab bar sits directly below it. */
  protected readonly toolbarHeight = 44;

  /** Document tab bar height (px) — sits directly below the toolbar. */
  protected readonly tabBarHeight = 36;

  /** Status bar height (px) — the footer pinned to the bottom of the window. */
  protected readonly footerHeight = 24;

  /**
   * Left/right offsets (px) for the document tab bar so it never overlaps the
   * sidebars. Collapsed panels contribute no width. Mirrors the canvas
   * minimap offset pattern.
   */
  protected readonly tabBarLeft = computed(() =>
    this.panels.collapsedLeft() || this.panels.leftTabs().length === 0
      ? 0
      : this.panels.leftWidth(),
  );
  protected readonly tabBarRight = computed(() =>
    this.panels.collapsedRight() || this.panels.rightTabs().length === 0
      ? 0
      : this.panels.rightWidth(),
  );
}
