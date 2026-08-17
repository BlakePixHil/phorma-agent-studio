/**
 * The `doctor` verb: three checks, reported BY EXIT CODE (Req 5.6).
 *
 * | Code | Meaning |
 * |---|---|
 * | 0 | Every check passed |
 * | 1 | The Deploy_Config_File is present but the Config_Parser rejected it |
 * | 2 | The Deploy_Config_File is absent |
 * | 3 | The CDK entry point is absent |
 * | 4 | The AWS session is invalid or expired |
 *
 * The codes are the contract, not the wording: `AwsCliService` maps 4 to the
 * `aws sso login` message without reading stderr (Req 5.7). Codes 2, 3 and 4 are
 * ordered from cheapest to most expensive, and the run stops at the first failure -
 * a config file that is not there makes the session check meaningless, because there
 * is no region to run it in.
 *
 * Code 1 is the one code Requirement 5.6 does not fix: a file that parsed as JSON
 * and failed validation is not "absent", so folding it into 2 would tell the Studio
 * to offer the wrong remedy. Its `ConfigError` message reaches stderr instead
 * (Req 3.4).
 *
 * Feature: aws-byo-deploy
 * Requirements: 3.4, 5.6, 5.7, 6.5
 */

import { cdkEntryPointPath, loadDeployConfig } from './config-file.js';
import {
  EXIT_ENTRY_POINT_ABSENT,
  EXIT_OK,
  EXIT_SESSION_INVALID,
  SSO_LOGIN_ADVICE,
  errorMessage,
} from './exit-codes.js';
import type { CliContext } from './ports.js';

/** `doctor` takes no arguments, so it can never be under-supplied. */
export const DOCTOR_USAGE = 'Usage: phorma-aws doctor';
export const DOCTOR_ARITY = 0;

export async function runDoctor(ctx: CliContext): Promise<number> {
  // Check 1: the Deploy_Config_File. Exit 2 when absent, 1 when unusable.
  const loaded = loadDeployConfig(ctx);
  if (!loaded.ok) return loaded.exitCode;
  const config = loaded.config;

  // Check 2: the CDK entry point. Without it every `cdk` step fails with a
  // resolution error that says nothing about the cause.
  const entryPoint = cdkEntryPointPath(ctx);
  if (!ctx.files.exists(entryPoint)) {
    ctx.io.err(`The CDK entry point is missing at ${entryPoint}.\n`);
    return EXIT_ENTRY_POINT_ABSENT;
  }

  // Check 3: the ambient session. The Node provider chain is the only credential
  // source, so this answers exactly the question the operator has (Req 6.5).
  try {
    const identity = await ctx.identity.callerIdentity(config.region);
    ctx.io.out(
      `Session valid in ${config.region}. Account ${identity.account ?? 'unknown'}, ` +
        `identity ${identity.arn ?? 'unknown'}.\n`,
    );
  } catch (err) {
    ctx.io.err(`The AWS session is invalid or expired: ${errorMessage(err)}\n`);
    ctx.io.err(`${SSO_LOGIN_ADVICE}\n`);
    return EXIT_SESSION_INVALID;
  }

  return EXIT_OK;
}
