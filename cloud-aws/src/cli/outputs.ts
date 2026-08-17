/**
 * The `outputs` verb: the same `deploy-outputs` envelope as `deploy`, read from
 * `CloudFormation:DescribeStacks` without deploying anything.
 *
 * Two paths need it. The recovery path in Requirement 9.4: a deploy that exited 0
 * but whose envelope never reached the Studio (a killed stream, a stale window)
 * would otherwise leave the operator copying URLs by hand. And the CI path: a team
 * that deploys from a pipeline still wants the Studio to learn its endpoints.
 *
 * It reads and never writes, so it is safe to offer as a plain refresh control.
 *
 * Feature: aws-byo-deploy
 * Requirements: 9.1, 9.2, 9.4
 */

import { MONITOR_API_OUTPUT, REQUIRED_OUTPUTS, TRIGGER_API_OUTPUT } from '../core/outputs.js';
import { encodeSentinelEnvelope, type SentinelPayload } from '../core/sentinel.js';
import { loadDeployConfig, stackNameOf } from './config-file.js';
import {
  EXIT_FAILURE,
  EXIT_SESSION_INVALID,
  SSO_LOGIN_ADVICE,
  errorMessage,
  isCredentialFailure,
} from './exit-codes.js';
import type { CliContext } from './ports.js';

/** `outputs` takes no arguments, so it can never be under-supplied. */
export const OUTPUTS_USAGE = 'Usage: phorma-aws outputs';
export const OUTPUTS_ARITY = 0;

export async function runOutputs(ctx: CliContext): Promise<number> {
  const loaded = loadDeployConfig(ctx);
  if (!loaded.ok) return EXIT_FAILURE;
  const config = loaded.config;
  const stackName = stackNameOf(config);

  let outputs: Record<string, string> | undefined;
  try {
    outputs = await ctx.stackOutputs.describe(config.region, stackName);
  } catch (err) {
    ctx.io.err(`Could not read the outputs of stack ${stackName}: ${errorMessage(err)}\n`);
    if (isCredentialFailure(err)) {
      ctx.io.err(`${SSO_LOGIN_ADVICE}\n`);
      return EXIT_SESSION_INVALID;
    }
    return EXIT_FAILURE;
  }

  if (outputs === undefined) {
    ctx.io.err(
      `Stack ${stackName} does not exist in ${config.region}. ` +
        'Run a deploy before reading its outputs.\n',
    );
    return EXIT_FAILURE;
  }

  // Same payload, same encoder, same output names as `deploy`, so the Studio has
  // exactly one decoder for both (Req 9.4).
  const found = outputs;
  const missing = REQUIRED_OUTPUTS.filter((name) => found[name] === undefined);
  const payload: SentinelPayload = {
    kind: 'deploy-outputs',
    triggerApiUrl: found[TRIGGER_API_OUTPUT],
    monitorApiUrl: found[MONITOR_API_OUTPUT],
  };
  for (const line of encodeSentinelEnvelope(payload)) ctx.io.out(`${line}\n`);
  if (missing.length > 0) {
    ctx.io.err(`Stack ${stackName} carries no value for ${missing.join(' and ')}.\n`);
  }
  return 0;
}
