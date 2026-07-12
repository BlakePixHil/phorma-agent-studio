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
import { DecimalPipe } from '@angular/common';
import { ButtonModule } from 'primeng/button';
import { SelectModule } from 'primeng/select';
import { SliderModule } from 'primeng/slider';
import { ToggleSwitchModule } from 'primeng/toggleswitch';
import { TooltipModule } from 'primeng/tooltip';

import { SettingsDialogService } from '../settings-dialog.service';
import { CloudService, PHORMA_CLOUD_DEFAULT_URL } from '../../../core/cloud.service';
import { CreditsDialogService } from '../../cloud/credits-dialog.service';
import { ModelTransportService } from '../../../core/model-transport.service';
import { PhormaCloudService } from '../../../core/phorma-cloud.service';
import { SettingsService } from '../../../core/settings.service';
import {
  SettingsRegistryService,
  type SettingDef,
  type SettingsPageDef,
  type SettingsSectionDef,
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

/** BYO providers that support a live model-list fetch. */
const LIVE_FETCH_PROVIDERS: ReadonlySet<ModelProviderId> = new Set([
  'anthropic',
  'openai',
  'gemini',
  'openrouter',
]);

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
  imports: [FormsModule, DecimalPipe, ButtonModule, SelectModule, SliderModule, ToggleSwitchModule, TooltipModule, PhormaCloudIcon],
  templateUrl: './settings-dialog.html',
  styleUrl: './settings-dialog.scss',
})
export class SettingsDialog {
  protected readonly dialog = inject(SettingsDialogService);
  protected readonly registry = inject(SettingsRegistryService);
  protected readonly settings = inject(SettingsService);
  protected readonly theme = inject(ThemeService);
  protected readonly creditsDialog = inject(CreditsDialogService);
  private readonly tauri = inject(TauriService);
  private readonly toast = inject(ToastService);
  private readonly transport = inject(ModelTransportService);

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

  /** A page's sections minus any hidden by their `visible` predicate. */
  protected visibleSections(page: SettingsPageDef): SettingsSectionDef[] {
    return page.sections.filter(section => (section.visible ? section.visible() : true));
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

  /** Providers that take a key (Ollama + Phorma Cloud are keyless). */
  protected readonly keyedProviders = MODEL_PROVIDERS.filter(
    p => p.id !== 'ollama' && p.id !== 'phorma-cloud',
  );

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

  /**
   * Provider options for the default-model picker. Phorma Cloud is shown (and
   * selectable) whenever the user is signed in; if they lack an active
   * subscription, the model picker is replaced by a subscribe CTA.
   */
  protected readonly providers = computed(() => {
    const signedIn = this.phormaCloud.signedIn();
    return MODEL_PROVIDERS.filter(p => p.id !== 'phorma-cloud' || signedIn);
  });

  /**
   * True when the default provider is Phorma Cloud but the account has no
   * active subscription — the model picker is replaced by a subscribe CTA.
   */
  protected readonly needsPhormaCloudSubscription = computed(
    () => this.settings.defaultProvider() === 'phorma-cloud' && !this.phormaCloud.subscribed(),
  );

  /** Bedrock model ids fetched from the mantle catalog for the current region. */
  protected readonly bedrockModels = signal<string[]>([]);
  /** True while auto-fetching Bedrock models for the model dropdown. */
  protected readonly loadingBedrockModels = signal(false);
  /** Last Bedrock fetch error (null when the last fetch succeeded). */
  protected readonly bedrockFetchError = signal<string | null>(null);
  /** Whether the user dismissed the current fetch-failure warning. */
  protected readonly bedrockWarningDismissed = signal(false);
  /** Region already fetched (or fetching), to avoid duplicate auto-fetches. */
  private lastBedrockFetch = '';

  /** Live-fetched model ids for the current BYO provider (empty until loaded). */
  protected readonly liveModels = signal<string[]>([]);
  /** True while fetching the model list for the current BYO provider. */
  protected readonly loadingModels = signal(false);
  /** Last BYO model-fetch error (null when the last fetch succeeded). */
  protected readonly modelFetchError = signal<string | null>(null);
  /** Provider already fetched (or fetching), to avoid duplicate auto-fetches. */
  private lastModelFetch = '';

  /**
   * Options for the default-model dropdown. Bedrock is populated from the live
   * mantle catalog (auto-fetched); Phorma Cloud uses the curated list; BYO
   * providers use live-fetched ids (falling back to static suggestions on
   * error).
   */
  protected readonly defaultModelSuggestions = computed(() => {
    const provider = this.settings.defaultProvider();
    if (provider === 'bedrock') return this.bedrockModels();
    if (provider === 'phorma-cloud') return PROVIDER_MODEL_SUGGESTIONS['phorma-cloud'];
    if (LIVE_FETCH_PROVIDERS.has(provider)) {
      return this.liveModels().length > 0 ? this.liveModels() : PROVIDER_MODEL_SUGGESTIONS[provider];
    }
    return PROVIDER_MODEL_SUGGESTIONS[provider] ?? [];
  });

  /**
   * Show the model dropdown unless a Bedrock catalog fetch failed — in that
   * case we fall back to a free-text input so the user can still type an id.
   * Phorma Cloud always shows the curated dropdown.
   */
  protected readonly showModelDropdown = computed(() => {
    const provider = this.settings.defaultProvider();
    if (provider === 'phorma-cloud') return true;
    if (LIVE_FETCH_PROVIDERS.has(provider)) return this.modelFetchError() === null;
    return provider !== 'bedrock' || this.bedrockFetchError() === null;
  });

  /** Whether the default provider is Phorma Cloud (curated, non-editable). */
  protected readonly isPhormaCloud = computed(
    () => this.settings.defaultProvider() === 'phorma-cloud',
  );

  /** The inline fetch-failure warning message, or null when there's nothing to show. */
  protected readonly bedrockWarning = computed(() =>
    this.settings.defaultProvider() === 'bedrock' && !this.bedrockWarningDismissed()
      ? this.bedrockFetchError()
      : null,
  );

  protected dismissBedrockWarning(): void {
    this.bedrockWarningDismissed.set(true);
  }

  protected onDefaultProviderChange(provider: ModelProviderId): void {
    this.settings.setDefaultProvider(provider);
  }

  protected onDefaultModelChange(model: string): void {
    this.settings.defaultModel.set((model ?? '').trim());
  }

  protected onDefaultModelInput(event: Event): void {
    this.settings.defaultModel.set((event.target as HTMLInputElement | null)?.value ?? '');
  }

  /**
   * Deep-links to the Cloud settings page to subscribe to Phorma Cloud.
   * Stripe checkout is not wired up yet (placeholder) — see agent-memory.
   */
  protected openSubscribe(): void {
    this.dialog.activePageId.set('cloud');
  }

  /** Opens the Buy Credits pack picker (placeholder — payments not wired up yet). */
  protected openBuyCredits(): void {
    this.creditsDialog.open();
  }

  /**
   * Fetches Bedrock's model options for a region into {@link bedrockModels}:
   * inference profiles (control plane) + the mantle `/v1/models` catalog,
   * merged. Runs automatically (no button) whenever Bedrock is the chosen
   * provider and the region changes. Fails silently only when BOTH sources
   * fail — recording the message for a dismissable inline warning and letting
   * the UI fall back to a text input.
   */
  private async loadBedrockModels(region: string): Promise<void> {
    this.loadingBedrockModels.set(true);
    this.bedrockFetchError.set(null);
    this.bedrockWarningDismissed.set(false);

    const [profiles, models] = await Promise.allSettled([
      this.transport.listBedrockInferenceProfiles(region),
      this.transport.listBedrockModels(region),
    ]);

    const ids = new Set<string>();
    if (profiles.status === 'fulfilled') for (const id of profiles.value) ids.add(id);
    if (models.status === 'fulfilled') for (const id of models.value) ids.add(id);

    if (ids.size > 0) {
      this.bedrockModels.set([...ids].sort());
    } else {
      // Both sources failed — surface the profile error (the one that matters
      // most for Claude) and fall back to manual entry.
      const reason = profiles.status === 'rejected' ? profiles.reason : (models as PromiseRejectedResult).reason;
      this.bedrockModels.set([]);
      this.lastBedrockFetch = ''; // allow a retry on the next change
      this.bedrockFetchError.set(reason instanceof Error ? reason.message : String(reason));
    }
    this.loadingBedrockModels.set(false);
  }

  /**
   * Fetches the live model list for a BYO provider into {@link liveModels}.
   * Runs automatically whenever the default provider is a BYO provider.
   * Fails silently (recording the error) so the picker falls back to static
   * suggestions + free text.
   */
  private async loadModels(provider: ModelProviderId): Promise<void> {
    if (!LIVE_FETCH_PROVIDERS.has(provider)) return;
    if (this.lastModelFetch === provider) return;
    this.lastModelFetch = provider;
    this.loadingModels.set(true);
    this.modelFetchError.set(null);
    try {
      const ids = await this.transport.listModels(
        provider as 'anthropic' | 'openai' | 'gemini' | 'openrouter',
      );
      this.liveModels.set(ids);
    } catch (error) {
      this.liveModels.set([]);
      this.modelFetchError.set(error instanceof Error ? error.message : String(error));
      this.lastModelFetch = ''; // allow a retry on the next change
    } finally {
      this.loadingModels.set(false);
    }
  }

  // ── Integrations (custom template) ──────────────────────────────────────

  /**
   * Presets that expose configurable secrets. Presets with no `envSchema`
   * (e.g. Filesystem, Memory) have nothing to configure here, so they're
   * omitted to avoid empty cards.
   */
  protected readonly mcpPresets: McpPreset[] = MCP_PRESETS.filter(
    preset => preset.envSchema.length > 0,
  );

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

    // Auto-fetch the Bedrock model catalog for the model dropdown whenever the
    // dialog is open with Bedrock as the default provider. Re-runs when the
    // region changes; the guard dedupes and `untracked` keeps the fetch's
    // signal writes from feeding back into this effect.
    effect(() => {
      if (!this.dialog.visible()) return;
      if (this.settings.defaultProvider() !== 'bedrock') return;
      const region = this.settings.bedrockRegion();
      if (!region || this.lastBedrockFetch === region) return;
      this.lastBedrockFetch = region;
      untracked(() => void this.loadBedrockModels(region));
    });

    // Auto-fetch the live model list for BYO providers (anthropic/openai/
    // gemini/openrouter) whenever the dialog is open with one as the default.
    // `untracked` keeps the fetch's signal writes from feeding back.
    effect(() => {
      if (!this.dialog.visible()) return;
      const provider = this.settings.defaultProvider();
      if (!LIVE_FETCH_PROVIDERS.has(provider)) return;
      if (this.lastModelFetch === provider) return;
      untracked(() => void this.loadModels(provider));
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
