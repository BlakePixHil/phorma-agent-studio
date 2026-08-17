import { Injectable, computed, effect, inject, signal } from '@angular/core';

import {
  DEFAULT_BEDROCK_REGION,
  PROVIDER_MODEL_SUGGESTIONS,
  type ModelProviderId,
} from './workflow.model';
import { TauriService } from './tauri.service';
import { loadLayout, saveLayout } from './layout-storage';

const BROWSER_KEYS_STORAGE = 'phorma.provider-keys';
const BROWSER_MCP_SECRETS_STORAGE = 'phorma.mcp-secrets';

/**
 * Where deployed workflows run:
 *  - `'phorma'` — Phorma Cloud, the managed offering (subscription).
 *  - `'cloudflare'` — the user's own Cloudflare account (free, technical).
 *  - `'aws'` — the user's own AWS account (ECS Fargate).
 *  - `null` — not chosen yet; deploy actions redirect to Settings → Cloud.
 */
export type CloudProviderChoice = 'phorma' | 'cloudflare' | 'aws' | null;

/**
 * Scope for MCP secrets: node-scoped values override preset-scoped
 * application defaults (Settings → Integrations).
 */
export type McpSecretScope = { node: string } | { preset: string };

/**
 * Application settings + provider credentials.
 *
 * Non-sensitive settings are reactive signals persisted through
 * `layout-storage` (localStorage). Sensitive values (API keys, MCP secrets)
 * live in the OS keychain via the Rust backend on desktop — they never enter
 * the webview; only "configured" flags come back. Browser preview falls back
 * to localStorage so web-mode debugging still works; the Settings dialog
 * labels this mode clearly.
 */
@Injectable({ providedIn: 'root' })
export class SettingsService {
  private readonly tauri = inject(TauriService);

  // ── Models ──────────────────────────────────────────────────────────────

  /** Ollama server base URL (local models need no key). */
  readonly ollamaBaseUrl = signal(loadLayout('ollamaBaseUrl', 'http://localhost:11434'));

  /** LM Studio server base URL (local models need no key). */
  readonly lmstudioBaseUrl = signal(loadLayout('lmstudioBaseUrl', 'http://localhost:1234'));

  /**
   * Default AWS region for Amazon Bedrock. Agents may override this per node,
   * so workflows can mix models hosted in different regions. The Bedrock API
   * key is stored separately like every other provider credential.
   */
  readonly bedrockRegion = signal(loadLayout('bedrockRegion', DEFAULT_BEDROCK_REGION));

  /**
   * Application default model. Agent nodes without an explicit provider/model
   * inherit this at run/deploy time. Ollama is the zero-key default so a
   * fresh install can run without provider setup.
   */
  readonly defaultProvider = signal<ModelProviderId>(
    loadLayout<ModelProviderId>('defaultProvider', 'ollama'),
  );
  readonly defaultModel = signal(loadLayout('defaultModel', 'llama3.2'));

  /** Default sampling temperature applied to inheriting agents. */
  readonly defaultTemperature = signal(loadLayout('defaultTemperature', 0.7));

  /** Resolved app default as a single object (for run options / display). */
  readonly resolvedDefaultModel = computed(() => ({
    provider: this.defaultProvider(),
    model: this.defaultModel(),
  }));

  // ── Execution ───────────────────────────────────────────────────────────

  /** Open the console dock automatically when a run starts. */
  readonly autoOpenConsoleOnRun = signal(loadLayout('autoOpenConsoleOnRun', true));

  /** Maximum tool-call rounds per agent turn (engine loop budget). */
  readonly maxToolRounds = signal(loadLayout('maxToolRounds', 8));

  // ── Workflows ───────────────────────────────────────────────────────────

  /** Autosave named workflows shortly after each edit. */
  readonly autosaveEnabled = signal(loadLayout('autosaveEnabled', false));

  /** Ask for confirmation before deleting a workflow from the library. */
  readonly confirmWorkflowDelete = signal(loadLayout('confirmWorkflowDelete', true));

  // ── Canvas ──────────────────────────────────────────────────────────────

  /** Mouse-wheel zoom sensitivity multiplier (0.25–3). */
  readonly zoomSensitivity = signal(loadLayout('zoomSensitivity', 1));

  // ── Updates ─────────────────────────────────────────────────────────────

  /** Download and stage app updates automatically in the background. */
  readonly autoUpdate = signal(loadLayout('autoUpdate', true));

  /** Grid spacing (canvas px) used when grid snapping is enabled. */
  readonly gridSnapSize = signal(loadLayout('gridSnapSize', 24));

  // ── Cloud ───────────────────────────────────────────────────────────────

  /**
   * Chosen cloud deploy target. Null until the user explicitly picks one in
   * Settings → Cloud — deploy entry points redirect there while unset.
   */
  readonly cloudProvider = signal<CloudProviderChoice>(
    loadLayout<CloudProviderChoice>('cloudProvider', null),
  );

  // ── Credential flags ────────────────────────────────────────────────────

  /** provider id → whether a key is configured (for Settings UI badges). */
  readonly keyConfigured = signal<Partial<Record<ModelProviderId, boolean>>>({});

  /**
   * `'{nodeId}:{envKey}'` or `'preset:{presetId}:{envKey}'` → whether an MCP
   * secret is configured.
   */
  readonly mcpSecretsConfigured = signal<Record<string, boolean>>({});

  constructor() {
    void this.refreshKeyFlags();
    // Persist the plain-value settings whenever they change.
    effect(() => saveLayout('defaultProvider', this.defaultProvider()));
    effect(() => saveLayout('defaultModel', this.defaultModel()));
    effect(() => saveLayout('defaultTemperature', this.defaultTemperature()));
    effect(() => saveLayout('autoOpenConsoleOnRun', this.autoOpenConsoleOnRun()));
    effect(() => saveLayout('maxToolRounds', this.maxToolRounds()));
    effect(() => saveLayout('autosaveEnabled', this.autosaveEnabled()));
    effect(() => saveLayout('confirmWorkflowDelete', this.confirmWorkflowDelete()));
    effect(() => saveLayout('zoomSensitivity', this.zoomSensitivity()));
    effect(() => saveLayout('gridSnapSize', this.gridSnapSize()));
    effect(() => saveLayout('autoUpdate', this.autoUpdate()));
    effect(() => saveLayout('cloudProvider', this.cloudProvider()));
  }

  setOllamaBaseUrl(url: string): void {
    this.ollamaBaseUrl.set(url.trim() || 'http://localhost:11434');
    saveLayout('ollamaBaseUrl', this.ollamaBaseUrl());
  }

  setLmstudioBaseUrl(url: string): void {
    this.lmstudioBaseUrl.set(url.trim() || 'http://localhost:1234');
    saveLayout('lmstudioBaseUrl', this.lmstudioBaseUrl());
  }

  setBedrockRegion(region: string): void {
    this.bedrockRegion.set(region.trim() || DEFAULT_BEDROCK_REGION);
    saveLayout('bedrockRegion', this.bedrockRegion());
  }

  /** Sets the app default provider, resetting the model to its first suggestion. */
  setDefaultProvider(provider: ModelProviderId): void {
    if (this.defaultProvider() === provider) return;
    this.defaultProvider.set(provider);
    this.defaultModel.set(PROVIDER_MODEL_SUGGESTIONS[provider][0] ?? '');
  }

  /** Stores (or clears, when empty) a provider API key. */
  async setProviderKey(provider: ModelProviderId, key: string): Promise<void> {
    if (this.tauri.isDesktop) {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('set_provider_key', { provider, key });
    } else {
      const keys = this.browserKeys();
      if (key.trim()) keys[provider] = key.trim();
      else delete keys[provider];
      localStorage.setItem(BROWSER_KEYS_STORAGE, JSON.stringify(keys));
    }
    await this.refreshKeyFlags();
  }

  /** Browser-mode key lookup (desktop keys never reach the webview). */
  browserKey(provider: ModelProviderId): string | null {
    return this.browserKeys()[provider] ?? null;
  }

  // ── MCP secrets ────────────────────────────────────────────────────────────

  /**
   * The keychain id for an MCP env var. Node scope: `mcp:{nodeId}:{envKey}`;
   * preset scope (application default): `mcp:preset:{presetId}:{envKey}`.
   * Both pass the Rust backend's `mcp:` prefix validation. The Rust side
   * (`mcp.rs`) resolves node scope first, then falls back to preset scope.
   */
  private mcpSecretKey(scope: McpSecretScope, envKey: string): string {
    return 'node' in scope
      ? `mcp:${scope.node}:${envKey}`
      : `mcp:preset:${scope.preset}:${envKey}`;
  }

  /** The `mcpSecretsConfigured` flag key for a scope + env var. */
  private mcpFlagKey(scope: McpSecretScope, envKey: string): string {
    return 'node' in scope ? `${scope.node}:${envKey}` : `preset:${scope.preset}:${envKey}`;
  }

  /** Stores (or clears, when empty) an MCP env var in the keychain. */
  async setMcpSecretScoped(scope: McpSecretScope, envKey: string, value: string): Promise<void> {
    if (this.tauri.isDesktop) {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('set_secret', { key: this.mcpSecretKey(scope, envKey), value });
    } else {
      const secrets = this.browserMcpSecrets();
      if (value.trim()) secrets[this.mcpSecretKey(scope, envKey)] = value.trim();
      else delete secrets[this.mcpSecretKey(scope, envKey)];
      localStorage.setItem(BROWSER_MCP_SECRETS_STORAGE, JSON.stringify(secrets));
    }
    await this.refreshMcpSecretFlagsScoped(scope, [envKey]);
  }

  /** Stores (or clears, when empty) a node-scoped MCP env var. */
  async setMcpSecret(nodeId: string, envKey: string, value: string): Promise<void> {
    await this.setMcpSecretScoped({ node: nodeId }, envKey, value);
  }

  /** Stores (or clears) a preset-scoped (application default) MCP env var. */
  async setPresetSecret(presetId: string, envKey: string, value: string): Promise<void> {
    await this.setMcpSecretScoped({ preset: presetId }, envKey, value);
  }

  /** Clears a node-scoped MCP env var from the keychain. */
  async clearMcpSecret(nodeId: string, envKey: string): Promise<void> {
    await this.setMcpSecret(nodeId, envKey, '');
  }

  /** Whether one scope's env var currently has a stored value. */
  private async hasMcpSecret(scope: McpSecretScope, envKey: string): Promise<boolean> {
    if (!this.tauri.isDesktop) {
      return !!this.browserMcpSecrets()[this.mcpSecretKey(scope, envKey)];
    }
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      return await invoke<boolean>('has_secret', { key: this.mcpSecretKey(scope, envKey) });
    } catch {
      return false;
    }
  }

  /**
   * Refreshes the `mcpSecretsConfigured` flags for a scope's env vars.
   * Call when the selected node changes (node scope) or when the Settings
   * Integrations page opens (preset scope) so configured badges are accurate.
   *
   * Writes only the keys it resolved, via `update`. Several of these run
   * concurrently by design (the canvas fires node scope + preset scope for
   * every MCP node in one pass), and each awaits its own keychain round-trips
   * - so cloning the map up front and `set`ting it at the end would let the
   * last one to finish silently discard every flag the others had resolved.
   */
  async refreshMcpSecretFlagsScoped(scope: McpSecretScope, envKeys: string[]): Promise<void> {
    const resolved: Record<string, boolean> = {};
    for (const envKey of envKeys) {
      resolved[this.mcpFlagKey(scope, envKey)] = await this.hasMcpSecret(scope, envKey);
    }
    this.mcpSecretsConfigured.update(current => ({ ...current, ...resolved }));
  }

  /** Refreshes node-scoped configured flags (properties panel badges). */
  async refreshMcpSecretFlags(nodeId: string, envKeys: string[]): Promise<void> {
    await this.refreshMcpSecretFlagsScoped({ node: nodeId }, envKeys);
  }

  /** Refreshes preset-scoped configured flags (Settings → Integrations). */
  async refreshPresetSecretFlags(presetId: string, envKeys: string[]): Promise<void> {
    await this.refreshMcpSecretFlagsScoped({ preset: presetId }, envKeys);
  }

  /**
   * Browser-mode MCP secret lookup (desktop secrets never reach the webview).
   * Node-scoped value wins; falls back to the preset-scoped app default.
   */
  browserMcpSecret(nodeId: string, envKey: string, presetId?: string): string | null {
    const secrets = this.browserMcpSecrets();
    const nodeValue = secrets[this.mcpSecretKey({ node: nodeId }, envKey)];
    if (nodeValue) return nodeValue;
    if (presetId) return secrets[this.mcpSecretKey({ preset: presetId }, envKey)] ?? null;
    return null;
  }

  /**
   * Resolves the bearer token for a REMOTE (`sse`) MCP node. On desktop the
   * value lives in the OS keychain, so we go through the narrow
   * `get_mcp_bearer` command (which returns ONLY this one secret); in the
   * browser it comes from the same localStorage path as other MCP secrets.
   * Returns `null` when nothing is stored.
   */
  async resolveMcpBearer(nodeId: string, authKey: string, presetId?: string): Promise<string | null> {
    if (this.tauri.isDesktop) {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const token = await invoke<string | null>('get_mcp_bearer', {
          serverId: nodeId,
          authKey,
          presetId: presetId ?? null,
        });
        return token && token.trim() ? token : null;
      } catch {
        return null;
      }
    }
    return this.browserMcpSecret(nodeId, authKey, presetId);
  }

  private browserMcpSecrets(): Record<string, string> {
    try {
      return JSON.parse(localStorage.getItem(BROWSER_MCP_SECRETS_STORAGE) ?? '{}') as Record<
        string,
        string
      >;
    } catch {
      return {};
    }
  }

  private async refreshKeyFlags(): Promise<void> {
    const flags: Partial<Record<ModelProviderId, boolean>> = {};
    const providers: ModelProviderId[] = ['anthropic', 'openai', 'gemini', 'openrouter', 'bedrock'];
    if (this.tauri.isDesktop) {
      const { invoke } = await import('@tauri-apps/api/core');
      for (const provider of providers) {
        try {
          flags[provider] = await invoke<boolean>('has_provider_key', { provider });
        } catch {
          flags[provider] = false;
        }
      }
    } else {
      const keys = this.browserKeys();
      for (const provider of providers) flags[provider] = !!keys[provider];
    }
    this.keyConfigured.set(flags);
  }

  private browserKeys(): Partial<Record<ModelProviderId, string>> {
    try {
      return JSON.parse(localStorage.getItem(BROWSER_KEYS_STORAGE) ?? '{}') as Partial<
        Record<ModelProviderId, string>
      >;
    } catch {
      return {};
    }
  }
}
