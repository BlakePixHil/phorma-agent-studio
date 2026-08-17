/**
 * Builds the Schedule_Shim Lambda bundle that `lambda.Code.fromAsset` consumes.
 *
 * ## Why this is a source module and not a script under `scripts/`
 *
 * A BYO deploy runs from a workspace the installer unpacked, NOT from a checkout,
 * and `cloud-aws/scripts/` is deliberately not shipped ("check-pipeline guards,
 * not part of a deploy" in `scripts/check-deploy-bundle.mjs`). `src/` is shipped.
 * So the builder has to live here or a real operator deploy would fail at synth
 * with `CannotFindFile` on a `dist/schedule-shim` that nothing ever produced.
 *
 * Two callers, one implementation:
 *
 * - `cli/plan.ts` and `cli/deploy.ts` call `buildScheduleShim` in-process before
 *   any `cdk` step, so the bundle is always built from the source that shipped
 *   beside it.
 * - `npm run bundle:shim` (and the `check` script) run this module through `tsx`,
 *   the same way `cdk.json` runs the CDK app.
 *
 * ## Why not `NodejsFunction`
 *
 * It bundles at synth time and falls back to a Docker build when it cannot
 * resolve a local esbuild. The Check_Pipeline guarantees it runs with no Docker
 * daemon, so that fallback would make the guarantee depend on the machine.
 * Pre-building and pointing `fromAsset` at a plain directory keeps synthesis a
 * pure file-hashing operation.
 *
 * Feature: aws-byo-deploy
 */

import { mkdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as esbuild from 'esbuild';

/** Entry point, relative to the package root. */
export const SHIM_ENTRY = 'src/shim/schedule-shim.ts';

/** Output directory, relative to the package root. The CDK asset path. */
export const SHIM_OUT_DIR = 'dist/schedule-shim';

/** Output file name. The Lambda handler is therefore `index.handler`. */
export const SHIM_OUT_FILE = 'index.mjs';

export interface ShimBuildResult {
  /** Absolute path of the directory `fromAsset` should be pointed at. */
  readonly outDir: string;
  /** Total bytes written, for the one line the CLI prints. */
  readonly bytes: number;
}

/**
 * The `cloud-aws` package root, derived from this module's own location so it does
 * not depend on the directory the CLI or the `cdk` process was launched from.
 *
 * This file is `<package>/src/shim/build.ts`, so the root is two segments up.
 */
export function packageRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

/**
 * Build the shim bundle, replacing any previous output.
 *
 * Everything is bundled in, including the AWS SDK and Smithy packages. The Node 22
 * Lambda runtime does ship an SDK, but taking it would mean the shim signs with
 * whatever version AWS has deployed while every other module in this package is
 * pinned exactly. A self-contained bundle keeps the signing path identical to the
 * one the tests exercise.
 */
export async function buildScheduleShim(root = packageRoot()): Promise<ShimBuildResult> {
  const outDir = join(root, SHIM_OUT_DIR);

  // A stale bundle surviving a failed build is worse than no bundle: synthesis
  // would succeed against yesterday's code.
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  const result = await esbuild.build({
    entryPoints: [join(root, SHIM_ENTRY)],
    outfile: join(outDir, SHIM_OUT_FILE),
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    // `@phorma/engine` resolves through a tsconfig path alias everywhere else in
    // the package. The shim imports none of it, and declaring the alias keeps
    // that true by construction rather than by habit.
    alias: { '@phorma/engine': join(root, '..', 'engine', 'src', 'index.ts') },
    // An ESM bundle that reaches for `require` at runtime dies on the first call.
    // Shimming the CJS interop members the AWS SDK still uses keeps it working.
    banner: {
      js: [
        "import { createRequire as __phormaCreateRequire } from 'node:module';",
        'const require = __phormaCreateRequire(import.meta.url);',
      ].join('\n'),
    },
    logLevel: 'silent',
    metafile: true,
  });

  if (result.errors.length > 0) {
    throw new Error(
      `Schedule_Shim bundle failed:\n${result.errors.map((e) => e.text).join('\n')}`,
    );
  }

  const bytes = Object.values(result.metafile.outputs).reduce((sum, o) => sum + o.bytes, 0);
  return { outDir, bytes };
}

// ---------------------------------------------------------------------------
// Direct invocation: `tsx src/shim/build.ts`
// ---------------------------------------------------------------------------

/**
 * `process` is reached through `globalThis` behind a narrow local shape, the
 * pattern `aws/stdout-log-writer.ts` and `server/startup.ts` use, because this
 * package installs no `@types/node`. The `node:` imports above are declared in
 * `src/shim/node-build.d.ts`.
 */
interface ProcessLike {
  argv: string[];
  exitCode?: number;
}

const currentProcess = (globalThis as { process?: ProcessLike }).process;
const invokedPath = currentProcess?.argv[1];

if (invokedPath !== undefined && resolve(invokedPath) === resolve(fileURLToPath(import.meta.url))) {
  try {
    const { outDir, bytes } = await buildScheduleShim();
    console.log(`Schedule_Shim bundled to ${outDir} (${(bytes / 1024).toFixed(0)} kB)`);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    if (currentProcess) currentProcess.exitCode = 1;
  }
}
