/**
 * The Phorma_AWS_CLI dispatch.
 *
 * `bin/phorma-aws.mjs` is a launcher and nothing more: it `tsImport`s this module
 * and assigns `process.exitCode = await runVerb(process.argv.slice(2))`. So the
 * argv this module receives starts AT THE VERB - `argv[0]` is the verb name, and
 * `argv[1]` is what `process.argv[3]` was, which is the URL for `request` and the
 * workflow id for `monitor-url` (Req 10.1).
 *
 * `runVerb` RETURNS a code and never calls `process.exit`. Two reasons: a verb that
 * exits mid-write can truncate the final Sentinel_Envelope line the Studio is
 * waiting for, and a returned code is testable in-process, which is what lets
 * Property 24 assert the under-supply rule for every verb without spawning six
 * children.
 *
 * Six verbs. Under-supply is enforced in ONE place, from each verb's declared
 * arity, and each verb also re-checks its own arguments so calling it directly
 * cannot skip the rule (Req 6.4).
 *
 * Feature: aws-byo-deploy
 * Requirements: 3.3, 3.4, 5.1, 5.5, 5.6, 6.2, 6.4, 6.5, 9.1, 10.1, 10.3, 10.4, 11.2
 */

import { runDeploy, DEPLOY_ARITY, DEPLOY_USAGE } from './deploy.js';
import { runDoctor, DOCTOR_ARITY, DOCTOR_USAGE } from './doctor.js';
import { EXIT_FAILURE } from './exit-codes.js';
import { runMonitorUrl, MONITOR_URL_ARITY, MONITOR_URL_USAGE } from './monitor-url.js';
import { runOutputs, OUTPUTS_ARITY, OUTPUTS_USAGE } from './outputs.js';
import { runPlan, PLAN_ARITY, PLAN_USAGE } from './plan.js';
import { runRequest, REQUEST_ARITY, REQUEST_USAGE } from './request.js';
import { createCliContext } from './runtime.js';
import type { CliContext } from './ports.js';

/** One verb: its name, its usage line, how many arguments it needs, and its body. */
export interface VerbSpec {
  name: string;
  /** Names the verb AND its arguments, so the operator can retype the command. */
  usage: string;
  /** Arguments required after the verb name. */
  arity: number;
  run(ctx: CliContext, argv: readonly string[]): Promise<number>;
}

/**
 * The six verbs, in the order the top-level usage line lists them.
 *
 * Exported so `main.spec.ts` enumerates the real table rather than a copy of it: a
 * seventh verb added without a usage line or an arity would fail the property test
 * instead of shipping unchecked.
 */
export const VERB_SPECS: readonly VerbSpec[] = Object.freeze([
  { name: 'plan', usage: PLAN_USAGE, arity: PLAN_ARITY, run: (ctx) => runPlan(ctx) },
  { name: 'deploy', usage: DEPLOY_USAGE, arity: DEPLOY_ARITY, run: (ctx) => runDeploy(ctx) },
  { name: 'request', usage: REQUEST_USAGE, arity: REQUEST_ARITY, run: runRequest },
  {
    name: 'monitor-url',
    usage: MONITOR_URL_USAGE,
    arity: MONITOR_URL_ARITY,
    run: runMonitorUrl,
  },
  { name: 'doctor', usage: DOCTOR_USAGE, arity: DOCTOR_ARITY, run: (ctx) => runDoctor(ctx) },
  { name: 'outputs', usage: OUTPUTS_USAGE, arity: OUTPUTS_ARITY, run: (ctx) => runOutputs(ctx) },
]);

/** The usage line for a missing or unknown verb. */
export const CLI_USAGE = `Usage: phorma-aws <${VERB_SPECS.map((v) => v.name).join('|')}> [...args]`;

/**
 * Run one verb and resolve with its exit code.
 *
 * `ctx` exists for the tests: production passes nothing and gets the Node- and
 * SDK-backed context, which loads no AWS client until a verb actually issues a
 * call. An under-supplied verb returns BEFORE the context is used for anything but
 * writing its usage line, so no AWS call happens on that path (Req 6.4).
 */
export async function runVerb(argv: readonly string[], ctx?: CliContext): Promise<number> {
  const context = ctx ?? createCliContext();
  const name = argv[0];
  const spec = VERB_SPECS.find((verb) => verb.name === name);

  if (!spec) {
    context.io.err(
      name === undefined || name === ''
        ? `${CLI_USAGE}\n`
        : `Unknown verb "${name}".\n${CLI_USAGE}\n`,
    );
    return EXIT_FAILURE;
  }

  if (argv.length - 1 < spec.arity) {
    context.io.err(`${spec.usage}\n`);
    return EXIT_FAILURE;
  }

  return spec.run(context, argv);
}
