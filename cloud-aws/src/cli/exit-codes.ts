/**
 * The exit codes the Studio reads, and the credential-failure classifier that
 * decides when code 4 applies.
 *
 * Requirement 5.6 fixes the `doctor` codes: 0 pass, 2 Deploy_Config_File absent,
 * 3 CDK entry point absent, 4 session invalid or expired. Requirement 10.7 makes
 * 4 the code the AWS_CLI_Service maps to "run `aws sso login`", so `request`,
 * `outputs`, `plan` and `deploy` reserve the SAME code for a credential
 * resolution or `ExpiredToken` failure. One code, one operator instruction,
 * whichever verb hit it.
 *
 * Feature: aws-byo-deploy
 * Requirements: 5.6, 10.7
 */

/** Every check passed. */
export const EXIT_OK = 0;

/**
 * A failure that is neither a missing prerequisite file nor an expired session:
 * a preflight failure, a non-zero `cdk` step, an under-supplied verb, a rejected
 * config, a transport error.
 */
export const EXIT_FAILURE = 1;

/** `doctor` only: the Deploy_Config_File is absent (Req 5.6). */
export const EXIT_CONFIG_ABSENT = 2;

/** `doctor` only: the CDK entry point is absent (Req 5.6). */
export const EXIT_ENTRY_POINT_ABSENT = 3;

/**
 * The ambient credentials could not be resolved, or the session has expired.
 * The Studio maps this to the `aws sso login` message (Req 5.7, 10.7).
 */
export const EXIT_SESSION_INVALID = 4;

/**
 * The next step every exit-4 path names, so the advice does not depend on which
 * verb produced it. `check-docs.mjs` derives the troubleshooting entry from the
 * `sso login` substring, so keep it verbatim.
 */
export const SSO_LOGIN_ADVICE = 'Run `aws sso login` to renew your session, then try again.';

/**
 * Error names the AWS SDK uses for "we have no usable credentials".
 *
 * `CredentialsProviderError` is what `fromNodeProviderChain()` throws when no
 * provider in the chain yielded anything. The rest are the service-side
 * rejections of a stale or wrong session, which are indistinguishable from the
 * operator's point of view: all five mean re-authenticate.
 */
const CREDENTIAL_ERROR_NAMES = new Set([
  'CredentialsProviderError',
  'ExpiredToken',
  'ExpiredTokenException',
  'InvalidClientTokenId',
  'UnrecognizedClientException',
  'TokenRefreshRequired',
  'AccessDenied',
  'AccessDeniedException',
]);

/**
 * Whether a thrown value is a credential resolution or expiry failure, and so
 * deserves `EXIT_SESSION_INVALID` rather than `EXIT_FAILURE`.
 *
 * Matched by error NAME first, which is the reliable signal. The message is
 * consulted only for `ExpiredToken` and the provider-chain phrasing, because a
 * nested SSO failure sometimes surfaces the cause in the message with a generic
 * name. Nothing broader than that: reading "denied" out of an arbitrary message
 * would map an authorization gap onto "log in again", which is the wrong
 * instruction.
 */
export function isCredentialFailure(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const name = (err as { name?: unknown }).name;
  if (typeof name === 'string' && CREDENTIAL_ERROR_NAMES.has(name)) return true;
  const message = (err as { message?: unknown }).message;
  if (typeof message !== 'string') return false;
  return (
    message.includes('ExpiredToken') ||
    message.includes('Could not load credentials') ||
    message.includes('security token included in the request is expired')
  );
}

/** The message text of a thrown value, without assuming it is an `Error`. */
export function errorMessage(err: unknown): string {
  if (typeof err === 'object' && err !== null) {
    const message = (err as { message?: unknown }).message;
    if (typeof message === 'string' && message.length > 0) return message;
  }
  return String(err);
}
