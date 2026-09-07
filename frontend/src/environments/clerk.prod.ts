/**
 * Production build configuration for the studio's Clerk integration.
 *
 * Substituted for `clerk.ts` by the `fileReplacements` entry in
 * `frontend/angular.json`'s production configuration, the same arrangement
 * `admin/angular.json` uses for its environment files.
 *
 * Holds the PUBLISHABLE key for the `clerk.phorma-labs.com` PRODUCTION instance
 * (the key body decodes to `clerk.phorma-labs.com$`). Public value, safe to ship
 * to the browser; the live `CLERK_SECRET_KEY` belongs only in the hosted
 * Worker's secrets and never in frontend code.
 *
 * This key must stay paired with the live `CLERK_SECRET_KEY` on the hosted
 * Worker. A token minted by one instance and verified against another reads as
 * 401 on every request, and `/status.json` cannot detect that mismatch: its
 * Clerk probe returns 200 for any valid key regardless of instance. Confirm a
 * rotation with `/api/me` and a production session token instead.
 *
 * The development key lives in `clerk.ts`. Clerk rejects production keys on
 * localhost, so the two files must never hold the same value.
 */
export const CLERK_PUBLISHABLE_KEY = 'pk_live_Y2xlcmsucGhvcm1hLWxhYnMuY29tJA';

/**
 * Clerk's hosted Account Portal for the production instance, no trailing slash.
 *
 * This is the ONLY sign-in surface the packaged desktop build can currently
 * complete, and it works because the browser loads it first-party on
 * `phorma-labs.com`: Clerk's `__client` cookie is `SameSite=Lax` and scoped to
 * `clerk.phorma-labs.com`, so it travels here and does NOT travel inside the
 * Tauri webview, whose origin (`http://tauri.localhost`) is cross-site. See
 * `PhormaCloudService.signIn` for the full mechanism and the measurements.
 *
 * Verified live: `/sign-in` and `/sign-up` both render the full Clerk form,
 * including Continue with Google. Note that a scripted request without a
 * browser User-Agent gets a 403 from Clerk's bot protection, so probe this host
 * with a real browser before concluding it is down.
 */
export const CLERK_ACCOUNT_PORTAL_URL = 'https://accounts.phorma-labs.com';
