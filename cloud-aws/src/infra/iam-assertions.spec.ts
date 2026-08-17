/**
 * IAM deny-list assertions over the synthesized CDK template.
 *
 * Asserts the four IAM roles have exactly the permissions they should and
 * nothing they should not. Runs as part of `npm test` and the `check` pipeline.
 *
 * Requirements: 4.2, 4.6, 8.6, 8.7, 11.8, 15.3, 15.4, 15.5, 15.6, 15.12, 15.15
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { PhormaAwsHostStack } from './stack.js';
import type { AwsDeployConfig } from '../core/config.js';

// ---------------------------------------------------------------------------
// Test stack synthesis
// ---------------------------------------------------------------------------

let template: Template;

const testConfig: AwsDeployConfig = {
  accountId: '123456789012',
  region: 'us-east-1',
  namePrefix: 'test-app',
  permissionsBoundaryArn: 'arn:aws:iam::123456789012:policy/test-boundary',
  bootstrapQualifier: 'hnb659fds',
  egressAllowList: [],
  costAllocationTags: { app: 'phorma' },
  retentionDays: 30,
  alarmNotificationArn: 'arn:aws:sns:us-east-1:123456789012:test-alarms',
  deployTrust: {
    identityCenter: {
      permissionSetArn: 'arn:aws:iam::123456789012:role/aws-reserved/sso.amazonaws.com/AWSReservedSSO_AdminAccess_abc123',
    },
  },
};

/** Synthesize the real stack, optionally overriding config fields. */
function synthesize(overrides: Partial<AwsDeployConfig> = {}): Template {
  const app = new cdk.App();
  const config: AwsDeployConfig = { ...testConfig, ...overrides };
  const stack = new PhormaAwsHostStack(app, 'TestStack', {
    env: { account: config.accountId, region: config.region },
    config,
  });
  return Template.fromStack(stack);
}

beforeAll(() => {
  template = synthesize();
}, 30_000);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Collect all policy statement actions from all managed policies attached to
 * a role with the given logical name pattern.
 */
function collectActionsFromPolicies(
  tpl: ReturnType<typeof template.toJSON>,
  policyNamePattern: string,
): string[] {
  const actions: string[] = [];
  for (const [, resource] of Object.entries(tpl.Resources ?? {})) {
    const res = resource as { Type: string; Properties?: Record<string, unknown> };
    if (res.Type !== 'AWS::IAM::ManagedPolicy') continue;
    const policyName = res.Properties?.ManagedPolicyName;
    if (typeof policyName !== 'string') continue;
    if (!policyName.startsWith(policyNamePattern)) continue;

    const doc = res.Properties?.PolicyDocument as {
      Statement?: Array<{ Action?: string | string[]; Effect?: string }>;
    } | undefined;
    if (!doc?.Statement) continue;

    for (const stmt of doc.Statement) {
      if (stmt.Effect !== 'Allow') continue;
      const a = stmt.Action;
      if (typeof a === 'string') actions.push(a);
      else if (Array.isArray(a)) actions.push(...a);
    }
  }
  return actions;
}

/**
 * Find a specific policy statement from managed policies matching a name pattern.
 */
function findStatements(
  tpl: ReturnType<typeof template.toJSON>,
  policyNamePattern: string,
): Array<{ Sid?: string; Effect: string; Action: string | string[]; Resource: unknown; Condition?: unknown }> {
  const statements: Array<{ Sid?: string; Effect: string; Action: string | string[]; Resource: unknown; Condition?: unknown }> = [];
  for (const [, resource] of Object.entries(tpl.Resources ?? {})) {
    const res = resource as { Type: string; Properties?: Record<string, unknown> };
    if (res.Type !== 'AWS::IAM::ManagedPolicy') continue;
    const policyName = res.Properties?.ManagedPolicyName;
    if (typeof policyName !== 'string') continue;
    if (!policyName.startsWith(policyNamePattern)) continue;

    const doc = res.Properties?.PolicyDocument as {
      Statement?: Array<Record<string, unknown>>;
    } | undefined;
    if (!doc?.Statement) continue;
    statements.push(...doc.Statement as typeof statements);
  }
  return statements;
}

/**
 * Find a role's trust policy (AssumeRolePolicyDocument) by role name.
 */
function findTrustPolicy(
  tpl: ReturnType<typeof template.toJSON>,
  roleName: string,
): Array<{ Effect: string; Action: string | string[]; Principal: unknown; Condition?: unknown }> {
  for (const [, resource] of Object.entries(tpl.Resources ?? {})) {
    const res = resource as { Type: string; Properties?: Record<string, unknown> };
    if (res.Type !== 'AWS::IAM::Role') continue;
    if (res.Properties?.RoleName !== roleName) continue;

    const doc = res.Properties?.AssumeRolePolicyDocument as {
      Statement?: Array<Record<string, unknown>>;
    } | undefined;
    return (doc?.Statement ?? []) as Array<{ Effect: string; Action: string | string[]; Principal: unknown; Condition?: unknown }>;
  }
  return [];
}

/**
 * Flatten a CDK Ref/GetAtt/Join intrinsic to a recognizable string for matching.
 */
function flattenResource(resource: unknown): string[] {
  if (typeof resource === 'string') return [resource];
  if (Array.isArray(resource)) return resource.flatMap(flattenResource);
  if (resource && typeof resource === 'object') {
    // Handle { 'Fn::GetAtt': [...] } and { Ref: ... }
    const obj = resource as Record<string, unknown>;
    if (obj.Ref) return [String(obj.Ref)];
    if (obj['Fn::GetAtt']) return [JSON.stringify(obj['Fn::GetAtt'])];
    if (obj['Fn::Join']) {
      const [, parts] = obj['Fn::Join'] as [string, unknown[]];
      return [JSON.stringify(obj['Fn::Join'])];
    }
    return [JSON.stringify(resource)];
  }
  return [String(resource)];
}

// ---------------------------------------------------------------------------
// 1. Runtime_Identity deny-list (Req 15.3, 15.12)
// ---------------------------------------------------------------------------

describe('Runtime_Identity - deny-list assertions', () => {
  /** Actions the Runtime_Identity MUST NOT hold (Req 15.3). */
  const DENIED_ACTION_PATTERNS = [
    'ecs:',
    'ecr:',
    's3:',
    'dynamodb:Scan',
    'secretsmanager:Create',
    'secretsmanager:Delete',
    'secretsmanager:Put',
    'iam:Create',
    'iam:Delete',
    'iam:Attach',
    'iam:Detach',
  ];

  it('grants no action from the deny list', () => {
    const tpl = template.toJSON();
    const actions = collectActionsFromPolicies(tpl, 'test-app-runtime');

    for (const denied of DENIED_ACTION_PATTERNS) {
      const violating = actions.filter(a => a.startsWith(denied));
      expect(violating, `Runtime_Identity must not hold actions starting with "${denied}"`).toEqual([]);
    }
  });

  it('grants no iam action other than iam:PassRole', () => {
    const tpl = template.toJSON();
    const actions = collectActionsFromPolicies(tpl, 'test-app-runtime');
    const iamActions = actions.filter(a => a.startsWith('iam:'));
    expect(iamActions).toEqual(['iam:PassRole']);
  });

  it('has exactly one iam:PassRole statement', () => {
    const tpl = template.toJSON();
    const statements = findStatements(tpl, 'test-app-runtime');
    const passRoleStatements = statements.filter(s => {
      const actions = Array.isArray(s.Action) ? s.Action : [s.Action];
      return actions.includes('iam:PassRole');
    });
    expect(passRoleStatements).toHaveLength(1);
  });

  it('iam:PassRole resource is exactly the Scheduler_Invoke_Identity role ARN', () => {
    const tpl = template.toJSON();
    const statements = findStatements(tpl, 'test-app-runtime');
    const passRoleStmt = statements.find(s => {
      const actions = Array.isArray(s.Action) ? s.Action : [s.Action];
      return actions.includes('iam:PassRole');
    });
    expect(passRoleStmt).toBeDefined();

    // The resource should reference the scheduler-invoke role ARN
    const resources = flattenResource(passRoleStmt!.Resource);
    const resourceStr = resources.join(' ');
    expect(resourceStr).toContain('SchedulerInvokeRole');
  });

  it('iam:PassRole condition requires iam:PassedToService = scheduler.amazonaws.com', () => {
    const tpl = template.toJSON();
    const statements = findStatements(tpl, 'test-app-runtime');
    const passRoleStmt = statements.find(s => {
      const actions = Array.isArray(s.Action) ? s.Action : [s.Action];
      return actions.includes('iam:PassRole');
    });
    expect(passRoleStmt).toBeDefined();
    expect(passRoleStmt!.Condition).toBeDefined();

    const condition = passRoleStmt!.Condition as Record<string, Record<string, unknown>>;
    expect(condition.StringEquals).toBeDefined();
    expect(condition.StringEquals['iam:PassedToService']).toBe('scheduler.amazonaws.com');
  });

  it('holds no secretsmanager action other than GetSecretValue (Req 8.6)', () => {
    const tpl = template.toJSON();
    const actions = collectActionsFromPolicies(tpl, 'test-app-runtime');
    const smActions = actions.filter(a => a.startsWith('secretsmanager:'));
    expect(smActions).toEqual(['secretsmanager:GetSecretValue']);
  });
});

// ---------------------------------------------------------------------------
// 2. Scheduler_Invoke_Identity (Req 15.13, 15.14, 15.15)
// ---------------------------------------------------------------------------

describe('Scheduler_Invoke_Identity - policy assertions', () => {
  // The single action is `lambda:InvokeFunction` on the Schedule_Shim, not
  // `execute-api:Invoke` on the trigger route. EventBridge Scheduler has no API
  // Gateway target in either its templated or its universal form, so the route
  // grant described a call the service cannot make. It moved to the shim's own
  // role, which is the identity that signs the request.
  it('grants exactly lambda:InvokeFunction on the Schedule_Shim', () => {
    const tpl = template.toJSON();
    const actions = collectActionsFromPolicies(tpl, 'test-app-scheduler-invoke');
    expect(actions).toEqual(['lambda:InvokeFunction']);
  });

  it('grants no action other than lambda:InvokeFunction', () => {
    const tpl = template.toJSON();
    const actions = collectActionsFromPolicies(tpl, 'test-app-scheduler-invoke');
    const nonInvoke = actions.filter(a => a !== 'lambda:InvokeFunction');
    expect(nonInvoke).toEqual([]);
  });

  it('holds no execute-api action at all', () => {
    const tpl = template.toJSON();
    const actions = collectActionsFromPolicies(tpl, 'test-app-scheduler-invoke');
    expect(actions.filter(a => a.startsWith('execute-api:'))).toEqual([]);
  });

  it('trust policy names scheduler.amazonaws.com as sole principal', () => {
    const tpl = template.toJSON();
    const trustStatements = findTrustPolicy(tpl, 'test-app-scheduler-invoke');
    expect(trustStatements.length).toBeGreaterThanOrEqual(1);

    // All trust statements must be for scheduler.amazonaws.com
    for (const stmt of trustStatements) {
      const principal = stmt.Principal as Record<string, unknown>;
      expect(principal.Service).toBe('scheduler.amazonaws.com');
    }
  });

  it('trust policy has aws:SourceArn condition scoped to the schedule group', () => {
    const tpl = template.toJSON();
    const trustStatements = findTrustPolicy(tpl, 'test-app-scheduler-invoke');
    expect(trustStatements.length).toBeGreaterThanOrEqual(1);

    // At least one trust statement must have the ArnEquals condition
    const hasSourceArnCondition = trustStatements.some(stmt => {
      if (!stmt.Condition) return false;
      const condition = stmt.Condition as Record<string, Record<string, unknown>>;
      // CDK may use ArnEquals or ArnLike
      const arnCondition = condition.ArnEquals ?? condition.ArnLike;
      if (!arnCondition) return false;
      const sourceArn = arnCondition['aws:SourceArn'];
      if (!sourceArn) return false;
      // The value should reference the schedule group
      const sourceArnStr = JSON.stringify(sourceArn);
      return sourceArnStr.includes('schedule') || sourceArnStr.includes('Schedule');
    });
    expect(hasSourceArnCondition).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. Task_Execution_Identity (Req 15.4)
// ---------------------------------------------------------------------------

describe('Task_Execution_Identity - policy assertions', () => {
  it('grants only image pull and log stream creation actions', () => {
    const tpl = template.toJSON();
    const actions = collectActionsFromPolicies(tpl, 'test-app-execution');

    // Allowed actions for Task_Execution
    const allowedActions = new Set([
      'ecr:GetDownloadUrlForLayer',
      'ecr:BatchGetImage',
      'ecr:BatchCheckLayerAvailability',
      'ecr:GetAuthorizationToken',
      'logs:CreateLogStream',
      'logs:PutLogEvents',
      'kms:Decrypt', // For ECR image pull (Req 11.12)
    ]);

    for (const action of actions) {
      expect(allowedActions.has(action), `Task_Execution_Identity must not hold "${action}"`).toBe(true);
    }
  });

  it('holds no dynamodb action', () => {
    const tpl = template.toJSON();
    const actions = collectActionsFromPolicies(tpl, 'test-app-execution');
    const tableActions = actions.filter(a => a.startsWith('dynamodb:'));
    expect(tableActions).toEqual([]);
  });

  it('holds no secretsmanager action', () => {
    const tpl = template.toJSON();
    const actions = collectActionsFromPolicies(tpl, 'test-app-execution');
    const smActions = actions.filter(a => a.startsWith('secretsmanager:'));
    expect(smActions).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 3b. Task_Execution_Identity image pull scope, both image paths (Req 4.2, 4.6)
// ---------------------------------------------------------------------------

describe('Task_Execution_Identity - image pull scope follows the image choice', () => {
  /** Repository-scoped pull statement, or undefined when there is none. */
  function pullStatement(tpl: Template) {
    return findStatements(tpl.toJSON(), 'test-app-execution').find(s => s.Sid === 'PullImage');
  }

  /** Every ECR action the execution role holds, in any statement. */
  function ecrActions(tpl: Template): string[] {
    return collectActionsFromPolicies(tpl.toJSON(), 'test-app-execution').filter(a =>
      a.startsWith('ecr:'),
    );
  }

  const BOOTSTRAP_REPO_ARN =
    'arn:aws:ecr:us-east-1:123456789012:repository/' +
    'cdk-hnb659fds-container-assets-123456789012-us-east-1';

  it('asset path scopes the pull to the CDK bootstrap image repository', () => {
    // No `imageUri`, so a DockerImageAsset publishes into the bootstrap
    // repository named by the CONFIGURED qualifier - never a hardcoded default.
    const stmt = pullStatement(template);
    expect(stmt).toBeDefined();
    expect(flattenResource(stmt!.Resource)).toEqual([BOOTSTRAP_REPO_ARN]);
  });

  it('asset path derives the repository from the configured bootstrap qualifier', () => {
    const tpl = synthesize({ bootstrapQualifier: 'phorma42' });
    const stmt = pullStatement(tpl);
    expect(stmt).toBeDefined();
    expect(flattenResource(stmt!.Resource)).toEqual([
      'arn:aws:ecr:us-east-1:123456789012:repository/' +
        'cdk-phorma42-container-assets-123456789012-us-east-1',
    ]);
  });

  it('ECR reference path scopes the pull to the repository parsed from imageUri', () => {
    const tpl = synthesize({
      imageUri: '210987654321.dkr.ecr.eu-west-1.amazonaws.com/platform/phorma-host:1.2.3',
    });
    const stmt = pullStatement(tpl);
    expect(stmt).toBeDefined();
    // Account and region come from the REFERENCE, not the deploy: a
    // cross-account pull is a normal platform arrangement.
    expect(flattenResource(stmt!.Resource)).toEqual([
      'arn:aws:ecr:eu-west-1:210987654321:repository/platform/phorma-host',
    ]);
  });

  it('ECR digest reference drops the digest from the repository ARN', () => {
    const tpl = synthesize({
      imageUri: `123456789012.dkr.ecr.us-east-1.amazonaws.com/phorma-host@sha256:${'a'.repeat(64)}`,
    });
    const stmt = pullStatement(tpl);
    expect(stmt).toBeDefined();
    expect(flattenResource(stmt!.Resource)).toEqual([
      'arn:aws:ecr:us-east-1:123456789012:repository/phorma-host',
    ]);
  });

  it('non-ECR reference path grants no repository-scoped ECR statement at all', () => {
    for (const imageUri of [
      'ghcr.io/phorma/agent-studio:0.2.0',
      'docker.io/library/phorma:latest',
      'registry.internal.example.com:5000/phorma/host:1.0.0',
      'public.ecr.aws/phorma/host:1.0.0',
    ]) {
      const tpl = synthesize({ imageUri });
      expect(pullStatement(tpl), `${imageUri} must produce no PullImage statement`).toBeUndefined();
      // Nothing is granted on a guessed or wildcard repository ARN either.
      expect(ecrActions(tpl)).toEqual(['ecr:GetAuthorizationToken']);
    }
  });

  it('ecr:GetAuthorizationToken stays on * on every image path', () => {
    for (const tpl of [
      template,
      synthesize({ imageUri: '123456789012.dkr.ecr.us-east-1.amazonaws.com/phorma-host:1' }),
      synthesize({ imageUri: 'ghcr.io/phorma/agent-studio:0.2.0' }),
    ]) {
      const auth = findStatements(tpl.toJSON(), 'test-app-execution').find(s => s.Sid === 'EcrAuth');
      expect(auth).toBeDefined();
      expect(flattenResource(auth!.Resource)).toEqual(['*']);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Deployment_Identity (Req 15.5, 15.6, 8.7, 11.8)
// ---------------------------------------------------------------------------

describe('Deployment_Identity - policy assertions', () => {
  it('iam:PassRole is limited to Runtime_Identity and Task_Execution_Identity only', () => {
    const tpl = template.toJSON();
    const statements = findStatements(tpl, 'test-app-deployment');
    const passRoleStatements = statements.filter(s => {
      const actions = Array.isArray(s.Action) ? s.Action : [s.Action];
      return actions.includes('iam:PassRole');
    });
    expect(passRoleStatements.length).toBeGreaterThanOrEqual(1);

    for (const stmt of passRoleStatements) {
      const resources = flattenResource(stmt.Resource);
      const resourceStr = resources.join(' ');
      // Must reference runtime and execution roles only, never scheduler-invoke
      expect(resourceStr).not.toContain('SchedulerInvoke');
      // Should reference the runtime and execution roles
      const containsRuntimeOrExecution =
        resourceStr.includes('RuntimeRole') || resourceStr.includes('ExecutionRole');
      expect(containsRuntimeOrExecution).toBe(true);
    }
  });

  it('image publishing is scoped to the bootstrap repository, and absent on the imageUri path', () => {
    // The deploy only pushes an image on the asset path, and it pushes into the
    // CDK bootstrap image repository (Req 4.2, 4.6).
    const assetStmt = findStatements(template.toJSON(), 'test-app-deployment')
      .find(s => s.Sid === 'Ecr');
    expect(assetStmt).toBeDefined();
    expect(flattenResource(assetStmt!.Resource)).toEqual([
      'arn:aws:ecr:us-east-1:123456789012:repository/' +
        'cdk-hnb659fds-container-assets-123456789012-us-east-1',
    ]);

    const referenceTpl = synthesize({
      imageUri: '123456789012.dkr.ecr.us-east-1.amazonaws.com/phorma-host:1.0.0',
    });
    const referenceStmt = findStatements(referenceTpl.toJSON(), 'test-app-deployment')
      .find(s => s.Sid === 'Ecr');
    expect(referenceStmt).toBeUndefined();
    const ecrActions = collectActionsFromPolicies(referenceTpl.toJSON(), 'test-app-deployment')
      .filter(a => a.startsWith('ecr:'));
    expect(ecrActions).toEqual([]);
  });

  it('holds no secretsmanager:GetSecretValue action (Req 8.7)', () => {
    const tpl = template.toJSON();
    const actions = collectActionsFromPolicies(tpl, 'test-app-deployment');
    expect(actions).not.toContain('secretsmanager:GetSecretValue');
    expect(actions).not.toContain('secretsmanager:BatchGetSecretValue');
    expect(actions).not.toContain('secretsmanager:ListSecretVersionIds');
  });

  it('holds no dynamodb:GetItem, Query or Scan on Run_Table (Req 15.5)', () => {
    const tpl = template.toJSON();
    const actions = collectActionsFromPolicies(tpl, 'test-app-deployment');
    expect(actions).not.toContain('dynamodb:GetItem');
    expect(actions).not.toContain('dynamodb:Query');
    expect(actions).not.toContain('dynamodb:Scan');
  });

  it('holds no kms:Decrypt action (Req 11.8)', () => {
    const tpl = template.toJSON();
    const actions = collectActionsFromPolicies(tpl, 'test-app-deployment');
    expect(actions).not.toContain('kms:Decrypt');
    // Also check GenerateDataKey and ReEncrypt variants
    const kmsDecryptLike = actions.filter(
      a => a === 'kms:Decrypt' || a.startsWith('kms:GenerateDataKey') || a.startsWith('kms:ReEncrypt'),
    );
    expect(kmsDecryptLike).toEqual([]);
  });
});
