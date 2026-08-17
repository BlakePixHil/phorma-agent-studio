/**
 * The `request` verb: one SigV4-signed HTTP call to the Trigger_API.
 *
 * Argument positions are a contract with `AwsRequestService`, which spawns
 * `npx phorma-aws request <url> <method>` (Req 10.1). In `process.argv` terms the
 * URL is index 3 and the method index 4; `runVerb` receives `process.argv.slice(2)`,
 * so within THIS argv the verb is index 0, the URL index 1 and the method index 2.
 * The body never appears in the argument list - it arrives on stdin (Req 10.2) -
 * so a request payload can never leak into a process listing.
 *
 * The exit code answers one question only: did an HTTP response come back?
 *
 * - Any response, any status, exits 0 and reports status, headers and body through
 *   the envelope (Req 10.4). A 409 from the trigger route is a fact the caller must
 *   be able to read, not a CLI failure.
 * - A transport failure exits 1.
 * - A credential resolution failure or an `ExpiredToken` exits 4, so the Studio
 *   names `aws sso login` (Req 10.7).
 *
 * Feature: aws-byo-deploy
 * Requirements: 6.4, 6.5, 10.1, 10.2, 10.3, 10.4, 10.7
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

export const REQUEST_USAGE = 'Usage: phorma-aws request <url> <method>';
export const REQUEST_ARITY = 2;

/** Methods that carry no request body, so stdin is never read for them. */
const BODYLESS_METHODS = new Set(['GET', 'HEAD']);

export async function runRequest(ctx: CliContext, argv: readonly string[]): Promise<number> {
  const url = argv[1];
  const method = argv[2];
  if (url === undefined || url === '' || method === undefined || method === '') {
    ctx.io.err(`${REQUEST_USAGE}\n`);
    return EXIT_FAILURE;
  }

  const loaded = loadDeployConfig(ctx);
  if (!loaded.ok) return EXIT_FAILURE;

  const upperMethod = method.toUpperCase();
  const body = BODYLESS_METHODS.has(upperMethod) ? undefined : await ctx.io.readStdin();

  let response;
  try {
    response = await ctx.signer.send({
      url,
      method: upperMethod,
      body,
      // The SIGNING region is always the configured one. Nothing about the URL
      // argument influences it, so a mistyped host cannot redirect a signature.
      region: loaded.config.region,
    });
  } catch (err) {
    ctx.io.err(`The request to ${url} failed: ${errorMessage(err)}\n`);
    if (isCredentialFailure(err)) {
      ctx.io.err(`${SSO_LOGIN_ADVICE}\n`);
      return EXIT_SESSION_INVALID;
    }
    return EXIT_FAILURE;
  }

  const payload: SentinelPayload = {
    kind: 'http-response',
    status: response.status,
    headers: response.headers,
    body: response.body,
  };
  for (const line of encodeSentinelEnvelope(payload)) ctx.io.out(`${line}\n`);

  // An HTTP response arrived, so the verb succeeded whatever the status said.
  return EXIT_OK;
}
