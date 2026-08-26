# @phorma/admin - telemetry dashboard

Owner-facing dashboard for the anonymous telemetry rollups collected by Phorma Agent Studio. It is a
standalone Angular 20 app (standalone components, signals, OnPush) with PrimeNG 20 on the
`@primeuix/themes` Aura preset, Tailwind v4, the Tabler icon webfont and `ngx-clerk`.

## Isolation

This package deliberately depends on nothing from `frontend/`, `engine/`, `cloud/` or `cloud-aws/`,
and imports nothing across a package boundary. The Admin_API response interfaces in
`src/app/core/models.ts` are a structural **twin** of the Worker's shapes, in the same sense as
`engine/src/types.ts` and `frontend/src/app/core/workflow.model.ts` - two independent declarations of
one contract, kept aligned by review and by the response-shape assertions in the `cloud` suite.

It shares exactly one thing with the other packages: the repo-wide version number, which
`cloud-aws/scripts/check-versions.mjs` enforces and `scripts/release.mjs` bumps.

## Commands

```powershell
cd admin
npm install --legacy-peer-deps   # ALWAYS --legacy-peer-deps, same as frontend
npm start                        # dev server on http://localhost:7323
npm run build                    # production build to dist/admin/browser
npx ng test --watch=false --browsers=ChromeHeadless
npx wrangler deploy              # publishes the static asset worker
npm run generate:world-map       # regenerates the geography world map paths
```

**Port 7323.** 7322 is the studio and 7321 is Phorma Code, so neither can be used here.

## Geography world map

The choropleth on the Geography view (`src/app/views/geography/world-map.ts`) paints from
`world-map.data.ts`, a generated file - do not edit it by hand. It is produced by
`scripts/generate-world-map.mjs` from Natural Earth's 1:110m admin-0 countries dataset (public
domain, https://www.naturalearthdata.com), shipped as topology by the `world-atlas` package,
projected with `d3-geo` and matched to ISO 3166-1 alpha-2 codes with `i18n-iso-countries`. Those
three packages plus `topojson-client` are dev-only: nothing about them ships to the browser besides
the generated paths. Run `npm run generate:world-map` after upgrading any of the four to pick up
projection or naming changes; the script is deterministic; re-running it without a version change is
a no-op.

## Configuration

`src/environments/environment.ts` (dev) and `environment.prod.ts` (production, swapped in by the
`fileReplacements` entry in `angular.json`) carry two values, both public:

| Value | Meaning |
|---|---|
| `apiBaseUrl` | Base URL of the cloud Worker serving `/api/admin/telemetry/*`. Dev default is `http://localhost:8787` (a `wrangler dev` of `cloud/`). |
| `clerkPublishableKey` | Clerk **publishable** key (`pk_test_...` / `pk_live_...`). Ships to the browser by design. |

Both files ship a placeholder key. Replace it with the key for your Clerk instance from
https://dashboard.clerk.com before running; until then the app renders but Clerk is not initialised
and logs a warning rather than crashing.

No secret belongs in this package. The Clerk secret key and `TELEMETRY_ADMIN_USER_IDS` (the owner
allowlist) are Worker secrets on `cloud/`, and authorization is decided server side - the dashboard
only ever presents a Clerk session token and reads the answer.

## Deployment

Independent of the installer and of the cloud Worker. `wrangler.jsonc` declares a static asset worker
named `phorma-admin` serving `./dist/admin/browser`. The name matters: the resulting origin
`https://phorma-admin.phorma-agent-studio.workers.dev` is listed in `ALLOWED_ORIGINS` under
`env.hosted` in `cloud/wrangler.jsonc`, so a rename breaks CORS for every admin request.

## Conventions

Tabler icons only (`ti ti-*`), an explicit `size="small"` on every PrimeNG control, no `p-dialog`, no
em dashes. `scripts/check-admin-conventions.mjs` enforces the first three across the templates.
