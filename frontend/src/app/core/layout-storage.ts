/**
 * Tiny localStorage-backed persistence helpers for layout/UI state.
 *
 * Keys are namespaced under `phorma.layout.` so they don't collide with
 * other Phorma storage (recent projects, last project path, etc.).
 *
 * All access is wrapped in try/catch so a corrupted entry or a locked-down
 * storage (private mode) never crashes the app — the fallback value is used.
 */

const PREFIX = 'phorma.layout.';

export function loadLayout<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (raw === null) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function saveLayout(key: string, value: unknown): void {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    // Ignore quota / private-mode errors — layout persistence is best-effort.
  }
}
