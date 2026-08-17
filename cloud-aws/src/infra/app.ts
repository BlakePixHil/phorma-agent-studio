/**
 * CDK application entry point.
 *
 * Reads deployment configuration from CDK context, validates it, then
 * synthesizes the PhormaAwsHostStack. The bootstrap qualifier is applied
 * through DefaultStackSynthesizer so the app deploys into shared accounts.
 *
 * Configuration is passed via CDK context key 'phorma:config' (set by the
 * CLI shim which reads cdk.context.phorma.json). When absent, a placeholder
 * config is used for type-checking synthesis. Both the reading and the
 * placeholder live in `context-config.ts`, which is asserted directly - this
 * module synthesizes on import, so a spec cannot import it.
 */
import { App, DefaultStackSynthesizer } from 'aws-cdk-lib';
import { configFromContext } from './context-config.js';
import { PhormaAwsHostStack } from './stack.js';

const app = new App();

// Read bootstrap qualifier from cdk.json context
const qualifier: string =
  app.node.tryGetContext('@aws-cdk/core:bootstrapQualifier') ?? 'hnb659fds';

// Load and validate deployment configuration from context. A `--context` value
// arrives as a JSON STRING, not an object - see `context-config.ts`.
const config = configFromContext(app.node.tryGetContext('phorma:config'), qualifier);

new PhormaAwsHostStack(app, `${config.namePrefix}-host`, {
  env: { account: config.accountId, region: config.region },
  stackName: `${config.namePrefix}-host`,
  synthesizer: new DefaultStackSynthesizer({ qualifier }),
  config,
});

app.synth();
