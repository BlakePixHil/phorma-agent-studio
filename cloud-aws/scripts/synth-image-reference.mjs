#!/usr/bin/env node
/**
 * The second Check_Pipeline synthesis: the Container_Image REFERENCE path.
 *
 * `npm run check` synthesizes twice, once per Container_Image path, because the
 * two paths build different templates: the asset path fingerprints
 * `cloud-aws/Dockerfile` and derives the Task_Execution ECR grant from the CDK
 * bootstrap image repository, the reference path carries `imageUri` verbatim and
 * derives that grant by parsing the reference (Req 4.1, 4.2, 4.4). The first
 * `cdk synth --quiet` in the chain covers the asset path, since `infra/app.ts`
 * falls back to a placeholder config with no `imageUri` when no context is
 * supplied. This script covers the other one.
 *
 * It exists as a script rather than a second inline `cdk synth` because the
 * config travels as `--context phorma:config=<json>` (`cli/config-file.ts`
 * `cdkConfigContextArgs`), and a JSON literal inside an npm script is not
 * portable across `cmd.exe` and `sh` quoting. Spawning with an argument array
 * sidesteps shell quoting entirely.
 *
 * Credential-free and Docker-free (Req 13.5): the config is a literal, nothing is
 * looked up, and the reference path builds no image asset.
 *
 * A distinct `--output` directory keeps this assembly away from the one the first
 * synth wrote, which `check-docs.mjs` reads afterwards, and keeps the two
 * `synth.lock` files apart. It sits UNDER `cdk.out` on purpose: that directory is
 * already gitignored, already skipped by `check-adapter-real.mjs`, and already in
 * `IMAGE_CONTEXT_EXCLUDES`, so a sibling output directory would instead land
 * inside the image build context and change the asset fingerprint on every run.
 *
 * Feature: aws-byo-deploy
 * Requirements: 4.1, 4.2, 4.4, 13.5, 13.6
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Where this assembly is written. Never `cdk.out` itself - see the header. */
const OUTPUT_DIR = 'cdk.out/image-path';

/**
 * A platform-published image in an account that is NOT the deploy account, so
 * the ECR grant derivation cannot pass by accidentally matching the bootstrap
 * repository. Same reference the template assertions use.
 */
const REFERENCE_IMAGE_URI =
  '210987654321.dkr.ecr.us-east-1.amazonaws.com/platform/phorma-host:1.2.3';

/**
 * A fully populated Deploy_Config_File shape, `imageUri` set.
 *
 * `namePrefix` differs from the placeholder config in `infra/app.ts`, so this
 * assembly's template file cannot be mistaken for the asset path's.
 */
const CONFIG = {
  accountId: '000000000000',
  region: 'us-east-1',
  namePrefix: 'phorma-check-image',
  permissionsBoundaryArn: 'arn:aws:iam::000000000000:policy/placeholder-boundary',
  bootstrapQualifier: 'phorma',
  egressAllowList: [],
  costAllocationTags: { app: 'phorma' },
  retentionDays: 30,
  alarmNotificationArn: 'arn:aws:sns:us-east-1:000000000000:placeholder-topic',
  imageUri: REFERENCE_IMAGE_URI,
};

const CDK_BIN = join(PKG_ROOT, 'node_modules', 'aws-cdk', 'bin', 'cdk');
if (!existsSync(CDK_BIN)) {
  process.stderr.write(
    `aws-cdk is not installed at ${CDK_BIN}. Run npm install in cloud-aws.\n`,
  );
  process.exit(1);
}

// Run the CLI through this Node binary rather than the `cdk` shim, so the spawn
// needs no shell on any platform.
const result = spawnSync(
  process.execPath,
  [
    CDK_BIN,
    'synth',
    '--quiet',
    '--context',
    `phorma:config=${JSON.stringify(CONFIG)}`,
    '--output',
    OUTPUT_DIR,
  ],
  { cwd: PKG_ROOT, stdio: 'inherit' },
);

if (result.error) {
  process.stderr.write(`cdk synth failed to start: ${result.error.message}\n`);
  process.exit(1);
}
if (result.status !== 0) {
  process.stderr.write(
    `cdk synth on the imageUri path exited with ${result.status ?? 'a signal'}.\n`,
  );
  process.exit(result.status ?? 1);
}

const template = join(PKG_ROOT, OUTPUT_DIR, `${CONFIG.namePrefix}-host.template.json`);
if (!existsSync(template)) {
  // The stack name derives from `namePrefix`, so an absent template means the
  // context never reached `infra/app.ts` and the synthesis silently fell back to
  // the placeholder config - which would make this whole step vacuous.
  process.stderr.write(
    `cdk synth wrote no ${CONFIG.namePrefix}-host template into ${OUTPUT_DIR}. ` +
      'The phorma:config context did not reach src/infra/app.ts.\n',
  );
  process.exit(1);
}

process.stdout.write(
  `Container image reference path synthesized: ${CONFIG.namePrefix}-host from ${REFERENCE_IMAGE_URI}.\n`,
);
