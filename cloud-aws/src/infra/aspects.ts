/**
 * Synthesis-time Aspects - six guardrails that fail CDK synthesis on a policy
 * violation rather than leaving it for a review finding.
 *
 * Each Aspect is a PURE FUNCTION over the construct tree: it reads node
 * properties, calls `Annotations.of(node).addError(message)` on violations,
 * and creates no resource. This purity allows Property 29 to drive them
 * against fast-check-generated construct trees.
 *
 * Requirements: 9.5, 9.11, 11.1, 12.5, 12.6, 12.7, 13.4, 13.5, 15.8
 */
import { IAspect, Annotations } from 'aws-cdk-lib';
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import { IConstruct } from 'constructs';

// ---------------------------------------------------------------------------
// 1. PermissionsBoundaryAspect (Req 13.4, 13.5)
// ---------------------------------------------------------------------------

/**
 * Fails synthesis when any IAM role lacks the configured permissions boundary.
 * If no boundary ARN is provided at construction time, every role fails.
 */
export class PermissionsBoundaryAspect implements IAspect {
  constructor(private readonly boundaryArn: string | undefined) {}

  visit(node: IConstruct): void {
    if (node instanceof iam.CfnRole) {
      if (!this.boundaryArn) {
        Annotations.of(node).addError(
          `[PermissionsBoundaryAspect] Role '${node.roleName ?? node.node.path}' cannot be created: no permissions boundary is configured.`,
        );
        return;
      }
      const boundary = node.permissionsBoundary;
      if (!boundary) {
        Annotations.of(node).addError(
          `[PermissionsBoundaryAspect] Role '${node.roleName ?? node.node.path}' is missing the required permissions boundary '${this.boundaryArn}'.`,
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 2. CustomerKeyAspect (Req 11.1)
// ---------------------------------------------------------------------------

/**
 * Fails synthesis when Run_Table, a secret, a log group or the ECR repo
 * synthesizes without the App_CMK.
 */
export class CustomerKeyAspect implements IAspect {
  visit(node: IConstruct): void {
    if (node instanceof dynamodb.CfnTable) {
      const sse = node.sseSpecification as
        | dynamodb.CfnTable.SSESpecificationProperty
        | undefined;
      if (!sse || !isEnabled(sse) || !hasKmsKey(sse)) {
        Annotations.of(node).addError(
          `[CustomerKeyAspect] Table '${node.tableName ?? node.node.path}' must use a customer-managed KMS key (App_CMK) for encryption.`,
        );
      }
    }

    if (node instanceof secretsmanager.CfnSecret) {
      if (!node.kmsKeyId) {
        Annotations.of(node).addError(
          `[CustomerKeyAspect] Secret '${node.name ?? node.node.path}' must use a customer-managed KMS key (App_CMK) for encryption.`,
        );
      }
    }

    if (node instanceof logs.CfnLogGroup) {
      if (!node.kmsKeyId) {
        Annotations.of(node).addError(
          `[CustomerKeyAspect] Log group '${node.logGroupName ?? node.node.path}' must use a customer-managed KMS key (App_CMK) for encryption.`,
        );
      }
    }

    if (node instanceof ecr.CfnRepository) {
      const enc = node.encryptionConfiguration as
        | ecr.CfnRepository.EncryptionConfigurationProperty
        | undefined;
      if (!enc || !hasKmsEncryption(enc)) {
        Annotations.of(node).addError(
          `[CustomerKeyAspect] ECR repository '${node.repositoryName ?? node.node.path}' must use a customer-managed KMS key (App_CMK) for encryption.`,
        );
      }
    }
  }
}

/** Check if SSE is enabled. */
function isEnabled(
  sse: dynamodb.CfnTable.SSESpecificationProperty,
): boolean {
  return sse.sseEnabled === true;
}

/** Check if SSE specifies a KMS key. */
function hasKmsKey(
  sse: dynamodb.CfnTable.SSESpecificationProperty,
): boolean {
  return !!(sse as { kmsMasterKeyId?: unknown }).kmsMasterKeyId;
}

/** Check if ECR encryption is KMS-based. */
function hasKmsEncryption(
  enc: ecr.CfnRepository.EncryptionConfigurationProperty,
): boolean {
  return enc.encryptionType === 'KMS' && !!(enc as { kmsKey?: unknown }).kmsKey;
}

// ---------------------------------------------------------------------------
// 3. AuthorizerAspect (Req 9.5, 9.11)
// ---------------------------------------------------------------------------

/**
 * Fails synthesis when an API route has no authorizer configured.
 *
 * WebSocket $disconnect and $default routes are exempt (authorization happens
 * at $connect). Portal routes with explicit unauthenticated opt-in are also
 * exempt - identified by having 'NONE' as the auth type.
 */
export class AuthorizerAspect implements IAspect {
  visit(node: IConstruct): void {
    if (node instanceof apigwv2.CfnRoute) {
      const routeKey = node.routeKey ?? '';
      // WebSocket $disconnect and $default don't need auth (auth is on $connect)
      if (routeKey === '$disconnect' || routeKey === '$default') {
        return;
      }
      const authType = node.authorizationType;
      if (!authType || authType === 'NONE') {
        // Check if this is an explicit portal opt-in (metadata marker)
        const portalOptIn = node.node.tryGetContext('phorma:unauthenticated') === true;
        if (!portalOptIn) {
          Annotations.of(node).addError(
            `[AuthorizerAspect] Route '${routeKey}' at '${node.node.path}' has no authorizer configured. Every route must have an authorizer or an explicit unauthenticated opt-in.`,
          );
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 4. NoIamUserAspect (Req 15.8)
// ---------------------------------------------------------------------------

/**
 * Fails synthesis when the template declares an IAM user or an access key.
 */
export class NoIamUserAspect implements IAspect {
  visit(node: IConstruct): void {
    if (node instanceof iam.CfnUser) {
      Annotations.of(node).addError(
        `[NoIamUserAspect] IAM user '${node.userName ?? node.node.path}' must not exist in the template. Use IAM roles instead.`,
      );
    }
    if (node instanceof iam.CfnAccessKey) {
      Annotations.of(node).addError(
        `[NoIamUserAspect] IAM access key at '${node.node.path}' must not exist in the template. Long-lived credentials are prohibited.`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// 5. AlarmTargetAspect (Req 12.5)
// ---------------------------------------------------------------------------

/**
 * Fails synthesis when an alarm has no notification target configured.
 */
export class AlarmTargetAspect implements IAspect {
  visit(node: IConstruct): void {
    if (node instanceof cloudwatch.CfnAlarm) {
      const hasAlarmActions = node.alarmActions && node.alarmActions.length > 0;
      if (!hasAlarmActions) {
        Annotations.of(node).addError(
          `[AlarmTargetAspect] Alarm '${node.alarmName ?? node.node.path}' has no notification target configured. Every alarm must have at least one alarm action.`,
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 6. TagAspect (Req 12.6, 12.7)
// ---------------------------------------------------------------------------

/**
 * Fails synthesis when a taggable resource is missing the configured tag set
 * or any tag value is empty.
 */
export class TagAspect implements IAspect {
  constructor(private readonly requiredTags: Record<string, string>) {}

  visit(node: IConstruct): void {
    // CfnResource is the L1 base for all CloudFormation resources
    if (!isCfnResource(node)) return;

    const tags = getResourceTags(node);
    if (!tags) {
      // Not a taggable resource - skip
      return;
    }

    for (const [key] of Object.entries(this.requiredTags)) {
      const tag = tags.find(
        (t: { key?: string; Key?: string }) => (t.key ?? t.Key) === key,
      );
      if (!tag) {
        Annotations.of(node).addError(
          `[TagAspect] Resource '${node.node.path}' is missing required tag '${key}'.`,
        );
        continue;
      }
      const value = (tag as Record<string, unknown>).value ?? (tag as Record<string, unknown>).Value;
      if (!value || (typeof value === 'string' && value.trim() === '')) {
        Annotations.of(node).addError(
          `[TagAspect] Resource '${node.node.path}' has an empty value for required tag '${key}'.`,
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Type guard for CfnResource instances. */
function isCfnResource(node: IConstruct): node is cdk.CfnResource {
  return node instanceof cdk.CfnResource;
}

/**
 * Check if a CfnResource has tags. Uses the TagManager exposed by CDK's
 * taggable protocol when available, or falls back to inspecting the
 * synthesized `cfnProperties` via `stack.resolve`.
 */
function getResourceTags(
  resource: cdk.CfnResource,
): Array<{ key?: string; Key?: string; value?: string; Value?: string }> | null {
  // CDK exposes tags through cdk.TagManager if the resource is taggable.
  // The CfnResource has a `tags` getter if the resource type supports tags.
  const taggable = resource as unknown as { tags?: cdk.TagManager; tagsRaw?: unknown[] };
  if (taggable.tags && taggable.tags instanceof cdk.TagManager) {
    const rendered = taggable.tags.renderTags();
    if (Array.isArray(rendered)) {
      return rendered as Array<{ key?: string; Key?: string; value?: string; Value?: string }>;
    }
  }
  if (Array.isArray(taggable.tagsRaw)) {
    return taggable.tagsRaw as Array<{ key?: string; Key?: string; value?: string; Value?: string }>;
  }
  return null;
}
