/**
 * ScheduleShimConstruct - the Lambda EventBridge Scheduler invokes on a cron fire.
 *
 * EventBridge Scheduler has no API Gateway target, templated or universal, so a
 * schedule cannot call the Trigger_Route directly. Lambda `Invoke` IS a templated
 * target, so this function is the one hop between them. What it does and why the
 * hop exists rather than a queue is documented in `src/shim/schedule-shim.ts`.
 *
 * Three deliberate choices:
 *
 * - NO VPC configuration. The Trigger_API endpoint is a public regional
 *   `execute-api` host guarded by `AWS_IAM`, which is how `phorma-aws request`
 *   already reaches it from an operator's laptop. Placing the function in the VPC
 *   would add ENI attachment to every cold start and require an
 *   `execute-api` interface endpoint, for no reachability the function does not
 *   already have and no exposure it does not already carry.
 * - Code from a PRE-BUILT directory, never `NodejsFunction`. Synthesis has to
 *   work with no Docker daemon, which is what `NodejsFunction` falls back to when
 *   local esbuild resolution fails. `shim/build.ts` produces the directory: from
 *   the `check` script in a checkout, and from `cli/shim-bundle.ts` before every
 *   `plan` and `deploy` in an operator's workspace.
 * - ARM64. The shim signs one request and exits; Graviton is cheaper per
 *   millisecond and nothing here is architecture sensitive.
 *
 * Feature: aws-byo-deploy
 */
import { Construct } from 'constructs';
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as kms from 'aws-cdk-lib/aws-kms';
import type { AwsDeployConfig } from '../../core/config.js';
import { SHIM_OUT_DIR } from '../../shim/build.js';

/**
 * ESM entry: `index.mjs` exporting `handler`.
 *
 * The directory comes from `shim/build.ts` rather than being restated, so the
 * builder and the asset path cannot drift into a `CannotFindFile` at synth.
 */
export const SHIM_HANDLER = 'index.handler';

/**
 * Wall-clock ceiling. The shim resolves credentials, signs and makes one HTTPS
 * call. Ten seconds is generous; a longer timeout would only delay the retry
 * Scheduler is going to make anyway.
 */
const SHIM_TIMEOUT_SECONDS = 10;

/** The bundle is about 1 MB and holds no data in memory. */
const SHIM_MEMORY_MB = 256;

/**
 * Concurrency ceiling. Schedules are capped at 50 per workflow and fire at minute
 * granularity, so a handful of concurrent invocations is the realistic peak. The
 * reservation stops a misconfigured estate from spending unbounded concurrency
 * on trigger calls the lease is going to reject anyway.
 */
const SHIM_RESERVED_CONCURRENCY = 10;

export interface ScheduleShimConstructProps {
  config: AwsDeployConfig;
  /** Absolute path of the package root, so the asset path is not cwd-dependent. */
  packageRoot: string;
  /** Trigger_API base URL, no trailing slash - resolved by `stack.ts`. */
  triggerApiUrl: string;
  /** The scheduled-run route ARN the function is allowed to invoke. */
  scheduledRunRouteArn: string;
  /** App_CMK, used to encrypt the function's own log group. */
  appCmk: kms.IKey;
  /** The permissions boundary every role in the estate carries. */
  permissionsBoundary: iam.IManagedPolicy;
}

export class ScheduleShimConstruct extends Construct {
  public readonly function: lambda.Function;
  /** The shim's execution role. Holds the only `execute-api:Invoke` on the route. */
  public readonly role: iam.Role;
  public readonly logGroup: logs.LogGroup;

  constructor(scope: Construct, id: string, props: ScheduleShimConstructProps) {
    super(scope, id);

    const {
      config, packageRoot, triggerApiUrl, scheduledRunRouteArn, appCmk, permissionsBoundary,
    } = props;
    const prefix = config.namePrefix;
    const stack = cdk.Stack.of(this);

    // Its own log group, so retention and App_CMK encryption match the estate
    // rather than defaulting to an unencrypted group with no expiry.
    this.logGroup = new logs.LogGroup(this, 'LogGroup', {
      logGroupName: `/phorma/${prefix}/schedule-shim`,
      retention: logs.RetentionDays.ONE_MONTH,
      encryptionKey: appCmk,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.role = new iam.Role(this, 'Role', {
      roleName: `${prefix}-schedule-shim`,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      permissionsBoundary,
    });

    // The whole point of the role: invoke the one route, and nothing else.
    //
    // This statement MOVED here from Scheduler_Invoke_Identity rather than being
    // added alongside it. Role disjointness holds because `execute-api:Invoke` on
    // this resource still has exactly one holder in the estate.
    this.role.addManagedPolicy(
      new iam.ManagedPolicy(this, 'InvokePolicy', {
        managedPolicyName: `${prefix}-schedule-shim-invoke`,
        statements: [
          new iam.PolicyStatement({
            sid: 'InvokeTriggerRoute',
            effect: iam.Effect.ALLOW,
            actions: ['execute-api:Invoke'],
            resources: [scheduledRunRouteArn],
          }),
        ],
      }),
    );

    this.role.addManagedPolicy(
      new iam.ManagedPolicy(this, 'LogsPolicy', {
        managedPolicyName: `${prefix}-schedule-shim-logs`,
        statements: [
          new iam.PolicyStatement({
            sid: 'WriteLogs',
            effect: iam.Effect.ALLOW,
            actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
            resources: [this.logGroup.logGroupArn, `${this.logGroup.logGroupArn}:*`],
          }),
        ],
      }),
    );

    this.role.addManagedPolicy(
      new iam.ManagedPolicy(this, 'KmsPolicy', {
        managedPolicyName: `${prefix}-schedule-shim-kms`,
        statements: [
          new iam.PolicyStatement({
            sid: 'EncryptLogs',
            effect: iam.Effect.ALLOW,
            actions: ['kms:Encrypt', 'kms:Decrypt', 'kms:GenerateDataKey'],
            resources: [appCmk.keyArn],
            conditions: {
              StringEquals: { 'kms:ViaService': `logs.${stack.region}.amazonaws.com` },
            },
          }),
        ],
      }),
    );

    this.function = new lambda.Function(this, 'Function', {
      functionName: `${prefix}-schedule-shim`,
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      // A plain directory: no bundling, no Docker, no credentials at synth time.
      code: lambda.Code.fromAsset(`${packageRoot}/${SHIM_OUT_DIR}`),
      handler: SHIM_HANDLER,
      role: this.role,
      timeout: cdk.Duration.seconds(SHIM_TIMEOUT_SECONDS),
      memorySize: SHIM_MEMORY_MB,
      reservedConcurrentExecutions: SHIM_RESERVED_CONCURRENCY,
      logGroup: this.logGroup,
      environment: {
        PHORMA_TRIGGER_API_URL: triggerApiUrl,
        // The SIGNING region, set explicitly rather than read from the Lambda's
        // own region, so the signature cannot drift from the API's region.
        PHORMA_REGION: stack.region,
      },
    });

    cdk.Tags.of(this).add('Name', `${prefix}-schedule-shim`);
  }
}
