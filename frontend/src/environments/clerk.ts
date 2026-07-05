/**
 * Clerk publishable key.
 *
 * This is a PUBLIC key — safe to ship to the browser. The corresponding
 * secret key (CLERK_SECRET_KEY) must NEVER appear in frontend code; it
 * lives only in `cloud/.env` and the worker's Wrangler secrets.
 *
 * Replace the placeholder with your real `pk_test_...` / `pk_live_...` key
 * from the Clerk dashboard (https://dashboard.clerk.com).
 */
export const CLERK_PUBLISHABLE_KEY =
  'pk_test_Zmxvd2luZy1zZWFob3JzZS03Mi5jbGVyay5hY2NvdW50cy5kZXYk';
