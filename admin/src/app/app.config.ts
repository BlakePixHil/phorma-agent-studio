import {
  ApplicationConfig,
  inject,
  provideAppInitializer,
  provideBrowserGlobalErrorListeners,
  provideZoneChangeDetection,
} from '@angular/core';
import { provideRouter } from '@angular/router';
import { provideHttpClient, withFetch } from '@angular/common/http';
import { provideAnimationsAsync } from '@angular/platform-browser/animations/async';
import { providePrimeNG } from 'primeng/config';
import { definePreset } from '@primeuix/themes';
import Aura from '@primeuix/themes/aura';
import { ClerkService } from 'ngx-clerk';

import { routes } from './app.routes';
import { environment } from '../environments/environment';

/**
 * The studio's Iris primary ramp, declared locally.
 *
 * Copied deliberately rather than imported: this package depends on nothing from
 * `frontend/`. A colour ramp is a brand constant, not a contract, so a local
 * literal is the right kind of duplication here.
 */
const IRIS_RAMP = {
  50: '#f3f4ff',
  100: '#e5e5ff',
  200: '#c8c8fd',
  300: '#a6a3f6',
  400: '#958efa',
  500: '#8578f6',
  600: '#7365db',
  700: '#5d51b7',
  800: '#483f8f',
  900: '#393173',
  950: '#26224b',
};

/** Aura with the Phorma primary palette. */
const AdminPreset = definePreset(Aura, {
  semantic: {
    primary: IRIS_RAMP,
  },
});

/**
 * True when the configured publishable key is a real Clerk key rather than the
 * placeholder shipped in `environment.ts`. Initialising Clerk with a placeholder
 * throws, which would take the whole app down before it renders, so the
 * scaffold skips init and lets the shell render its signed-out surface.
 */
function hasClerkKey(key: string): boolean {
  return /^pk_(test|live)_/.test(key) && !key.includes('REPLACE_WITH');
}

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideZoneChangeDetection({ eventCoalescing: true }),
    provideRouter(routes),
    provideHttpClient(withFetch()),
    // ngx-clerk v0.2.0 exposes `ClerkService.__init` rather than a
    // `provideClerk` helper. The publishable key is a PUBLIC value read from
    // build configuration (Requirement 10.15) - the Clerk secret key never
    // appears in this package.
    provideAppInitializer(() => {
      const key = environment.clerkPublishableKey;
      if (!hasClerkKey(key)) {
        console.warn(
          'Clerk publishable key is not configured. Set clerkPublishableKey in src/environments/environment.ts.'
        );
        return;
      }
      inject(ClerkService).__init({ publishableKey: key });
    }),
    provideAnimationsAsync(),
    providePrimeNG({
      ripple: true,
      theme: {
        preset: AdminPreset,
        options: {
          // Dark mode is the `.app-dark` class on <html> (see index.html and
          // styles.scss).
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
