/**
 * The Phorma Cloud base URL, and the one place that knows how to read it.
 *
 * It lives in its own leaf module rather than in `CloudService` because three
 * callers on the run path need it and MUST NOT import `CloudService`:
 * `ModelTransportService` and `PhormaCloudService` would close the
 * `RunControllerService -> ModelTransportService -> PhormaCloudService ->
 * CloudService -> RunControllerService` DI cycle (NG0200). A plain function has
 * no such hazard.
 *
 * ## The dev.phoma-labs.com migration
 *
 * The original hosted endpoint was deployed on a typo domain,
 * `dev.phoma-labs.com` (no `r`), before `phorma-labs.com` was registered. Every
 * install that ran that build carries the typo host, and some carry it
 * PERSISTED in `phorma.layout.phormaCloudUrl` because the settings dialog
 * writes the value it resolved. Changing the constant alone would leave those
 * installs pointing at the old host forever, so {@link loadPhormaCloudUrl}
 * rewrites a known-legacy host on read and persists the correction.
 *
 * Keep the legacy host serving until the fleet has updated: an install that has
 * not taken the new build still resolves the old default, and its updater
 * endpoint is a `workers.dev` hostname, so the update path does not depend on
 * either custom domain.
 */

import { loadLayout, saveLayout } from './layout-storage';

/** Default Phorma Cloud runtime URL (override via the hidden setting). */
export const PHORMA_CLOUD_DEFAULT_URL = 'https://cloud.phorma-labs.com';

/** localStorage key (under the `phorma.layout.` prefix) holding the override. */
const STORAGE_KEY = 'phormaCloudUrl';

/**
 * Hosts that used to be the default and must never be honoured again. Compared
 * by host, so a stored value keeps working whether or not it had a trailing
 * slash, a scheme difference, or a path.
 */
const LEGACY_HOSTS: readonly string[] = ['dev.phoma-labs.com', 'phoma-labs.com'];

function hostOf(url: string): string | null {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}

/** True when `url` points at a host we have since abandoned. */
export function isLegacyPhormaCloudUrl(url: string): boolean {
  const host = hostOf(url);
  return host !== null && LEGACY_HOSTS.includes(host);
}

/**
 * The Phorma Cloud base URL for this install: the persisted override when there
 * is one, otherwise the built-in default. A persisted value on a retired host is
 * replaced by the default and written back, so the correction happens once
 * rather than on every read.
 */
export function loadPhormaCloudUrl(): string {
  const stored = loadLayout(STORAGE_KEY, '');
  if (typeof stored !== 'string' || stored.length === 0) return PHORMA_CLOUD_DEFAULT_URL;
  if (isLegacyPhormaCloudUrl(stored)) {
    saveLayout(STORAGE_KEY, PHORMA_CLOUD_DEFAULT_URL);
    return PHORMA_CLOUD_DEFAULT_URL;
  }
  return stored;
}

/** Normalizes and persists a user-entered override. Empty resets to default. */
export function savePhormaCloudUrl(url: string): string {
  const trimmed = url.trim().replace(/\/$/, '');
  const next = trimmed.length > 0 && !isLegacyPhormaCloudUrl(trimmed)
    ? trimmed
    : PHORMA_CLOUD_DEFAULT_URL;
  saveLayout(STORAGE_KEY, next);
  return next;
}
