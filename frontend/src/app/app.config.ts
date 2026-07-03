import {
  ApplicationConfig,
  provideBrowserGlobalErrorListeners,
  provideZoneChangeDetection,
} from '@angular/core';
import { provideRouter } from '@angular/router';
import { provideAnimationsAsync } from '@angular/platform-browser/animations/async';
import { providePrimeNG } from 'primeng/config';
import { definePreset } from '@primeuix/themes';
import Aura from '@primeuix/themes/aura';

import { routes } from './app.routes';
import { MONOCHROME_PALETTE } from './core/theme-palettes';

/**
 * Aura preset with the primary palette overridden to Phorma's default
 * monochrome ramp. The palette can be swapped at runtime via
 * `ThemeService.setPalette()` (which calls `updatePrimaryPalette`), so this
 * only needs to seed the correct first-paint colours.
 */
const PhormaPreset = definePreset(Aura, {
  semantic: {
    primary: MONOCHROME_PALETTE.ramp,
  },
});

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideZoneChangeDetection({ eventCoalescing: true }),
    provideRouter(routes),
    provideAnimationsAsync(),
    providePrimeNG({
      ripple: true,
      theme: {
        preset: PhormaPreset,
        options: {
          // Dark mode is toggled by adding `.app-dark` to the <html> element.
          // This keeps PrimeNG, Tailwind, and our own design tokens in sync.
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
