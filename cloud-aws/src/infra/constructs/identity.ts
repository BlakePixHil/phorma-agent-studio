/**
 * IdentityConstruct - Four IAM roles with managed policies.
 *
 * Creates the Deployment_Identity, Runtime_Identity, Task_Execution_Identity
 * and Scheduler_Invoke_Identity with the exact permission sets the design's
 * identity table states. All policies are managed policies with prefixed names
 * and no inline policy.
 *
 * Requirements: 4.2, 4.6, 5.8, 15.1, 15.2, 15.3, 15.4, 15.5, 15.6, 15.7, 15.13,
 *   15.14, 13.6
 */
import { Construct } from 'constructs';
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as logs from 'aws-cdk-lib/aws-logs';
import type { AwsDeployConfig, DeployTrustConfig } from '../../core/config.js';
import type { ContainerImageChoice } from '../../core/container-image.js';

export interface IdentityConstructProps {
  config: AwsDeployConfig;
  runTable: dynamodb.Table;
  appCmk: kms.IKey;
  /**
   * Where the Container_Image comes from. The Task_Execution_Identity's
   * repository-scoped ECR grant is derived from it, so the roles cannot name a
   * repository the deploy never pulls from (Req 4.2, 4.6).
   */
  imageChoice: ContainerImageChoice;
  logGroup: logs.ILogGroup;
  monitorApiStageArn: string;
  scheduleGroupArn: string;
  /**
   * The Schedule_Shim function ARN, which is what Scheduler_Invoke_Identity is
   * allowed to invoke.
   *
   * The scheduled-run ROUTE arn is deliberately absent from this construct now.
   * EventBridge Scheduler cannot target an API Gateway route at all, so granting
   * `execute-api:Invoke` here described an invocation that could never happen.
   * That permission moved to the shim's own role in `schedule-shim.ts`, which is
   * the identity that really makes the signed call.
   */
  scheduleShimFunctionArn: string;
  /**
   * The Schedule_Shim's execution role ARN. The Deployment_Identity must be able
   * to pass it when it creates the function.
   */
  scheduleShimRoleArn: string;
}

export class IdentityConstruct extends Construct {
  public readonly runtimeRole: iam.Role;
  public readonly executionRole: iam.Role;
  public readonly deploymentRole: iam.Role;
  public readonly schedulerInvokeRole: iam.Role;

  constructor(scope: Construct, id: string, props: IdentityConstructProps) {
    super(scope, id);

    const {
      config, runTable, appCmk, imageChoice, logGroup,
      monitorApiStageArn, scheduleShimFunctionArn, scheduleShimRoleArn, scheduleGroupArn,
    } = props;
    const prefix = config.namePrefix;
    const stack = cdk.Stack.of(this);

    // The one ECR repository this deploy touches, or `undefined` when the image
    // lives outside ECR. Both the pull grant on Task_Execution_Identity and the
    // publish grant on Deployment_Identity are scoped to it.
    const imageRepositoryArn = imagePullRepositoryArn(imageChoice, {
      account: stack.account,
      region: stack.region,
      bootstrapQualifier: config.bootstrapQualifier,
    });
    const boundary = iam.ManagedPolicy.fromManagedPolicyArn(
      this, 'Boundary', config.permissionsBoundaryArn,
    );

    // -----------------------------------------------------------------------
    // 4. Scheduler_Invoke_Identity (created first - referenced by others)
    // -----------------------------------------------------------------------
    this.schedulerInvokeRole = new iam.Role(this, 'SchedulerInvokeRole', {
      roleName: `${prefix}-scheduler-invoke`,
      assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com', {
        conditions: {
          ArnEquals: {
            'aws:SourceArn': scheduleGroupArn,
          },
        },
      }),
      permissionsBoundary: boundary,
    });

    // Exactly one action: lambda:InvokeFunction on the Schedule_Shim.
    //
    // Previously `execute-api:Invoke` on the scheduled-run route, which was a
    // permission for a call EventBridge Scheduler is incapable of making: it has
    // no API Gateway target in either its templated or its universal form. The
    // single-action shape is unchanged; only the action and resource moved to the
    // hop that actually exists.
    const schedulerInvokePolicy = new iam.ManagedPolicy(this, 'SchedulerInvokePolicy', {
      managedPolicyName: `${prefix}-scheduler-invoke-policy`,
      statements: [
        new iam.PolicyStatement({
          sid: 'InvokeScheduleShim',
          effect: iam.Effect.ALLOW,
          actions: ['lambda:InvokeFunction'],
          resources: [scheduleShimFunctionArn],
        }),
      ],
    });
    this.schedulerInvokeRole.addManagedPolicy(schedulerInvokePolicy);

    // -----------------------------------------------------------------------
    // 2. Runtime_Identity (ECS task role)
    // -----------------------------------------------------------------------
    this.runtimeRole = new iam.Role(this, 'RuntimeRole', {
      roleName: `${prefix}-runtime`,
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      permissionsBoundary: boundary,
    });

    // Run_Table item actions (no Scan)
    const runtimeDataPolicy = new iam.ManagedPolicy(this, 'RuntimeDataPolicy', {
      managedPolicyName: `${prefix}-runtime-data`,
      statements: [
        new iam.PolicyStatement({
          sid: 'RunTableAccess',
          effect: iam.Effect.ALLOW,
          actions: [
            'dynamodb:GetItem',
            'dynamodb:PutItem',
            'dynamodb:UpdateItem',
            'dynamodb:DeleteItem',
            'dynamodb:Query',
            'dynamodb:BatchWriteItem',
          ],
          resources: [
            runTable.tableArn,
            `${runTable.tableArn}/index/*`,
          ],
        }),
      ],
    });
    this.runtimeRole.addManagedPolicy(runtimeDataPolicy);

    // Secrets Manager: GetSecretValue on the app prefix
    const secretsPrefix = `arn:aws:secretsmanager:${stack.region}:${stack.account}:secret:${prefix}/*`;
    const runtimeSecretsPolicy = new iam.ManagedPolicy(this, 'RuntimeSecretsPolicy', {
      managedPolicyName: `${prefix}-runtime-secrets`,
      statements: [
        new iam.PolicyStatement({
          sid: 'GetSecretValue',
          effect: iam.Effect.ALLOW,
          actions: ['secretsmanager:GetSecretValue'],
          resources: [secretsPrefix],
        }),
      ],
    });
    this.runtimeRole.addManagedPolicy(runtimeSecretsPolicy);

    // KMS Decrypt on App_CMK with ViaService condition
    const runtimeKmsPolicy = new iam.ManagedPolicy(this, 'RuntimeKmsPolicy', {
      managedPolicyName: `${prefix}-runtime-kms`,
      statements: [
        new iam.PolicyStatement({
          sid: 'DecryptAppCmk',
          effect: iam.Effect.ALLOW,
          actions: ['kms:Decrypt', 'kms:GenerateDataKey'],
          resources: [appCmk.keyArn],
          conditions: {
            StringEquals: {
              'kms:ViaService': [
                `dynamodb.${stack.region}.amazonaws.com`,
                `secretsmanager.${stack.region}.amazonaws.com`,
                `logs.${stack.region}.amazonaws.com`,
              ],
            },
          },
        }),
      ],
    });
    this.runtimeRole.addManagedPolicy(runtimeKmsPolicy);

    // Monitor_API ManageConnections
    const runtimeMonitorPolicy = new iam.ManagedPolicy(this, 'RuntimeMonitorPolicy', {
      managedPolicyName: `${prefix}-runtime-monitor`,
      statements: [
        new iam.PolicyStatement({
          sid: 'ManageConnections',
          effect: iam.Effect.ALLOW,
          actions: ['execute-api:ManageConnections'],
          resources: [monitorApiStageArn],
        }),
      ],
    });
    this.runtimeRole.addManagedPolicy(runtimeMonitorPolicy);

    // Logs: stream and event writes
    const runtimeLogsPolicy = new iam.ManagedPolicy(this, 'RuntimeLogsPolicy', {
      managedPolicyName: `${prefix}-runtime-logs`,
      statements: [
        new iam.PolicyStatement({
          sid: 'WriteLogs',
          effect: iam.Effect.ALLOW,
          actions: [
            'logs:CreateLogStream',
            'logs:PutLogEvents',
          ],
          resources: [
            logGroup.logGroupArn,
            `${logGroup.logGroupArn}:*`,
          ],
        }),
      ],
    });
    this.runtimeRole.addManagedPolicy(runtimeLogsPolicy);

    // Metrics: PutMetricData in the app namespace
    const runtimeMetricsPolicy = new iam.ManagedPolicy(this, 'RuntimeMetricsPolicy', {
      managedPolicyName: `${prefix}-runtime-metrics`,
      statements: [
        new iam.PolicyStatement({
          sid: 'PublishMetrics',
          effect: iam.Effect.ALLOW,
          actions: ['cloudwatch:PutMetricData'],
          resources: ['*'],
          conditions: {
            StringEquals: {
              'cloudwatch:namespace': `Phorma/${prefix}`,
            },
          },
        }),
      ],
    });
    this.runtimeRole.addManagedPolicy(runtimeMetricsPolicy);

    // Scheduler: create, delete, read on the app schedule group
    const runtimeSchedulerPolicy = new iam.ManagedPolicy(this, 'RuntimeSchedulerPolicy', {
      managedPolicyName: `${prefix}-runtime-scheduler`,
      statements: [
        new iam.PolicyStatement({
          sid: 'ManageSchedules',
          effect: iam.Effect.ALLOW,
          actions: [
            'scheduler:CreateSchedule',
            'scheduler:DeleteSchedule',
            'scheduler:GetSchedule',
            'scheduler:ListSchedules',
          ],
          resources: [
            scheduleGroupArn,
            `arn:aws:scheduler:${stack.region}:${stack.account}:schedule/${prefix}-schedules/*`,
          ],
        }),
      ],
    });
    this.runtimeRole.addManagedPolicy(runtimeSchedulerPolicy);

    // iam:PassRole - exactly one statement, one resource, one condition (Req 15.2, 15.3)
    const runtimePassRolePolicy = new iam.ManagedPolicy(this, 'RuntimePassRolePolicy', {
      managedPolicyName: `${prefix}-runtime-passrole`,
      statements: [
        new iam.PolicyStatement({
          sid: 'PassSchedulerInvokeRole',
          effect: iam.Effect.ALLOW,
          actions: ['iam:PassRole'],
          resources: [this.schedulerInvokeRole.roleArn],
          conditions: {
            StringEquals: {
              'iam:PassedToService': 'scheduler.amazonaws.com',
            },
          },
        }),
      ],
    });
    this.runtimeRole.addManagedPolicy(runtimePassRolePolicy);

    // -----------------------------------------------------------------------
    // 3. Task_Execution_Identity
    // -----------------------------------------------------------------------
    this.executionRole = new iam.Role(this, 'ExecutionRole', {
      roleName: `${prefix}-execution`,
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      permissionsBoundary: boundary,
    });

    // Image pull, scoped to the repository the image choice actually names.
    //
    // `ecr:GetAuthorizationToken` stays on `*` because the API takes no resource:
    // it is granted whether or not the image lives in ECR, since its shape must
    // not depend on parsing a registry hostname the operator controls. The
    // repository-scoped statement is present only when there IS a repository to
    // name - on a non-ECR `imageUri` (ghcr.io, docker.io, a private registry, or
    // public.ecr.aws) the Fargate agent pulls without any `ecr:*` call, so the
    // statement is omitted entirely rather than filled with a guessed ARN or a
    // wildcard. Granting nothing is correct there; granting a malformed ARN would
    // be a silently dead statement, and granting `*` would hand the execution role
    // read access to every repository in the account (Req 4.2, 5.8).
    const executionEcrPolicy = new iam.ManagedPolicy(this, 'ExecutionEcrPolicy', {
      managedPolicyName: `${prefix}-execution-ecr`,
      statements: [
        ...(imageRepositoryArn
          ? [
              new iam.PolicyStatement({
                sid: 'PullImage',
                effect: iam.Effect.ALLOW,
                actions: [
                  'ecr:GetDownloadUrlForLayer',
                  'ecr:BatchGetImage',
                  'ecr:BatchCheckLayerAvailability',
                ],
                resources: [imageRepositoryArn],
              }),
            ]
          : []),
        new iam.PolicyStatement({
          sid: 'EcrAuth',
          effect: iam.Effect.ALLOW,
          actions: ['ecr:GetAuthorizationToken'],
          resources: ['*'],
        }),
      ],
    });
    this.executionRole.addManagedPolicy(executionEcrPolicy);

    // Log stream creation
    const executionLogsPolicy = new iam.ManagedPolicy(this, 'ExecutionLogsPolicy', {
      managedPolicyName: `${prefix}-execution-logs`,
      statements: [
        new iam.PolicyStatement({
          sid: 'CreateLogStream',
          effect: iam.Effect.ALLOW,
          actions: [
            'logs:CreateLogStream',
            'logs:PutLogEvents',
          ],
          resources: [
            logGroup.logGroupArn,
            `${logGroup.logGroupArn}:*`,
          ],
        }),
      ],
    });
    this.executionRole.addManagedPolicy(executionLogsPolicy);

    // KMS for ECR image pull
    const executionKmsPolicy = new iam.ManagedPolicy(this, 'ExecutionKmsPolicy', {
      managedPolicyName: `${prefix}-execution-kms`,
      statements: [
        new iam.PolicyStatement({
          sid: 'DecryptEcrImages',
          effect: iam.Effect.ALLOW,
          actions: ['kms:Decrypt'],
          resources: [appCmk.keyArn],
        }),
      ],
    });
    this.executionRole.addManagedPolicy(executionKmsPolicy);

    // -----------------------------------------------------------------------
    // 1. Deployment_Identity
    // -----------------------------------------------------------------------

    // Build the trust principal from the deployTrust config (Req 15.7)
    const trustPrincipal = buildDeployTrustPrincipal(config.deployTrust, stack);

    this.deploymentRole = new iam.Role(this, 'DeploymentRole', {
      roleName: `${prefix}-deployment`,
      assumedBy: trustPrincipal,
      permissionsBoundary: boundary,
    });

    // CloudFormation, asset staging, IAM role creation, ECS, DynamoDB create, etc.
    const deployPolicy = new iam.ManagedPolicy(this, 'DeployPolicy', {
      managedPolicyName: `${prefix}-deployment-policy`,
      statements: [
        new iam.PolicyStatement({
          sid: 'CloudFormation',
          effect: iam.Effect.ALLOW,
          actions: [
            'cloudformation:*',
          ],
          resources: [
            `arn:aws:cloudformation:${stack.region}:${stack.account}:stack/${prefix}*`,
          ],
        }),
        new iam.PolicyStatement({
          sid: 'AssetStaging',
          effect: iam.Effect.ALLOW,
          actions: ['s3:*'],
          resources: [
            `arn:aws:s3:::cdk-*-assets-${stack.account}-${stack.region}`,
            `arn:aws:s3:::cdk-*-assets-${stack.account}-${stack.region}/*`,
          ],
        }),
        new iam.PolicyStatement({
          sid: 'IamRoleCreation',
          effect: iam.Effect.ALLOW,
          actions: [
            'iam:CreateRole',
            'iam:DeleteRole',
            'iam:GetRole',
            'iam:TagRole',
            'iam:UntagRole',
            'iam:UpdateRole',
            'iam:PutRolePolicy',
            'iam:DeleteRolePolicy',
            'iam:GetRolePolicy',
            'iam:AttachRolePolicy',
            'iam:DetachRolePolicy',
            'iam:ListRolePolicies',
            'iam:ListAttachedRolePolicies',
            'iam:CreatePolicy',
            'iam:DeletePolicy',
            'iam:GetPolicy',
            'iam:GetPolicyVersion',
            'iam:CreatePolicyVersion',
            'iam:DeletePolicyVersion',
            'iam:ListPolicyVersions',
          ],
          resources: [
            `arn:aws:iam::${stack.account}:role/${prefix}-*`,
            `arn:aws:iam::${stack.account}:policy/${prefix}-*`,
          ],
          conditions: {
            StringEquals: {
              'iam:PermissionsBoundary': config.permissionsBoundaryArn,
            },
          },
        }),
        new iam.PolicyStatement({
          sid: 'PassRole',
          effect: iam.Effect.ALLOW,
          actions: ['iam:PassRole'],
          resources: [
            this.runtimeRole.roleArn,
            this.executionRole.roleArn,
            // Passed when the deploy creates the Schedule_Shim function.
            scheduleShimRoleArn,
          ],
        }),
        new iam.PolicyStatement({
          sid: 'Ecs',
          effect: iam.Effect.ALLOW,
          actions: ['ecs:*'],
          resources: [
            `arn:aws:ecs:${stack.region}:${stack.account}:cluster/${prefix}-*`,
            `arn:aws:ecs:${stack.region}:${stack.account}:service/${prefix}-*`,
            `arn:aws:ecs:${stack.region}:${stack.account}:task-definition/${prefix}-*`,
            `arn:aws:ecs:${stack.region}:${stack.account}:task-definition/${prefix}-*:*`,
          ],
        }),
        new iam.PolicyStatement({
          sid: 'DynamoDB',
          effect: iam.Effect.ALLOW,
          actions: [
            'dynamodb:CreateTable',
            'dynamodb:UpdateTable',
            'dynamodb:DeleteTable',
            'dynamodb:DescribeTable',
            'dynamodb:DescribeTimeToLive',
            'dynamodb:UpdateTimeToLive',
            'dynamodb:DescribeContinuousBackups',
            'dynamodb:UpdateContinuousBackups',
            'dynamodb:TagResource',
            'dynamodb:UntagResource',
            'dynamodb:ListTagsOfResource',
          ],
          resources: [
            `arn:aws:dynamodb:${stack.region}:${stack.account}:table/${prefix}-*`,
          ],
        }),
        new iam.PolicyStatement({
          sid: 'SecretsManager',
          effect: iam.Effect.ALLOW,
          actions: [
            'secretsmanager:CreateSecret',
            'secretsmanager:TagResource',
            'secretsmanager:PutResourcePolicy',
          ],
          resources: [
            `arn:aws:secretsmanager:${stack.region}:${stack.account}:secret:${prefix}/*`,
          ],
        }),
        new iam.PolicyStatement({
          sid: 'Scheduler',
          effect: iam.Effect.ALLOW,
          actions: ['scheduler:*'],
          resources: [
            scheduleGroupArn,
          ],
        }),
        // Schedule_Shim lifecycle. Scoped to the prefixed function name, so this
        // role cannot touch any other function in the account. Named actions
        // rather than `lambda:*` because the list is short and closed: create,
        // read, update, delete, tag, and the concurrency setting the construct
        // reserves.
        new iam.PolicyStatement({
          sid: 'Lambda',
          effect: iam.Effect.ALLOW,
          actions: [
            'lambda:CreateFunction',
            'lambda:DeleteFunction',
            'lambda:GetFunction',
            'lambda:GetFunctionConfiguration',
            'lambda:UpdateFunctionCode',
            'lambda:UpdateFunctionConfiguration',
            'lambda:TagResource',
            'lambda:UntagResource',
            'lambda:ListTags',
            'lambda:PutFunctionConcurrency',
            'lambda:DeleteFunctionConcurrency',
            'lambda:AddPermission',
            'lambda:RemovePermission',
            'lambda:GetPolicy',
          ],
          resources: [
            `arn:aws:lambda:${stack.region}:${stack.account}:function:${prefix}-*`,
          ],
        }),
        new iam.PolicyStatement({
          sid: 'ApiGateway',
          effect: iam.Effect.ALLOW,
          actions: ['apigateway:*'],
          resources: [
            `arn:aws:apigateway:${stack.region}::/apis/${prefix}-*`,
            `arn:aws:apigateway:${stack.region}::/apis/*`,
          ],
        }),
        new iam.PolicyStatement({
          sid: 'Kms',
          effect: iam.Effect.ALLOW,
          actions: ['kms:CreateGrant', 'kms:DescribeKey'],
          resources: [appCmk.keyArn],
        }),
        new iam.PolicyStatement({
          sid: 'Ec2Describe',
          effect: iam.Effect.ALLOW,
          actions: [
            'ec2:Describe*',
            'ec2:CreateSecurityGroup',
            'ec2:DeleteSecurityGroup',
            'ec2:AuthorizeSecurityGroupIngress',
            'ec2:AuthorizeSecurityGroupEgress',
            'ec2:RevokeSecurityGroupIngress',
            'ec2:RevokeSecurityGroupEgress',
            'ec2:CreateVpcEndpoint',
            'ec2:DeleteVpcEndpoints',
            'ec2:ModifyVpcEndpoint',
            'ec2:CreateTags',
            'ec2:DeleteTags',
          ],
          resources: ['*'],
        }),
        // Image asset publishing, mirroring the `AssetStaging` grant on the
        // bootstrap asset bucket above. Only the asset path publishes an image,
        // and it publishes into the bootstrap image repository; on the `imageUri`
        // path the deploy builds and pushes nothing, so the statement is omitted.
        ...(imageChoice.kind === 'asset' && imageRepositoryArn
          ? [
              new iam.PolicyStatement({
                sid: 'Ecr',
                effect: iam.Effect.ALLOW,
                actions: ['ecr:*'],
                resources: [imageRepositoryArn],
              }),
            ]
          : []),
        new iam.PolicyStatement({
          sid: 'Logs',
          effect: iam.Effect.ALLOW,
          actions: [
            'logs:CreateLogGroup',
            'logs:DeleteLogGroup',
            'logs:PutRetentionPolicy',
            'logs:TagResource',
            'logs:DescribeLogGroups',
          ],
          resources: [
            `arn:aws:logs:${stack.region}:${stack.account}:log-group:/phorma/${prefix}*`,
          ],
        }),
        new iam.PolicyStatement({
          sid: 'ElasticLoadBalancing',
          effect: iam.Effect.ALLOW,
          actions: ['elasticloadbalancing:*'],
          resources: ['*'],
        }),
        new iam.PolicyStatement({
          sid: 'CloudWatch',
          effect: iam.Effect.ALLOW,
          actions: [
            'cloudwatch:PutMetricAlarm',
            'cloudwatch:DeleteAlarms',
            'cloudwatch:DescribeAlarms',
            'cloudwatch:TagResource',
          ],
          resources: [
            `arn:aws:cloudwatch:${stack.region}:${stack.account}:alarm:${prefix}-*`,
          ],
        }),
        new iam.PolicyStatement({
          sid: 'Sns',
          effect: iam.Effect.ALLOW,
          actions: ['sns:Subscribe', 'sns:Unsubscribe'],
          resources: [config.alarmNotificationArn],
        }),
      ],
    });
    this.deploymentRole.addManagedPolicy(deployPolicy);

    cdk.Tags.of(this).add('Name', `${prefix}-identity`);
  }
}

// ---------------------------------------------------------------------------
// Helper: derive the image repository ARN from the image choice (Req 4.2, 4.6)
// ---------------------------------------------------------------------------

export interface ImageRepositoryScope {
  /** Deploy account. A CDK token is fine - it resolves at deploy time. */
  account: string;
  /** Deploy region. A CDK token is fine - it resolves at deploy time. */
  region: string;
  /** The configured CDK bootstrap qualifier, never a hardcoded default. */
  bootstrapQualifier: string;
}

/**
 * A private ECR registry hostname: `{account}.dkr.ecr[-fips].{region}.{suffix}`.
 *
 * The account is exactly twelve digits and the region is a lowercase AWS region
 * token, which together are what makes the ARN derivable. The suffix is left
 * loose (`amazonaws.com`, `amazonaws.com.cn`, and the isolated-partition
 * equivalents all appear) because nothing in the ARN is read from it.
 *
 * `public.ecr.aws/...` deliberately does NOT match: ECR Public is a different
 * service with no repository ARN in the deploy account, and Fargate pulls from it
 * without an `ecr:*` call.
 */
const PRIVATE_ECR_HOST = /^(\d{12})\.dkr\.ecr(?:-fips)?\.([a-z0-9-]+)\.[a-z0-9.-]+$/;

/**
 * The single ECR repository this deploy pulls the Container_Image from, or
 * `undefined` when the image does not live in a private ECR repository.
 *
 * - Asset path: the CDK bootstrap image repository. A `DockerImageAsset` publishes
 *   into `cdk-{qualifier}-container-assets-{account}-{region}`, the repository the
 *   bootstrap stack created, so the ARN is derived from the CONFIGURED qualifier
 *   plus the deploy account and region. Nothing here hardcodes `hnb659fds`.
 * - Reference path: the repository parsed out of `imageUri`, which may sit in
 *   another account (a cross-account pull is a normal platform arrangement), so
 *   the account and region come from the reference and not from the deploy.
 * - Reference path pointing anywhere else - `ghcr.io`, `docker.io`, an internal
 *   Harbor, `public.ecr.aws` - has no ECR repository to name and yields
 *   `undefined`. The caller omits the repository-scoped statement rather than
 *   inventing an ARN.
 *
 * Pure: no construct, no token creation, no I/O. `account` and `region` may be
 * CDK tokens, which pass through into the returned string untouched.
 */
export function imagePullRepositoryArn(
  imageChoice: ContainerImageChoice,
  scope: ImageRepositoryScope,
): string | undefined {
  if (imageChoice.kind === 'asset') {
    const { account, region, bootstrapQualifier } = scope;
    const repository = `cdk-${bootstrapQualifier}-container-assets-${account}-${region}`;
    return `arn:aws:ecr:${region}:${account}:repository/${repository}`;
  }
  return referenceRepositoryArn(imageChoice.imageUri);
}

/**
 * Parse `{account}.dkr.ecr.{region}.amazonaws.com/{name}[:tag|@digest]` into a
 * repository ARN. Returns `undefined` for any reference that is not a private ECR
 * pull: a non-ECR registry, a bare Docker Hub name with no registry host at all,
 * or an ECR host with an empty repository path.
 */
function referenceRepositoryArn(imageUri: string): string | undefined {
  const firstSlash = imageUri.indexOf('/');
  if (firstSlash <= 0) return undefined;

  const host = imageUri.slice(0, firstSlash);
  const hostMatch = PRIVATE_ECR_HOST.exec(host);
  if (!hostMatch) return undefined;
  const [, account, region] = hostMatch;

  // Strip the tag or digest. A digest (`@sha256:...`) can only follow the name,
  // and a colon after the last slash is a tag - a colon inside the host would
  // have failed the host match already.
  const path = imageUri.slice(firstSlash + 1);
  const withoutDigest = path.split('@')[0];
  const lastSlash = withoutDigest.lastIndexOf('/');
  const lastColon = withoutDigest.lastIndexOf(':');
  const name = lastColon > lastSlash ? withoutDigest.slice(0, lastColon) : withoutDigest;
  if (name.length === 0) return undefined;

  return `arn:aws:ecr:${region}:${account}:repository/${name}`;
}

// ---------------------------------------------------------------------------
// Helper: build the deploy trust principal from config (Req 15.7)
// ---------------------------------------------------------------------------

function buildDeployTrustPrincipal(
  trust: DeployTrustConfig | undefined,
  stack: cdk.Stack,
): iam.IPrincipal {
  if (!trust || (!trust.identityCenter && !trust.githubOidc)) {
    // Fallback to account principal when no explicit trust is configured.
    // This allows the stack to synthesize for basic testing, but the property
    // test verifies that the three supported shapes produce valid trust policies.
    return new iam.AccountPrincipal(stack.account);
  }

  const principals: iam.IPrincipal[] = [];

  if (trust.identityCenter) {
    // Identity Center assumes through the account's SSO provider
    principals.push(new iam.ArnPrincipal(trust.identityCenter.permissionSetArn));
  }

  if (trust.githubOidc) {
    const conditions: Record<string, Record<string, string>> = {
      StringEquals: {
        'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
      },
      StringLike: {
        'token.actions.githubusercontent.com:sub': trust.githubOidc.environment
          ? `repo:${trust.githubOidc.repository}:environment:${trust.githubOidc.environment}`
          : `repo:${trust.githubOidc.repository}:ref:refs/heads/${trust.githubOidc.branch}`,
      },
    };
    principals.push(new iam.FederatedPrincipal(
      trust.githubOidc.providerArn,
      conditions,
      'sts:AssumeRoleWithWebIdentity',
    ));
  }

  if (principals.length === 1) return principals[0];
  return new iam.CompositePrincipal(...principals);
}
