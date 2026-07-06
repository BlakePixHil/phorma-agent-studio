import { Injectable, inject, signal } from '@angular/core';
import { updatePrimaryPalette } from '@primeuix/themes';
import {
  DEFAULT_PALETTE_ID,
  THEME_PALETTES,
  type ThemePalette,
  type ThemePaletteId,
} from './theme-palettes';

const STORAGE_KEY = 'phorma-theme';
const PALETTE_KEY = 'phorma-palette';
const DARK_CLASS = 'app-dark';

export type ThemeMode = 'light' | 'dark';

/**
 * Manages the light/dark theme and the primary colour palette.
 *
 * - Light/dark is toggled by adding `.app-dark` to the document root.
 * - The primary palette is applied to PrimeNG at runtime via
 *   `updatePrimaryPalette()` (the preset is seeded with the default palette in
 *   `app.config.ts` so first paint is correct before Angular boots).
 *
 * Both pieces of state are persisted to localStorage and re-applied on load,
 * which gives the settings panel a single service to talk to when the user
 * picks a new accent colour.
 */
@Injectable({ providedIn: 'root' })
export class ThemeService {
  private readonly _mode = signal<ThemeMode>(this.readInitialMode());
  private readonly _palette = signal<ThemePalette>(this.readInitialPalette());

  /** Current theme mode as a reactive signal. */
  readonly mode = this._mode.asReadonly();

  /** Currently active primary palette as a reactive signal. */
  readonly palette = this._palette.asReadonly();

  constructor() {
    this.applyMode(this._mode());
    this.applyPalette(this._palette());
  }

  /** Switches between light and dark mode. */
  toggle(): void {
    this.setMode(this._mode() === 'dark' ? 'light' : 'dark');
  }

  /** Explicitly sets the theme mode. */
  setMode(mode: ThemeMode): void {
    this._mode.set(mode);
    this.applyMode(mode);
    try {
      localStorage.setItem(STORAGE_KEY, mode);
    } catch {
      // Ignore storage errors (e.g. privacy mode).
    }
  }

  /** Sets the active primary palette by id. */
  setPalette(id: ThemePaletteId): void {
    const palette = THEME_PALETTES[id];
    if (!palette) return;
    this._palette.set(palette);
    this.applyPalette(palette);
    try {
      localStorage.setItem(PALETTE_KEY, id);
    } catch {
      // Ignore storage errors.
    }
  }

  private applyMode(mode: ThemeMode): void {
    const root = document.documentElement;
    root.classList.toggle(DARK_CLASS, mode === 'dark');
  }

  private applyPalette(palette: ThemePalette): void {
    // `updatePrimaryPalette` swaps the primary ramp on the live Aura preset
    // and re-emits the themed CSS variables — no app reload needed.
    updatePrimaryPalette(palette.ramp as never);
  }

  private readInitialMode(): ThemeMode {
    try {
      const stored = localStorage.getItem(STORAGE_KEY) as ThemeMode | null;
      if (stored === 'light' || stored === 'dark') {
        return stored;
      }
    } catch {
      // Ignore storage errors.
    }
    // Default to dark for the native desktop aesthetic.
    return 'dark';
  }

  private readInitialPalette(): ThemePalette {
    try {
      const stored = localStorage.getItem(PALETTE_KEY) as ThemePaletteId | null;
      if (stored && THEME_PALETTES[stored]) {
        return THEME_PALETTES[stored];
      }
      // Migrate retired palette ids to their replacements.
      const storedStr = stored as string;
      if (storedStr === 'indigo' || storedStr === 'blue') {
        localStorage.setItem(PALETTE_KEY, 'azure');
        return THEME_PALETTES['azure'];
      }
      if (storedStr === 'slate') {
        localStorage.setItem(PALETTE_KEY, 'iris');
        return THEME_PALETTES['iris'];
      }
    } catch {
      // Ignore storage errors.
    }
    return THEME_PALETTES[DEFAULT_PALETTE_ID];
  }
}
