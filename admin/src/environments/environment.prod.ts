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
   * Deliberately the same `flowing-seahorse-72` development instance the studio
   * ships in `frontend/src/environments/clerk.ts`, because that is the instance
   * the hosted Worker's `CLERK_SECRET_KEY` verifies against. Swapping this to a
   * `pk_live_...` key means swapping the Worker's secret in the same change, or
   * every dashboard request reads as 401.
   */
  clerkPublishableKey: 'pk_test_Zmxvd2luZy1zZWFob3JzZS03Mi5jbGVyay5hY2NvdW50cy5kZXYk',
};
