/**
 * The CloudFormation output names the deploy emits and endpoint discovery reads.
 *
 * These logical ids are the contract between the two ends of Requirement 9: the
 * IaC_App declares one output per endpoint (`infra/stack.ts`), and the `deploy`
 * and `outputs` verbs look the values up by name to build the Sentinel_Envelope
 * the Studio persists into `triggerApiUrl` / `monitorApiUrl`. Declaring the names
 * here, once, is what stops a rename on one end from silently producing a deploy
 * whose endpoints can never be discovered.
 *
 * Constants only, no imports: this module sits in `core/`, so it stays free of
 * the AWS SDK, of CDK and of any I/O, and the CLI can read the same names without
 * pulling `aws-cdk-lib` into its process.
 *
 * Requirements: 9.1, 9.4
 */

/** Logical id of the output carrying the Trigger_API base URL (`https://...`). */
export const TRIGGER_API_OUTPUT = 'TriggerApiUrl';

/** Logical id of the output carrying the Monitor_API WebSocket URL (`wss://...`). */
export const MONITOR_API_OUTPUT = 'MonitorApiUrl';

/** One of the two output names a successful deploy must return. */
export type RequiredOutputName = typeof TRIGGER_API_OUTPUT | typeof MONITOR_API_OUTPUT;

/**
 * Every output endpoint discovery requires, in the order it reports them.
 *
 * Discovery iterates this list rather than reading two fields by hand, so an
 * output absent from a successful deploy is reported BY NAME and the previously
 * stored endpoint values are left untouched (Req 9.4).
 */
export const REQUIRED_OUTPUTS: readonly RequiredOutputName[] = Object.freeze([
  TRIGGER_API_OUTPUT,
  MONITOR_API_OUTPUT,
]);
