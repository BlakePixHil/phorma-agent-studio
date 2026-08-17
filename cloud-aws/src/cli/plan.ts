/**
 * The `plan` verb: Preflight to completion, then `cdk diff`.
 *
 * The ORDER is the requirement (Req 5.1, 5.5). Preflight runs first, runs every
 * check even after one has failed, and a single failure means no `cdk` step runs
 * at all. That matters because `cdk diff` cannot detect any of the things
 * Preflight checks: a missing VPC, a subnet in the wrong VPC, a disabled App_CMK
 * and an unreachable Docker daemon all surface as a confusing diff or a deploy
 * that dies halfway, hours later.
 *
 * Feature: aws-byo-deploy
 * Requirements: 4.5, 5.1, 5.2, 5.4, 5.5
 */

import { formatPreflightFailures, runPreflightChecks } from '../infra/preflight.js';
import { cdkConfigContextArgs, loadDeployConfig } from './config-file.js';
import {
  EXIT_FAILURE,
  EXIT_SESSION_INVALID,
  SSO_LOGIN_ADVICE,
  errorMessage,
  isCredentialFailure,
} from './exit-codes.js';
import type { CliContext } from './ports.js';
import { bundleShimForCdk } from './shim-bundle.js';

/** `plan` takes no arguments, so it can never be under-supplied. */
export const PLAN_USAGE = 'Usage: phorma-aws plan';
export const PLAN_ARITY = 0;

export async function runPlan(ctx: CliContext): Promise<number> {
  const loaded = loadDeployConfig(ctx);
  if (!loaded.ok) return EXIT_FAILURE;
  const config = loaded.config;

  let preflight;
  try {
    preflight = await runPreflightChecks(config, ctx.describeBackend, {
      dockerProbe: ctx.dockerProbe,
    });
  } catch (err) {
    // A describe call that FAILED is not the same as a prerequisite that is
    // absent, so it is never reported as one. An expired session takes exit 4 so
    // the Studio can name `aws sso login` uniformly with `doctor`.
    ctx.io.err(`Preflight could not complete: ${errorMessage(err)}\n`);
    if (isCredentialFailure(err)) {
      ctx.io.err(`${SSO_LOGIN_ADVICE}\n`);
      return EXIT_SESSION_INVALID;
    }
    return EXIT_FAILURE;
  }

  if (!preflight.passed) {
    ctx.io.err(`${formatPreflightFailures(preflight)}\n`);
    ctx.io.err('Preflight failed, so no cdk diff step ran.\n');
    return EXIT_FAILURE;
  }

  ctx.io.out('Preflight checks passed.\n');

  // `cdk diff` synthesizes, so the Schedule_Shim asset has to exist first.
  const bundled = await bundleShimForCdk(ctx);
  if (!bundled.ok) return bundled.code;

  return ctx.commands.run('npx', ['cdk', 'diff', ...cdkConfigContextArgs(config)], ctx.root);
}
