/**
 * Container_Image source decision.
 *
 * PURE - no AWS SDK import, no I/O, no `node:` import. The switch between
 * "build the image from the repository Dockerfile" and "reference an image the
 * platform already published" is a total function over the parsed
 * configuration, so the IaC_App reads it once and never re-derives it.
 *
 * Requirements: 4.1, 4.2
 */

import type { AwsDeployConfig } from './config.js';

/** The Dockerfile the asset path builds, relative to the repository root. */
export const HOST_DOCKERFILE = 'cloud-aws/Dockerfile' as const;

/**
 * Exactly two outcomes exist. There is no third shape and no undefined
 * result: `resolveContainerImage` is total.
 */
export type ContainerImageChoice =
  | { kind: 'asset'; dockerfile: 'cloud-aws/Dockerfile' }
  | { kind: 'reference'; imageUri: string };

/**
 * Decide where the Fargate task's Container_Image comes from.
 *
 * - `imageUri` absent -> `asset`: a CDK Docker image asset built from
 *   `cloud-aws/Dockerfile` (Req 4.1).
 * - `imageUri` present -> `reference`: that reference verbatim, and no ECR
 *   repository is created (Req 4.2).
 *
 * A blank or whitespace-only `imageUri` counts as ABSENT and yields the asset
 * choice. An empty string in `cdk.context.phorma.json` is an operator slip
 * (a cleared form field serialized as `""`), never an intent to reference an
 * image with no name; treating it as a reference would synthesize a task
 * definition pointing at nothing and fail only at deploy time. The reference
 * value is trimmed so surrounding whitespace cannot reach the registry.
 */
export function resolveContainerImage(config: AwsDeployConfig): ContainerImageChoice {
  const raw = config.imageUri;
  const imageUri = typeof raw === 'string' ? raw.trim() : '';
  if (imageUri.length === 0) {
    return { kind: 'asset', dockerfile: HOST_DOCKERFILE };
  }
  return { kind: 'reference', imageUri };
}
