/**
 * Development build configuration for the telemetry admin dashboard.
 *
 * Both values are PUBLIC by design and both come from build configuration only
 * (Requirement 10.15). This file must never carry a Clerk secret key or any
 * Worker secret - notably the owner allowlist, which lives only as a Worker
 * secret on `cloud/` and is never read by the browser. Authorization is decided
 * server side by the Admin_API. See `admin/README.md` for the secret names, kept
 * out of client source on purpose and enforced by
 * `scripts/check-telemetry-secrets.mjs`.
 *
 * To run locally:
 *   1. `clerkPublishableKey` is the `flowing-seahorse-72` development instance,
 *      the same instance `frontend/src/environments/clerk.ts` ships and the same
 *      one the hosted Worker's `CLERK_SECRET_KEY` verifies against. A session
 *      token from another instance fails `verifyRequest` and reads as 401.
 *   2. Point `apiBaseUrl` at a `wrangler dev` of `cloud/` (default
 *      http://localhost:8787) or at the deployed hosted Worker.
 *   3. `npm start` serves on http://localhost:7323.
 *
 * `angular.json` swaps this file for `environment.prod.ts` on a production build.
 */
export const environment = {
  production: false,
  /** Base URL of the cloud Worker serving `/api/admin/telemetry/*`. */
  apiBaseUrl: 'http://localhost:8787',
  /** Clerk PUBLISHABLE key for the `flowing-seahorse-72` development instance. */
  clerkPublishableKey: 'pk_test_Zmxvd2luZy1zZWFob3JzZS03Mi5jbGVyay5hY2NvdW50cy5kZXYk',
};
