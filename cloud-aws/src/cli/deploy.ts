/**
 * The `deploy` verb: Preflight, `cdk deploy`, then the endpoint envelope.
 *
 * Preflight runs first here for the same reason it does in `plan`: a failure means
 * no `cdk deploy` step runs at all (Req 5.5), and the Docker probe is the only
 * check that can catch a missing daemon before a `DockerImageAsset` build starts.
 *
 * The deploy itself carries `--require-approval never`, because the Studio has
 * already asked the operator through `ConfirmDialogService` and a child process
 * with no TTY cannot answer a CDK prompt. `--outputs-file` writes the stack's
 * outputs to a fresh temporary directory, which is then read and re-emitted as one
 * Sentinel_Envelope so the Studio can persist the two endpoints without parsing
 * CDK's console output (Req 9.2).
 *
 * A successful deploy that returns fewer than both outputs still exits 0: the
 * infrastructure IS deployed. The missing output is named on stderr, and the
 * envelope simply omits that field, which is what makes the Studio leave the
 * previously stored value untouched (Req 9.4).
 *
 * Feature: aws-byo-deploy
 * Requirements: 4.5, 5.5, 9.1, 9.2, 9.4, 10.4
 */

import { join } from 'node:path';

import { MONITOR_API_OUTPUT, REQUIRED_OUTPUTS, TRIGGER_API_OUTPUT } from '../core/outputs.js';
import { encodeSentinelEnvelope, type SentinelPayload } from '../core/sentinel.js';
import { formatPreflightFailures, runPreflightChecks } from '../infra/preflight.js';
import { cdkConfigContextArgs, loadDeployConfig, stackNameOf } from './config-file.js';
import {
  EXIT_FAILURE,
  EXIT_SESSION_INVALID,
  SSO_LOGIN_ADVICE,
  errorMessage,
  isCredentialFailure,
} from './exit-codes.js';
import type { CliContext } from './ports.js';
import { bundleShimForCdk } from './shim-bundle.js';

/** `deploy` takes no arguments, so it can never be under-supplied. */
export const DEPLOY_USAGE = 'Usage: phorma-aws deploy';
export const DEPLOY_ARITY = 0;

/** The file name `--outputs-file` writes inside the fresh temporary directory. */
export const OUTPUTS_FILE_NAME = 'outputs.json';

export async function runDeploy(ctx: CliContext): Promise<number> {
  const loaded = loadDeployConfig(ctx);
  if (!loaded.ok) return EXIT_FAILURE;
  const config = loaded.config;

  let preflight;
  try {
    preflight = await runPreflightChecks(config, ctx.describeBackend, {
      dockerProbe: ctx.dockerProbe,
    });
  } catch (err) {
    ctx.io.err(`Preflight could not complete: ${errorMessage(err)}\n`);
    if (isCredentialFailure(err)) {
      ctx.io.err(`${SSO_LOGIN_ADVICE}\n`);
      return EXIT_SESSION_INVALID;
    }
    return EXIT_FAILURE;
  }

  if (!preflight.passed) {
    ctx.io.err(`${formatPreflightFailures(preflight)}\n`);
    ctx.io.err('Preflight failed, so no cdk deploy step ran.\n');
    return EXIT_FAILURE;
  }

  ctx.io.out('Preflight checks passed.\n');

  // Built before `cdk deploy` synthesizes, and after Preflight so a missing
  // prerequisite is still reported without paying for a bundle first.
  const bundled = await bundleShimForCdk(ctx);
  if (!bundled.ok) return bundled.code;

  const outputsPath = join(ctx.files.makeTempDir(), OUTPUTS_FILE_NAME);
  const code = await ctx.commands.run(
    'npx',
    [
      'cdk',
      'deploy',
      '--require-approval',
      'never',
      '--outputs-file',
      outputsPath,
      ...cdkConfigContextArgs(config),
    ],
    ctx.root,
  );
  if (code !== 0) return code;

  emitDeployOutputs(ctx, readOutputsFile(ctx, outputsPath, stackNameOf(config)));
  return code;
}

/**
 * Read the `--outputs-file` document into a flat name-to-value map.
 *
 * CDK writes `{ "<stackName>": { "<OutputKey>": "<value>" } }`. The configured
 * stack is preferred, but every entry is merged, so a deploy whose stack name
 * changed still surfaces its endpoints rather than reporting them missing.
 */
function readOutputsFile(
  ctx: CliContext,
  path: string,
  stackName: string,
): Record<string, string> {
  const text = ctx.files.readText(path);
  if (text === undefined) {
    ctx.io.err(`The deploy wrote no outputs file at ${path}.\n`);
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    ctx.io.err(`The deploy outputs file at ${path} is not valid JSON: ${errorMessage(err)}\n`);
    return {};
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};

  const byStack = parsed as Record<string, unknown>;
  const merged: Record<string, string> = {};
  const stacks = Object.keys(byStack).sort((a, b) =>
    a === stackName ? 1 : b === stackName ? -1 : 0,
  );
  for (const stack of stacks) {
    const outputs = byStack[stack];
    if (typeof outputs !== 'object' || outputs === null || Array.isArray(outputs)) continue;
    for (const [key, value] of Object.entries(outputs as Record<string, unknown>)) {
      if (typeof value === 'string') merged[key] = value;
    }
  }
  return merged;
}

/**
 * Emit the one `deploy-outputs` envelope, naming any required output the stack did
 * not return (Req 9.4). Encoding goes through `core/sentinel.ts` and the output
 * names come from `core/outputs.ts`, so neither is restated here.
 */
function emitDeployOutputs(ctx: CliContext, outputs: Record<string, string>): void {
  const missing = REQUIRED_OUTPUTS.filter((name) => outputs[name] === undefined);
  const payload: SentinelPayload = {
    kind: 'deploy-outputs',
    triggerApiUrl: outputs[TRIGGER_API_OUTPUT],
    monitorApiUrl: outputs[MONITOR_API_OUTPUT],
  };
  for (const line of encodeSentinelEnvelope(payload)) ctx.io.out(`${line}\n`);
  if (missing.length > 0) {
    ctx.io.err(`The stack returned no value for ${missing.join(' and ')}.\n`);
  }
}
