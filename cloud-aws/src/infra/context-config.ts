/**
 * How the IaC_App reads its Deploy_Config from CDK context.
 *
 * PURE - no I/O, no SDK. Split out of `app.ts` so it can be asserted directly:
 * `app.ts` synthesizes on import, so nothing can import it from a spec.
 *
 * The one non-obvious rule here is that a `--context key=value` argument arrives
 * as a STRING. The CDK CLI splits the assignment and stores the right-hand side
 * verbatim (`parseStringContextListToObject`); only the `context` block in
 * `cdk.json` and `cdk.context.json` carry real JSON values. So the
 * `--context phorma:config=<json>` argument every CLI verb passes
 * (`cli/config-file.ts` `cdkConfigContextArgs`) reaches `tryGetContext` as a JSON
 * string, and a reader that accepts only an object silently ignores it and
 * synthesizes the placeholder - the operator's account, region, name prefix,
 * boundary and image reference all quietly replaced. This module accepts both
 * shapes, and reports a malformed string rather than falling back.
 *
 * Feature: aws-byo-deploy
 * Requirements: 3.1, 3.3, 4.2, 13.5
 */

import { ConfigError, parseAwsDeployConfig, type AwsDeployConfig } from '../core/config.js';

/**
 * The config `cdk synth` uses when no `phorma:config` context is supplied.
 *
 * This is the Check_Pipeline's first synthesis: no operator config exists, so the
 * shape is a syntactically valid placeholder. `imageUri` is deliberately absent,
 * which makes this the Container_Image ASSET path (Req 4.1). The reference path
 * is synthesized separately by `scripts/synth-image-reference.mjs`.
 */
export function placeholderConfig(qualifier: string): AwsDeployConfig {
  return {
    accountId: '000000000000',
    region: 'us-east-1',
    namePrefix: 'phorma-check',
    permissionsBoundaryArn: 'arn:aws:iam::000000000000:policy/placeholder-boundary',
    bootstrapQualifier: qualifier,
    egressAllowList: [],
    costAllocationTags: { app: 'phorma' },
    retentionDays: 30,
    alarmNotificationArn: 'arn:aws:sns:us-east-1:000000000000:placeholder-topic',
  };
}

/**
 * Resolve the Deploy_Config from the `phorma:config` context value.
 *
 * Absent (or blank) yields the placeholder. A string is parsed as JSON first. A
 * value that is present but unusable throws, because synthesizing the placeholder
 * instead of the config the operator supplied is the worst available outcome: the
 * deploy would target account `000000000000` under the name prefix
 * `phorma-check`.
 */
export function configFromContext(raw: unknown, qualifier: string): AwsDeployConfig {
  if (raw === undefined || raw === null) {
    return placeholderConfig(qualifier);
  }

  if (typeof raw === 'string') {
    if (raw.trim().length === 0) {
      return placeholderConfig(qualifier);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new ConfigError(
        `The phorma:config context is not valid JSON: ${detail}`,
      );
    }
    return parseAwsDeployConfig(parsed);
  }

  return parseAwsDeployConfig(raw);
}
