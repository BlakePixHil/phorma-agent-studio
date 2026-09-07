/**
 * Development build configuration for the studio's Clerk integration.
 *
 * Holds the PUBLISHABLE key for the `flowing-seahorse-72` DEVELOPMENT instance
 * (base64-decode the key body to confirm which instance a key targets: this one
 * decodes to `flowing-seahorse-72.clerk.accounts.dev$`). A publishable key is a
 * PUBLIC value, safe to ship to the browser. The matching secret key
 * (`CLERK_SECRET_KEY`) must NEVER appear in frontend code: it lives only in
 * `cloud/.dev.vars` for a local `wrangler dev` (copy the tracked
 * `cloud/.dev.vars.example` template, which documents the `sk_test_` pairing),
 * and in the Worker's Wrangler secrets once deployed.
 *
 * Do not put a `pk_live_` key here. Clerk rejects production keys on localhost,
 * so `ng serve` on port 7322 would no longer be able to sign in. The production
 * key lives in `clerk.prod.ts` and is swapped in by the `fileReplacements` entry
 * in `frontend/angular.json`'s production configuration, so the two files must
 * never hold the same value.
 *
 * Whichever instance this points at, the Worker it talks to must verify against
 * the SAME one: a session token minted by one instance fails `verifyToken`
 * against another and reads as 401 on every request.
 */
export const CLERK_PUBLISHABLE_KEY =
  'pk_test_Zmxvd2luZy1zZWFob3JzZS03Mi5jbGVyay5hY2NvdW50cy5kZXYk';

/**
 * Clerk's hosted Account Portal for this instance, with no trailing slash.
 *
 * The DESKTOP build sends the user here in their system browser instead of
 * opening Clerk's in-webview modal, because the modal cannot complete against a
 * production instance - see `PhormaCloudService.signIn` for the mechanism. This
 * file's value is the development instance's portal, which is what a
 * `backend/npm run dev` desktop shell talks to.
 *
 * A development instance serves its portal from `<slug>.accounts.dev`; a
 * production instance serves it from `accounts.<your-domain>`. The two are
 * different hosts, so this constant is part of the `fileReplacements` pair
 * rather than derived from the publishable key at runtime.
 */
export const CLERK_ACCOUNT_PORTAL_URL = 'https://flowing-seahorse-72.accounts.dev';
