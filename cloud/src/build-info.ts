/**
 * Build stamp for the deployed worker.
 *
 * A BYO worker only picks up runtime and portal improvements when its owner
 * pulls the repo and deploys again. Without a stamp there is no way for the
 * studio to tell them their portal is running old code - they would just see
 * stale behaviour and assume it was a bug.
 *
 * `GET /portal` returns this value so the studio can compare it against its own
 * version and show a "your worker is behind" notice. Phorma Cloud users never
 * see that notice: we deploy their runtime, so it is always current.
 *
 * Kept as a plain constant rather than a `package.json` import because the
 * worker bundle has `resolveJsonModule` disabled and should stay
 * dependency-free. `scripts/release.mjs` bumps it alongside the manifests, and
 * `cloud/test/deploy-config.test.mjs` fails if it drifts from
 * `cloud/package.json`.
 */
export const WORKER_BUILD = '0.2.0-beta.11';
