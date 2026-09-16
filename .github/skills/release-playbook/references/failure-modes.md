# Release failure modes

Every entry here happened in this repository. Each is written signature-first, because the point is
to recognise a failure you are looking at, not to read a list of warnings before you start.

Ordered roughly by how long the failure stayed invisible - the slow ones are the dangerous ones.

---

## The worker reports a version nobody released

**Signature.** `/status.json` reports `build: 0.2.0-beta.12` with a fresh `checkedAt` (so it is not
edge-cached), while a route that shipped in beta.14 answers `401` instead of `404`.

**Cause.** The worker was deployed from a mid-development tree, before `release.mjs` bumped
`cloud/src/build-info.ts`. `WORKER_BUILD` moves only through that script.

**Why it hid.** Nothing else surfaces the worker's identity. The routes worked, the app worked, and
the only symptom was a number in a JSON blob nobody reads unless they are already suspicious.

**Prevention.** Deploy the worker *after* `release.mjs`, never before, and check
`/status.json`'s `build` against the tag every single release. Phase 7 gate.

**Related.** A worker-only change still needs a version bump. Deploying `/signed-in` on top of the
beta.16 tag immediately re-created a one-commit version of this drift; it was closed by cutting
beta.17 and redeploying, not by documenting an exception. CI is ~18 minutes and installers behave
identically when only `cloud/` changed, so the bump is cheap and it keeps the invariant true.

---

## A job fails in two seconds with no steps, and the reason is the GitHub bill

**Signature.** `publish-r2` is red after ~2s. `gh run view --json jobs` shows `steps: []` and an
empty `runner_name`. `gh run view --job <id> --log` answers `log not found`. All four installer
builds are green and the GitHub Release is complete.

**Cause.** The job was never scheduled: "recent account payments have failed or your spending limit
needs to be increased". The four-platform matrix drains the Actions budget first - macOS bills at
10x and Windows at 2x - so the cheap sync job at the end is the one that starves.

**Why it hid.** The failure has no log to read, and the workflow-level view says only "failure". It
is easy to misread as a runner-image problem, except the same `ubuntu-22.04` label succeeded in the
same run.

**Prevention.** Read a 0-step job through
`gh api repos/{owner}/{repo}/check-runs/{jobId}/annotations`, which is the only surface carrying the
message. Fix billing and re-run the job, or republish from a dev machine (Phase 6 recovery). Until
R2 is synced the release has NOT reached users, no matter how complete the GitHub Release looks.

---

## The updater manifest points at an old version and clients get 204

**Signature.** `stable/latest.json` in R2 names a version older than the one just released. Every
installed client's update check returns `204 No Content` - i.e. "you are up to date" - forever.

**Cause.** `gh release download ""` with an unset `VERSION` falls back to the release GitHub marks
"Latest". GitHub marks the newest **non-prerelease** as Latest, so on a beta chain that is an old
version. The R2 sync then published old assets over the new manifest.

**Why it hid.** Nothing errors. The workflow is green, the GitHub Release is correct and complete,
and the only broken thing is what users' apps see.

**Prevention.** `VERSION` is set on the download step in `release.yml` (not only on the sync step),
and `publish-r2.mjs` aborts on a version mismatch. Never rely on `gh`'s Latest fallback in CI.
Phase 8 gate: the updater must answer **200 plus JSON** for an older version, not 204.

---

## A production build shipping the development auth key

**Signature.** Sign-in silently does nothing in an installed build - no error, no UI - while it
works perfectly in `ng serve`.

**Cause.** The `fileReplacements` swap did not take effect, or the environment pair was inverted.
An `admin` pair once survived review because its doc comments asserted the opposite of the keys the
files held.

**Why it hid.** A `pk_live_` / `pk_test_` **prefix** grep passes on a bundle that was never
replaced, because both prefixes appear inside the Clerk SDK as prefix-check literals. And Tauri v2
only compiles devtools into a release build when the `devtools` feature is on, which
`backend/src-tauri/Cargo.toml` does not set - so there was no console to read.

**Prevention.** Grep the base64 key **body**, both directions: the production body present, the
development body absent. Keep every environment file's doc comment matching the key it actually
holds. Phase 3 gate.

---

## `cargo check --locked` fails in CI after a version bump

**Signature.** `cannot update the lock file ... because --locked was passed`.

**Cause.** `Cargo.toml`'s version moved without `Cargo.lock`'s matching workspace-crate entry.

**Prevention.** `release.mjs` bumps `Cargo.lock` too, and `setCargoLockVersion` **throws** rather
than no-opping if it cannot find the entry, because a stale lock only surfaces later as this
failure. If Phase 4 shows `Cargo.lock` in the diff, re-run `cargo check --locked` before pushing.

---

## Installers build from untested code

**Signature.** The Release workflow is green and the GitHub Release is complete, but CI never ran
for that commit.

**Cause.** Only the tag was pushed. `ci.yml` triggers on `push: branches: ['**']` and a tag is not a
branch; `release.yml` triggers on `push: tags: ['v*']`.

**Prevention.** Always `git push origin main vX.Y.Z` - both refs, one command. Phase 6 expects
**two** new runs in `gh run list`.

---

## `tauri-action` builds the wrong directory on Linux

**Signature.** Linux job fails resolving `mcp/frontend`.

**Cause.** Removing `projectPath: backend` lets auto-detection crawl into `mcp/` and resolve
`beforeBuildCommand`'s `../frontend` relative to the wrong root.

**Prevention.** Do not remove that line.

---

## An empty signing secret is worse than a missing one

**Signature.** macOS build fails in `SecKeychainItemImport`.

**Cause.** `${{ secrets.X }}` for a secret that does not exist yields an **empty string**, and
Tauri's bundler treats a defined-but-empty `APPLE_CERTIFICATE` as "sign with this".

**Prevention.** The OS code-signing env vars stay fully commented out in `release.yml` - not
env-gated - until real certificate values exist.

---

## A partial platform matrix reads as success

**Signature.** The Release workflow shows green-ish, some platforms succeeded, and the GitHub
Release has assets for only two of four targets.

**Cause.** `fail-fast: false` on the build matrix, which is correct (one platform's failure should
not cancel the others) but means the run does not read as a clean failure at a glance.

**Prevention.** Phase 6 gate enumerates assets explicitly with
`gh release view vX.Y.Z --json assets`. A partial matrix is a failed release.

---

## A `wrangler secret put` publishes no config change

**Signature.** A `vars` edit in `wrangler.jsonc` (`CLERK_AUTHORIZED_PARTIES`,
`OPENROUTER_WORKSPACE_ID`, `TELEMETRY_K_ANONYMITY_DISABLED`) is not live even though a new version
appears in `wrangler deployments list`.

**Cause.** A `Source: Secret Change` version carries the **previous** version's vars forward. Only
`wrangler deploy` applies a `vars` edit.

**Corollary in the other direction.** A deploy silently overwrites live vars with the file's, so
`npx wrangler versions view <id> --env hosted` before deploying is how you catch drift. It caught a
live worker missing `TELEMETRY_K_ANONYMITY_DISABLED`, which the deploy then added.

---

## `/status.json` cannot confirm a Clerk key rotation

**Signature.** All status components report operational; production tokens still 401.

**Cause.** `probeAuth` sends `CLERK_SECRET_KEY` to `GET api.clerk.com/v1/jwks` and branches only on
the HTTP status - and `/v1/jwks` answers 200 for whichever instance the key belongs to, so a
`sk_test_` and an `sk_live_` key are indistinguishable there. It never touches `CLERK_JWT_KEY` at
all, and with a PEM set `@clerk/backend` never falls back to the secret key.

**Prevention.** `/api/me` with a real production session token returning 200 rather than 401 is the
only end-to-end proof. Instance identity is also checkable with no secret by comparing
`/.well-known/jwks.json` `kid`.

---

## A blocked verification step is a release risk

**Signature.** A task sat "blocked" for a whole spec because it needed something only a production
build could produce - and it was exactly the check that would have caught the shipped bug.

**Case.** `stripe-billing` task 1.7 was "confirm the rotation with `/api/me` and a production
session token". No production build existed to mint one, so it stayed blocked, and the Clerk
production-instance failure shipped in beta.14.

**Prevention.** Treat an unrunnable verification as a risk to state loudly, not a formality to
carry forward. Phase 9.

---

## A stale checklist sends you to re-run migrations against live data

**Signature.** The go-live checklist says a D1 migration is unapplied; it has been applied for
weeks.

**Prevention.** Verify a checklist in **both** directions. And check the `sqlite_master` **columns**,
not just `d1_migrations` - wrangler records a migration by filename, so a file edited after a partial
apply stays stamped while its later statements never run. That has already happened locally in this
repo: `d1_migrations` listed all four while `credit_grants` and `stripe_events` did not exist.

---

## A HEAD probe on a release asset 404s while GET returns it

**Signature.** `Invoke-WebRequest <asset> -Method Head` returns 404, so a verification step
concludes the release did not publish. `-Method Get` on the same URL returns 200 and the real
installer.

**Cause.** `handleReleaseRequest` gates on `if (request.method !== 'GET') return null`, so a HEAD
falls through to the agent router, which 404s. Open, minor, and harmless to real clients: the Tauri
updater and browsers both GET.

**Prevention.** Probe with `-Method Get ... -MaximumRedirection 0` and read `RawContentLength`.
Fixable by admitting HEAD (Workers strips the body automatically), but not worth its own release.

---

## Local suites that die at import, not at an assertion

**Signature.** A `cloud` suite fails instantly with `ERR_UNKNOWN_BUILTIN_MODULE` (`node:sqlite`) or
`does not provide an export named 'registerHooks'`.

**Cause.** Local Node is older than the suite needs. CI pins Node **24** for the checks job
specifically for this; `release.yml` uses Node 20 because it builds the app and runs no tests.

**Prevention.** Read an import-time failure as an environment mismatch, not a code defect. Verify
the affected behaviour directly and say explicitly which suite you could not run.

---

## Port exhaustion in the cloud suite chain, blamed on the wrong suite

**Signature.** `connect EADDRINUSE 127.0.0.1:<port>` partway through a property test, in a suite
that passes when run alone.

**Cause.** Miniflare's `dispatchFetch` and `getD1Database` each cost one loopback socket **per
request/statement**, held 120s in TIME_WAIT on Windows against a ~16k ephemeral range. The billing
suites consume ~12,800 sockets; the failure lands in whichever innocent suite runs next.

**Prevention.** `test:unit` runs the D1-heavy suites last and calls `await-port-drain.mjs` before
the hungriest ones. Read this as a whole-chain budget problem. Do not run the cloud chain next to a
karma run. Never lower iteration counts to buy it back.
