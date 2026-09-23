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

import { ActiveOwnerService } from './active-owner.service';
import { loadLayout } from './layout-storage';
import { loadPhormaCloudUrl } from './phorma-cloud-url';
import { PhormaCloudService } from './phorma-cloud.service';
import { SettingsService } from './settings.service';
import { TauriService } from './tauri.service';
import { TelemetryService } from './telemetry.service';
import type { ModelProviderId } from './workflow.model';

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
  // A DI LEAF (it injects nothing at all), which is why it is safe here: this
  // service sits ON the known NG0200 cycle. It supplies the `X-Phorma-Owner`
  // header every hosted inference call carries beside its bearer, so a member
  // running locally is metered against the ORGANISATION when that is the active
  // owner (multi-organisation-phorma, Requirement 20.4).
  private readonly activeOwner = inject(ActiveOwnerService);
  // Safe DI direction even though this service sits on the known NG0200 cycle:
  // `TelemetryService` is a leaf that injects only `TauriService`, so it cannot
  // reach back into `RunControllerService`.
  private readonly telemetry = inject(TelemetryService);

  /** The ModelClient local runs should use. */
  create(): ModelClient {
    const byoClient = this.tauri.isDesktop
      ? new TauriModelClient()
      : new FetchModelClient(async provider =>
          providerRequiresKey(provider) ? this.settings.browserKey(provider) : null,
        );
    // Read the URL from the leaf module (not CloudService) to avoid a circular
    // DI: RunControllerService → ModelTransportService → CloudService →
    // RunControllerService. The value rarely changes and is re-read on every
    // create() call, so it stays current enough.
    const cloudBaseUrl = loadPhormaCloudUrl();
    const composite = new CompositeModelClient(byoClient, this.phormaCloud, cloudBaseUrl, () =>
      this.activeOwner.ownerHeader(),
    );
    // The engine's `FetchModelClient` cannot count anything itself — it is pure
    // TypeScript with no Angular — so the studio-side transport seam counts for
    // it. Wrapping the composite (not each inner client) is what keeps one
    // failed inference call to exactly one counter.
    return new CountedModelClient(composite, this.telemetry);
  }

  /**
   * Sends the smallest possible REAL inference call to a provider/model and
   * reports whether it answered. Deliberately goes through {@link create} so
   * the probe exercises the exact path a run or an assistant turn takes: same
   * key resolution, same proxy, same endpoint and region, same wire format. A
   * probe that reached the provider its own way could pass while inference
   * still fails - which is the whole reason this exists.
   *
   * Listing a model catalog is NOT a substitute: the catalog endpoints answer
   * per region and say nothing about whether a given model id (or geographic
   * inference profile) is invocable from the configured region.
   *
   * A failure here is a genuine failed inference call, so it counts in
   * telemetry like any other - `create()` wraps the counted client.
   */
  async testModel(model: {
    provider: ModelProviderId;
    model: string;
  }): Promise<{ ok: true; ms: number; reply: string } | { ok: false; message: string }> {
    if (!model.model.trim()) return { ok: false, message: 'Choose a model first.' };

    // No `temperature`: a reachability probe has no opinion on sampling, and
    // the newest Claude models reject the field outright. The engine omits it
    // for those models anyway (`acceptsSamplingParams`), but leaving it off
    // keeps the probe answering "can I reach this model" and nothing else.
    const request: ModelRequest = {
      provider: model.provider,
      model: model.model.trim(),
      system: 'Reply with the single word OK. Nothing else.',
      messages: [{ role: 'user', content: 'ping' }],
      maxTokens: 16,
      ...this.settings.providerEndpoints(),
    };

    const started = Date.now();
    try {
      let reply = '';
      for await (const chunk of this.create().stream(request)) {
        if (chunk.type === 'text') reply += chunk.text;
      }
      return { ok: true, ms: Date.now() - started, reply: reply.trim() };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
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
    private readonly ownerHeader: () => Record<string, string>,
  ) {}

  stream(request: ModelRequest): AsyncIterable<ModelChunk> {
    if (request.provider === 'phorma-cloud') {
      return new PhormaCloudModelClient(
        this.phormaCloud,
        this.cloudBaseUrl,
        this.ownerHeader,
      ).stream(request);
    }
    return this.byo.stream(request);
  }
}

/**
 * Counts a failed inference call, then rethrows it untouched (Requirements 3.1,
 * 3.2, 11.3). Only a CATEGORY is recorded: `recordError` has no parameter a
 * message, a status or a stack could travel in, and the error object itself
 * never leaves this file.
 *
 * One wrapper around the composite, rather than one per inner client, is what
 * keeps a single failed call to a single counter. A consumer that abandons the
 * stream early (the stop button) closes the generator instead of throwing, so a
 * deliberate stop counts nothing.
 */
class CountedModelClient implements ModelClient {
  constructor(
    private readonly inner: ModelClient,
    private readonly telemetry: TelemetryService,
  ) {}

  async *stream(request: ModelRequest): AsyncIterable<ModelChunk> {
    try {
      yield* this.inner.stream(request);
    } catch (error) {
      this.telemetry.recordError(modelErrorCategory(error));
      throw error;
    }
  }
}

/**
 * `model-call` when a provider (or the Phorma Cloud proxy) answered and the
 * answer was a failure, `network` when the request never produced a response.
 * `fetch` rejects with a bare `TypeError` for a DNS, connect, TLS or CORS
 * failure, which is the only signal the browser gives us — the desktop path goes
 * through Rust, where a transport failure arrives as an ordinary `Error` that
 * cannot be told apart from a provider error, so it stays on `model-call`.
 */
function modelErrorCategory(error: unknown): 'model-call' | 'network' {
  if (error instanceof ModelRequestError) return 'model-call';
  return error instanceof Error && error.name === 'TypeError' ? 'network' : 'model-call';
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
    private readonly ownerHeader: () => Record<string, string>,
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
        // The active owner, beside the bearer. EMPTY for a personal account, so a
        // solo install sends exactly the request it has always sent.
        ...this.ownerHeader(),
      },
      body: wire.body,
    });

    if (!response.ok || !response.body) {
      const detail = await response.text().catch(() => '');
      let message = detail;
      // The entitlement gate's stable machine code, when the worker sent one
      // (stripe-billing requirement 19). Read here because this is the LAST
      // place the structured body exists: from here on the refusal is an Error
      // travelling through the engine, so a code not lifted onto
      // `ModelRequestError` now can only ever be recovered by parsing prose -
      // which is the exact fragility requirement 19 removes. An older worker
      // sends no `code`, leaving it undefined, and the consumers' prose
      // fallback covers that (requirement 20).
      let code: string | undefined;
      try {
        const parsed = JSON.parse(detail) as { error?: string; code?: string };
        message = parsed?.error ?? detail;
        code = typeof parsed?.code === 'string' && parsed.code ? parsed.code : undefined;
      } catch {
        // keep raw text
      }
      throw new ModelRequestError(
        `Phorma Cloud request failed (${response.status}): ${message.slice(0, 300)}`,
        response.status,
        code,
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
