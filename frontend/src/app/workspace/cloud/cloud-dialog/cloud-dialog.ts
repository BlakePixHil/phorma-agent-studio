import {
  ChangeDetectionStrategy,
  Component,
  HostListener,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { ButtonModule } from 'primeng/button';
import { TooltipModule } from 'primeng/tooltip';

import {
  deriveEgressAllowList,
  type ConnectionSummary,
  type EgressAllowList,
} from '@phorma/engine';

import { ConfirmDialogService } from '../../../shared/confirm-dialog/confirm-dialog.service';
import { ToastService } from '../../../shared/toast/toast.service';
import { CloudDialogService } from '../cloud-dialog.service';
import { CloudService } from '../../../core/cloud.service';
import { ConnectionStoreService } from '../../../core/connection-store.service';
import { PhormaCloudService, tierLabel } from '../../../core/phorma-cloud.service';
import { SettingsService } from '../../../core/settings.service';
import { SettingsDialogService } from '../../settings/settings-dialog.service';
import { TauriService } from '../../../core/tauri.service';
import { TerminalOutputService } from '../../../core/terminal-output.service';
import { WorkflowService } from '../../../core/workflow.service';
import { MODEL_PROVIDERS } from '../../../core/workflow.model';
import { AwsCliService } from '../../../core/deploy/aws-cli.service';
import {
  AWS_CONFIG_FILENAME,
  AwsDeployConfigService,
} from '../../../core/deploy/aws-deploy-config.service';
import type { DeployCommand } from '../../../core/deploy/deploy-targets';

/**
 * Cloud — push the active workflow and connect the live monitor.
 *
 * Branches on the chosen provider (Settings → Cloud):
 *  - **Phorma Cloud**: managed hosting. Push + monitor only; no
 *    infrastructure vocabulary, no deploy step.
 *  - **Your own Cloudflare**: the full technical flow — deploy the worker
 *    with wrangler, set URL/token, then push + monitor.
 *
 * Styled to match the confirmation dialog: a bespoke overlay (not p-dialog)
 * with the same card surface, icon-led header, and p-button actions.
 */
@Component({
  selector: 'app-cloud-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, DecimalPipe, ButtonModule, TooltipModule],
  templateUrl: './cloud-dialog.html',
  styleUrl: './cloud-dialog.scss',
})
export class CloudDialog {
  protected readonly dialog = inject(CloudDialogService);
  protected readonly cloud = inject(CloudService);
  protected readonly workflow = inject(WorkflowService);
  protected readonly settings = inject(SettingsService);
  protected readonly phormaCloud = inject(PhormaCloudService);
  protected readonly tierLabel = tierLabel;
  private readonly settingsDialog = inject(SettingsDialogService);
  private readonly confirmDialog = inject(ConfirmDialogService);
  protected readonly isDesktop = inject(TauriService).isDesktop;
  protected readonly awsConfig = inject(AwsDeployConfigService);
  protected readonly awsCli = inject(AwsCliService);
  private readonly terminal = inject(TerminalOutputService);
  private readonly toast = inject(ToastService);
  private readonly connectionStore = inject(ConnectionStoreService);

  /** The chosen deploy target ('cloudflare' fallback keeps legacy behavior). */
  protected readonly provider = computed(() => this.settings.cloudProvider() ?? 'cloudflare');

  /** Region_Pin display for the AWS target. */
  protected readonly awsRegionLabel = computed(() => this.awsConfig.region() || null);

  /**
   * Deployment status for the workflow this dialog is showing. Goes through
   * `deployedStatusFor` rather than reading `cloud.deployedStatus()` directly:
   * the signal is a single shared slot, and other surfaces (the library panel's
   * delete, which purges the cloud) check the status of OTHER workflows, which
   * would otherwise be rendered here as if it were this workflow's.
   */
  protected readonly deployedStatus = computed(() =>
    this.cloud.deployedStatusFor(this.workflow.activeDoc()?.workflowId),
  );

  // ── AWS body section ───────────────────────────────────────────────────────

  /**
   * Instance-scoped prefix for the read-only endpoint field ids.
   *
   * A spec can mount two fixtures in one browser, and a static `id` would then
   * duplicate and break every `<label for>` association. One counter keeps the
   * prefix unique per component instance, exactly as the Settings dialog does.
   */
  private static awsInstanceCount = 0;
  private readonly awsScope = `cloud-aws-${(CloudDialog.awsInstanceCount += 1)}`;

  /** Scoped element id for one AWS field, e.g. `cloud-aws-1-triggerApiUrl`. */
  protected awsFieldId(field: string): string {
    return `${this.awsScope}-${field}`;
  }

  /**
   * Which AWS command is in flight, so the spinner lands on the control the
   * operator pressed. `AwsCliService.running()` is one shared boolean and
   * cannot tell Plan and deploy apart from Doctor.
   */
  private readonly awsActiveCommand = signal<'deploy' | 'doctor' | null>(null);

  protected readonly awsDeployRunning = computed(
    () => this.awsCli.running() && this.awsActiveCommand() === 'deploy',
  );

  protected readonly awsDoctorRunning = computed(
    () => this.awsCli.running() && this.awsActiveCommand() === 'doctor',
  );

  /**
   * Plan and deploy and Doctor are disabled while a command is in flight, in
   * browser preview (Requirement 1.8) and while the configuration is incomplete
   * (Requirement 2.5). The configuration itself is edited in Settings, so this
   * surface only reads the aggregate.
   */
  protected readonly awsControlsDisabled = computed(
    () => this.awsCli.running() || !this.isDesktop || !this.awsConfig.valid(),
  );

  /** The aggregate line shown while the configuration is incomplete. */
  protected readonly awsInvalidFieldsLabel = computed(() => {
    const count = this.awsConfig.invalidFieldCount();
    return count === 1 ? '1 field needs attention' : `${count} fields need attention`;
  });

  /** True while either discovered endpoint is absent (Requirement 9.6). */
  protected readonly awsEndpointsIncomplete = computed(
    () => !this.awsConfig.triggerApiUrl() || !this.awsConfig.monitorApiUrl(),
  );

  constructor() {
    // Refresh the account chip and the deployment status whenever the dialog
    // opens - both providers deploy one instance per workflow, so the status
    // check applies regardless of which one is active.
    effect(() => {
      if (!this.dialog.visible()) return;
      const workflowId = this.workflow.activeDoc()?.workflowId;
      untracked(() => {
        if (this.provider() === 'phorma') void this.phormaCloud.refresh();
        this.cloud.deployedStatus.set(null);
        this.cloud.deployedStatusWorkflowId.set(null);
        if (workflowId) void this.cloud.refreshStatus(workflowId);
      });
    });
  }

  /** Jumps to Settings → Cloud to change the provider. */
  protected openCloudSettings(): void {
    this.dialog.close();
    this.settingsDialog.open('cloud');
  }

  /** Confirms, then removes the active workflow's deployed spec. */
  protected async removeFromCloud(): Promise<void> {
    const workflowId = this.workflow.activeDoc()?.workflowId;
    if (!workflowId) return;
    const confirmed = await this.confirmDialog.confirm({
      title: 'Remove from cloud?',
      message:
        `"${this.workflow.activeName()}" will stop running in the cloud immediately - scheduled ` +
        `triggers, manual runs and the live monitor all need a fresh push afterward. Its published ` +
        `portal is taken offline, and the cloud copy of its run history and usage is deleted. Your ` +
        `local workflow, connections and account usage totals are untouched.`,
      confirmLabel: 'Remove',
      tone: 'danger',
    });
    if (!confirmed) return;
    await this.cloud.removeWorkflow(workflowId);
  }

  protected onUrlInput(event: Event): void {
    this.cloud.setWorkerUrl((event.target as HTMLInputElement | null)?.value ?? '');
  }

  protected onTokenInput(event: Event): void {
    this.cloud.setToken((event.target as HTMLInputElement | null)?.value ?? '');
  }

  protected onFolderInput(event: Event): void {
    this.cloud.setCloudFolder((event.target as HTMLInputElement | null)?.value ?? '');
  }

  // ── AWS commands ───────────────────────────────────────────────────────────

  /**
   * Rewrites the Deploy_Config_File FIRST (Requirement 3.6), then hands off to
   * `AwsCliService.planAndDeploy`, which owns the plan-then-confirm-then-deploy
   * ordering, the refusal to deploy after a non-zero plan, and the endpoint
   * discovery that follows a successful deploy. This dialog adds no second
   * ordering rule.
   */
  protected async runAwsPlanAndDeploy(): Promise<void> {
    if (!(await this.writeAwsConfigFile())) return;
    const cwd = this.awsConfig.cloudAwsDirectory();
    this.awsActiveCommand.set('deploy');
    try {
      await this.awsCli.planAndDeploy(
        cwd,
        await this.awsCdkEntryExists(cwd),
        await this.awsEgressAllowList(),
      );
    } finally {
      this.awsActiveCommand.set(null);
    }
  }

  /** Runs the `doctor` verb. Needs no config rewrite - it reads the file. */
  protected async runAwsDoctor(): Promise<void> {
    const command: DeployCommand = {
      program: 'npx',
      args: ['phorma-aws', 'doctor'],
      cwd: this.awsConfig.cloudAwsDirectory(),
    };
    this.awsActiveCommand.set('doctor');
    try {
      await this.awsCli.runCommand(command);
    } finally {
      this.awsActiveCommand.set(null);
    }
  }

  /**
   * Opens the run console. This is the affordance offered in place of a Cancel
   * button: `run_streamed_command` exposes no cancellation, and killing a
   * `cdk deploy` mid-flight is worse than letting it settle.
   */
  protected openRunConsole(): void {
    this.terminal.open('run');
  }

  private async writeAwsConfigFile(): Promise<boolean> {
    const written = await this.awsConfig.writeConfigFile();
    if (!written) {
      this.toast.error(
        'Could not write the deploy configuration',
        `The Studio writes ${AWS_CONFIG_FILENAME} into the cloud-aws folder before ` +
          'running the CLI. Check the path in Settings.',
      );
    }
    return written;
  }

  /**
   * Whether the configured directory holds a CDK entry point. `AwsCliService`
   * takes this as an argument so filesystem access stays with the caller. Same
   * probe the Settings dialog uses.
   */
  private async awsCdkEntryExists(cloudAwsDir: string): Promise<boolean> {
    if (!cloudAwsDir || !this.isDesktop) return false;
    const separator = cloudAwsDir.includes('\\') ? '\\' : '/';
    const path = `${cloudAwsDir.replace(/[\\/]$/, '')}${separator}cdk.json`;
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke<string>('read_workflow_file', { path });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * The egress allow-list the deploy writes to the console, derived from the
   * active graph, the locally known connections and the configured model
   * providers. Pure derivation lives in the engine.
   */
  private async awsEgressAllowList(): Promise<EgressAllowList> {
    const spec = this.workflow.exportActiveSpec();
    let connections: ConnectionSummary[] = [];
    try {
      connections = await this.connectionStore.list();
    } catch {
      connections = [];
    }
    const configured = this.settings.keyConfigured();
    const defaultProvider = this.settings.defaultProvider();
    const providers = MODEL_PROVIDERS.map(entry => entry.id).filter(
      id => id === defaultProvider || configured[id] === true,
    );
    return deriveEgressAllowList({ specs: spec ? [spec] : [], connections, providers });
  }

  @HostListener('document:keydown.escape')
  protected onEscape(): void {
    if (this.dialog.visible()) this.dialog.close();
  }
}
