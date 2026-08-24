import {
  ApplicationConfig,
  ErrorHandler,
  provideBrowserGlobalErrorListeners,
  provideZoneChangeDetection,
  inject,
  provideAppInitializer,
} from '@angular/core';
import { provideRouter } from '@angular/router';
import { provideAnimationsAsync } from '@angular/platform-browser/animations/async';
import { providePrimeNG } from 'primeng/config';
import { definePreset } from '@primeuix/themes';
import Aura from '@primeuix/themes/aura';
import { ClerkService } from 'ngx-clerk';

import { routes } from './app.routes';
import {
  IRIS_PALETTE,
  THEME_PALETTES,
  type ThemePaletteId,
} from './core/theme-palettes';
import { PHORMA_COMPONENTS, PHORMA_SEMANTIC } from './core/theme-preset';
import { TelemetryErrorHandler } from './core/telemetry-error-handler';
import { CLERK_PUBLISHABLE_KEY } from '../environments/clerk';

/**
 * Read the saved palette from localStorage synchronously at config time so
 * the Aura preset is seeded with the correct primary ramp on first paint.
 * This avoids a flash of the default (iris) palette before
 * `ThemeService` constructs and calls `updatePrimaryPalette`.
 */
function readInitialPaletteRamp() {
  try {
    const stored = localStorage.getItem('phorma-palette') as ThemePaletteId | null;
    if (stored && THEME_PALETTES[stored]) {
      return THEME_PALETTES[stored].ramp;
    }
    // Migrate retired palette ids to their replacements.
    const storedStr = stored as string;
    if (storedStr === 'indigo' || storedStr === 'blue') {
      localStorage.setItem('phorma-palette', 'azure');
      return THEME_PALETTES['azure'].ramp;
    }
    if (storedStr === 'slate') {
      localStorage.setItem('phorma-palette', 'iris');
      return THEME_PALETTES['iris'].ramp;
    }
  } catch {
    // Ignore storage errors (e.g. privacy mode).
  }
  return IRIS_PALETTE.ramp;
}

/**
 * Aura preset with the primary palette overridden to Phorma's saved palette,
 * plus the Phorma design-language overrides (soft borderless form fields and
 * per-theme content/overlay/text surfaces — see `core/theme-preset.ts`).
 *
 * The palette can still be swapped at runtime via `ThemeService.setPalette()`
 * (which calls `updatePrimaryPalette`), but seeding the correct ramp here
 * ensures the first paint matches the user's choice without a flash. The
 * design-language overrides are palette-independent: they resolve through
 * `--phorma-*` and `--p-primary-color` at paint time, so `updatePrimaryPalette`
 * cannot clobber them.
 */
const PhormaPreset = definePreset(Aura, {
  semantic: {
    primary: readInitialPaletteRamp(),
    ...PHORMA_SEMANTIC,
  },
  components: PHORMA_COMPONENTS,
});

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    // Counts `error:unknown` for a throw no surface classified, then delegates to
    // Angular's own reporting unchanged. The global listeners above are what
    // route a window `error` or `unhandledrejection` here as well.
    { provide: ErrorHandler, useClass: TelemetryErrorHandler },
    provideZoneChangeDetection({ eventCoalescing: true }),
    provideRouter(routes),
    // Initialise Clerk (ngx-clerk v0.2.0 exposes ClerkService.__init rather
    // than a provideClerk helper). The publishable key is a public value
    // sourced from src/environments/clerk.ts — Angular's esbuild builder
    // doesn't load Vite's import.meta.env, so we use the environments pattern.
    provideAppInitializer(() => {
      const clerk = inject(ClerkService);
      clerk.__init({
        publishableKey: CLERK_PUBLISHABLE_KEY,
      });
    }),
    provideAnimationsAsync(),
    providePrimeNG({
      ripple: true,
      theme: {
        preset: PhormaPreset,
        options: {
          // Dark mode is toggled by adding `.app-dark` to the <html> element.
          // Every dark-family theme mode carries `.app-dark` (plus its own
          // class — `.app-solarized`, `.app-charcoal`, etc. — which overrides
          // the `--phorma-*` surface tokens). This keeps PrimeNG, Tailwind,
          // and our own design tokens in sync.
          darkModeSelector: '.app-dark',
          cssLayer: {
            name: 'primeng',
            order: 'theme, base, primeng',
          },
        },
      },
    }),
  ],
};
