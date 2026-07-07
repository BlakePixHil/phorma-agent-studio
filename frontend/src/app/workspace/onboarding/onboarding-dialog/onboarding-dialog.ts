import {
  ChangeDetectionStrategy,
  Component,
  HostListener,
  inject,
  signal,
  computed,
} from '@angular/core';
import { ButtonModule } from 'primeng/button';

import { OnboardingService } from '../onboarding.service';
import { TauriService } from '../../../core/tauri.service';
import { SettingsService } from '../../../core/settings.service';
import { SettingsDialogService } from '../../settings/settings-dialog.service';

/** Curated model choices shown in the wizard's model picker. */
interface ModelOption {
  id: string;
  label: string;
  description: string;
  /** Approximate download size in GB. */
  sizeGb: number;
  recommended?: boolean;
}

const CURATED_MODELS: ModelOption[] = [
  { id: 'qwen2.5:7b', label: 'Qwen 2.5 7B', description: 'Best balance of speed and quality', sizeGb: 4.7, recommended: true },
  { id: 'llama3.2:3b', label: 'Llama 3.2 3B', description: 'Fast and small - great for trying out', sizeGb: 2.0 },
  { id: 'qwen2.5:14b', label: 'Qwen 2.5 14B', description: 'Higher quality, needs a capable machine', sizeGb: 9.0 },
  { id: 'llama3.2:1b', label: 'Llama 3.2 1B', description: 'Tiny - runs on almost anything', sizeGb: 1.3 },
];

type Step =
  | 'welcome'
  | 'source'
  | 'ollama-detect'
  | 'ollama-install'
  | 'model-pick'
  | 'model-pull'
  | 'api-keys'
  | 'done';

type Source = 'ollama' | 'api-keys';

/** Ordered wizard stages backing the progress indicator. */
const STAGES = ['Welcome', 'Model source', 'Setup', 'Finish'] as const;

/**
 * First-run setup wizard.
 *
 * A bespoke full-overlay dialog matching the cloud/confirm dialog pattern
 * with a multi-step state machine. Strictly modal: there is no close button,
 * backdrop clicks and Escape do nothing - the only exits are completing the
 * steps or the explicit "Skip setup" action, both of which permanently mark
 * setup as done via `OnboardingService.finish()`.
 *
 * The Ollama install and model pull steps stream progress from the Rust
 * backend via `ollama-event` events; every download requires explicit
 * consent with the size stated up front, and a free-disk check guards
 * against filling the disk.
 */
@Component({
  selector: 'app-onboarding-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ButtonModule],
  templateUrl: './onboarding-dialog.html',
  styleUrl: './onboarding-dialog.scss',
})
export class OnboardingDialog {
  protected readonly dialog = inject(OnboardingService);
  private readonly tauri = inject(TauriService);
  private readonly settings = inject(SettingsService);
  private readonly settingsDialog = inject(SettingsDialogService);

  protected readonly step = signal<Step>('welcome');
  protected readonly source = signal<Source | null>(null);

  // Ollama detection state
  protected readonly ollamaChecking = signal(false);
  protected readonly ollamaModels = signal<string[]>([]);

  // Install state
  protected readonly installing = signal(false);
  protected readonly installProgress = signal('');
  protected readonly installError = signal<string | null>(null);

  // Model picker state
  protected readonly selectedModel = signal<ModelOption | null>(null);
  protected readonly diskFreeBytes = signal<number | null>(null);

  // Pull state
  protected readonly pulling = signal(false);
  protected readonly pullProgress = signal('');
  protected readonly pullError = signal<string | null>(null);
  private pullRequestId: string | null = null;

  protected readonly models = CURATED_MODELS;
  protected readonly stages = STAGES;

  /** Index into `STAGES` for the progress indicator. */
  protected readonly stageIndex = computed(() => {
    switch (this.step()) {
      case 'welcome':
        return 0;
      case 'source':
        return 1;
      case 'done':
        return 3;
      default:
        return 2;
    }
  });

  protected readonly diskFreeGb = computed(() => {
    const bytes = this.diskFreeBytes();
    return bytes !== null ? bytes / 1e9 : null;
  });

  protected readonly insufficientDisk = computed(() => {
    const model = this.selectedModel();
    const freeGb = this.diskFreeGb();
    return model !== null && freeGb !== null && freeGb < model.sizeGb;
  });

  /** A download or install is in flight - navigation away is blocked. */
  protected readonly busy = computed(() => this.installing() || this.pulling());

  /** Step title shown in the card header. */
  protected title(): string {
    switch (this.step()) {
      case 'welcome':
        return 'Welcome to Phorma Agent Studio';
      case 'source':
        return 'Choose your model source';
      case 'ollama-detect':
        return 'Checking for Ollama';
      case 'ollama-install':
        return 'Install Ollama';
      case 'model-pick':
        return 'Pick a local model';
      case 'model-pull':
        return 'Downloading model';
      case 'api-keys':
        return 'Use your own API keys';
      case 'done':
        return 'Setup complete';
    }
  }

  /** Step subtitle shown under the title. */
  protected subtitle(): string {
    switch (this.step()) {
      case 'welcome':
        return "Let's get you set up to build and run AI agent workflows.";
      case 'source':
        return 'You can change this at any time in Settings.';
      case 'ollama-detect':
        return 'Looking for a local Ollama runtime on this machine.';
      case 'ollama-install':
        return 'Ollama runs AI models locally - free and private.';
      case 'model-pick':
        return 'Downloads happen once; the model then runs fully offline.';
      case 'model-pull':
        return 'Keep this window open - progress streams live.';
      case 'api-keys':
        return 'Connect Anthropic, OpenAI, Gemini, or OpenRouter.';
      case 'done':
        return 'Everything is ready to go.';
    }
  }

  // ── Step transitions ─────────────────────────────────────────────────────

  protected chooseSource(src: Source): void {
    this.source.set(src);
    if (src === 'ollama') {
      this.step.set('ollama-detect');
      void this.detectOllama();
    } else {
      this.step.set('api-keys');
    }
  }

  protected back(): void {
    if (this.busy()) return;
    switch (this.step()) {
      case 'source':
        this.step.set('welcome');
        break;
      case 'ollama-detect':
      case 'ollama-install':
      case 'model-pick':
      case 'api-keys':
        this.step.set('source');
        break;
      case 'model-pull':
        this.step.set('model-pick');
        break;
      default:
        break;
    }
  }

  /** Completes the wizard - the only way it closes. */
  protected finish(): void {
    this.dialog.finish();
    // Reset the state machine for a potential re-run from Settings.
    this.step.set('welcome');
    this.source.set(null);
    this.selectedModel.set(null);
    this.pullProgress.set('');
    this.pullError.set(null);
    this.installProgress.set('');
    this.installError.set(null);
  }

  /** Explicit skip - counts as having been through setup. */
  protected skip(): void {
    if (this.busy()) return;
    this.finish();
  }

  // ── Ollama detection ─────────────────────────────────────────────────────

  protected async detectOllama(): Promise<void> {
    if (!this.tauri.isDesktop) {
      this.step.set('ollama-install');
      return;
    }
    this.ollamaChecking.set(true);
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const status = await invoke<{ running: boolean; version?: string; models: string[] }>(
        'ollama_status',
        { baseUrl: this.settings.ollamaBaseUrl() },
      );
      this.ollamaModels.set(status.models);
      if (status.running) {
        this.step.set('model-pick');
        void this.checkDisk();
      } else {
        this.step.set('ollama-install');
      }
    } catch {
      this.step.set('ollama-install');
    } finally {
      this.ollamaChecking.set(false);
    }
  }

  protected async checkDisk(): Promise<void> {
    if (!this.tauri.isDesktop) return;
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const bytes = await invoke<number>('disk_free');
      this.diskFreeBytes.set(bytes);
    } catch {
      this.diskFreeBytes.set(null);
    }
  }

  // ── Ollama install ───────────────────────────────────────────────────────

  protected async installOllama(): Promise<void> {
    if (!this.tauri.isDesktop || this.installing()) return;
    this.installing.set(true);
    this.installError.set(null);
    this.installProgress.set('Starting…');

    const requestId = `ollama-install-${Date.now()}`;
    const { invoke } = await import('@tauri-apps/api/core');
    const { listen } = await import('@tauri-apps/api/event');

    const unlisten = await listen<{ requestId: string; kind: string; data?: string }>(
      'ollama-event',
      e => {
        if (e.payload.requestId !== requestId) return;
        if (e.payload.kind === 'progress') {
          this.installProgress.set(e.payload.data ?? '');
        } else if (e.payload.kind === 'done') {
          this.installProgress.set('Ollama installed successfully.');
        } else if (e.payload.kind === 'error') {
          this.installError.set(e.payload.data ?? 'Unknown error');
        }
      },
    );

    try {
      await invoke('ollama_install', { requestId });
      await this.detectOllama();
    } catch (err) {
      this.installError.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.installing.set(false);
      unlisten();
    }
  }

  // ── Model pull ───────────────────────────────────────────────────────────

  protected selectModel(model: ModelOption): void {
    if (this.pulling()) return;
    this.selectedModel.set(model);
  }

  protected startPull(): void {
    if (!this.selectedModel() || this.insufficientDisk()) return;
    this.step.set('model-pull');
    void this.pullModel();
  }

  private async pullModel(): Promise<void> {
    const model = this.selectedModel();
    if (!model || !this.tauri.isDesktop || this.pulling()) return;

    this.pulling.set(true);
    this.pullError.set(null);
    this.pullProgress.set('Starting download…');
    this.pullRequestId = `ollama-pull-${Date.now()}`;

    const { invoke } = await import('@tauri-apps/api/core');
    const { listen } = await import('@tauri-apps/api/event');

    const unlisten = await listen<{ requestId: string; kind: string; data?: string }>(
      'ollama-event',
      e => {
        if (e.payload.requestId !== this.pullRequestId) return;
        if (e.payload.kind === 'progress') {
          this.pullProgress.set(e.payload.data ?? '');
        } else if (e.payload.kind === 'done') {
          this.pullProgress.set('Download complete.');
        } else if (e.payload.kind === 'error') {
          this.pullError.set(e.payload.data ?? 'Unknown error');
        }
      },
    );

    try {
      await invoke('ollama_pull', {
        requestId: this.pullRequestId,
        model: model.id,
        baseUrl: this.settings.ollamaBaseUrl(),
      });
      // Set as the app-wide default model and advance.
      this.settings.defaultProvider.set('ollama');
      this.settings.defaultModel.set(model.id);
      this.step.set('done');
    } catch (err) {
      this.pullError.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.pulling.set(false);
      unlisten();
    }
  }

  protected async cancelPull(): Promise<void> {
    if (!this.pullRequestId || !this.tauri.isDesktop) return;
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('ollama_cancel_pull', { requestId: this.pullRequestId });
    } catch {
      // Best-effort.
    }
    this.pulling.set(false);
    this.pullProgress.set('');
    this.step.set('model-pick');
  }

  // ── API keys path ────────────────────────────────────────────────────────

  /** Finishes the wizard and deep-links into API key settings. */
  protected openApiKeySettings(): void {
    this.finish();
    this.settingsDialog.open('api-keys');
  }

  // ── Keyboard ─────────────────────────────────────────────────────────────

  /**
   * Escape is deliberately a no-op: the wizard only closes via finish or
   * skip. Swallow the key so it doesn't reach canvas shortcuts underneath.
   */
  @HostListener('document:keydown.escape', ['$event'])
  protected onEscape(event: Event): void {
    if (this.dialog.visible()) {
      event.stopPropagation();
    }
  }
}
