/**
 * Runs every `cloud-aws/test/*.e2e.mts` scenario script and reports which failed.
 *
 * Why this exists: `cloud-aws/npm test` is `vitest --run`, and
 * `vitest.config.ts` explicitly EXCLUDES `test/**`. So before this runner, the
 * scenario scripts only ran when a human remembered to type the command, and CI
 * ran none of them. That is the same gap `engine/test/run-all.mjs` was written to
 * close, and it hid a dead script there for long enough to matter.
 *
 * These scripts drive the real `runner.ts` and the real Server_Entry against
 * `FakeRunTable` and the fake AWS backends, so they need no credentials and no
 * Docker. They are the only place the Execution_Lease, the fencing invariant, the
 * Frame_Inbox drain and the schedule path are exercised end to end.
 *
 * No `TSX_TSCONFIG_PATH` override, unlike the engine runner: every script here
 * resolves `@phorma/engine` through `cloud-aws/tsconfig.json`, which is the
 * tsconfig tsx already picks relative to the entry file.
 *
 * Usage: npm run test:e2e   (from cloud-aws/)
 */
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(testDir, '..', '..');

const scripts = readdirSync(testDir)
  .filter((name) => name.endsWith('.e2e.mts'))
  .sort();

if (scripts.length === 0) {
  console.error('No *.e2e.mts scenario scripts found - did the directory move?');
  process.exit(1);
}

/**
 * The tsx CLI entry, resolved from the package rather than shelled out to.
 *
 * `tsx` is a runtime `dependency` of this package at an exact pin, so it is
 * always present and this needs no network. Spawning `process.execPath` with it
 * avoids both the platform `.cmd` shim problem and Node's DEP0190 warning, which
 * `shell: true` with an argument array emits into every CI log.
 */
const TSX_CLI = createRequire(import.meta.url).resolve('tsx/cli');

const failed = [];

for (const script of scripts) {
  console.log(`\n=== ${script} ===`);
  const result = spawnSync(process.execPath, [TSX_CLI, join(testDir, script)], {
    cwd: repoRoot,
    stdio: 'inherit',
  });
  // A crash before the first assertion - a signal, or a module-resolution error -
  // is a failure too. That mode looks like silence, not like a red test.
  if (result.status !== 0) {
    failed.push(`${script} (exit ${result.status ?? `signal ${result.signal}`})`);
  }
}

console.log(`\n${scripts.length - failed.length}/${scripts.length} scenario scripts passed.`);
if (failed.length > 0) {
  for (const entry of failed) console.error(`  FAILED  ${entry}`);
  process.exit(1);
}
