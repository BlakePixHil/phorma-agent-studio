import { Injectable, computed, inject, signal } from '@angular/core';

import {
  DataTransportError,
  FetchDecisionClient,
  decisionResultFromHttp,
  type DecisionClient,
  type DecisionRequest,
  type DecisionResult,
  type TransportFailureKind,
} from '@phorma/engine';

import { ActiveOwnerService } from './active-owner.service';
import { loadPhormaCloudUrl } from './phorma-cloud-url';
import { PhormaCloudService } from './phorma-cloud.service';
import { SettingsService } from './settings.service';
import { TauriService } from './tauri.service';

/**
 * `DecisionTransportService` - the System One (TypeSafe Jev) `DecisionClient`
 * for local runs, evals and studio features.
 *
 * Three backends:
 *  - **Desktop BYO**: the Rust `decision_evaluate` command reads the TypeSafe
 *    key from the OS keychain and performs the call, so the key never enters
 *    the webview.
 *  - **Browser BYO**: the engine's `FetchDecisionClient` with the key from the
 *    browser store (subject to CORS on api.typesafe.ai).
 *  - **Phorma Cloud**: the metered `/api/decide` proxy with the Clerk session,
 *    billed against the tenant's credits.
 *
 * `auto` prefers a configured key, then a Phorma Cloud sign-in.
 *
 * DI: a leaf on the run path. It injects exactly the services
 * `ModelTransportService` already injects safely (never `CloudService`), and
 * reads the cloud base URL from the leaf module, avoiding the known NG0200
 * cycle `RunControllerService -> ... -> CloudService -> RunControllerService`.
 */
@Injectable({ providedIn: 'root' })
export class DecisionTransportService {
  private readonly tauri = inject(TauriService);
  private readonly settings = inject(SettingsService);
  private readonly phormaCloud = inject(PhormaCloudService);
  private readonly activeOwner = inject(ActiveOwnerService);

  /**
   * Dev-only override installed by the E2E harness (`__phormaTest`), so a
   * browser test can drive System One behaviour deterministically without a
   * key or network. Never set in production: the harness is `isDevMode()`-gated.
   */
  private readonly stub = signal<DecisionClient | null>(null);

  /** Installs (or clears, with null) a test decision client. Dev harness only. */
  setTestClient(client: DecisionClient | null): void {
    this.stub.set(client);
  }

  /** True when a call made now would have somewhere to go. */
  readonly available = computed(() => this.stub() !== null || this.resolveBackend() !== null);

  /** Human label of where calls go right now, for Settings and hints. */
  readonly backendLabel = computed(() => {
    if (this.stub()) return 'the test stub';
    switch (this.resolveBackend()) {
      case 'byo':
        return 'your TypeSafe key';
      case 'phorma-cloud':
        return 'Phorma Cloud credits';
      default:
        return null;
    }
  });

  /**
   * The client local runs should use, or `undefined` when nothing is
   * configured - the engine then falls back (Router) or fails naming the
   * missing capability (every other System One step).
   */
  create(): DecisionClient | undefined {
    const stub = this.stub();
    if (stub) return stub;
    const backend = this.resolveBackend();
    if (backend === 'byo') {
      return this.tauri.isDesktop
        ? new TauriDecisionClient()
        : new FetchDecisionClient(async () => this.settings.browserDecisionKey());
    }
    if (backend === 'phorma-cloud') {
      return new PhormaCloudDecisionClient(this.phormaCloud, loadPhormaCloudUrl(), () =>
        this.activeOwner.ownerHeader(),
      );
    }
    return undefined;
  }

  /** Default decision model from Settings. */
  defaultModel(): string {
    return this.settings.decisionModel().trim() || 'jev-latest';
  }

  private resolveBackend(): 'byo' | 'phorma-cloud' | null {
    const source = this.settings.decisionSource();
    const hasKey = this.settings.decisionKeyConfigured();
    const signedIn = this.phormaCloud.signedIn();
    if (source === 'byo') return hasKey ? 'byo' : null;
    if (source === 'phorma-cloud') return signedIn ? 'phorma-cloud' : null;
    if (hasKey) return 'byo';
    if (signedIn) return 'phorma-cloud';
    return null;
  }
}

/** The `decision_evaluate` answer, mirroring the Rust `DecisionResponseDto`. */
interface DecisionResponseDto {
  status: number;
  headers: Record<string, string>;
  body: string;
}

const TRANSPORT_KINDS: readonly TransportFailureKind[] = ['connect', 'dns', 'tls', 'timeout', 'aborted', 'unknown'];

/** Desktop: Rust performs the call with the keychain key. */
class TauriDecisionClient implements DecisionClient {
  async evaluate(request: DecisionRequest): Promise<DecisionResult> {
    const { invoke } = await import('@tauri-apps/api/core');
    let response: DecisionResponseDto;
    try {
      response = await invoke<DecisionResponseDto>('decision_evaluate', { body: JSON.stringify(request) });
    } catch (error) {
      throw toTransportError(error);
    }
    return decisionResultFromHttp(response.status, response.headers, response.body, Object.keys(request.questions));
  }
}

/** Turns a Rust `{ kind, message }` rejection into a classified error. */
function toTransportError(error: unknown): Error {
  const record = (error ?? {}) as { kind?: unknown; message?: unknown };
  const message = typeof record.message === 'string' ? record.message : String(error);
  if (typeof record.kind === 'string' && record.kind === 'config') return new Error(message);
  const kind = TRANSPORT_KINDS.includes(record.kind as TransportFailureKind)
    ? (record.kind as TransportFailureKind)
    : 'unknown';
  return new DataTransportError(kind, message);
}

/** Phorma Cloud: the metered `/api/decide` proxy with the Clerk session. */
class PhormaCloudDecisionClient implements DecisionClient {
  constructor(
    private readonly phormaCloud: PhormaCloudService,
    private readonly cloudBaseUrl: string,
    private readonly ownerHeader: () => Record<string, string>,
  ) {}

  async evaluate(request: DecisionRequest): Promise<DecisionResult> {
    const jwt = await this.phormaCloud.sessionToken();
    if (!jwt) throw new Error('Sign in to Phorma Cloud to use System One on Phorma Cloud credits.');
    const base = this.cloudBaseUrl.replace(/\/$/, '');
    let response: Response;
    try {
      response = await fetch(`${base}/api/decide`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${jwt}`,
          ...this.ownerHeader(),
        },
        body: JSON.stringify(request),
      });
    } catch (error) {
      throw new DataTransportError('unknown', `Phorma Cloud could not be reached: ${error instanceof Error ? error.message : String(error)}`);
    }
    const body = await response.text().catch(() => '');
    const headers: Record<string, string> = {};
    response.headers.forEach((value, name) => {
      headers[name.toLowerCase()] = value;
    });
    return decisionResultFromHttp(response.status, headers, body, Object.keys(request.questions));
  }
}
