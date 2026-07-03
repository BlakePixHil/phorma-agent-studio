/**
 * Primary palette definitions for Phorma.
 *
 * Each palette follows the PrimeNG `PaletteDesignToken` shape — a 50→950
 * ramp. The active palette is injected into the Aura preset via `definePreset`
 * (see `app.config.ts`) and can be swapped at runtime through
 * `ThemeService.setPalette()`.
 *
 * Palettes are intentionally a small, curated set. Adding a new one is just
 * a new entry here + a key in `ThemePaletteId`.
 */

export type ThemePaletteId = 'monochrome' | 'slate' | 'indigo' | 'emerald';

export interface ThemePalette {
  /** Stable identifier persisted to localStorage. */
  id: ThemePaletteId;
  /** Human-readable label shown in the settings panel. */
  label: string;
  /** 50→950 colour ramp used by PrimeNG's `primary` token. */
  ramp: {
    50: string;
    100: string;
    200: string;
    300: string;
    400: string;
    500: string;
    600: string;
    700: string;
    800: string;
    900: string;
    950: string;
  };
}

/**
 * The default palette — a true monochrome ramp built from cool neutrals.
 *
 * Light end is near-white, dark end is near-black, with a faint blue undertone
 * so it harmonises with the existing charcoal canvas tokens. This replaces the
 * previous emerald/green default for a more restrained, professional look.
 */
export const MONOCHROME_PALETTE: ThemePalette = {
  id: 'monochrome',
  label: 'Monochrome',
  ramp: {
    50:  '#f6f7f9',
    100: '#eceef2',
    200: '#d5d9e1',
    300: '#b1b8c6',
    400: '#878fa3',
    500: '#67708a',
    600: '#525a72',
    700: '#43495d',
    800: '#3a3f4f',
    900: '#333744',
    950: '#1f222b',
  },
};

/** A slightly warmer neutral ramp (stone-like). */
export const SLATE_PALETTE: ThemePalette = {
  id: 'slate',
  label: 'Slate',
  ramp: {
    50:  '#f8fafc',
    100: '#f1f5f9',
    200: '#e2e8f0',
    300: '#cbd5e1',
    400: '#94a3b8',
    500: '#64748b',
    600: '#475569',
    700: '#334155',
    800: '#1e293b',
    900: '#0f172a',
    950: '#020617',
  },
};

/** Indigo — a calm, professional accent. */
export const INDIGO_PALETTE: ThemePalette = {
  id: 'indigo',
  label: 'Indigo',
  ramp: {
    50:  '#eef2ff',
    100: '#e0e7ff',
    200: '#c7d2fe',
    300: '#a5b4fc',
    400: '#818cf8',
    500: '#6366f1',
    600: '#4f46e5',
    700: '#4338ca',
    800: '#3730a3',
    900: '#312e81',
    950: '#1e1b4b',
  },
};

/** Emerald — the original Aura default, kept as an option. */
export const EMERALD_PALETTE: ThemePalette = {
  id: 'emerald',
  label: 'Emerald',
  ramp: {
    50:  '#ecfdf5',
    100: '#d1fae5',
    200: '#a7f3d0',
    300: '#6ee7b7',
    400: '#34d399',
    500: '#10b981',
    600: '#059669',
    700: '#047857',
    800: '#065f46',
    900: '#064e3b',
    950: '#022c22',
  },
};

/** All available palettes, keyed by id — used by the settings UI. */
export const THEME_PALETTES: Record<ThemePaletteId, ThemePalette> = {
  monochrome: MONOCHROME_PALETTE,
  slate:      SLATE_PALETTE,
  indigo:     INDIGO_PALETTE,
  emerald:    EMERALD_PALETTE,
};

/** Ordered list for rendering palette pickers. */
export const THEME_PALETTE_LIST: ThemePalette[] = [
  MONOCHROME_PALETTE,
  SLATE_PALETTE,
  INDIGO_PALETTE,
  EMERALD_PALETTE,
];

/** Default palette applied on first launch. */
export const DEFAULT_PALETTE_ID: ThemePaletteId = 'monochrome';

/**
 * Converts a `ThemePalette` to the PrimeNG `primary` token shape expected by
 * `definePreset` / `updatePrimaryPalette`.
 */
export function toPrimaryToken(palette: ThemePalette): Record<string, string> {
  return { ...palette.ramp };
}
