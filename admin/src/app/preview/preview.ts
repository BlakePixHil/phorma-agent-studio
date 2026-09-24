import type { EnvironmentProviders, Provider } from '@angular/core';

/**
 * Extra providers for the dev-only fixture preview. Empty in every real build;
 * the `preview` configuration in `angular.json` swaps this file for
 * `preview.fixtures.ts` (`npm run preview`), so no fixture ever ships.
 */
export const PREVIEW_PROVIDERS: (Provider | EnvironmentProviders)[] = [];
