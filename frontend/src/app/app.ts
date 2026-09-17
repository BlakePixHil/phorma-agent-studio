import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
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
import { TelemetryService } from './core/telemetry.service';
import { LibraryExportService } from './core/library-export.service';
import { WorkflowBackupService } from './core/cloud/workflow-backup.service';
import { NotificationCenterService } from './core/notification-center.service';
import { DeployedNotificationsService } from './core/deployed-notifications.service';
import { CloudService } from './core/cloud.service';
import { RunControllerService } from './core/run-controller.service';
import { PhormaCloudService } from './core/phorma-cloud.service';
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
import { PromptDialog } from './workspace/prompt/prompt-dialog/prompt-dialog';
import { PropertiesDialog } from './workspace/properties/properties-dialog/properties-dialog';
import { EvalsDialog } from './workspace/evals/evals-dialog/evals-dialog';
import { UsageDialog } from './workspace/usage/usage-dialog/usage-dialog';
import { SkillsPanel } from './workspace/skills/skills-panel/skills-panel';
import { ConnectionsPanel } from './workspace/connections/connections-panel/connections-panel';
import { ConnectionEditorDialog } from './workspace/connections/connection-editor-dialog/connection-editor-dialog';
import { ConnectorInstallDialog } from './workspace/connections/connector-install-dialog/connector-install-dialog';
import { ConnectorPackageDialog } from './workspace/connections/connector-package-dialog/connector-package-dialog';
import { SkillEditorDialog } from './workspace/skills/skill-editor-dialog/skill-editor-dialog';
import { PortalPanel } from './workspace/portal/portal-panel/portal-panel';
import { VersionHistoryDialog } from './workspace/workflows/version-history-dialog/version-history-dialog';
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
    PromptDialog,
    PropertiesDialog,
    EvalsDialog,
    UsageDialog,
    SkillsPanel,
    SkillEditorDialog,
    ConnectionsPanel,
    ConnectionEditorDialog,
    ConnectorInstallDialog,
    ConnectorPackageDialog,
    PortalPanel,
    VersionHistoryDialog,
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
  private readonly telemetry = inject(TelemetryService);
  // Injected here purely to CONSTRUCT it at startup: its rewrite-on-save effect
  // watches the workflow library, and a service nobody injects has no effect at
  // all. Without this, "keep the export up to date" would only arm itself after
  // the user happened to open Settings > Cloud once per session.
  private readonly libraryExport = inject(LibraryExportService);
  // Injected for the same reason: its upload effect watches the workflow library,
  // and a service nobody injects has no effect at all. Backup that only armed once
  // the user opened Settings would be missing on the day it mattered.
  private readonly workflowBackup = inject(WorkflowBackupService);
  // The notification centre's three collaborators, wired together HERE because the
  // shell is the only place that may hold all of them: `NotificationCenterService`
  // must not inject `CloudService` (that closes the known NG0200 cycle), and
  // `DeployedNotificationsService` must not decide when it is allowed to run.
  private readonly notificationCentre = inject(NotificationCenterService);
  private readonly deployedNotifications = inject(DeployedNotificationsService);
  private readonly cloud = inject(CloudService);
  private readonly runController = inject(RunControllerService);
  private readonly phormaCloud = inject(PhormaCloudService);

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
    // Anonymous usage telemetry. Returns synchronously and defers its own work
    // onto an idle callback, so it never sits on the first-paint path (4.9), and
    // it swallows every failure so startup continues without it (5.7).
    this.telemetry.bootstrap();
    this.wireNotifications();
  }

  /**
   * Connects the notification centre to the things it deliberately cannot reach.
   *
   * Two jobs. First, install the deep-link handler: navigating to a run needs
   * `CloudService` to attach the monitor, and `NotificationCenterService` must not
   * inject it - the same settable-seam arrangement as
   * `RunControllerService.remoteApprovalSender`. Second, own the poll's lifecycle,
   * because "may this account read the feed" is an entitlement question the poll
   * should answer to rather than ask.
   */
  private wireNotifications(): void {
    this.notificationCentre.deepLinkHandler = target => {
      if (target.workflowId) this.workflow.openWorkflow(target.workflowId);
      // Reveal the Runs panel, auto-showing the tab when the user has hidden it -
      // `setActive` handles that, so a hidden Runs tab cannot swallow the link.
      this.panels.setActive(this.runsPanelSide(), 'runs');
      // A deployed run's events come over the monitor socket, and the Durable
      // Object replays the in-flight run - so this is also what makes the canvas
      // animate for a run the studio did not start.
      if (target.deployed && target.workflowId) {
        void this.cloud.connect(target.workflowId);
      }
      // Consumed by the Runs panel once its history has loaded, which for a cloud
      // run is one request later.
      if (target.runId) this.runController.focusRunId.set(target.runId);
    };

    // Start and stop with entitlement. `start()` is idempotent and resets the
    // backoff, so re-running it on a subscription change is also the recovery path
    // for a user who just subscribed and should not wait out a failed poll's timer.
    effect(() => {
      if (this.phormaCloud.subscribed()) this.deployedNotifications.start();
      else this.deployedNotifications.stop();
    });
  }

  /** Whichever side the user keeps the Runs panel on. */
  private runsPanelSide(): 'left' | 'right' {
    return this.panels.tabs().find(tab => tab.id === 'runs')?.side ?? 'left';
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
