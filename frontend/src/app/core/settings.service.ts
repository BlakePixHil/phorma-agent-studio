import { Injectable, inject, signal } from '@angular/core';

import type { ModelProviderId } from './workflow.model';
import { TauriService } from './tauri.service';
import { loadLayout, saveLayout } from './layout-storage';

const BROWSER_KEYS_STORAGE = 'phorma.provider-keys';
const BROWSER_MCP_SECRETS_STORAGE = 'phorma.mcp-secrets';

/**
 * Provider credentials + model-transport settings.
 *
 * Desktop: keys live in the OS keychain via the Rust backend — they never
 * enter the webview; only a "key exists" flag comes back.
 * Browser preview: keys fall back to localStorage so web-mode debugging still
 * works. The Settings dialog labels this mode clearly.
 */
@Injectable({ providedIn: 'root' })
export class SettingsService {
  private readonly tauri = inject(TauriService);

  /** Ollama server base URL (local models need no key). */
  readonly ollamaBaseUrl = signal(loadLayout('ollamaBaseUrl', 'http://localhost:11434'));

  /** provider id → whether a key is configured (for Settings UI badges). */
  readonly keyConfigured = signal<Partial<Record<ModelProviderId, boolean>>>({});

  /** `'{nodeId}:{envKey}' → whether an MCP secret is configured. */
  readonly mcpSecretsConfigured = signal<Record<string, boolean>>({});

  constructor() {
    void this.refreshKeyFlags();
  }

  setOllamaBaseUrl(url: string): void {
    this.ollamaBaseUrl.set(url.trim() || 'http://localhost:11434');
    saveLayout('ollamaBaseUrl', this.ollamaBaseUrl());
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

  /** The keychain id for a node-scoped MCP env var. */
  private mcpSecretKey(nodeId: string, envKey: string): string {
    return `mcp:${nodeId}:${envKey}`;
  }

  /** Stores (or clears, when empty) an MCP server env var in the keychain. */
  async setMcpSecret(nodeId: string, envKey: string, value: string): Promise<void> {
    if (this.tauri.isDesktop) {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('set_secret', { key: this.mcpSecretKey(nodeId, envKey), value });
    } else {
      const secrets = this.browserMcpSecrets();
      if (value.trim()) secrets[this.mcpSecretKey(nodeId, envKey)] = value.trim();
      else delete secrets[this.mcpSecretKey(nodeId, envKey)];
      localStorage.setItem(BROWSER_MCP_SECRETS_STORAGE, JSON.stringify(secrets));
    }
    await this.refreshMcpSecretFlags(nodeId, [envKey]);
  }

  /** Clears an MCP server env var from the keychain. */
  async clearMcpSecret(nodeId: string, envKey: string): Promise<void> {
    await this.setMcpSecret(nodeId, envKey, '');
  }

  /**
   * Refreshes the `mcpSecretsConfigured` flags for a node's env vars.
   * Call this when the selected node changes so the properties panel shows
   * accurate configured badges.
   */
  async refreshMcpSecretFlags(nodeId: string, envKeys: string[]): Promise<void> {
    const next = { ...this.mcpSecretsConfigured() };
    if (this.tauri.isDesktop) {
      const { invoke } = await import('@tauri-apps/api/core');
      for (const envKey of envKeys) {
        try {
          next[`${nodeId}:${envKey}`] = await invoke<boolean>('has_secret', {
            key: this.mcpSecretKey(nodeId, envKey),
          });
        } catch {
          next[`${nodeId}:${envKey}`] = false;
        }
      }
    } else {
      const secrets = this.browserMcpSecrets();
      for (const envKey of envKeys) {
        next[`${nodeId}:${envKey}`] = !!secrets[this.mcpSecretKey(nodeId, envKey)];
      }
    }
    this.mcpSecretsConfigured.set(next);
  }

  /** Browser-mode MCP secret lookup (desktop secrets never reach the webview). */
  browserMcpSecret(nodeId: string, envKey: string): string | null {
    return this.browserMcpSecrets()[this.mcpSecretKey(nodeId, envKey)] ?? null;
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
    const providers: ModelProviderId[] = ['anthropic', 'openai', 'gemini', 'openrouter'];
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
