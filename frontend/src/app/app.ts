import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { CdkDropListGroup } from '@angular/cdk/drag-drop';

import { Toolbar } from './layout/toolbar/toolbar';
import { Sidebar } from './layout/sidebar/sidebar';
import { SidePanelPane } from './layout/sidebar/side-panel-pane.directive';
import { DocumentTabs } from './layout/document-tabs/document-tabs';
import { GraphCanvas } from './workspace/canvas/graph-canvas';
import { TauriService } from './core/tauri.service';
import { TestHarnessService } from './core/test-harness.service';
import { WorkflowService } from './core/workflow.service';
import { PanelRegistryService } from './core/panel-registry.service';
import { UpdateService } from './core/update.service';
import { BottomTerminal } from './layout/terminal/bottom-terminal';
import { TerminalOutputService } from './core/terminal-output.service';
import { AgentsPalette } from './workspace/palette/agents-palette/agents-palette';
import { WorkflowsPanel } from './workspace/workflows/workflows-panel/workflows-panel';
import { PromptPanel } from './workspace/prompt/prompt-panel/prompt-panel';
import { PropertiesPanel } from './workspace/properties/properties-panel/properties-panel';
import { RunsPanel } from './workspace/runs/runs-panel/runs-panel';
import { UsagePanel } from './workspace/usage/usage-panel/usage-panel';
import { EvalsPanel } from './workspace/evals/evals-panel/evals-panel';
import { SettingsDialog } from './workspace/settings/settings-dialog/settings-dialog';
import { CloudDialog } from './workspace/cloud/cloud-dialog/cloud-dialog';
import { CreditsDialog } from './workspace/cloud/credits-dialog/credits-dialog';
import { OnboardingDialog } from './workspace/onboarding/onboarding-dialog/onboarding-dialog';
import { OnboardingService } from './workspace/onboarding/onboarding.service';
import { CommandPalette } from './workspace/command-palette/command-palette';
import { AiReviewBar } from './workspace/command-palette/ai-review-bar';
import { AssistantPanel } from './workspace/assistant/assistant-panel/assistant-panel';
import { AssistantDialog } from './workspace/assistant/assistant-dialog/assistant-dialog';
import { SkillsPanel } from './workspace/skills/skills-panel/skills-panel';
import { SkillEditorDialog } from './workspace/skills/skill-editor-dialog/skill-editor-dialog';
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
    UsagePanel,
    EvalsPanel,
    SettingsDialog,
    CloudDialog,
    CreditsDialog,
    OnboardingDialog,
    CommandPalette,
    AiReviewBar,
    AssistantPanel,
    AssistantDialog,
    SkillsPanel,
    SkillEditorDialog,
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
  protected readonly updates = inject(UpdateService);
  private readonly onboarding = inject(OnboardingService);
  private readonly testHarness = inject(TestHarnessService);

  protected readonly title = signal('Phorma Agent Studio');

  /** True when running inside the Tauri desktop runtime. */
  protected readonly isDesktop = this.tauri.isDesktop;

  constructor() {
    // Kick off the auto-update check loop (no-op in web mode).
    this.updates.start();
    // Open the first-run wizard on a fresh desktop install.
    this.onboarding.maybeAutoOpen();
    // Dev-only programmatic E2E harness (window.__phormaTest). No-op in prod.
    this.testHarness.install();
  }

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

  /** Expose Math for the statusbar progress percentage template. */
  protected readonly Math = Math;

  /**
   * Status-bar update badge click handler — same one-click path as the
   * toolbar Update button: download (if needed), silent install, restart.
   */
  async onUpdateBadgeClick(): Promise<void> {
    await this.updates.updateNow();
  }
}
