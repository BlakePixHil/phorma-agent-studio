/**
 * PhormaAwsHostStack - the single CDK stack composing all constructs.
 *
 * Creates NetworkConstruct, DataConstruct, SecretsConstruct, ComputeConstruct,
 * TriggerApiConstruct, MonitorApiConstruct, ScheduleConstruct,
 * IdentityConstruct and ObservabilityConstruct within a single `cdk deploy`.
 *
 * Every resource name carries the configured prefix (Req 13.7). The bootstrap
 * qualifier is applied through DefaultStackSynthesizer (Req 13.3). Uses
 * Vpc.fromVpcAttributes, never fromLookup (Req 13.8).
 *
 * The Container_Image is decided once here, by `resolveContainerImage`, and
 * handed to `ComputeConstruct` as a ready `ecs.ContainerImage` (Req 4.1, 4.2).
 * The Server_Entry environment is resolved here too, from the constructs that
 * own each value, and handed to `ComputeConstruct` (Req 7.9).
 *
 * It ends with the two endpoint outputs endpoint discovery reads, under the
 * logical ids `core/outputs.ts` declares (Req 9.1).
 *
 * Requirements: 4.1, 4.2, 4.4, 7.9, 9.1, 9.5, 9.6, 9.7, 10.1, 10.2, 10.3, 10.10, 11.1,
 *   11.7, 11.12, 12.3, 12.4, 13.2, 13.3, 13.6, 13.7, 15.1, 15.2, 15.3, 15.4,
 *   15.5, 15.6, 15.7, 15.13, 15.14, 18.1
 */
import * as cdk from 'aws-cdk-lib';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecrAssets from 'aws-cdk-lib/aws-ecr-assets';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import { Construct } from 'constructs';
import type { AwsDeployConfig } from '../core/config.js';
import { resolveContainerImage } from '../core/container-image.js';
import { MONITOR_API_OUTPUT, TRIGGER_API_OUTPUT } from '../core/outputs.js';
import * as iam from 'aws-cdk-lib/aws-iam';
import { NetworkConstruct } from './constructs/network.js';
import { SecretsConstruct } from './constructs/secrets.js';
import { DataConstruct } from './constructs/data.js';
import { ObservabilityConstruct } from './constructs/observability.js';
import { ScheduleConstruct } from './constructs/schedule.js';
import { ScheduleShimConstruct } from './constructs/schedule-shim.js';
import { MonitorApiConstruct } from './constructs/monitor-api.js';
import { TriggerApiConstruct } from './constructs/trigger-api.js';
import { IdentityConstruct } from './constructs/identity.js';
import { ComputeConstruct } from './constructs/compute.js';
import {
  AlarmTargetAspect,
  AuthorizerAspect,
  CustomerKeyAspect,
  NoIamUserAspect,
  PermissionsBoundaryAspect,
  TagAspect,
} from './aspects.js';

// ---------------------------------------------------------------------------
// Docker image asset context
// ---------------------------------------------------------------------------

/**
 * What the Docker image asset must NOT see in its build context.
 *
 * The context is the repository ROOT, because the image needs both `cloud-aws/`
 * and `engine/` (the engine is consumed as source through the tsconfig path
 * alias, never as a published package). A whole-repository context would make
 * the asset fingerprint depend on every file in the repository, so a frontend
 * or docs edit would change the hash and force an image rebuild and republish
 * on the next deploy. Excluding the trees the Dockerfile never COPYs - every
 * sibling package, `docs`, the specs, all `node_modules` and all build output -
 * takes the churning parts of the repository out of the fingerprint.
 *
 * The repository-root `.dockerignore` mirrors this list, so a hand-run
 * `docker build -f cloud-aws/Dockerfile .` fingerprints the same context. Keep
 * the two in sync: a pattern added here and not there (or the reverse) means the
 * asset CDK hashes is no longer the image a human build produces.
 *
 * `cdk.out` is excluded by name for a second reason: the asset staging directory
 * lives under the CDK output directory, which sits INSIDE the build context, and
 * a context that contains its own staging directory copies itself forever.
 *
 * Requirements: 4.1, 4.3
 */
export const IMAGE_CONTEXT_EXCLUDES: readonly string[] = Object.freeze([
  'node_modules',
  '**/node_modules',
  'frontend',
  'backend',
  'cloud',
  'mcp',
  'docs',
  '.git',
  '.kiro',
  'cdk.out',
  '**/cdk.out',
  '**/*.spec.ts',
  // The Schedule_Shim Lambda bundle. It is rebuilt before every synth and the
  // container never COPYs it, so leaving it in would make the image fingerprint
  // change on every deploy and force a pointless rebuild and republish.
  'dist',
  '**/dist',
]);

/**
 * Absolute path of the repository root, derived from this module's own location.
 *
 * `cloud-aws` installs no `@types/node`, so neither `process.cwd()` nor a
 * `node:path` import type-checks here (the same constraint that produced the
 * `globalThis` reads in `aws/stdout-log-writer.ts` and `server/startup.ts`, and
 * the ambient `server/node-http.d.ts`). `import.meta.url` is typed by `lib.dom`,
 * which this package already includes, so the location is read from the module
 * URL and converted with plain string work - no import, no ambient declaration,
 * and no dependency on the directory the `cdk` CLI happens to run from.
 *
 * This file is `<repo>/cloud-aws/src/infra/stack.ts`, so the root is four
 * segments up.
 */
function repositoryRootFrom(moduleUrl: string): string {
  const withoutScheme = decodeURIComponent(moduleUrl.replace(/^file:\/\//, ''));
  // A Windows URL path is `/C:/...`; drop the leading slash so the drive letter
  // starts the path. A POSIX path is left untouched.
  const absolute = /^\/[A-Za-z]:/.test(withoutScheme) ? withoutScheme.slice(1) : withoutScheme;
  const segments = absolute.split('/');
  // stack.ts -> infra -> src -> cloud-aws -> repository root
  return segments.slice(0, -4).join('/') || '/';
}

export const REPO_ROOT = repositoryRootFrom(import.meta.url);

/**
 * Absolute path of the `cloud-aws` package root, derived the same way and for the
 * same reason as `REPO_ROOT`: the Schedule_Shim asset path must not depend on the
 * directory the `cdk` CLI was invoked from.
 *
 * This file is `<repo>/cloud-aws/src/infra/stack.ts`, so the package root is
 * three segments up.
 */
function packageRootFrom(moduleUrl: string): string {
  const withoutScheme = decodeURIComponent(moduleUrl.replace(/^file:\/\//, ''));
  const absolute = /^\/[A-Za-z]:/.test(withoutScheme) ? withoutScheme.slice(1) : withoutScheme;
  // stack.ts -> infra -> src -> cloud-aws
  return absolute.split('/').slice(0, -3).join('/') || '/';
}

export const PACKAGE_ROOT = packageRootFrom(import.meta.url);

// ---------------------------------------------------------------------------
// API endpoints
// ---------------------------------------------------------------------------

/** Construct id of the stage `MonitorApiConstruct` creates. */
const MONITOR_STAGE_CHILD_ID = 'MonitorApiStage';

/** Construct id of the stage `TriggerApiConstruct` creates. */
const TRIGGER_STAGE_CHILD_ID = 'TriggerApiStage';

/**
 * The stage a construct created, by child id.
 *
 * Every endpoint below is derived from the stage resource rather than from a
 * restated stage name, so `findChild` throwing during synthesis (which the
 * Check_Pipeline catches) is the failure mode for a renamed or removed stage.
 */
function stageChild(scope: Construct, childId: string, purpose: string): apigwv2.CfnStage {
  const child = scope.node.findChild(childId);
  if (!(child instanceof apigwv2.CfnStage)) {
    throw new Error(
      `Construct child "${childId}" is not a CfnStage, so ${purpose} cannot be derived.`,
    );
  }
  return child;
}

/**
 * The Monitor_API stage URL, in the scheme the caller needs.
 *
 * Two callers, two schemes, one derivation:
 *
 * - `https://` for `PHORMA_MONITOR_ENDPOINT`, which the Host_Adapter hands to the
 *   API Gateway Management API client. `monitor-backend.ts` would normalise
 *   either scheme, so this is a choice about which value needs no translation at
 *   the point of use, not a correctness requirement.
 * - `wss://` for the `MonitorApiUrl` deploy output, which is the URL a monitoring
 *   client dials.
 *
 * The stage NAME is read off the synthesized stage instead of restating the
 * literal `monitor-api.ts` sets. A rename there would otherwise leave the task
 * posting to a stage that does not exist and the Studio dialling one, and both
 * failures would surface only at runtime.
 */
function monitorApiUrl(
  stack: cdk.Stack,
  monitorApi: MonitorApiConstruct,
  scheme: 'https' | 'wss',
): string {
  const stage = stageChild(monitorApi, MONITOR_STAGE_CHILD_ID, 'the Monitor_API URL');
  // Ref on AWS::ApiGatewayV2::Stage resolves to the stage name - the same
  // assumption `MonitorApiConstruct.stageArn` already makes.
  return `${scheme}://${monitorApi.api.ref}.execute-api.${stack.region}.amazonaws.com/${stage.ref}`;
}

/**
 * The Trigger_API base URL the Studio prefixes every Trigger_Route with.
 *
 * The `$default` stage of an HTTP API is served at the API ROOT, so the base URL
 * carries no stage path and no trailing slash - which is also exactly what the
 * Config_Parser accepts for `triggerApiUrl`. Any other stage name IS part of the
 * path, so the name decides whether a segment is appended rather than the value
 * assuming the stage `trigger-api.ts` happens to create today.
 *
 * `stageName` is read here, not `ref`: the decision has to be made at synth time,
 * and the name is a literal in `trigger-api.ts` rather than a token. `ref` would
 * be an unresolved token that no comparison could branch on.
 */
function triggerApiBaseUrl(stack: cdk.Stack, triggerApi: TriggerApiConstruct): string {
  const stage = stageChild(triggerApi, TRIGGER_STAGE_CHILD_ID, 'the Trigger_API base URL');
  const stagePath = stage.stageName === '$default' ? '' : `/${stage.stageName}`;
  return `https://${triggerApi.api.ref}.execute-api.${stack.region}.amazonaws.com${stagePath}`;
}

export interface PhormaAwsHostStackProps extends cdk.StackProps {
  config: AwsDeployConfig;
}

export class PhormaAwsHostStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: PhormaAwsHostStackProps) {
    super(scope, id, props);

    const { config } = props;

    // Apply cost-allocation tags to all resources in the stack
    for (const [key, value] of Object.entries(config.costAllocationTags)) {
      cdk.Tags.of(this).add(key, value);
    }

    // 1. Secrets/KMS - the App_CMK (needed by most other constructs)
    const secrets = new SecretsConstruct(this, 'Secrets', { config });

    // 2. Observability (log group needed by compute and identity)
    const observability = new ObservabilityConstruct(this, 'Observability', {
      config,
      encryptionKey: secrets.appCmk,
    });

    // 3. Network (VPC, subnets, endpoints, security groups)
    const network = new NetworkConstruct(this, 'Network', { config });

    // 4. Data (Run_Table with GSIs)
    const data = new DataConstruct(this, 'Data', {
      config,
      encryptionKey: secrets.appCmk,
    });

    // 5. Schedule group
    const schedule = new ScheduleConstruct(this, 'Schedule', { config });

    // 6. Monitor_API (WebSocket, needs Run_Table)
    const monitorApi = new MonitorApiConstruct(this, 'MonitorApi', {
      config,
      runTable: data.runTable,
    });

    // 7. Trigger_API (HTTP API + NLB, needs VPC)
    const triggerApi = new TriggerApiConstruct(this, 'TriggerApi', {
      config,
      vpc: network.vpc,
      taskSubnets: network.taskSubnets,
      taskSecurityGroup: network.taskSecurityGroup,
    });

    // 8. Container_Image: built from the repository Dockerfile, or the
    // operator's own published reference (Req 4.1, 4.2). Decided once, here, and
    // read twice: IdentityConstruct scopes the Task_Execution_Identity's ECR
    // grant to whatever repository the choice names, and ComputeConstruct puts
    // the image on the task definition.
    const imageChoice = resolveContainerImage(config);

    // 8b. Schedule_Shim. Built BEFORE Identity because Scheduler_Invoke_Identity
    // is granted `lambda:InvokeFunction` on this function, and the
    // Deployment_Identity must be able to pass this function's role.
    //
    // The boundary is imported here rather than taken from IdentityConstruct for
    // the same ordering reason. Two imports of one ARN are two thin wrappers
    // around a string, and `PermissionsBoundaryAspect` verifies at synth time that
    // every role in the estate carries it either way.
    const scheduleShim = new ScheduleShimConstruct(this, 'ScheduleShim', {
      config,
      packageRoot: PACKAGE_ROOT,
      triggerApiUrl: triggerApiBaseUrl(this, triggerApi),
      scheduledRunRouteArn: triggerApi.scheduledRunRouteArn,
      appCmk: secrets.appCmk,
      permissionsBoundary: iam.ManagedPolicy.fromManagedPolicyArn(
        this, 'ShimBoundary', config.permissionsBoundaryArn,
      ),
    });

    // 9. Identity (4 roles, needs table/key/image choice/logGroup/api ARNs)
    const identity = new IdentityConstruct(this, 'Identity', {
      config,
      runTable: data.runTable,
      appCmk: secrets.appCmk,
      imageChoice,
      logGroup: observability.logGroup,
      monitorApiStageArn: monitorApi.stageArn,
      scheduleShimFunctionArn: scheduleShim.function.functionArn,
      scheduleShimRoleArn: scheduleShim.role.roleArn,
      scheduleGroupArn: schedule.scheduleGroupArn,
    });

    // 10. The `ecs.ContainerImage` the task definition carries.
    //
    // A DockerImageAsset needs no Docker daemon and no credentials at synth
    // time: it fingerprints the build context and writes one entry into the
    // asset manifest, and `docker build` runs later, during publishing
    // (Req 4.4). It does need the directory and the Dockerfile to exist, which
    // is why the context path is derived from this module rather than from the
    // caller's working directory.
    const image =
      imageChoice.kind === 'reference'
        ? ecs.ContainerImage.fromRegistry(imageChoice.imageUri)
        : ecs.ContainerImage.fromDockerImageAsset(
            new ecrAssets.DockerImageAsset(this, 'HostImage', {
              directory: REPO_ROOT,
              file: imageChoice.dockerfile,
              exclude: [...IMAGE_CONTEXT_EXCLUDES],
              platform: ecrAssets.Platform.LINUX_AMD64,
            }),
          );

    // 11. Compute (ECS cluster + Fargate service, registered with NLB TG)
    //
    // The Server_Entry environment is resolved here, from the constructs that
    // own each value, so `compute.ts` maps values onto names and derives none of
    // them (Req 7.9). Every value is available by this point: Data, Schedule,
    // MonitorApi, TriggerApi and Identity are all built above.
    new ComputeConstruct(this, 'Compute', {
      config,
      vpc: network.vpc,
      taskSubnets: network.taskSubnets,
      taskSecurityGroup: network.taskSecurityGroup,
      taskRole: identity.runtimeRole,
      executionRole: identity.executionRole,
      image,
      logGroup: observability.logGroup,
      targetGroup: triggerApi.targetGroup,
      serverEnv: {
        runTableName: data.runTable.tableName,
        monitorEndpoint: monitorApiUrl(this, monitorApi, 'https'),
        // `awsSecretName` composes `{prefix}/conn/{connectionId}/{key}`, and the
        // Runtime_Identity's `secretsmanager:GetSecretValue` grant in
        // `identity.ts` is scoped to `secret:{namePrefix}/*`. The prefix is the
        // bare name prefix, with no trailing separator, or every credential
        // lookup would compose a name outside the grant.
        secretPrefix: config.namePrefix,
        scheduleGroup: schedule.scheduleGroupName,
        // Must equal the namespace the alarms read and the namespace the
        // Runtime_Identity's `cloudwatch:PutMetricData` condition names.
        metricNamespace: observability.metricNamespace,
        // What every schedule the runtime creates points at. The Schedule_Shim
        // function, not the Trigger_Route: Scheduler has no API Gateway target,
        // so the route ARN that used to sit here made `CreateSchedule` fail and
        // took every cron-carrying spec push down with it.
        scheduleTargetArn: scheduleShim.function.functionArn,
        scheduleRoleArn: identity.schedulerInvokeRole.roleArn,
      },
    });

    // Synthesis guardrails. Registered after every construct so they visit the
    // complete tree, and after `Tags.of` above so the tag Aspect has already
    // populated each TagManager by the time TagAspect reads it. Each one fails
    // synthesis naming the offending element rather than deferring to review.
    cdk.Aspects.of(this).add(new PermissionsBoundaryAspect(config.permissionsBoundaryArn));
    cdk.Aspects.of(this).add(new CustomerKeyAspect());
    cdk.Aspects.of(this).add(new AuthorizerAspect());
    cdk.Aspects.of(this).add(new NoIamUserAspect());
    cdk.Aspects.of(this).add(new AlarmTargetAspect());
    cdk.Aspects.of(this).add(new TagAspect(config.costAllocationTags));

    // Endpoint discovery (Req 9.1). These two outputs are how the Studio learns
    // where its endpoints are: the `deploy` and `outputs` verbs look them up BY
    // NAME, so the logical ids come from `core/outputs.ts` rather than from
    // literals here - a rename there moves both ends at once, and a rename only
    // here could not compile.
    //
    // Both values must satisfy the Config_Parser, which rejects a `triggerApiUrl`
    // that is not `https:` or that carries a trailing slash, and a `monitorApiUrl`
    // that is not `wss:`. A deploy emitting anything else would write a config the
    // CLI then refuses to read.
    new cdk.CfnOutput(this, TRIGGER_API_OUTPUT, {
      value: triggerApiBaseUrl(this, triggerApi),
      description: 'Trigger_API base URL - the Studio prefixes every Trigger_Route with it.',
      exportName: `${config.namePrefix}-trigger-api-url`,
    });
    new cdk.CfnOutput(this, MONITOR_API_OUTPUT, {
      value: monitorApiUrl(this, monitorApi, 'wss'),
      description: 'Monitor_API WebSocket URL - the URL a monitoring client dials.',
      exportName: `${config.namePrefix}-monitor-api-url`,
    });
  }
}
