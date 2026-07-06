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
import { FormsModule } from '@angular/forms';
import { CurrencyPipe } from '@angular/common';
import { ButtonModule } from 'primeng/button';
import { SelectModule } from 'primeng/select';
import { SliderModule } from 'primeng/slider';
import { ToggleSwitchModule } from 'primeng/toggleswitch';
import { TooltipModule } from 'primeng/tooltip';

import { SettingsDialogService } from '../settings-dialog.service';
import { CloudService, PHORMA_CLOUD_DEFAULT_URL } from '../../../core/cloud.service';
import { PhormaCloudService } from '../../../core/phorma-cloud.service';
import { SettingsService } from '../../../core/settings.service';
import {
  SettingsRegistryService,
  type SettingDef,
  type SettingsPageDef,
} from '../../../core/settings-registry';
import { TauriService } from '../../../core/tauri.service';
import { ThemeService } from '../../../core/theme.service';
import { THEME_PALETTES, type ThemePalette, type ThemePaletteId } from '../../../core/theme-palettes';
import { MCP_PRESETS, type McpPreset } from '../../../core/node-catalog';
import { ToastService } from '../../../shared/toast/toast.service';
import { PhormaCloudIcon } from '../../../shared/icons/phorma-cloud-icon';
import {
  MODEL_PROVIDERS,
  PROVIDER_MODEL_SUGGESTIONS,
  type ModelProviderId,
} from '../../../core/workflow.model';

/**
 * Application Settings — a large two-pane dialog (left page nav + scrollable
 * content) rendered from the declarative `SettingsRegistryService`.
 *
 * Generic settings (toggles, selects, numbers, sliders, text) apply
 * instantly through their descriptors. Sensitive sections (API keys,
 * integration credentials) are bespoke templates with explicit Save buttons;
 * values go to the OS keychain on desktop and never come back into the
 * webview — only "configured" flags do. Browser preview falls back to
 * localStorage and is labelled as such.
 */
@Component({
  selector: 'app-settings-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, CurrencyPipe, ButtonModule, SelectModule, SliderModule, ToggleSwitchModule, TooltipModule, PhormaCloudIcon],
  templateUrl: './settings-dialog.html',
  styleUrl: './settings-dialog.scss',
})
export class SettingsDialog {
  protected readonly dialog = inject(SettingsDialogService);
  protected readonly registry = inject(SettingsRegistryService);
  protected readonly settings = inject(SettingsService);
  protected readonly theme = inject(ThemeService);
  private readonly tauri = inject(TauriService);
  private readonly toast = inject(ToastService);

  protected readonly isDesktop = this.tauri.isDesktop;

  // ── Navigation + search ─────────────────────────────────────────────────

  protected readonly searchQuery = signal('');

  /** Pages whose content matches the search query (all when query empty). */
  protected readonly visiblePages = computed<SettingsPageDef[]>(() => {
    const matching = this.registry.matchingPageIds(this.searchQuery());
    return this.registry.pages.filter(page => matching.has(page.id));
  });

  /** The currently displayed page (self-heals when filtered out by search). */
  protected readonly activePage = computed<SettingsPageDef | null>(() => {
    const visible = this.visiblePages();
    if (visible.length === 0) return null;
    return visible.find(page => page.id === this.dialog.activePageId()) ?? visible[0];
  });

  protected selectPage(pageId: string): void {
    this.dialog.activePageId.set(pageId);
  }

  protected onSearchInput(event: Event): void {
    this.searchQuery.set((event.target as HTMLInputElement | null)?.value ?? '');
  }

  // ── Generic control value coercion ──────────────────────────────────────

  protected asBool(setting: SettingDef): boolean {
    return !!setting.get();
  }

  protected asNumber(setting: SettingDef): number {
    const value = Number(setting.get());
    return Number.isFinite(value) ? value : 0;
  }

  protected asString(setting: SettingDef): string {
    return String(setting.get() ?? '');
  }

  protected setFromInput(setting: SettingDef, event: Event): void {
    setting.set((event.target as HTMLInputElement | null)?.value ?? '');
  }

  // ── API keys (custom template) ──────────────────────────────────────────

  /** Providers that take a key (Ollama is keyless). */
  protected readonly keyedProviders = MODEL_PROVIDERS.filter(p => p.id !== 'ollama');

  /** Unsaved key inputs, per provider. */
  protected readonly keyDrafts = signal<Partial<Record<ModelProviderId, string>>>({});

  protected readonly storageLabel = this.isDesktop
    ? 'Secrets are stored in your OS keychain and never leave this machine.'
    : 'Browser preview: secrets are stored in localStorage. Use the desktop app for keychain-backed storage.';

  protected onKeyDraftInput(provider: ModelProviderId, event: Event): void {
    const value = (event.target as HTMLInputElement | null)?.value ?? '';
    this.keyDrafts.update(drafts => ({ ...drafts, [provider]: value }));
  }

  protected async saveKey(provider: ModelProviderId): Promise<void> {
    const draft = this.keyDrafts()[provider];
    if (draft === undefined) return;
    try {
      await this.settings.setProviderKey(provider, draft);
      this.keyDrafts.update(drafts => {
        const next = { ...drafts };
        delete next[provider];
        return next;
      });
      this.toast.success(draft.trim() ? 'Key saved' : 'Key removed', this.providerLabel(provider));
    } catch (error) {
      this.toast.error('Could not save key', error instanceof Error ? error.message : String(error));
    }
  }

  protected async clearKey(provider: ModelProviderId): Promise<void> {
    try {
      await this.settings.setProviderKey(provider, '');
      this.toast.success('Key removed', this.providerLabel(provider));
    } catch (error) {
      this.toast.error('Could not remove key', error instanceof Error ? error.message : String(error));
    }
  }

  private providerLabel(provider: ModelProviderId): string | undefined {
    return this.keyedProviders.find(p => p.id === provider)?.label;
  }

  // ── Palette picker (custom template) ────────────────────────────────────

  protected readonly palettes: ThemePalette[] = Object.values(THEME_PALETTES);

  protected pickPalette(id: ThemePaletteId): void {
    this.theme.setPalette(id);
  }

  // ── Default model (custom template) ─────────────────────────────────────

  protected readonly providers = MODEL_PROVIDERS;

  protected readonly defaultModelSuggestions = computed(
    () => PROVIDER_MODEL_SUGGESTIONS[this.settings.defaultProvider()] ?? [],
  );

  protected onDefaultProviderChange(provider: ModelProviderId): void {
    this.settings.setDefaultProvider(provider);
  }

  protected onDefaultModelInput(event: Event): void {
    this.settings.defaultModel.set((event.target as HTMLInputElement | null)?.value ?? '');
  }

  protected pickDefaultModel(model: string): void {
    this.settings.defaultModel.set(model);
  }

  protected onDefaultTemperatureInput(event: Event): void {
    const parsed = Number((event.target as HTMLInputElement | null)?.value);
    if (Number.isFinite(parsed)) {
      this.settings.defaultTemperature.set(Math.min(2, Math.max(0, parsed)));
    }
  }

  // ── Integrations (custom template) ──────────────────────────────────────

  protected readonly mcpPresets: McpPreset[] = MCP_PRESETS;

  /** Unsaved integration credential inputs, keyed `'{presetId}:{envKey}'`. */
  protected readonly presetDrafts = signal<Record<string, string>>({});

  // ── Cloud provider (custom template) ────────────────────────────────────

  protected readonly cloud = inject(CloudService);
  protected readonly phormaCloud = inject(PhormaCloudService);

  /** Signed-in Clerk user (null while loading / signed out). */
  protected readonly clerkUser = this.phormaCloud.user;

  protected pickCloudProvider(choice: 'phorma' | 'cloudflare'): void {
    this.settings.cloudProvider.set(choice);
    if (choice === 'phorma') void this.phormaCloud.refresh();
  }

  /**
   * Resets the Phorma Cloud endpoint to the built-in default. Guards against
   * a stale `phormaCloudUrl` persisted in localStorage from a previous
   * default (e.g. before a custom-domain migration) silently pointing the
   * studio at a dead URL — the account card then shows "Load failed" with
   * no obvious cause.
   */
  protected resetPhormaCloudUrl(): void {
    this.cloud.setPhormaCloudUrl(PHORMA_CLOUD_DEFAULT_URL);
    void this.phormaCloud.refresh();
  }

  protected onWorkerUrlInput(event: Event): void {
    this.cloud.setWorkerUrl((event.target as HTMLInputElement | null)?.value ?? '');
  }

  protected onCloudTokenInput(event: Event): void {
    this.cloud.setToken((event.target as HTMLInputElement | null)?.value ?? '');
  }

  protected onCloudFolderInput(event: Event): void {
    this.cloud.setCloudFolder((event.target as HTMLInputElement | null)?.value ?? '');
  }

  /** Worker secrets settable from the guided wizard (BYO Cloudflare). */
  protected readonly workerSecretNames = [
    'ANTHROPIC_API_KEY',
    'OPENAI_API_KEY',
    'GEMINI_API_KEY',
    'OPENROUTER_API_KEY',
    'PHORMA_TOKEN',
  ] as const;

  /** Unsaved worker-secret inputs, keyed by secret name. */
  protected readonly workerSecretDrafts = signal<Record<string, string>>({});

  protected onWorkerSecretInput(name: string, event: Event): void {
    const value = (event.target as HTMLInputElement | null)?.value ?? '';
    this.workerSecretDrafts.update(drafts => ({ ...drafts, [name]: value }));
  }

  protected async saveWorkerSecret(name: string): Promise<void> {
    const draft = this.workerSecretDrafts()[name];
    if (!draft?.trim()) return;
    await this.cloud.putWorkerSecret(name, draft);
    this.workerSecretDrafts.update(drafts => {
      const next = { ...drafts };
      delete next[name];
      return next;
    });
  }

  constructor() {
    // Refresh preset-scoped configured flags whenever the dialog opens so
    // Integrations badges are accurate. `untracked` is REQUIRED: the refresh
    // reads AND writes `mcpSecretsConfigured` synchronously (browser path),
    // which would otherwise register the signal as a dependency of this
    // effect and loop it forever.
    effect(() => {
      if (!this.dialog.visible()) return;
      untracked(() => {
        for (const preset of this.mcpPresets) {
          void this.settings.refreshPresetSecretFlags(
            preset.id,
            preset.envSchema.map(field => field.name),
          );
        }
      });
    });

    // Refresh the Phorma Cloud profile whenever the Cloud page is shown with
    // the phorma provider active (quota bar stays current).
    effect(() => {
      if (!this.dialog.visible()) return;
      if (this.dialog.activePageId() !== 'cloud') return;
      if (this.settings.cloudProvider() !== 'phorma') return;
      untracked(() => void this.phormaCloud.refresh());
    });
  }

  protected presetFlagKey(presetId: string, envKey: string): string {
    return `preset:${presetId}:${envKey}`;
  }

  protected onPresetDraftInput(presetId: string, envKey: string, event: Event): void {
    const value = (event.target as HTMLInputElement | null)?.value ?? '';
    this.presetDrafts.update(drafts => ({ ...drafts, [`${presetId}:${envKey}`]: value }));
  }

  protected async savePresetSecret(preset: McpPreset, envKey: string): Promise<void> {
    const draftKey = `${preset.id}:${envKey}`;
    const draft = this.presetDrafts()[draftKey];
    if (draft === undefined) return;
    try {
      await this.settings.setPresetSecret(preset.id, envKey, draft);
      this.presetDrafts.update(drafts => {
        const next = { ...drafts };
        delete next[draftKey];
        return next;
      });
      this.toast.success(draft.trim() ? 'Credential saved' : 'Credential removed', preset.label);
    } catch (error) {
      this.toast.error(
        'Could not save credential',
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  protected async clearPresetSecret(preset: McpPreset, envKey: string): Promise<void> {
    try {
      await this.settings.setPresetSecret(preset.id, envKey, '');
      this.toast.success('Credential removed', preset.label);
    } catch (error) {
      this.toast.error(
        'Could not remove credential',
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  // ── Dialog chrome ───────────────────────────────────────────────────────

  @HostListener('document:keydown.escape')
  protected onEscape(): void {
    if (this.dialog.visible()) this.dialog.close();
  }
}
