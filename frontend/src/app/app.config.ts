import {
  ApplicationConfig,
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
import { MONOCHROME_PALETTE } from './core/theme-palettes';
import { CLERK_PUBLISHABLE_KEY } from '../environments/clerk';

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
