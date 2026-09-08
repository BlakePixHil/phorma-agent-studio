import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  HostListener,
  computed,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { CurrencyPipe, DecimalPipe } from '@angular/common';
import { ButtonModule } from 'primeng/button';
import { SelectModule } from 'primeng/select';
import { SliderModule } from 'primeng/slider';
import { ToggleSwitchModule } from 'primeng/toggleswitch';
import { TooltipModule } from 'primeng/tooltip';

import { SettingsDialogService } from '../settings-dialog.service';
import { BillingRefreshService } from '../../../core/billing-refresh.service';
import { BillingService, subscriptionLookupKey } from '../../../core/billing.service';
import { CloudService } from '../../../core/cloud.service';
import { ENTRY_PLAN_TIER } from '../../../core/plan-catalog';
import { PHORMA_CLOUD_DEFAULT_URL } from '../../../core/phorma-cloud-url';
import { DeployConfigService } from '../../../core/deploy-config.service';
import {
  DEPLOY_TARGETS,
  type DeployCommand,
  type DeployTargetId,
} from '../../../core/deploy/deploy-targets';
import {
  AWS_CONFIG_FILENAME,
  AwsDeployConfigService,
} from '../../../core/deploy/aws-deploy-config.service';
import { AwsCliService } from '../../../core/deploy/aws-cli.service';
import { DeployWorkspaceService } from '../../../core/deploy/deploy-workspace.service';
import { WorkflowService } from '../../../core/workflow.service';
import { ConnectionStoreService } from '../../../core/connection-store.service';
import { CreditsDialogService } from '../../cloud/credits-dialog.service';
import { ModelTransportService } from '../../../core/model-transport.service';
import { DesktopAuthService } from '../../../core/desktop-auth.service';
import { PhormaCloudService, tierLabel } from '../../../core/phorma-cloud.service';
import { SettingsService } from '../../../core/settings.service';
import {
  SettingsRegistryService,
  type SettingDef,
  type SettingsPageDef,
  type SettingsSectionDef,
} from '../../../core/settings-registry';
import { TauriService } from '../../../core/tauri.service';
import { ThemeService } from '../../../core/theme.service';
import { CanvasStateService, MINIMAP_ANCHORS, type MinimapAnchor } from '../../../core/canvas-state.service';
import { UsageAnalyticsService } from '../../../core/usage-analytics.service';
import { THEME_PALETTES, type ThemePalette, type ThemePaletteId } from '../../../core/theme-palettes';
import { THEME_MODE_LIST, type ThemeMode, type ThemeModeDef } from '../../../core/theme-modes';
import {
  MCP_LOCAL_ICON,
  MCP_OAUTH_ICON,
  MCP_PRESETS,
  MCP_TRANSPORT_LABEL,
  mcpTransportKind,
  type McpPreset,
  type McpTransportKind,
} from '../../../core/node-catalog';
import { ToastService } from '../../../shared/toast/toast.service';
import { PhormaCloudIcon } from '../../../shared/icons/phorma-cloud-icon';
import { CheckoutFallback } from '../../../shared/billing/checkout-fallback';
import { PastDueNotice } from '../../../shared/billing/past-due-notice';
import { InfoPopover } from '../../../shared/info-popover/info-popover';
import { PlanCards } from '../../cloud/plan-cards/plan-cards';
import { PrivacySettings } from '../privacy/privacy-settings';
import {
  MODEL_PROVIDERS,
  PROVIDER_MODEL_SUGGESTIONS,
  type ModelProviderId,
} from '../../../core/workflow.model';
import {
  acceptsSamplingParams,
  deriveEgressAllowList,
  type ConnectionSummary,
  type EgressAllowList,
} from '@phorma/engine';

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
  imports: [FormsModule, CurrencyPipe, DecimalPipe, ButtonModule, SelectModule, SliderModule, ToggleSwitchModule, TooltipModule, PhormaCloudIcon, CheckoutFallback, PastDueNotice, InfoPopover, PlanCards, PrivacySettings],
  templateUrl: './settings-dialog.html',
  styleUrl: './settings-dialog.scss',
})
export class SettingsDialog {
  protected readonly dialog = inject(SettingsDialogService);
  protected readonly registry = inject(SettingsRegistryService);
  protected readonly settings = inject(SettingsService);
  protected readonly theme = inject(ThemeService);
  protected readonly canvas = inject(CanvasStateService);
  protected readonly creditsDialog = inject(CreditsDialogService);
  protected readonly billing = inject(BillingService);
  private readonly billingRefresh = inject(BillingRefreshService);
  protected readonly usageAnalytics = inject(UsageAnalyticsService);
  private readonly tauri = inject(TauriService);
  private readonly toast = inject(ToastService);
  private readonly transport = inject(ModelTransportService);

  protected readonly isDesktop = this.tauri.isDesktop;

  /** The scrollable content pane (for anchor scrolling). */
  private readonly contentRef = viewChild<ElementRef<HTMLElement>>('contentRef');

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

  // ── Minimap anchor picker (custom template) ─────────────────────────────

  /** Corner options for the minimap dock position, with display labels. */
  protected readonly minimapAnchors: { value: MinimapAnchor; label: string }[] =
    MINIMAP_ANCHORS.map(anchor => ({
      value: anchor,
      label: anchor.replace('-', ' ').replace(/\b\w/g, c => c.toUpperCase()),
    }));

  // ── Theme mode picker (custom template) ─────────────────────────────────

  /** All theme modes, rendered as swatch cards. */
  protected readonly themeModes: ThemeModeDef[] = THEME_MODE_LIST;

  protected pickTheme(id: ThemeMode): void {
    this.theme.setMode(id);
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

  /** Ollama models installed locally (empty until loaded). */
  protected readonly ollamaModels = signal<string[]>([]);
  /** True while fetching the installed Ollama model list. */
  protected readonly loadingOllamaModels = signal(false);
  /** Whether the Ollama daemon was reachable on the last fetch. */
  protected readonly ollamaRunning = signal(true);
  /** True after the first Ollama fetch completes (controls empty-state UI). */
  protected readonly ollamaFetched = signal(false);
  /** Guards against duplicate auto-fetches within a single dialog session. */
  private ollamaFetchedOnce = false;

  /** LM Studio models available from the local server (empty until loaded). */
  protected readonly lmstudioModels = signal<string[]>([]);
  /** True while fetching the LM Studio model list. */
  protected readonly loadingLmstudioModels = signal(false);
  /** Whether the LM Studio server was reachable on the last fetch. */
  protected readonly lmstudioRunning = signal(true);
  /** True after the first LM Studio fetch completes (controls empty-state UI). */
  protected readonly lmstudioFetched = signal(false);
  /** Guards against duplicate auto-fetches within a single dialog session. */
  private lmstudioFetchedOnce = false;

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
    if (provider === 'ollama') {
      return this.ollamaModels().length > 0 ? this.ollamaModels() : PROVIDER_MODEL_SUGGESTIONS['ollama'];
    }
    if (provider === 'lmstudio') {
      return this.lmstudioModels().length > 0 ? this.lmstudioModels() : PROVIDER_MODEL_SUGGESTIONS['lmstudio'];
    }
    if (LIVE_FETCH_PROVIDERS.has(provider)) {
      return this.liveModels().length > 0 ? this.liveModels() : PROVIDER_MODEL_SUGGESTIONS[provider];
    }
    return PROVIDER_MODEL_SUGGESTIONS[provider] ?? [];
  });

  /**
   * Placeholder text for the model input, per provider. Shown when no model
   * is selected (e.g. when the provider requires a key but none is stored).
   */
  protected readonly modelPlaceholder = computed(() => {
    switch (this.settings.defaultProvider()) {
      case 'anthropic':   return 'claude-sonnet-5';
      case 'openai':      return 'gpt-5-mini';
      case 'gemini':      return 'gemini-3.5-flash';
      case 'openrouter':  return 'anthropic/claude-sonnet-4.5';
      case 'bedrock':     return 'e.g. anthropic.claude-sonnet-4-6-v1';
      case 'ollama':      return 'e.g. llama3.2';
      case 'lmstudio':    return 'e.g. llama-3.2-3b-instruct';
      default:            return 'model id';
    }
  });

  /**
   * Value bound to the model input/dropdown. Returns an empty string (so the
   * placeholder shows) when the selected provider requires an API key but
   * none is stored — the input should not appear pre-filled in that case.
   * Keyless providers (Ollama, Phorma Cloud) and configured providers show the
   * stored model value as normal.
   */
  protected readonly modelDisplayValue = computed(() => {
    const provider = this.settings.defaultProvider();
    if (provider === 'ollama' || provider === 'lmstudio' || provider === 'phorma-cloud') return this.settings.defaultModel();
    if (this.settings.keyConfigured()[provider]) return this.settings.defaultModel();
    return '';
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

  /**
   * When Bedrock is selected but the API key is missing, the model catalog
   * fetch will always fail. This returns the fetch error (if any) so it can
   * be shown as a secondary hint inside the missing-key warning block,
   * rather than as a separate dismissible warning.
   */
  protected readonly bedrockFetchHint = computed<string | null>(() => {
    if (this.settings.defaultProvider() !== 'bedrock') return null;
    if (this.settings.keyConfigured()['bedrock']) return null;
    return this.bedrockFetchError();
  });

  /**
   * Warning shown when the selected provider requires an API key but none is
   * stored. Returns the provider label (for the message) or null when the
   * key is configured, the provider is keyless (Ollama / Phorma Cloud), or
   * Phorma Cloud is showing the subscribe CTA.
   */
  protected readonly missingKeyWarning = computed<string | null>(() => {
    const provider = this.settings.defaultProvider();
    if (provider === 'ollama' || provider === 'lmstudio' || provider === 'phorma-cloud') return null;
    if (this.needsPhormaCloudSubscription()) return null;
    if (this.settings.keyConfigured()[provider]) return null;
    const entry = MODEL_PROVIDERS.find(p => p.id === provider);
    return entry?.label ?? provider;
  });

  /**
   * Whether the chosen default model accepts a `temperature`, which decides if
   * the slider is offered at all. Reads the STORED model rather than
   * {@link modelDisplayValue} (blank while a key is missing) so the answer
   * matches what a run would actually send.
   *
   * The engine is the authority here - `acceptsSamplingParams` is the same
   * function `buildWireRequest` gates on - so the control and the wire body can
   * never disagree about whether the knob does anything.
   */
  protected readonly defaultModelTakesTemperature = computed(() =>
    acceptsSamplingParams(this.settings.defaultModel()),
  );

  /** True while the default-model connectivity probe is in flight. */
  protected readonly testingModel = signal(false);
  /** Result of the last connectivity probe (null before the first run). */
  protected readonly modelTestResult = signal<{ ok: boolean; text: string } | null>(null);

  /**
   * Whether the Test button is actionable: a model id is chosen and, for
   * providers that need one, a key is configured. Phorma Cloud without a
   * subscription shows the subscribe CTA instead.
   */
  protected readonly canTestModel = computed(() => {
    const provider = this.settings.defaultProvider();
    if (this.needsPhormaCloudSubscription()) return false;
    if (!this.modelDisplayValue().trim()) return false;
    if (provider === 'ollama' || provider === 'lmstudio' || provider === 'phorma-cloud') return true;
    return !!this.settings.keyConfigured()[provider];
  });

  /**
   * Sends a one-token call to the configured provider/model and reports the
   * outcome inline. This is the only check that proves the whole chain works:
   * a stored key can be expired or scoped to the wrong account, and a Bedrock
   * geographic inference profile is only invocable from a region inside its
   * geography - both of which a model-catalog fetch happily reports as fine.
   */
  protected async testDefaultModel(): Promise<void> {
    if (this.testingModel() || !this.canTestModel()) return;
    this.testingModel.set(true);
    this.modelTestResult.set(null);
    this.copiedModelTestResult.set(false);
    try {
      const result = await this.transport.testModel({
        provider: this.settings.defaultProvider(),
        model: this.modelDisplayValue(),
      });
      if (result.ok) {
        this.modelTestResult.set({
          ok: true,
          text: `Model answered in ${result.ms} ms${result.reply ? ` ("${result.reply.slice(0, 40)}")` : ''}.`,
        });
      } else {
        this.modelTestResult.set({ ok: false, text: this.testFailureText(result.message) });
      }
    } finally {
      this.testingModel.set(false);
    }
  }

  /** True for a moment after the test message is copied (tick feedback). */
  protected readonly copiedModelTestResult = signal(false);
  private copyResultTimer: ReturnType<typeof setTimeout> | undefined;

  /**
   * Copies the test message. Provider errors are the text most likely to be
   * pasted into a support thread or a search box, and they are long enough that
   * selecting them by hand inside a dialog is awkward.
   */
  protected async copyModelTestResult(): Promise<void> {
    const text = this.modelTestResult()?.text;
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Fallback for insecure contexts where the async clipboard is blocked.
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      try {
        document.execCommand('copy');
      } finally {
        document.body.removeChild(textarea);
      }
    }
    this.copiedModelTestResult.set(true);
    clearTimeout(this.copyResultTimer);
    this.copyResultTimer = setTimeout(() => this.copiedModelTestResult.set(false), 1500);
  }

  /**
   * Turns a raw provider error into something actionable. Bedrock's
   * "model identifier is invalid" is overwhelmingly a region mismatch rather
   * than a typo: a `us.` / `eu.` / `apac.` / `au.` prefixed inference profile
   * only resolves in a region inside that geography, so the same id that works
   * in `ap-southeast-2` is invalid in `us-east-1`.
   */
  private testFailureText(message: string): string {
    if (this.settings.defaultProvider() !== 'bedrock') return message;
    const model = this.modelDisplayValue().trim();
    const geo = /^([a-z]{2,4})\./.exec(model)?.[1];
    if (geo && /model identifier is invalid|ValidationException/i.test(message)) {
      return `${message} - "${geo}." is a geographic inference profile, so it must be invoked from a region inside that geography. Current region: ${this.settings.bedrockRegion()}.`;
    }
    return message;
  }

  /** Deep-links to the API Keys settings page and focuses the input for the
   * currently-selected provider (so the user can paste their key immediately). */
  protected openApiKeys(): void {
    const provider = this.settings.defaultProvider();
    const anchor = `api-key-${provider}`;
    this.dialog.activePageId.set('api-keys');
    this.dialog.anchorId.set(anchor);
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
   * True once a checkout has been started from THIS page, which arms the
   * "Didn't open?" affordance. See {@link CheckoutFallback}.
   */
  protected readonly checkoutAttempted = signal(false);

  /**
   * Starts a real Stripe Checkout Session for the entry plan (requirement 27).
   *
   * This CTA lives in the Models page beside the default-model picker, where
   * there is no room to compare plans, so it buys {@link ENTRY_PLAN_TIER} and
   * pairs with a "See all plans" link to the plan cards on the Cloud page. The
   * hosted Stripe page names the plan and the price before anything is charged,
   * so the fast path hides nothing.
   */
  protected async subscribe(): Promise<void> {
    const lookupKey = subscriptionLookupKey(ENTRY_PLAN_TIER);
    if (!lookupKey) return;
    this.checkoutAttempted.set(true);
    // Only a real hand-off opens the bounded `/api/me` window (requirements 29,
    // 30); a refused or abandoned checkout leaves no timer running.
    if (await this.billing.startCheckout(lookupKey)) this.billingRefresh.watch();
  }

  /** Deep-links to the Cloud settings page, where the plan cards live. */
  protected openCloudPlans(): void {
    this.dialog.activePageId.set('cloud');
  }

  /**
   * Abandons a pending browser sign-in.
   *
   * Nothing needs revoking: the device code simply expires worker-side within its
   * ten-minute window, and it can only ever be redeemed once.
   */
  protected cancelDesktopSignIn(): void {
    this.desktopAuth.cancel();
  }

  /** Opens the Buy Credits pack picker. */
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

  /**
   * Fetches the list of models installed in the local Ollama daemon into
   * {@link ollamaModels}. Runs automatically whenever the dialog is open and
   * Ollama is the default provider. When the daemon is unreachable or has no
   * models installed, the picker falls back to static suggestions and the
   * empty-state UI offers a link to the Ollama model catalog and the setup
   * wizard.
   */
  private async loadOllamaModels(): Promise<void> {
    this.loadingOllamaModels.set(true);
    try {
      const { running, models } = await this.transport.listOllamaModels(this.settings.ollamaBaseUrl());
      this.ollamaRunning.set(running);
      this.ollamaModels.set(models);
    } catch {
      this.ollamaRunning.set(false);
      this.ollamaModels.set([]);
    } finally {
      this.loadingOllamaModels.set(false);
      this.ollamaFetched.set(true);
    }
  }

  /**
   * Deep-links to the General settings page and highlights the Setup wizard
   * setting so the user can install Ollama / pull a model.
   */
  protected openSetupWizardSetting(): void {
    this.dialog.activePageId.set('general');
    this.dialog.anchorId.set('run-setup-wizard');
  }

  /**
   * Fetches the list of models available from the local LM Studio server into
   * {@link lmstudioModels}. Runs automatically whenever the dialog is open and
   * LM Studio is the default provider. When the server is unreachable, the
   * picker falls back to static suggestions.
   */
  private async loadLmstudioModels(): Promise<void> {
    this.loadingLmstudioModels.set(true);
    try {
      const { running, models } = await this.transport.listLmstudioModels(this.settings.lmstudioBaseUrl());
      this.lmstudioRunning.set(running);
      this.lmstudioModels.set(models);
    } catch {
      this.lmstudioRunning.set(false);
      this.lmstudioModels.set([]);
    } finally {
      this.loadingLmstudioModels.set(false);
      this.lmstudioFetched.set(true);
    }
  }

  // ── Integrations (custom template) ──────────────────────────────────────

  /**
   * Presets a user can act on from this page: those exposing secrets, plus
   * OAuth ones.
   *
   * An OAuth preset has an EMPTY `envSchema` (its credential is an
   * interactive session, not a pasted value), so filtering on `envSchema`
   * alone hid it here entirely - and the canvas warning's "Configure in
   * Settings - Integrations" deep-link then landed on a page with no sign of
   * the server it was complaining about. They are listed with a pointer to the
   * node's Connect button, which is where authorizing actually happens.
   * Presets with neither (Filesystem, Memory) still have nothing to configure.
   */
  protected readonly mcpPresets: McpPreset[] = MCP_PRESETS.filter(
    preset => preset.envSchema.length > 0 || preset.authMode === 'oauth',
  );

  protected readonly mcpTransportKind = mcpTransportKind;
  protected readonly mcpTransportLabel = MCP_TRANSPORT_LABEL;
  protected readonly mcpLocalIcon = MCP_LOCAL_ICON;
  protected readonly mcpOauthIcon = MCP_OAUTH_ICON;

  /**
   * Integrations split by where the server runs AND whether a deployed worker
   * can actually authenticate it: Remote (deployable) leads, then Sign-in
   * (OAuth) servers - reachable from the cloud, but the session never leaves
   * this device - then Local. All three are collapsible; a deep-linked card
   * auto-expands its group via {@link integrationGroupOpen}.
   */
  protected readonly integrationGroups: {
    kind: McpTransportKind;
    label: string;
    presets: McpPreset[];
  }[] = (['remote', 'oauth', 'local'] as const)
    .map(kind => ({
      kind,
      label:
        kind === 'remote'
          ? 'Remote MCP servers'
          : kind === 'oauth'
            ? 'Sign-in (OAuth) MCP servers'
            : 'Local MCP servers',
      presets: this.mcpPresets.filter(
        preset => mcpTransportKind(preset.transport, preset.authMode) === kind,
      ),
    }))
    .filter(group => group.presets.length > 0);

  /** Whether each integration group's expander is open. Remote starts open;
   *  a collapsed group auto-opens when a deep-linked card lands in it. */
  protected readonly integrationGroupOpen = signal<Record<McpTransportKind, boolean>>({
    remote: true,
    oauth: true,
    local: true,
  });

  protected onIntegrationGroupToggle(kind: McpTransportKind, event: Event): void {
    const open = (event.target as HTMLDetailsElement | null)?.open ?? false;
    this.integrationGroupOpen.update(current => ({ ...current, [kind]: open }));
  }

  /** Unsaved integration credential inputs, keyed `'{presetId}:{envKey}'`. */
  protected readonly presetDrafts = signal<Record<string, string>>({});

  // ── Cloud provider (custom template) ────────────────────────────────────

  protected readonly cloud = inject(CloudService);
  protected readonly phormaCloud = inject(PhormaCloudService);
  // The browser handoff is the only sign-in a desktop build has, and while it is
  // running the user is looking at a different window. This panel has to say so and
  // offer a way out, or an abandoned attempt looks like a frozen button.
  private readonly desktopAuth = inject(DesktopAuthService);
  protected readonly desktopAuthPending = computed(() => this.desktopAuth.state() === 'pending');
  protected readonly deployConfig = inject(DeployConfigService);
  protected readonly tierLabel = tierLabel;

  /**
   * Whether to render the signed-in account card.
   *
   * The Clerk-or-device-token union, NOT the Clerk user object. It used to be
   * `phormaCloud.user`, and that was a shipped bug: on desktop Clerk never loads a
   * user, so this whole card - plan, quota, Refresh, Sign out, the past-due banner
   * and the plan cards - collapsed into the "Sign in with your Phorma account"
   * note for an account that was already signed in.
   */
  protected readonly accountSignedIn = this.phormaCloud.signedIn;

  /**
   * Display label for the account when no email is known.
   *
   * A brand new account has no tenant row and the handoff may carry no address, so
   * the card needs something to show. Prefers the Clerk user id in a browser build
   * and the device token's subject on desktop; both are the same Clerk user id.
   */
  protected readonly accountId = computed(
    () => this.phormaCloud.user()?.id ?? this.desktopAuth.userId() ?? 'Phorma account',
  );

  /**
   * Selects a Deploy_Target and persists it through
   * {@link SettingsService.cloudProvider}. Typed as `DeployTargetId` so every
   * registered target - including `aws` - is accepted by type as well as at
   * runtime (Requirement 1.4).
   */
  protected pickCloudProvider(choice: DeployTargetId): void {
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

  // ── Deploy runtime (bundled, so a BYO deploy needs no repository clone) ───

  protected readonly deployWorkspace = inject(DeployWorkspaceService);

  /**
   * Unpacks the Cloudflare worker this app ships with, installs its
   * dependencies, and points the runtime folder at it.
   *
   * The service owns the copy, the install and every message; this surface only
   * stores the resulting path, because the folder setting belongs to
   * `CloudService`.
   */
  protected async prepareCloudflareRuntime(): Promise<void> {
    const path = await this.deployWorkspace.prepare('cloud');
    if (path) this.cloud.setCloudFolder(path);
  }

  /** The same, for the AWS CDK application. */
  protected async prepareAwsRuntime(): Promise<void> {
    const path = await this.deployWorkspace.prepare('cloud-aws');
    if (path) this.awsConfig.setCloudAwsDirectory(path);
  }

  // ── Advanced BYO deploy overrides ────────────────────────────────────────
  // All optional. Leaving them blank deploys the committed wrangler.jsonc as-is.

  protected onAccountIdInput(event: Event): void {
    this.deployConfig.setAccountId((event.target as HTMLInputElement | null)?.value ?? '');
  }

  protected onWorkerNameInput(event: Event): void {
    this.deployConfig.setWorkerName((event.target as HTMLInputElement | null)?.value ?? '');
  }

  protected onPortalDomainInput(event: Event): void {
    this.deployConfig.setPortalDomain((event.target as HTMLInputElement | null)?.value ?? '');
  }

  // ── BYO AWS target (custom template) ─────────────────────────────────────
  //
  // The AWS body section is bespoke `<input class="phorma-settings__input">`
  // markup, like every other field in this dialog: `_field.scss`'s `chrome()`
  // mixin is the shared recipe for these hand-rolled controls, and layering it
  // over a `pInputText` would mean overriding a PrimeNG control's font-size,
  // which desynchronizes its height from its neighbours. Every PrimeNG control
  // the section DOES render (the folder picker, the tag buttons and the Plan,
  // Deploy and Doctor controls) carries an explicit `size="small"`
  // (Requirement 1.9).

  protected readonly awsConfig = inject(AwsDeployConfigService);
  protected readonly awsCli = inject(AwsCliService);
  private readonly workflow = inject(WorkflowService);
  private readonly connectionStore = inject(ConnectionStoreService);

  /**
   * Per-instance prefix for every `id` in the AWS section.
   *
   * Two instances of a panel body are routinely in the DOM at once in this app,
   * and a spec can mount two fixtures in one browser, so a static `id` would
   * duplicate and break every `<label for>` association. One counter keeps the
   * prefix unique per component instance.
   */
  private static awsInstanceCount = 0;
  private readonly awsScope = `aws-${(SettingsDialog.awsInstanceCount += 1)}`;

  /** Scoped element id for one AWS field, e.g. `aws-1-accountId`. */
  protected awsFieldId(field: string): string {
    return `${this.awsScope}-${field}`;
  }

  /**
   * The aggregate line the form shows while the configuration is incomplete
   * (Requirement 2.5).
   *
   * Reads `invalidFieldCount` rather than counting again: the store enumerates
   * field validity exactly once, so the count and the aggregate validity can
   * never disagree.
   */
  protected readonly awsInvalidFieldsLabel = computed(() => {
    const count = this.awsConfig.invalidFieldCount();
    return count === 1 ? '1 field needs attention' : `${count} fields need attention`;
  });

  /** Which container image path a deploy will take (Requirement 4.7). */
  protected readonly awsImageNotice = computed(() =>
    this.awsConfig.imageUri()
      ? 'The deploy will reference this image and run no local image build.'
      : 'The deploy builds the container image from the runtime folder and needs a running Docker daemon.',
  );

  /** True while either discovered endpoint is absent (Requirement 9.6). */
  protected readonly awsEndpointsIncomplete = computed(
    () => !this.awsConfig.triggerApiUrl() || !this.awsConfig.monitorApiUrl(),
  );

  /**
   * Plan, Deploy and Doctor are disabled in browser preview (Requirement 1.8),
   * while a command is in flight, and while the aggregate validity is false
   * (Requirement 2.5). The fields stay editable in all three states so an
   * operator can prepare a configuration in the browser and deploy later.
   */
  protected readonly awsControlsDisabled = computed(
    () => !this.isDesktop || this.awsCli.running() || !this.awsConfig.valid(),
  );

  /**
   * Subnet ids as the comma-separated text the operator edits.
   *
   * A local draft rather than a `join()` of the stored array: the store
   * normalizes on every write, so binding the joined value straight back would
   * rewrite the input mid-keystroke and jump the caret.
   */
  protected readonly awsSubnetIdsText = signal('');

  protected onAwsSubnetIdsInput(event: Event): void {
    const raw = (event.target as HTMLInputElement | null)?.value ?? '';
    this.awsSubnetIdsText.set(raw);
    this.awsConfig.setSubnetIds(raw.split(','));
  }

  /**
   * Cost-allocation tags as editable rows, held locally for the same reason as
   * {@link awsSubnetIdsText}: the store holds a `Record`, and rebuilding the
   * rows from it on every keystroke would collapse two rows the moment their
   * keys briefly matched.
   */
  protected readonly awsTagRows = signal<{ key: string; value: string }[]>([]);

  protected onAwsTagKeyInput(index: number, event: Event): void {
    const key = (event.target as HTMLInputElement | null)?.value ?? '';
    this.awsTagRows.update(rows => rows.map((row, i) => (i === index ? { ...row, key } : row)));
    this.syncAwsTagSet();
  }

  protected onAwsTagValueInput(index: number, event: Event): void {
    const value = (event.target as HTMLInputElement | null)?.value ?? '';
    this.awsTagRows.update(rows => rows.map((row, i) => (i === index ? { ...row, value } : row)));
    this.syncAwsTagSet();
  }

  protected addAwsTagRow(): void {
    this.awsTagRows.update(rows => [...rows, { key: '', value: '' }]);
  }

  protected removeAwsTagRow(index: number): void {
    this.awsTagRows.update(rows => rows.filter((_, i) => i !== index));
    this.syncAwsTagSet();
  }

  /** Writes the editable rows back as the stored tag record, trimmed. */
  private syncAwsTagSet(): void {
    const tags: Record<string, string> = {};
    for (const row of this.awsTagRows()) {
      const key = row.key.trim();
      if (key) tags[key] = row.value.trim();
    }
    this.awsConfig.setTagSet(tags);
  }

  protected onAwsAccountIdInput(event: Event): void {
    this.awsConfig.setAccountId((event.target as HTMLInputElement | null)?.value ?? '');
  }

  protected onAwsRegionInput(event: Event): void {
    this.awsConfig.setRegion((event.target as HTMLInputElement | null)?.value ?? '');
  }

  protected onAwsNamePrefixInput(event: Event): void {
    this.awsConfig.setNamePrefix((event.target as HTMLInputElement | null)?.value ?? '');
  }

  protected onAwsPermissionsBoundaryArnInput(event: Event): void {
    this.awsConfig.setPermissionsBoundaryArn(
      (event.target as HTMLInputElement | null)?.value ?? '',
    );
  }

  protected onAwsBootstrapQualifierInput(event: Event): void {
    this.awsConfig.setBootstrapQualifier((event.target as HTMLInputElement | null)?.value ?? '');
  }

  protected onAwsVpcIdInput(event: Event): void {
    this.awsConfig.setVpcId((event.target as HTMLInputElement | null)?.value ?? '');
  }

  protected onAwsAppCmkArnInput(event: Event): void {
    this.awsConfig.setAppCmkArn((event.target as HTMLInputElement | null)?.value ?? '');
  }

  protected onAwsNotificationTargetArnInput(event: Event): void {
    this.awsConfig.setNotificationTargetArn((event.target as HTMLInputElement | null)?.value ?? '');
  }

  protected onAwsRetentionDaysInput(event: Event): void {
    const raw = ((event.target as HTMLInputElement | null)?.value ?? '').trim();
    // An empty or non-numeric entry is stored as NaN so the validator reports it
    // rather than silently substituting the 30-day default.
    this.awsConfig.setRetentionDays(raw === '' ? Number.NaN : Number(raw));
  }

  protected onAwsImageUriInput(event: Event): void {
    this.awsConfig.setImageUri((event.target as HTMLInputElement | null)?.value ?? '');
  }

  protected onAwsDirectoryInput(event: Event): void {
    this.awsConfig.setCloudAwsDirectory((event.target as HTMLInputElement | null)?.value ?? '');
  }

  /** Picks the `cloud-aws/` folder with the native dialog (desktop only). */
  protected async pickAwsDirectory(): Promise<void> {
    try {
      const folder = await this.tauri.selectFolderDialog('Select the runtime folder');
      if (folder) this.awsConfig.setCloudAwsDirectory(folder);
    } catch (error) {
      this.toast.error(
        'Folder picker unavailable',
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  /**
   * Runs the `plan` verb. The Deploy_Config_File is rewritten first so the CLI
   * reads what the form currently holds (Requirement 3.6).
   */
  protected async runAwsPlan(): Promise<void> {
    if (!(await this.writeAwsConfigFile())) return;
    const cwd = this.awsConfig.cloudAwsDirectory();
    const command = DEPLOY_TARGETS['aws'].planCommand?.({
      cloudFolder: cwd,
      workflowId: '',
      baseUrl: '',
    });
    if (command) await this.awsCli.runCommand(command);
  }

  /**
   * Rewrites the Deploy_Config_File and hands off to
   * `AwsCliService.planAndDeploy`, which owns the plan-then-confirm-then-deploy
   * ordering. This surface adds no second ordering rule.
   */
  protected async runAwsDeploy(): Promise<void> {
    if (!(await this.writeAwsConfigFile())) return;
    const cwd = this.awsConfig.cloudAwsDirectory();
    await this.awsCli.planAndDeploy(
      cwd,
      await this.awsCdkEntryExists(cwd),
      await this.awsEgressAllowList(),
    );
  }

  /** Runs the `doctor` verb. Needs no config rewrite - it reads the file. */
  protected async runAwsDoctor(): Promise<void> {
    const command: DeployCommand = {
      program: 'npx',
      args: ['phorma-aws', 'doctor'],
      cwd: this.awsConfig.cloudAwsDirectory(),
    };
    await this.awsCli.runCommand(command);
  }

  private async writeAwsConfigFile(): Promise<boolean> {
    const written = await this.awsConfig.writeConfigFile();
    if (!written) {
      this.toast.error(
        'Could not write the deploy configuration',
        `The Studio writes ${AWS_CONFIG_FILENAME} into the cloud-aws folder before ` +
          'running the CLI. Check the path.',
      );
    }
    return written;
  }

  /**
   * Whether the configured directory holds a CDK entry point. `AwsCliService`
   * takes this as an argument so filesystem access stays with the caller.
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

  // ── Any other worker secret ──────────────────────────────────────────────
  // The fixed list above covers the provider keys, and used to be the ONLY
  // input: a `CONN_*`, `MCP_*` or `KEY_ENC_SECRET` value could not be set from
  // the studio at all, which turned a validation error into a dead end.

  protected readonly customSecretName = signal('');
  protected readonly customSecretValue = signal('');

  /** The shape `wrangler secret put` (and `putWorkerSecret`) accepts. */
  protected readonly customSecretReady = computed(
    () => /^[A-Z][A-Z0-9_]*$/.test(this.customSecretName().trim()) && this.customSecretValue().trim().length > 0,
  );

  protected onCustomSecretNameInput(event: Event): void {
    this.customSecretName.set((event.target as HTMLInputElement | null)?.value ?? '');
  }

  protected onCustomSecretValueInput(event: Event): void {
    this.customSecretValue.set((event.target as HTMLInputElement | null)?.value ?? '');
  }

  protected async saveCustomWorkerSecret(): Promise<void> {
    if (!this.customSecretReady()) return;
    await this.cloud.putWorkerSecret(this.customSecretName().trim(), this.customSecretValue());
    this.customSecretValue.set('');
    this.customSecretName.set('');
  }

  constructor() {
    // Seed the two AWS fields that are edited as text but stored as structures.
    // Done here rather than in an `effect()` on purpose: an effect that read the
    // store and wrote the draft, while every keystroke writes the store from the
    // draft, is the read-and-write-the-same-signal loop that has already OOM'd
    // this dialog once.
    this.awsSubnetIdsText.set(this.awsConfig.subnetIds().join(', '));
    const tagRows = Object.entries(this.awsConfig.tagSet()).map(([key, value]) => ({ key, value }));
    this.awsTagRows.set(tagRows.length > 0 ? tagRows : [{ key: '', value: '' }]);

    // Usage page (EPIC 2): refresh the ledgers when the page is opened.
    effect(() => {
      if (!this.dialog.visible() || this.dialog.activePageId() !== 'usage') return;
      untracked(() => void this.usageAnalytics.refresh());
    });

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

    // Scroll to a specific anchor (e.g. an integration card) after the dialog
    // opens. The anchor id is set by `SettingsDialogService.open()` and cleared
    // after consumption. Deferred to the next microtask + rAF so the dialog's
    // DOM has rendered before we try to scroll.
    effect(() => {
      const visible = this.dialog.visible();
      const anchor = this.dialog.anchorId();
      if (!visible || !anchor) return;
      untracked(() => {
        queueMicrotask(() => {
          requestAnimationFrame(() => {
            const container = this.contentRef()?.nativeElement;
            if (!container) return;
            const target = container.querySelector(`#${CSS.escape(anchor)}`);
            if (target instanceof HTMLElement) {
              // A card inside a collapsed expander is display:none, so expand
              // its group first or scrollIntoView has nothing to reach.
              const details = target.closest('details');
              if (details instanceof HTMLDetailsElement && !details.open) details.open = true;
              target.scrollIntoView({ behavior: 'smooth', block: 'center' });
              // Briefly flash the card so the user notices it.
              target.classList.add('phorma-settings__integration--highlight');
              setTimeout(() => target.classList.remove('phorma-settings__integration--highlight'), 2000);
              // If the target is an input, focus it so the user can type immediately.
              if (target instanceof HTMLInputElement) {
                target.focus();
              }
            }
            this.dialog.anchorId.set(null);
          });
        });
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

    // A connectivity result only describes the exact provider/model/region it
    // ran against, so any change to those three invalidates it. Region is why
    // this is an effect rather than a reset inside the change handlers: it is
    // written by the generic registry descriptor, which has no hook here.
    effect(() => {
      this.settings.defaultProvider();
      this.settings.defaultModel();
      this.settings.bedrockRegion();
      untracked(() => this.modelTestResult.set(null));
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

    // Auto-fetch the installed Ollama model list whenever the dialog is open
    // with Ollama as the default provider. Runs once per dialog session so
    // a pull started from the setup wizard is picked up on the next open.
    effect(() => {
      if (!this.dialog.visible()) return;
      if (this.settings.defaultProvider() !== 'ollama') return;
      if (this.ollamaFetchedOnce) return;
      this.ollamaFetchedOnce = true;
      untracked(() => void this.loadOllamaModels());
    });

    // Auto-fetch the LM Studio model list whenever the dialog is open with
    // LM Studio as the default provider. Runs once per dialog session.
    effect(() => {
      if (!this.dialog.visible()) return;
      if (this.settings.defaultProvider() !== 'lmstudio') return;
      if (this.lmstudioFetchedOnce) return;
      this.lmstudioFetchedOnce = true;
      untracked(() => void this.loadLmstudioModels());
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
