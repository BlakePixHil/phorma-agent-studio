/**
 * ObservabilityConstruct - Log groups, metrics namespace and alarms.
 *
 * Creates the CloudWatch log groups with retention matching the configured
 * run-event retention, and the two alarms (failed-scheduled-run and
 * lease-takeover) with notification targets.
 *
 * Requirements: 12.3, 12.4, 11.7
 */
import { Construct } from 'constructs';
import * as cdk from 'aws-cdk-lib';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatch_actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as kms from 'aws-cdk-lib/aws-kms';
import type { AwsDeployConfig } from '../../core/config.js';

/**
 * Map retention days to the closest valid CloudWatch Logs retention value.
 */
function toLogRetentionDays(days: number): logs.RetentionDays {
  // CloudWatch Logs only accepts specific retention values
  const validValues = [
    1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096,
    1827, 2192, 2557, 2922, 3288, 3653,
  ];
  // Find the smallest valid value >= configured days
  for (const v of validValues) {
    if (v >= days) return v as logs.RetentionDays;
  }
  return logs.RetentionDays.TEN_YEARS;
}

export interface ObservabilityConstructProps {
  config: AwsDeployConfig;
  encryptionKey: kms.IKey;
}

export class ObservabilityConstruct extends Construct {
  public readonly logGroup: logs.LogGroup;
  public readonly metricNamespace: string;
  public readonly failedScheduledRunAlarm: cloudwatch.Alarm;
  public readonly leaseTakeoverAlarm: cloudwatch.Alarm;

  constructor(scope: Construct, id: string, props: ObservabilityConstructProps) {
    super(scope, id);

    const { config, encryptionKey } = props;
    const prefix = config.namePrefix;
    this.metricNamespace = `Phorma/${prefix}`;

    // Log group with App_CMK encryption and matching retention
    this.logGroup = new logs.LogGroup(this, 'LogGroup', {
      logGroupName: `/phorma/${prefix}/host`,
      retention: toLogRetentionDays(config.retentionDays),
      encryptionKey,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // Import the notification topic
    const notificationTopic = sns.Topic.fromTopicArn(
      this, 'NotificationTopic', config.alarmNotificationArn,
    );

    // Alarm: failed-scheduled-run (Req 12.3)
    this.failedScheduledRunAlarm = new cloudwatch.Alarm(this, 'FailedScheduledRunAlarm', {
      alarmName: `${prefix}-failed-scheduled-run`,
      alarmDescription: 'A scheduled run failed to complete successfully.',
      metric: new cloudwatch.Metric({
        namespace: this.metricNamespace,
        metricName: 'FailedScheduledRun',
        statistic: 'Sum',
        period: cdk.Duration.minutes(5),
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    this.failedScheduledRunAlarm.addAlarmAction(
      new cloudwatch_actions.SnsAction(notificationTopic),
    );

    // Alarm: lease-takeover (Req 12.4)
    this.leaseTakeoverAlarm = new cloudwatch.Alarm(this, 'LeaseTakeoverAlarm', {
      alarmName: `${prefix}-lease-takeover`,
      alarmDescription: 'An Execution_Lease was taken over from a previous Runner.',
      metric: new cloudwatch.Metric({
        namespace: this.metricNamespace,
        metricName: 'LeaseTakeover',
        statistic: 'Sum',
        period: cdk.Duration.minutes(5),
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    this.leaseTakeoverAlarm.addAlarmAction(
      new cloudwatch_actions.SnsAction(notificationTopic),
    );

    cdk.Tags.of(this).add('Name', `${prefix}-observability`);
  }
}
