import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DialogModule } from 'primeng/dialog';

import { SettingsDialogService } from '../settings-dialog.service';
import { SettingsService } from '../../../core/settings.service';
import { TauriService } from '../../../core/tauri.service';
import { ToastService } from '../../../shared/toast/toast.service';
import { MODEL_PROVIDERS, type ModelProviderId } from '../../../core/workflow.model';

/**
 * Settings — provider API keys and model transport.
 *
 * Desktop: keys go straight to the OS keychain via Rust; the webview only
 * ever sees "configured / not configured".
 * Browser preview: keys fall back to localStorage (clearly labelled).
 */
@Component({
  selector: 'app-settings-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DialogModule],
  templateUrl: './settings-dialog.html',
  styleUrl: './settings-dialog.scss',
})
export class SettingsDialog {
  protected readonly dialog = inject(SettingsDialogService);
  protected readonly settings = inject(SettingsService);
  private readonly tauri = inject(TauriService);
  private readonly toast = inject(ToastService);

  /** Providers that take a key (Ollama is keyless). */
  protected readonly keyedProviders = MODEL_PROVIDERS.filter(p => p.id !== 'ollama');

  protected readonly isDesktop = this.tauri.isDesktop;

  /** Unsaved key inputs, per provider. */
  protected readonly drafts = signal<Partial<Record<ModelProviderId, string>>>({});

  protected readonly storageLabel = computed(() =>
    this.isDesktop ? 'Keys are stored in your OS keychain and never leave this machine.'
      : 'Browser preview: keys are stored in localStorage. Use the desktop app for keychain-backed storage.',
  );

  protected onDraftInput(provider: ModelProviderId, event: Event): void {
    const value = (event.target as HTMLInputElement | null)?.value ?? '';
    this.drafts.update(drafts => ({ ...drafts, [provider]: value }));
  }

  protected async saveKey(provider: ModelProviderId): Promise<void> {
    const draft = this.drafts()[provider];
    if (draft === undefined) return;
    try {
      await this.settings.setProviderKey(provider, draft);
      this.drafts.update(drafts => {
        const next = { ...drafts };
        delete next[provider];
        return next;
      });
      this.toast.success(
        draft.trim() ? 'Key saved' : 'Key removed',
        this.keyedProviders.find(p => p.id === provider)?.label,
      );
    } catch (error) {
      this.toast.error('Could not save key', error instanceof Error ? error.message : String(error));
    }
  }

  protected async clearKey(provider: ModelProviderId): Promise<void> {
    try {
      await this.settings.setProviderKey(provider, '');
      this.toast.success('Key removed', this.keyedProviders.find(p => p.id === provider)?.label);
    } catch (error) {
      this.toast.error('Could not remove key', error instanceof Error ? error.message : String(error));
    }
  }

  protected onOllamaUrlInput(event: Event): void {
    this.settings.setOllamaBaseUrl((event.target as HTMLInputElement | null)?.value ?? '');
  }
}
