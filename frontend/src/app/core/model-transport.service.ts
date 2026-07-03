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
      const parser = createStreamParser(request.provider);
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
