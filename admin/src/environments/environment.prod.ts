/**
 * Production build configuration for the telemetry admin dashboard.
 *
 * Substituted for `environment.ts` by the `fileReplacements` entry in
 * `angular.json`. Same rule as the development file: public values only, no
 * Clerk secret key and no Worker secret (Requirement 10.15).
 */
export const environment = {
  production: true,
  /** The hosted cloud Worker. */
  apiBaseUrl: 'https://phorma-agent-studio-cloud.phorma-agent-studio.workers.dev',
  /**
   * Clerk PUBLISHABLE key - safe to ship to the browser.
   *
   * The PRODUCTION instance (`clerk.phorma-labs.com`). This must stay paired with
   * the live `CLERK_SECRET_KEY` on the hosted Worker: a token minted by one
   * instance and verified against another reads as 401 on every dashboard
   * request. `/status.json` cannot detect that mismatch, because its Clerk probe
   * returns 200 for any valid key regardless of instance - confirm a rotation
   * with `/api/me` and a production session token instead.
   *
   * The development key lives in `environment.ts` and is swapped in by the
   * `fileReplacements` entry in `angular.json`. Production keys are rejected on
   * localhost by Clerk, so the two files must never hold the same value.
   */
  clerkPublishableKey: 'pk_live_Y2xlcmsucGhvcm1hLWxhYnMuY29tJA',
};
