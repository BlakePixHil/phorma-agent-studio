/**
 * ComputeConstruct - ECS cluster and Fargate service.
 *
 * Creates the ECS cluster and Fargate service with AssignPublicIp: DISABLED
 * in private subnets. The task uses the Runtime_Identity as task role and the
 * Task_Execution_Identity as execution role.
 *
 * The Container_Image arrives ready-made: `stack.ts` resolves the dual path
 * (repository Dockerfile asset, or the operator's published reference) once and
 * passes an `ecs.ContainerImage`. This construct never decides where the image
 * comes from, so neither path needs a branch here (Req 4.1, 4.2).
 *
 * The container definition also carries the Server_Entry configuration contract
 * (Req 7.9). The seven `PHORMA_*` names `readServerEnv` requires are set here;
 * `AWS_REGION`, the eighth, is injected by the Fargate agent, so setting it
 * would be redundant at best and wrong at worst. Values are resolved by
 * `stack.ts` from the constructs that own them - this construct maps values onto
 * names and owns nothing else about them.
 *
 * Requirements: 4.1, 4.2, 7.9, 10.1, 13.2
 */
import { Construct } from 'constructs';
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import type { AwsDeployConfig } from '../../core/config.js';

/**
 * The values behind the seven task-definition environment names.
 *
 * Field names mirror `ServerEnv` in `src/server/env.ts` deliberately: the two
 * ends of the contract read the same vocabulary, so a reviewer can line them up
 * without translating. Every field is a string because several arrive as CDK
 * tokens that only resolve at deploy time.
 */
export interface ServerEnvValues {
  /** Run_Table name - `DataConstruct`. */
  runTableName: string;
  /** Monitor_API stage endpoint - `MonitorApiConstruct`. */
  monitorEndpoint: string;
  /** IaC-owned Secrets Manager name prefix, matching `awsSecretName`. */
  secretPrefix: string;
  /** Schedule group name - `ScheduleConstruct`. */
  scheduleGroup: string;
  /** Metric namespace - `ObservabilityConstruct`. */
  metricNamespace: string;
  /** Schedule_Shim function ARN - `ScheduleShimConstruct`. The schedule target. */
  scheduleTargetArn: string;
  /** Scheduler_Invoke_Identity role ARN - `IdentityConstruct`. */
  scheduleRoleArn: string;
}

export interface ComputeConstructProps {
  config: AwsDeployConfig;
  vpc: ec2.IVpc;
  taskSubnets: ec2.ISubnet[];
  taskSecurityGroup: ec2.ISecurityGroup;
  taskRole: iam.IRole;
  executionRole: iam.IRole;
  /** The resolved Container_Image, built by `stack.ts` from the image choice. */
  image: ecs.ContainerImage;
  logGroup: logs.ILogGroup;
  targetGroup: elbv2.INetworkTargetGroup;
  /** Values for the Server_Entry environment block (Req 7.9). */
  serverEnv: ServerEnvValues;
}

export class ComputeConstruct extends Construct {
  public readonly cluster: ecs.Cluster;
  public readonly service: ecs.FargateService;

  constructor(scope: Construct, id: string, props: ComputeConstructProps) {
    super(scope, id);

    const {
      config, vpc, taskSubnets, taskSecurityGroup,
      taskRole, executionRole, image, logGroup, targetGroup, serverEnv,
    } = props;
    const prefix = config.namePrefix;

    // ECS Cluster
    this.cluster = new ecs.Cluster(this, 'Cluster', {
      clusterName: `${prefix}-cluster`,
      vpc,
    });

    // Task definition
    const taskDef = new ecs.FargateTaskDefinition(this, 'TaskDef', {
      family: `${prefix}-host`,
      cpu: 512,
      memoryLimitMiB: 1024,
      taskRole,
      executionRole,
    });

    taskDef.addContainer('host', {
      containerName: `${prefix}-host`,
      image,
      // The Server_Entry contract (Req 7.9). `readServerEnv` fails startup
      // naming every absent name, so an omission here is a task that never
      // reaches the health check rather than a subtle runtime fault.
      // `AWS_REGION` is deliberately absent - the ECS agent provides it.
      environment: {
        PHORMA_RUN_TABLE: serverEnv.runTableName,
        PHORMA_MONITOR_ENDPOINT: serverEnv.monitorEndpoint,
        PHORMA_SECRET_PREFIX: serverEnv.secretPrefix,
        PHORMA_SCHEDULE_GROUP: serverEnv.scheduleGroup,
        PHORMA_METRIC_NAMESPACE: serverEnv.metricNamespace,
        PHORMA_SCHEDULE_TARGET_ARN: serverEnv.scheduleTargetArn,
        PHORMA_SCHEDULE_ROLE_ARN: serverEnv.scheduleRoleArn,
      },
      logging: ecs.LogDrivers.awsLogs({
        logGroup: logGroup as logs.LogGroup,
        streamPrefix: 'host',
      }),
      portMappings: [{ containerPort: 8080 }],
      healthCheck: {
        command: ['CMD-SHELL', 'curl -f http://localhost:8080/health || exit 1'],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        retries: 3,
        startPeriod: cdk.Duration.seconds(60),
      },
    });

    // Fargate service - AssignPublicIp: DISABLED, private subnets
    this.service = new ecs.FargateService(this, 'Service', {
      serviceName: `${prefix}-host`,
      cluster: this.cluster,
      taskDefinition: taskDef,
      desiredCount: 1,
      assignPublicIp: false,
      vpcSubnets: { subnets: taskSubnets },
      securityGroups: [taskSecurityGroup],
      circuitBreaker: { rollback: true },
      minHealthyPercent: 100,
    });

    // Register service with the NLB target group
    this.service.attachToNetworkTargetGroup(targetGroup);

    cdk.Tags.of(this).add('Name', `${prefix}-compute`);
  }
}
