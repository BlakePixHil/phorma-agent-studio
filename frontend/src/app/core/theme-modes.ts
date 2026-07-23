/**
 * Theme mode definitions for Phorma.
 *
 * A "theme mode" is the surface/background theme of the whole editor (canvas,
 * chrome, nodes, code syntax). It is DISTINCT from the accent palette
 * (`theme-palettes.ts`) which only recolours interactive accents
 * (PrimeNG `--p-primary-*`). The two are orthogonal — pick a theme for the
 * backgrounds, pick an accent for the highlights.
 *
 * Each mode maps to one or more CSS classes applied to `<html>` (see
 * `ThemeService.applyMode`). Dark-family modes include the `app-dark` class
 * so PrimeNG's Aura dark tokens apply; their own `:root.<class>` block in
 * `styles.scss` then overrides the `--phorma-*` surface tokens.
 *
 * Adding a new theme is:
 *   1. Add a key to `ThemeMode` + an entry in `THEME_MODES` below.
 *   2. Add the matching `:root.<class>` block in `styles.scss`.
 * No service/UI changes are needed — the settings picker renders from
 * `THEME_MODE_LIST` and the service applies classes generically.
 */

export type ThemeMode =
  | 'dark'
  | 'light'
  | 'charcoal'
  | 'midnight'
  | 'solarized-dark'
  | 'nord';

export interface ThemeModeDef {
  /** Stable identifier persisted to localStorage. */
  id: ThemeMode;
  /** Human-readable label shown in the settings picker. */
  label: string;
  /** One-line description shown under the label. */
  description: string;
  /**
   * CSS classes applied to `<html>` when this mode is active. Exactly one of
   * these must carry the `:root.<class>` variable block in `styles.scss`
   * (see `themeClass`). Dark-family modes must include `app-dark` so PrimeNG
   * dark tokens apply.
   */
  classes: readonly string[];
  /**
   * The single class that owns the `:root.<class>` token block in
   * `styles.scss`. Used by the picker to render a live swatch preview.
   */
  themeClass: string;
  /** Whether this is a dark-family theme (drives Clerk appearance, etc.). */
  dark: boolean;
  /**
   * Static preview colours for the settings swatch card. Rendered as a mini
   * canvas + panel + node so the picker shows a real preview even before the
   * theme is applied. Derived from the theme's `:root` token block.
   */
  swatch: {
    /** Canvas/background colour. */
    canvas: string;
    /** Floating chrome/panel colour. */
    panel: string;
    /** Node surface colour. */
    node: string;
    /** Node header colour (slightly lighter/darker than node). */
    nodeHeader: string;
    /** Primary text colour. */
    text: string;
    /** Border/hairline colour. */
    border: string;
  };
}

/** Obsidian — the default. Near-black surfaces with a faint violet undertone. */
export const DARK_MODE: ThemeModeDef = {
  id: 'dark',
  label: 'Dark',
  description: 'Obsidian with a faint violet undertone.',
  classes: ['app-dark'],
  themeClass: 'app-dark',
  dark: true,
  swatch: {
    canvas: '#0c0a10',
    panel: '#17131d',
    node: '#17131d',
    nodeHeader: '#1d1826',
    text: '#e6e6e6',
    border: 'rgba(255, 255, 255, 0.08)',
  },
};

/** Light — clean neutral light surfaces. */
export const LIGHT_MODE: ThemeModeDef = {
  id: 'light',
  label: 'Light',
  description: 'Clean neutral light surfaces.',
  classes: [],
  themeClass: '',
  dark: false,
  swatch: {
    canvas: '#f2f3f5',
    panel: '#ffffff',
    node: '#ffffff',
    nodeHeader: '#f7f8fa',
    text: '#1a1a1a',
    border: 'rgba(0, 0, 0, 0.10)',
  },
};

/**
 * Charcoal — a flat, warm-neutral grey. No hue tint: surfaces sit on a pure
 * neutral ramp so the editor reads like a machined graphite tool.
 */
export const CHARCOAL_MODE: ThemeModeDef = {
  id: 'charcoal',
  label: 'Charcoal',
  description: 'Flat warm-neutral graphite, zero hue tint.',
  classes: ['app-dark', 'app-charcoal'],
  themeClass: 'app-charcoal',
  dark: true,
  swatch: {
    canvas: '#17161a',
    panel: '#1e1d22',
    node: '#1e1d22',
    nodeHeader: '#242329',
    text: '#e8e6e3',
    border: 'rgba(255, 255, 255, 0.08)',
  },
};

/**
 * Midnight — a deep blue-tinted dark. Surfaces pull toward indigo/navy for a
 * cooler, "night sky" feel compared with the neutral obsidian default.
 */
export const MIDNIGHT_MODE: ThemeModeDef = {
  id: 'midnight',
  label: 'Midnight',
  description: 'Deep blue-tinted dark, cool night-sky surfaces.',
  classes: ['app-dark', 'app-midnight'],
  themeClass: 'app-midnight',
  dark: true,
  swatch: {
    canvas: '#0b1020',
    panel: '#121a30',
    node: '#121a30',
    nodeHeader: '#182242',
    text: '#dbe4ff',
    border: 'rgba(148, 178, 255, 0.12)',
  },
};

/** Solarized Dark — the classic Ethan Schoonover palette. */
export const SOLARIZED_DARK_MODE: ThemeModeDef = {
  id: 'solarized-dark',
  label: 'Solarized Dark',
  description: 'Classic Ethan Schoonover palette.',
  classes: ['app-dark', 'app-solarized'],
  themeClass: 'app-solarized',
  dark: true,
  swatch: {
    canvas: '#002b36',
    panel: '#073642',
    node: '#073642',
    nodeHeader: '#0a3e4a',
    text: '#93a1a1',
    border: 'rgba(131, 148, 150, 0.15)',
  },
};

/**
 * Nord — an arctic, north-bluish palette based on the Nord colour scheme.
 * Muted polar-night surfaces with frost accents.
 */
export const NORD_MODE: ThemeModeDef = {
  id: 'nord',
  label: 'Nord',
  description: 'Arctic, north-bluish muted palette.',
  classes: ['app-dark', 'app-nord'],
  themeClass: 'app-nord',
  dark: true,
  swatch: {
    canvas: '#2e3440',
    panel: '#3b4252',
    node: '#3b4252',
    nodeHeader: '#434c5e',
    text: '#d8dee9',
    border: 'rgba(216, 222, 233, 0.10)',
  },
};

/** All available theme modes, keyed by id. */
export const THEME_MODES: Record<ThemeMode, ThemeModeDef> = {
  dark: DARK_MODE,
  light: LIGHT_MODE,
  charcoal: CHARCOAL_MODE,
  midnight: MIDNIGHT_MODE,
  'solarized-dark': SOLARIZED_DARK_MODE,
  nord: NORD_MODE,
};

/** Ordered list for rendering the settings theme picker. */
export const THEME_MODE_LIST: ThemeModeDef[] = [
  DARK_MODE,
  CHARCOAL_MODE,
  MIDNIGHT_MODE,
  SOLARIZED_DARK_MODE,
  NORD_MODE,
  LIGHT_MODE,
];

/** Default theme mode applied on first launch. */
export const DEFAULT_THEME_MODE: ThemeMode = 'dark';
