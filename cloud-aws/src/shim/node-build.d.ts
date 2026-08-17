/**
 * The `node:` surface `shim/build.ts` imports, declared locally.
 *
 * Same reasoning as `cli/node-runtime.d.ts` and `server/node-http.d.ts`:
 * `cloud-aws` installs no `@types/node` on purpose, and `globalThis` can satisfy a
 * GLOBAL but never an IMPORT, so each module that genuinely needs a `node:`
 * specifier declares the members it touches.
 *
 * Scoped to the builder deliberately. `shim/schedule-shim.ts`, the code that
 * actually runs in Lambda, imports NO `node:` module at all - it reads `crypto`
 * and `fetch` as globals typed by `lib.dom` - so nothing here widens the handler's
 * surface.
 *
 * If `@types/node` is ever added to this package, delete this file alongside
 * `cli/node-runtime.d.ts` and `server/node-http.d.ts` in the same change: two
 * declarations of one module collide.
 *
 * Feature: aws-byo-deploy
 */

declare module 'node:fs/promises' {
  /** Remove a path. `recursive` for a directory, `force` to ignore absence. */
  export function rm(
    path: string,
    options?: { recursive?: boolean; force?: boolean },
  ): Promise<void>;
  /** Create a directory, `recursive` to create missing parents. */
  export function mkdir(path: string, options?: { recursive?: boolean }): Promise<unknown>;
}
