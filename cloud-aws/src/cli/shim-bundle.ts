/**
 * Build the Schedule_Shim bundle before any `cdk` step.
 *
 * ## Why a verb has to do this
 *
 * `infra/schedule-shim.ts` points `lambda.Code.fromAsset` at
 * `<package>/dist/schedule-shim`, and `fromAsset` on a missing directory fails
 * synthesis with `CannotFindFile`. In a checkout the `check` script produces that
 * directory. In a real operator deploy there is no checkout: the runtime folder is
 * a workspace the installer unpacked, and `cloud-aws/scripts/` is deliberately not
 * shipped, so nothing else can have built it.
 *
 * So `plan` and `deploy` build it themselves, in-process, from
 * `shim/build.ts` - which IS shipped, being under `src/`. That also makes the
 * bundle necessarily current: it is built from the shim source sitting beside it,
 * on every plan and every deploy, rather than being a stale artefact carried in
 * the installer.
 *
 * A build failure returns non-zero before `cdk` runs, so a broken shim never
 * reaches a deploy as a synthesis error hours later.
 *
 * Feature: aws-byo-deploy
 */

import { buildScheduleShim } from '../shim/build.js';
import { EXIT_FAILURE } from './exit-codes.js';
import { errorMessage } from './exit-codes.js';
import type { CliContext } from './ports.js';

/** Built, or a CLI exit code to return. */
export type ShimBundleOutcome = { ok: true } | { ok: false; code: number };

export async function bundleShimForCdk(ctx: CliContext): Promise<ShimBundleOutcome> {
  try {
    const { bytes } = await buildScheduleShim();
    ctx.io.out(`Schedule_Shim bundled (${(bytes / 1024).toFixed(0)} kB).\n`);
    return { ok: true };
  } catch (err) {
    ctx.io.err(`The Schedule_Shim bundle failed: ${errorMessage(err)}\n`);
    ctx.io.err('No cdk step ran. Re-run "Set up runtime files" in Settings > Cloud.\n');
    return { ok: false, code: EXIT_FAILURE };
  }
}
