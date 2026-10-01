import { Injectable, inject } from '@angular/core';

import {
  DataTransportError,
  decodeBase64,
  DEFAULT_MAX_RESPONSE_BYTES,
  DEFAULT_REQUEST_TIMEOUT_SEC,
  MAX_REQUEST_TIMEOUT_SEC,
  MIN_REQUEST_TIMEOUT_SEC,
  type DataFetcher,
  type DataRequest,
  type DataResponse,
  type TransportFailureKind,
} from '@phorma/engine';

import { ConnectionStoreService } from './connection-store.service';
import { TauriService } from './tauri.service';
import { TelemetryService } from './telemetry.service';

/**
 * `DataFetchService` — outbound HTTP for data nodes (design §7.1, §7.2, §13;
 * Requirements 8.16, 8.17, 8.18, 8.20, 18.3, 18.4).
 *
 * Two backends, selected by {@link TauriService.isDesktop}:
 *
 * - **Desktop**: every request goes through the Rust `data_request` command
 *   rather than the webview, for three reasons — no webview CORS, so a data
 *   node can call an API that never heard of this application; connection
 *   secrets are read from the keychain and applied to the request inside Rust,
 *   so no credential ever crosses the IPC boundary into JavaScript
 *   (Requirement 3.3); and transport failures are classified there, where the
 *   error actually is.
 * - **Browser preview**: the browser's own `fetch`, subject to `mode: 'cors'` —
 *   an API that has not opted into CORS cannot be reached from here, which is a
 *   documented limitation of running without the desktop app or a deployed
 *   worker (design §13). No connection secret ever reaches this path: a node
 *   that names a `connectionId` fails earlier, at `ConnectionStore.resolve`
 *   (Requirement 3.8), so only unauthenticated calls arrive here.
 *
 * Both backends honour the same contract: an HTTP status is never a failure —
 * 3xx, 4xx and 5xx all come back as a {@link DataResponse} — and the same six
 * {@link TransportFailureKind} values classify a request that produced no
 * response, so the retry classifier sees identical behaviour on every host
 * (Requirements 8.16, 8.17, 8.18, 8.20).
 */

/** The six transport kinds, mirroring `TransportFailureKind`. */
const TRANSPORT_KINDS: readonly TransportFailureKind[] = [
  'connect',
  'dns',
  'tls',
  'timeout',
  'aborted',
  'unknown',
];

/** A failure crossing IPC from `data_request`, already scrubbed of secrets. */
interface DataErrorDto {
  kind: string;
  message: string;
}

/** The `data_request` answer, mirroring `DataResponseDto`. */
interface DataResponseDto {
  status: number;
  headers: Record<string, string>;
  body: string;
  truncated: boolean;
  byteCount: number;
  durationMs: number;
}

@Injectable({ providedIn: 'root' })
export class DataFetchService {
  private readonly tauri = inject(TauriService);
  private readonly connections = inject(ConnectionStoreService);
  // Safe DI direction: `TelemetryService` is a leaf that injects only
  // `TauriService`, so this edge reaches nothing on the run path.
  private readonly telemetry = inject(TelemetryService);

  /**
   * The `DataFetcher` handed to `RunOptions.dataFetch`. Bound as a field so the
   * run wiring can pass `this.dataFetchHost.fetch` without losing `this`.
   */
  readonly fetch: DataFetcher = (request) => this.perform(request);

  /**
   * The single seam both backends pass through, so a request that produced no
   * response is counted exactly once as `network` (Requirements 3.1, 3.2, 11.3).
   * Category only - the {@link DataTransportError} carries a message and a
   * failure kind, and neither reaches `recordError`, which has no parameter for
   * them. An HTTP status is never a failure here, so a 4xx or 5xx response
   * counts nothing, and anything rejected before a socket opened (an
   * unresolvable connection, a malformed request) is not a network failure and
   * counts nothing either.
   */
  private async perform(request: DataRequest): Promise<DataResponse> {
    try {
      return await (this.tauri.isDesktop
        ? this.performDesktop(request)
        : this.performBrowser(request));
    } catch (error) {
      if (error instanceof DataTransportError) this.telemetry.recordError('network');
      throw error;
    }
  }

  private async performDesktop(request: DataRequest): Promise<DataResponse> {
    // Undefined when the request needs no credential (an unauthenticated call or
    // a notify webhook); throws when a credential was expected but cannot be
    // applied, because an unauthenticated request must never go out in its place.
    const credentials = this.connections.credentialsFor(request);

    const { invoke } = await import('@tauri-apps/api/core');
    let response: DataResponseDto;
    try {
      response = await invoke<DataResponseDto>('data_request', {
        connectionId: credentials?.connectionId ?? null,
        secretKeys: credentials?.secretKeys ?? [],
        auth: credentials?.auth ?? null,
        request: {
          url: request.url,
          method: request.method,
          headers: request.headers,
          body: request.body ?? null,
          bodyEncoding: request.bodyEncoding ?? null,
          timeoutMs: request.timeoutMs ?? null,
          maxResponseBytes: request.maxResponseBytes ?? null,
        },
      });
    } catch (error) {
      throw toDataHostError(error);
    }

    return {
      status: response.status,
      headers: response.headers,
      body: response.body,
      truncated: response.truncated,
      byteCount: response.byteCount,
      durationMs: response.durationMs,
    };
  }

  /**
   * Requirements 3.8, 18.4: browser `fetch`, with the same response-byte cap,
   * request timeout and failure-kind mapping as the desktop and worker drivers.
   * No connection is ever resolved on this path (Requirement 3.8), so there is
   * no credential to apply here — the request the engine hands over already
   * carries every header it needs.
   */
  private async performBrowser(request: DataRequest): Promise<DataResponse> {
    const timeoutMs = resolveTimeoutMs(request.timeoutMs);
    const maxBytes = resolveMaxBytes(request.maxResponseBytes);
    const method = (request.method || 'GET').toUpperCase();

    const controller = new AbortController();
    // Distinguishes our own abort (a timeout) from any other AbortError.
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    const startedAt = Date.now();
    try {
      const init: RequestInit = {
        method,
        headers: { ...request.headers },
        mode: 'cors',
        signal: controller.signal,
        redirect: 'follow',
      };
      if (request.body !== undefined && !BODYLESS_METHODS.has(method)) {
        // A `base64` body is binary (multipart uploads): send the bytes, not the text.
        init.body =
          request.bodyEncoding === 'base64' ? toArrayBuffer(decodeBase64(request.body)) : request.body;
      }

      let response: Response;
      try {
        response = await fetch(request.url, init);
      } catch (error) {
        throw toBrowserTransportError(error, timedOut, timeoutMs);
      }

      let read: { body: string; byteCount: number; truncated: boolean };
      try {
        read = await readCappedBody(response, maxBytes);
      } catch (error) {
        throw toBrowserTransportError(error, timedOut, timeoutMs);
      }

      return {
        status: response.status,
        headers: lowerCasedHeaders(response.headers),
        body: read.body,
        truncated: read.truncated,
        byteCount: read.byteCount,
        durationMs: Math.max(0, Date.now() - startedAt),
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Methods for which `fetch` refuses a request body. */
const BODYLESS_METHODS = new Set(['GET', 'HEAD']);

/** Requirement 8.20: the node-declared timeout when sane, otherwise 30 seconds. */
function resolveTimeoutMs(timeoutMs: number | undefined): number {
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs)) {
    return DEFAULT_REQUEST_TIMEOUT_SEC * 1000;
  }
  return Math.min(
    Math.max(Math.floor(timeoutMs), MIN_REQUEST_TIMEOUT_SEC * 1000),
    MAX_REQUEST_TIMEOUT_SEC * 1000,
  );
}

/** Requirement 8.18: the node-declared cap when positive, otherwise 4 MiB. */
function resolveMaxBytes(maxResponseBytes: number | undefined): number {
  if (typeof maxResponseBytes !== 'number' || !Number.isFinite(maxResponseBytes)) {
    return DEFAULT_MAX_RESPONSE_BYTES;
  }
  const floored = Math.floor(maxResponseBytes);
  return floored > 0 ? floored : DEFAULT_MAX_RESPONSE_BYTES;
}

/** Requirement 8.17: lower-cased header names, `retry-after` and `link` intact. */
function lowerCasedHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

/**
 * Requirement 8.18: reads at most `maxBytes` of the body, streaming rather than
 * buffering the whole response, so a response far larger than the cap is never
 * materialised just to be clipped afterwards.
 */
async function readCappedBody(
  response: Response,
  maxBytes: number,
): Promise<{ body: string; byteCount: number; truncated: boolean }> {
  const stream = response.body;
  if (stream === null) return { body: '', byteCount: 0, truncated: false };

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let retained = 0;
  let truncated = false;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined || value.byteLength === 0) continue;

      const room = maxBytes - retained;
      if (value.byteLength >= room) {
        if (room > 0) {
          chunks.push(value.subarray(0, room));
          retained += room;
        }
        truncated = value.byteLength > room || !(await isStreamExhausted(reader));
        break;
      }
      chunks.push(value);
      retained += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  return { body: decodeUtf8(chunks, retained), byteCount: retained, truncated };
}

/** True when the stream had nothing left after a chunk exactly filled the cap. */
async function isStreamExhausted(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<boolean> {
  const next = await reader.read();
  return next.done === true || next.value === undefined || next.value.byteLength === 0;
}

/** Joins the retained chunks and decodes them, replacing a clipped byte sequence. */
function decodeUtf8(chunks: readonly Uint8Array[], byteLength: number): string {
  if (byteLength === 0) return '';
  const merged = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8', { fatal: false, ignoreBOM: false }).decode(merged);
}

/**
 * Maps a browser `fetch` rejection onto the same six {@link TransportFailureKind}
 * values the desktop and worker drivers report, so the retry classifier behaves
 * identically regardless of host. Only `connect`, `dns` and `tls` mean "provably
 * never reached the server"; a browser `fetch` failure is almost always opaque
 * (a bare `TypeError: Failed to fetch`, including for a CORS rejection), so
 * anything that does not clearly say otherwise lands on `unknown` — the safe
 * side of the non-idempotent retry decision.
 */
function toBrowserTransportError(
  error: unknown,
  timedOut: boolean,
  timeoutMs: number,
): DataTransportError {
  if (timedOut) return new DataTransportError('timeout', `Request timed out after ${timeoutMs} ms.`);

  const name = error instanceof Error ? error.name : '';
  if (name === 'AbortError') return new DataTransportError('aborted', 'Request was aborted.');

  const detail = error instanceof Error ? error.message : String(error);
  const text = `${name} ${detail}`.toLowerCase();
  let kind: TransportFailureKind = 'unknown';
  if (/certificat|\btls\b|\bssl\b|handshake|self.signed/.test(text)) kind = 'tls';
  else if (/\bdns\b|getaddrinfo|enotfound|name not resolved|could not be resolved/.test(text)) kind = 'dns';
  else if (/econnrefused|econnreset|connection (refused|reset|closed)|failed to connect|could not connect/.test(text)) {
    kind = 'connect';
  }

  return new DataTransportError(kind, detail.length > 0 ? detail : `Transport failure (${kind}).`);
}

/**
 * Turns a rejection from `data_request` or `sql_query` — both return the same
 * `DataErrorDto` — into the error the engine expects: a
 * {@link DataTransportError} for one of the six transport kinds, so the retry
 * classifier can decide whether a non-idempotent step may be retried, and a
 * plain error for anything rejected before a socket opened — an unsent malformed
 * request must not be retried as if the network had hiccupped.
 */
export function toDataHostError(error: unknown): Error {
  const dto = asDataError(error);
  if (dto === undefined) {
    return error instanceof Error ? error : new Error(String(error));
  }
  const kind = TRANSPORT_KINDS.find((candidate) => candidate === dto.kind);
  return kind === undefined ? new Error(dto.message) : new DataTransportError(kind, dto.message);
}

function asDataError(error: unknown): DataErrorDto | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const { kind, message } = error as { kind?: unknown; message?: unknown };
  if (typeof kind !== 'string' || typeof message !== 'string') return undefined;
  return { kind, message };
}

/** A standalone `ArrayBuffer` holding exactly these bytes, for `fetch` bodies. */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return copy.buffer;
}
