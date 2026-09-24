import { Injectable, inject } from '@angular/core';

import { normalizeWebUrl, readablePage, type ReadablePage } from '@phorma/engine';

import { ActiveOwnerService } from './active-owner.service';
import { loadPhormaCloudUrl } from './phorma-cloud-url';
import { PhormaCloudService } from './phorma-cloud.service';
import { TauriService } from './tauri.service';

/**
 * The raw answer from either page-reading host. Mirrors `WebFetchResponse` in
 * `backend/src-tauri/src/web_fetch.rs` and `WebFetchResult` in
 * `cloud/src/web-fetch.ts` - the three are one contract.
 */
export interface WebFetchResult {
  status: number;
  finalUrl: string;
  contentType: string | null;
  body: string;
  truncated: boolean;
}

/** A page read for a model: where it came from, and its readable text. */
export interface WebPage extends ReadablePage {
  /** The URL actually read, after redirects. */
  url: string;
  status: number;
}

/** A page-reading failure with a message fit to show a user or a model. */
export class WebFetchError extends Error {
  override readonly name = 'WebFetchError';
}

/**
 * Reads public web pages for the AI assistant (the `web_fetch` tool and the
 * chat's URL references).
 *
 * Three routes, picked by where the studio runs:
 *
 * - **Desktop**: the Rust `web_fetch` command. No CORS, public-address-only
 *   egress with DNS pinning, manual redirect checks.
 * - **Browser, signed in**: `POST /api/fetch` on Phorma Cloud, the same guard
 *   in the worker. A browser cannot read most sites directly (CORS), so this is
 *   the path that makes the feature work under `ng serve` and the web build.
 * - **Browser, signed out**: refused with a message saying how to enable it,
 *   rather than a plain `fetch` that fails on CORS for nearly every site and
 *   bypasses the egress guard for the rest.
 *
 * DI: injects only `TauriService`, `PhormaCloudService` (already on the
 * transport path through `ModelTransportService`) and the `ActiveOwnerService`
 * leaf, and reads the cloud URL from the leaf module - never `CloudService`
 * (the NG0200 cycle; see `.kiro/steering/structure.md`).
 */
@Injectable({ providedIn: 'root' })
export class WebFetchService {
  private readonly tauri = inject(TauriService);
  private readonly phormaCloud = inject(PhormaCloudService);
  private readonly activeOwner = inject(ActiveOwnerService);

  /** Whether pages can be read at all from this session. */
  available(): boolean {
    return this.tauri.isDesktop || this.phormaCloud.signedIn();
  }

  /**
   * Reads a page and converts it to model-friendly text.
   *
   * @throws {WebFetchError} for an invalid URL, an unreadable or refused page,
   *   or a transport failure.
   */
  async read(rawUrl: string, options: { maxChars?: number } = {}): Promise<WebPage> {
    const url = normalizeWebUrl(rawUrl);
    if (!url) throw new WebFetchError(`"${rawUrl}" is not a valid web address.`);
    const result = await this.fetchRaw(url);
    if (result.status >= 400) {
      throw new WebFetchError(`${hostOf(result.finalUrl)} answered HTTP ${result.status}.`);
    }
    const page = readablePage(result.body, {
      url: result.finalUrl,
      contentType: result.contentType,
      maxChars: options.maxChars,
    });
    return {
      ...page,
      truncated: page.truncated || result.truncated,
      url: result.finalUrl,
      status: result.status,
    };
  }

  /**
   * Fetches raw text through the host's guarded path. Exposed for callers that
   * want the unconverted body (the web-search tool reads JSON APIs).
   */
  async fetchRaw(url: string): Promise<WebFetchResult> {
    if (this.tauri.isDesktop) {
      const { invoke } = await import('@tauri-apps/api/core');
      try {
        return await invoke<WebFetchResult>('web_fetch', { url, maxBytes: null });
      } catch (error) {
        throw new WebFetchError(typeof error === 'string' ? error : errorText(error));
      }
    }
    return this.fetchViaCloud(url);
  }

  private async fetchViaCloud(url: string): Promise<WebFetchResult> {
    const base = loadPhormaCloudUrl().replace(/\/$/, '');
    const bearer = this.phormaCloud.signedIn() ? await this.phormaCloud.sessionToken() : null;
    if (!base || !bearer) {
      throw new WebFetchError(
        'Reading web pages in the browser needs a Phorma Cloud sign-in (browsers block most ' +
          'sites from being read directly). Sign in, or use the desktop app.',
      );
    }
    let response: Response;
    try {
      response = await fetch(`${base}/api/fetch`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${bearer}`,
          ...this.activeOwner.ownerHeader(),
        },
        body: JSON.stringify({ url }),
      });
    } catch (error) {
      throw new WebFetchError(`Could not reach Phorma Cloud: ${errorText(error)}`);
    }
    const payload = (await response.json().catch(() => null)) as
      | (WebFetchResult & { error?: undefined })
      | { error?: string }
      | null;
    if (!response.ok || !payload || typeof payload.error === 'string') {
      const message = payload && typeof payload.error === 'string' ? payload.error : `HTTP ${response.status}`;
      throw new WebFetchError(message);
    }
    return payload as WebFetchResult;
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
