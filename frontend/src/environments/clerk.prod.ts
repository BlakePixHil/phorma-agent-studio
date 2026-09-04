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
