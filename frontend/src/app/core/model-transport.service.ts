import { Injectable, inject } from '@angular/core';

import {
  FetchModelClient,
  ModelRequestError,
  buildWireRequest,
  createStreamParser,
  providerRequiresKey,
  type ModelChunk,
  type ModelClient,
  type ModelRequest,
} from '@phorma/engine';

import { PHORMA_CLOUD_DEFAULT_URL } from './cloud.service';
import { loadLayout } from './layout-storage';
import { PhormaCloudService } from './phorma-cloud.service';
import { SettingsService } from './settings.service';
import { TauriService } from './tauri.service';

/**
 * Chooses the model transport for local runs:
 *  - Desktop: {@link TauriModelClient} — the engine-built request goes to the
 *    Rust proxy, which injects the key from the OS keychain and streams the
 *    raw response lines back as events. No CORS, no keys in the webview.
 *  - Browser preview: the engine's own {@link FetchModelClient} with keys
 *    from localStorage (Ollama needs none and is the recommended web-mode
 *    provider).
 *
 * The returned client is a composite: `phorma-cloud` requests are intercepted
 * and routed through the Phorma Cloud /api/infer proxy (billed against the
 * tenant's subscription credits); all other providers use the BYO path above.
 */
@Injectable({ providedIn: 'root' })
export class ModelTransportService {
  private readonly tauri = inject(TauriService);
  private readonly settings = inject(SettingsService);
  private readonly phormaCloud = inject(PhormaCloudService);

  /** The ModelClient local runs should use. */
  create(): ModelClient {
    const byoClient = this.tauri.isDesktop
      ? new TauriModelClient()
      : new FetchModelClient(async provider =>
          providerRequiresKey(provider) ? this.settings.browserKey(provider) : null,
        );
    // Read phormaCloudUrl directly from localStorage (not CloudService) to
    // avoid a circular DI: RunControllerService → ModelTransportService →
    // CloudService → RunControllerService. The value rarely changes and is
    // re-read on every create() call, so it stays current enough.
    const cloudBaseUrl = loadLayout('phormaCloudUrl', PHORMA_CLOUD_DEFAULT_URL);
    return new CompositeModelClient(byoClient, this.phormaCloud, cloudBaseUrl);
  }

  /**
   * Lists model ids available on Amazon Bedrock's `bedrock-mantle` endpoint
   * for a region, using the stored Bedrock API key. Desktop goes through the
   * Rust proxy (key stays in the keychain, no CORS); browser preview fetches
   * directly with the localStorage key (subject to CORS).
   */
  async listBedrockModels(region: string): Promise<string[]> {
    const trimmed = region.trim();
    if (!trimmed) throw new Error('Choose an AWS region first.');

    if (this.tauri.isDesktop) {
      const { invoke } = await import('@tauri-apps/api/core');
      return invoke<string[]>('list_bedrock_models', { region: trimmed });
    }

    const key = this.settings.browserKey('bedrock');
    if (!key) throw new Error('No Bedrock API key configured. Add one in Settings → API Keys.');
    const response = await fetch(`https://bedrock-mantle.${trimmed}.api.aws/v1/models`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`Bedrock models request failed (${response.status}): ${detail.slice(0, 300)}`);
    }
    const body = (await response.json()) as { data?: { id?: string }[] };
    return (body.data ?? [])
      .map(model => model.id)
      .filter((id): id is string => !!id)
      .sort();
  }

  /**
   * Lists system-defined Bedrock inference profile ids for a region (e.g.
   * `au.anthropic.claude-opus-4-7`) via the control-plane endpoint. Desktop
   * goes through the Rust proxy; browser preview fetches directly (CORS
   * permitting). These are merged into the Bedrock model picker.
   */
  async listBedrockInferenceProfiles(region: string): Promise<string[]> {
    const trimmed = region.trim();
    if (!trimmed) throw new Error('Choose an AWS region first.');

    if (this.tauri.isDesktop) {
      const { invoke } = await import('@tauri-apps/api/core');
      return invoke<string[]>('list_bedrock_inference_profiles', { region: trimmed });
    }

    const key = this.settings.browserKey('bedrock');
    if (!key) throw new Error('No Bedrock API key configured. Add one in Settings → API Keys.');
    const response = await fetch(
      `https://bedrock.${trimmed}.amazonaws.com/inference-profiles?typeEquals=SYSTEM_DEFINED&maxResults=1000`,
      { headers: { Authorization: `Bearer ${key}` } },
    );
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(
        `Bedrock inference-profiles request failed (${response.status}): ${detail.slice(0, 300)}`,
      );
    }
    const body = (await response.json()) as {
      inferenceProfileSummaries?: { inferenceProfileId?: string }[];
    };
    return (body.inferenceProfileSummaries ?? [])
      .map(profile => profile.inferenceProfileId)
      .filter((id): id is string => !!id)
      .sort();
  }

  /**
   * Lists model ids available for a BYO provider (anthropic/openai/gemini/
   * openrouter), using the stored API key. Desktop goes through the Rust proxy
   * (key stays in the keychain, no CORS); browser preview fetches directly
   * with the localStorage key (subject to CORS — may fail; callers should fall
   * back to free-text). Phorma Cloud and Ollama are not supported here
   * (Phorma Cloud uses a curated list; Ollama is local).
   */
  async listModels(provider: 'anthropic' | 'openai' | 'gemini' | 'openrouter'): Promise<string[]> {
    if (this.tauri.isDesktop) {
      const { invoke } = await import('@tauri-apps/api/core');
      return invoke<string[]>('list_provider_models', { provider });
    }

    const key = this.settings.browserKey(provider);
    if (!key) throw new Error(`No ${provider} API key configured. Add one in Settings → API Keys.`);

    const url = this.providerModelsUrl(provider);
    const headers: Record<string, string> = { Authorization: `Bearer ${key}` };
    if (provider === 'anthropic') headers['anthropic-version'] = '2023-06-01';

    const response = await fetch(url, { headers });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`${provider} models request failed (${response.status}): ${detail.slice(0, 300)}`);
    }
    const body = (await response.json()) as {
      data?: { id?: string }[];
      models?: { name?: string }[];
    };
    const ids: string[] = [];
    for (const model of body.data ?? []) {
      if (model.id) ids.push(model.id);
    }
    for (const model of body.models ?? []) {
      if (model.name) ids.push(model.name);
    }
    return [...new Set(ids)].sort();
  }

  /**
   * Lists model ids installed in the local Ollama daemon (via `/api/tags`).
   * Desktop goes through the Rust `ollama_status` command (which also reports
   * whether the daemon is running); browser preview fetches directly. No API
   * key is required for Ollama.
   *
   * Returns `{ running, models }` so callers can distinguish "daemon not
   * running" from "running but no models installed" — both yield an empty
   * model list but warrant different empty-state UI.
   */
  async listOllamaModels(baseUrl?: string): Promise<{ running: boolean; models: string[] }> {
    const url = (baseUrl ?? loadLayout('ollamaBaseUrl', 'http://localhost:11434')).trim();

    if (this.tauri.isDesktop) {
      const { invoke } = await import('@tauri-apps/api/core');
      const status = await invoke<{ running: boolean; version?: string; models: string[] }>(
        'ollama_status',
        { baseUrl: url },
      );
      return { running: status.running, models: status.models };
    }

    try {
      const tagsResp = await fetch(`${url}/api/tags`);
      if (!tagsResp.ok) {
        return { running: false, models: [] };
      }
      const body = (await tagsResp.json()) as { models?: { name?: string }[] };
      const models = (body.models ?? [])
        .map(m => m.name)
        .filter((name): name is string => !!name)
        .sort();
      return { running: true, models };
    } catch {
      return { running: false, models: [] };
    }
  }

  /**
   * Lists model ids available from the local LM Studio server (via `/v1/models`).
   * LM Studio exposes the standard OpenAI-compatible models endpoint. No API key
   * is required. Returns `{ running, models }` so callers can distinguish
   * "server not running" from "running but no models loaded".
   */
  async listLmstudioModels(baseUrl?: string): Promise<{ running: boolean; models: string[] }> {
    const url = (baseUrl ?? loadLayout('lmstudioBaseUrl', 'http://localhost:1234')).trim();

    try {
      const response = await fetch(`${url}/v1/models`);
      if (!response.ok) return { running: false, models: [] };
      const body = (await response.json()) as { data?: { id?: string }[] };
      const models = (body.data ?? [])
        .map(m => m.id)
        .filter((id): id is string => !!id)
        .sort();
      return { running: true, models };
    } catch {
      return { running: false, models: [] };
    }
  }

  /** Provider models-list endpoint URL (browser path). */
  private providerModelsUrl(provider: 'anthropic' | 'openai' | 'gemini' | 'openrouter'): string {
    switch (provider) {
      case 'anthropic':
        return 'https://api.anthropic.com/v1/models?limit=1000';
      case 'openai':
        return 'https://api.openai.com/v1/models';
      case 'gemini':
        return 'https://generativelanguage.googleapis.com/v1beta/models';
      case 'openrouter':
        return 'https://openrouter.ai/api/v1/models';
    }
  }
}

let requestCounter = 0;

/** Bridges the engine's streaming contract onto the Rust LLM proxy. */
class TauriModelClient implements ModelClient {
  async *stream(request: ModelRequest): AsyncIterable<ModelChunk> {
    const wire = buildWireRequest(request);
    requestCounter += 1;
    const requestId = `req-${Date.now().toString(36)}-${requestCounter}`;

    const { invoke } = await import('@tauri-apps/api/core');
    const { listen } = await import('@tauri-apps/api/event');

    // Simple async queue: Tauri events push, the async iterator pulls.
    const queue: (string | { done: true } | { error: string })[] = [];
    let wake: (() => void) | null = null;
    const push = (item: (typeof queue)[number]): void => {
      queue.push(item);
      wake?.();
      wake = null;
    };

    const unlisten = await listen<{
      requestId: string;
      kind: 'line' | 'done' | 'error';
      data?: string;
    }>('llm-stream-event', event => {
      const payload = event.payload;
      if (payload.requestId !== requestId) return;
      if (payload.kind === 'line' && payload.data !== undefined) push(payload.data);
      else if (payload.kind === 'error') push({ error: payload.data ?? 'Stream failed.' });
      else if (payload.kind === 'done') push({ done: true });
    });

    // Fire the proxied request; events stream while this promise is pending.
    const proxyCall = invoke('llm_proxy_stream', {
      requestId,
      provider: request.provider,
      url: wire.url,
      headers: wire.headers,
      body: wire.body,
    }).catch((error: unknown) => {
      push({ error: error instanceof Error ? error.message : String(error) });
    });

    try {
      const parser = createStreamParser(request);
      for (;;) {
        if (queue.length === 0) {
          await new Promise<void>(resolve => (wake = resolve));
        }
        while (queue.length > 0) {
          const item = queue.shift()!;
          if (typeof item === 'string') {
            for (const chunk of parser.push(item)) {
              if (chunk.type === 'done') return;
              yield chunk;
            }
          } else if ('error' in item) {
            throw new Error(item.error);
          } else {
            for (const chunk of parser.end()) {
              if (chunk.type === 'done') return;
              yield chunk;
            }
            return; // done
          }
        }
      }
    } finally {
      unlisten();
      void proxyCall;
      // Best-effort cancel if the consumer bailed early (stop button).
      void invoke('cancel_llm_stream', { requestId }).catch(() => undefined);
    }
  }
}

/**
 * Routes `phorma-cloud` requests to the Phorma Cloud proxy and everything
 * else to the BYO client (Tauri or Fetch). The engine calls `stream()` per
 * node with `request.provider`, so this composite can branch at runtime.
 */
class CompositeModelClient implements ModelClient {
  constructor(
    private readonly byo: ModelClient,
    private readonly phormaCloud: PhormaCloudService,
    private readonly cloudBaseUrl: string,
  ) {}

  stream(request: ModelRequest): AsyncIterable<ModelChunk> {
    if (request.provider === 'phorma-cloud') {
      return new PhormaCloudModelClient(this.phormaCloud, this.cloudBaseUrl).stream(request);
    }
    return this.byo.stream(request);
  }
}

/**
 * Streams a single inference call through the Phorma Cloud /api/infer proxy.
 * The engine builds an OpenRouter-shaped wire request (the model id is already
 * a curated OpenRouter slug); we POST it to the proxy with the Clerk session
 * JWT, which injects the tenant's runtime key, forwards to OpenRouter, and
 * streams SSE back. We parse those lines with the OpenRouter stream parser.
 *
 * The tenant key never enters the webview — only the Clerk JWT does.
 */
class PhormaCloudModelClient implements ModelClient {
  constructor(
    private readonly phormaCloud: PhormaCloudService,
    private readonly cloudBaseUrl: string,
  ) {}

  async *stream(request: ModelRequest): AsyncIterable<ModelChunk> {
    const jwt = await this.resolveJwt();
    if (!jwt) {
      throw new Error('Sign in to Phorma Cloud to run agents on Phorma Cloud credits.');
    }

    // Build the OpenRouter-shaped wire request. The adapter for phorma-cloud
    // reuses the OpenRouter builder, so the body is already correct; we only
    // need the body (the proxy rewrites headers + URL for OpenRouter).
    const wire = buildWireRequest(request);

    const base = this.cloudBaseUrl.replace(/\/$/, '');
    const response = await fetch(`${base}/api/infer`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${jwt}`,
      },
      body: wire.body,
    });

    if (!response.ok || !response.body) {
      const detail = await response.text().catch(() => '');
      let message = detail;
      try {
        message = (JSON.parse(detail) as { error?: string })?.error ?? detail;
      } catch {
        // keep raw text
      }
      throw new ModelRequestError(
        `Phorma Cloud request failed (${response.status}): ${message.slice(0, 300)}`,
        response.status,
      );
    }

    // Parse the OpenRouter SSE stream with the engine's OpenRouter parser.
    // We pass a request whose provider is openrouter so createStreamParser
    // picks the OpenAI-compatible parser (phorma-cloud uses the same parser).
    const parser = createStreamParser({ ...request, provider: 'openrouter' });
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffered = '';

    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        for (const chunk of parser.end()) {
          if (chunk.type === 'done') return;
          yield chunk;
        }
        return;
      }
      buffered += decoder.decode(value, { stream: true });
      const lines = buffered.split('\n');
      buffered = lines.pop() ?? '';
      for (const line of lines) {
        for (const chunk of parser.push(line)) {
          if (chunk.type === 'done') return;
          yield chunk;
        }
      }
    }
  }

  /** Resolves a fresh Clerk session JWT for the proxy (null when signed out). */
  private async resolveJwt(): Promise<string | null> {
    return this.phormaCloud.sessionToken();
  }
}
