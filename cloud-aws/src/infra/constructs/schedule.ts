/**
 * ScheduleConstruct - EventBridge Scheduler schedule group.
 *
 * Creates the schedule group that the Host_Adapter populates at spec-push
 * time. The Runtime_Identity creates/deletes individual schedules; the IaC_App
 * only owns the group.
 *
 * Requirements: 13.2
 */
import { Construct } from 'constructs';
import * as cdk from 'aws-cdk-lib';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import type { AwsDeployConfig } from '../../core/config.js';

export interface ScheduleConstructProps {
  config: AwsDeployConfig;
}

export class ScheduleConstruct extends Construct {
  public readonly scheduleGroup: scheduler.CfnScheduleGroup;
  public readonly scheduleGroupArn: string;
  /**
   * The group name, derived once. The Host_Adapter needs it as a plain string
   * (`PHORMA_SCHEDULE_GROUP`), and the group ARN embeds it, so it is a field
   * rather than three copies of the same template literal.
   */
  public readonly scheduleGroupName: string;

  constructor(scope: Construct, id: string, props: ScheduleConstructProps) {
    super(scope, id);

    const { config } = props;
    const prefix = config.namePrefix;
    this.scheduleGroupName = `${prefix}-schedules`;

    this.scheduleGroup = new scheduler.CfnScheduleGroup(this, 'ScheduleGroup', {
      name: this.scheduleGroupName,
    });

    this.scheduleGroupArn = cdk.Fn.join('', [
      'arn:aws:scheduler:',
      cdk.Stack.of(this).region,
      ':',
      cdk.Stack.of(this).account,
      ':schedule-group/',
      this.scheduleGroupName,
    ]);

    cdk.Tags.of(this).add('Name', `${prefix}-schedule`);
  }
}
