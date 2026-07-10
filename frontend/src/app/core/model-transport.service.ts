import { Injectable, inject } from '@angular/core';

import {
  FetchModelClient,
  buildWireRequest,
  createStreamParser,
  providerRequiresKey,
  type ModelChunk,
  type ModelClient,
  type ModelRequest,
} from '@phorma/engine';

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
 */
@Injectable({ providedIn: 'root' })
export class ModelTransportService {
  private readonly tauri = inject(TauriService);
  private readonly settings = inject(SettingsService);

  /** The ModelClient local runs should use. */
  create(): ModelClient {
    if (this.tauri.isDesktop) {
      return new TauriModelClient();
    }
    return new FetchModelClient(async provider =>
      providerRequiresKey(provider) ? this.settings.browserKey(provider) : null,
    );
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
