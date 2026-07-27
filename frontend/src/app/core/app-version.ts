/**
 * The studio's own version.
 *
 * A literal rather than a `package.json` import because `resolveJsonModule` is
 * off in the Angular build. `scripts/release.mjs` bumps it alongside every
 * manifest, and `cloud/test/deploy-config.test.mjs` fails if it drifts from
 * `frontend/package.json`.
 *
 * Used to compare against a deployed BYO worker's build stamp, so the studio can
 * tell the owner when their worker is running older code than the app.
 */
export const APP_VERSION = '0.2.0-beta.8';
