/**
 * The `monitor-url` verb: a presigned Monitor_API `$connect` URL.
 *
 * The webview holds no AWS credentials, and a browser `WebSocket` cannot carry a
 * SigV4 `Authorization` header, so the only way to open an IAM-authorized socket
 * is a URL whose signature lives in its query string. `workflowId` is part of that
 * SIGNED query string, not appended afterwards, or the signature would not cover it
 * and API Gateway would reject the connect (Req 11.2).
 *
 * The expiry is 300 seconds by design, not by configuration. It is short enough
 * that a leaked URL is worth little, and the Studio presigns afresh on every
 * reconnect attempt, so an expired URL recovers on its own (Req 11.8).
 *
 * The workflow id is at `process.argv` index 3, which is index 1 of the argv this
 * verb receives.
 *
 * Feature: aws-byo-deploy
 * Requirements: 6.4, 6.5, 11.1, 11.2, 11.8
 */

import { encodeSentinelEnvelope, type SentinelPayload } from '../core/sentinel.js';
import { loadDeployConfig } from './config-file.js';
import {
  EXIT_FAILURE,
  EXIT_OK,
  EXIT_SESSION_INVALID,
  SSO_LOGIN_ADVICE,
  errorMessage,
  isCredentialFailure,
} from './exit-codes.js';
import type { CliContext } from './ports.js';

export const MONITOR_URL_USAGE = 'Usage: phorma-aws monitor-url <workflowId>';
export const MONITOR_URL_ARITY = 1;

/** Presign validity, seconds (Req 11.2). */
export const MONITOR_URL_EXPIRES_IN_SEC = 300;

export async function runMonitorUrl(ctx: CliContext, argv: readonly string[]): Promise<number> {
  const workflowId = argv[1];
  if (workflowId === undefined || workflowId === '') {
    ctx.io.err(`${MONITOR_URL_USAGE}\n`);
    return EXIT_FAILURE;
  }

  const loaded = loadDeployConfig(ctx);
  if (!loaded.ok) return EXIT_FAILURE;
  const config = loaded.config;

  // The Monitor_API URL is a DISCOVERED value: it exists only after a deploy has
  // reported its outputs, so an absent one means "not deployed yet" rather than a
  // malformed configuration.
  if (config.monitorApiUrl === undefined) {
    ctx.io.err(
      'monitorApiUrl is not set in cdk.context.phorma.json. ' +
        'Deploy the stack, or run the outputs verb, so the endpoint is discovered.\n',
    );
    return EXIT_FAILURE;
  }

  let url: string;
  try {
    url = await ctx.signer.presign({
      url: config.monitorApiUrl,
      region: config.region,
      query: { workflowId },
      expiresInSec: MONITOR_URL_EXPIRES_IN_SEC,
    });
  } catch (err) {
    ctx.io.err(`Could not presign the monitor URL: ${errorMessage(err)}\n`);
    if (isCredentialFailure(err)) {
      ctx.io.err(`${SSO_LOGIN_ADVICE}\n`);
      return EXIT_SESSION_INVALID;
    }
    return EXIT_FAILURE;
  }

  const payload: SentinelPayload = { kind: 'monitor-url', url };
  for (const line of encodeSentinelEnvelope(payload)) ctx.io.out(`${line}\n`);
  return EXIT_OK;
}
