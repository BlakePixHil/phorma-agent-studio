/**
 * Deploy_Config_File load, shared by all six verbs.
 *
 * One `JSON.parse` and one call into `core/config.ts` (Req 3.1, 3.3). This module
 * exists so the parse-and-report sequence is written once, NOT so a second parser
 * can live here: every field rule stays in `parseAwsDeployConfig`, and the
 * `$generatedBy` provenance member the AWS_Config_Store writes is ignored there
 * rather than stripped here. There is no comment-stripping step, because the
 * Deploy_Config_File carries no comments (Req 3.2, 3.5).
 *
 * A rejected config writes the `ConfigError` message to stderr and yields a
 * non-zero code (Req 3.4). An ABSENT file yields a distinguishable outcome, so
 * `doctor` can report exit 2 for it while the other verbs report exit 1.
 *
 * Feature: aws-byo-deploy
 * Requirements: 3.1, 3.3, 3.4, 5.6
 */

import { join } from 'node:path';

import { ConfigError, parseAwsDeployConfig, type AwsDeployConfig } from '../core/config.js';
import { EXIT_CONFIG_ABSENT, EXIT_FAILURE, errorMessage } from './exit-codes.js';
import type { CliContext } from './ports.js';

/** The Deploy_Config_File name, beside `cdk.json` in the package root. */
export const CONFIG_FILE_NAME = 'cdk.context.phorma.json';

/** The CDK entry point `doctor` checks for (Req 5.6). */
export const CDK_ENTRY_POINT = 'src/infra/app.ts';

export type ConfigLoadResult =
  | { ok: true; config: AwsDeployConfig }
  /** `absent` distinguishes the missing file from a file that failed to parse. */
  | { ok: false; absent: boolean; exitCode: number };

/** Absolute path of the Deploy_Config_File for this context. */
export function configFilePath(ctx: CliContext): string {
  return join(ctx.root, CONFIG_FILE_NAME);
}

/** Absolute path of the CDK entry point for this context. */
export function cdkEntryPointPath(ctx: CliContext): string {
  return join(ctx.root, CDK_ENTRY_POINT);
}

/**
 * Read, parse and validate the Deploy_Config_File, reporting to stderr on
 * failure.
 *
 * `exitCode` is `EXIT_CONFIG_ABSENT` when the file is missing and `EXIT_FAILURE`
 * when it is present but unusable. Only `doctor` propagates the former; the other
 * verbs override it, because a missing config file is not a distinct operator
 * action for them - it is one more reason the verb cannot run.
 */
export function loadDeployConfig(ctx: CliContext): ConfigLoadResult {
  const path = configFilePath(ctx);
  const text = ctx.files.readText(path);
  if (text === undefined) {
    ctx.io.err(
      `${CONFIG_FILE_NAME} not found at ${path}. ` +
        'Configure the AWS deploy target in Settings then Cloud, which writes this file.\n',
    );
    return { ok: false, absent: true, exitCode: EXIT_CONFIG_ABSENT };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    ctx.io.err(`${CONFIG_FILE_NAME} is not valid JSON: ${errorMessage(err)}\n`);
    return { ok: false, absent: false, exitCode: EXIT_FAILURE };
  }

  try {
    return { ok: true, config: parseAwsDeployConfig(raw) };
  } catch (err) {
    const label = err instanceof ConfigError ? 'ConfigError' : 'Error';
    ctx.io.err(`${label}: ${errorMessage(err)}\n`);
    return { ok: false, absent: false, exitCode: EXIT_FAILURE };
  }
}

/**
 * The `--context phorma:config=<json>` argument every `cdk` step carries.
 *
 * The config travels as context rather than being re-read by `infra/app.ts`, so
 * the values the verb validated are exactly the values that synthesize.
 */
export function cdkConfigContextArgs(config: AwsDeployConfig): string[] {
  return ['--context', `phorma:config=${JSON.stringify(config)}`];
}

/** The CloudFormation stack name the IaC_App deploys under (`infra/app.ts`). */
export function stackNameOf(config: AwsDeployConfig): string {
  return `${config.namePrefix}-host`;
}
