import { Injectable, inject, signal } from '@angular/core';
import { updatePrimaryPalette } from '@primeuix/themes';
import {
  DEFAULT_PALETTE_ID,
  THEME_PALETTES,
  type ThemePalette,
  type ThemePaletteId,
} from './theme-palettes';
import {
  DEFAULT_THEME_MODE,
  THEME_MODES,
  type ThemeMode,
  type ThemeModeDef,
} from './theme-modes';

const STORAGE_KEY = 'phorma-theme';
const PALETTE_KEY = 'phorma-palette';

/** Every theme class the service manages on `<html>` (union of all modes). */
const ALL_THEME_CLASSES: readonly string[] = [
  ...new Set(Object.values(THEME_MODES).flatMap(mode => mode.classes)),
];

export type { ThemeMode, ThemeModeDef } from './theme-modes';

/**
 * Manages the editor theme mode and the primary accent palette.
 *
 * - The theme mode is the surface/background theme (canvas, chrome, nodes).
 *   It is applied by swapping a set of classes on `<html>`; dark-family
 *   modes include `app-dark` so PrimeNG's Aura dark tokens apply, and their
 *   own `:root.<class>` block in `styles.scss` overrides the `--phorma-*`
 *   surface tokens. Modes are data-driven from `theme-modes.ts` — adding a
 *   theme is one registry entry + one CSS block.
 * - The accent palette is applied to PrimeNG at runtime via
 *   `updatePrimaryPalette()` (the preset is seeded with the saved palette in
 *   `app.config.ts` so first paint is correct before Angular boots).
 *
 * Both pieces of state are persisted to localStorage and re-applied on load,
 * which gives the settings panel a single service to talk to.
 */
@Injectable({ providedIn: 'root' })
export class ThemeService {
  private readonly _mode = signal<ThemeMode>(this.readInitialMode());
  private readonly _palette = signal<ThemePalette>(this.readInitialPalette());

  /** Current theme mode as a reactive signal. */
  readonly mode = this._mode.asReadonly();

  /** The active theme mode definition (label, classes, swatch, dark flag). */
  get modeDef(): ThemeModeDef {
    return THEME_MODES[this._mode()];
  }

  /** Currently active primary palette as a reactive signal. */
  readonly palette = this._palette.asReadonly();

  constructor() {
    this.applyMode(this._mode());
    this.applyPalette(this._palette());
  }

  /** Explicitly sets the theme mode. */
  setMode(mode: ThemeMode): void {
    if (!THEME_MODES[mode]) return;
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

  /** Swaps the active theme classes on `<html>` for the given mode. */
  private applyMode(mode: ThemeMode): void {
    const root = document.documentElement;
    const active = new Set(THEME_MODES[mode]?.classes ?? []);
    for (const cls of ALL_THEME_CLASSES) {
      root.classList.toggle(cls, active.has(cls));
    }
  }

  private applyPalette(palette: ThemePalette): void {
    // `updatePrimaryPalette` swaps the primary ramp on the live Aura preset
    // and re-emits the themed CSS variables — no app reload needed.
    updatePrimaryPalette(palette.ramp as never);
  }

  private readInitialMode(): ThemeMode {
    try {
      const stored = localStorage.getItem(STORAGE_KEY) as ThemeMode | null;
      if (stored && stored in THEME_MODES) {
        return stored;
      }
    } catch {
      // Ignore storage errors.
    }
    // Default to dark for the native desktop aesthetic.
    return DEFAULT_THEME_MODE;
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
