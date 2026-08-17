/**
 * Runs every `engine/test/*.e2e.mts` scenario script and fails on the first
 * one that fails.
 *
 * Why this exists: `engine/npm test` is `vitest --run`, and `vitest.config.ts`
 * explicitly EXCLUDES `test/**`. So before this runner, all eleven scenario
 * scripts (~400 assertions covering journal replay, sub-workflow frames,
 * for-each correlation, retry/fallback, usage pricing and the portal
 * projection) only ran when a human remembered to type the command. One of
 * them - `ias-template.e2e.mts` - had been dead for long enough that its
 * import chain grew a `@phorma/engine` value import past it, so it crashed at
 * MODULE_NOT_FOUND with zero checks executed and nobody noticed.
 *
 * TSX_TSCONFIG_PATH: two scripts (`ias-template`, `connectors-builtin`) import
 * frontend modules that resolve `@phorma/engine` through the tsconfig path
 * alias. tsx applies `paths` from ONE tsconfig, chosen relative to the entry
 * file, and `engine/tsconfig.json` has no alias (it IS the engine). Pointing
 * tsx at the frontend tsconfig is what makes the cross-package imports
 * resolve; engine-relative imports are plain relative paths and unaffected.
 *
 * Usage: npm run test:e2e   (from engine/)
 */
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
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

const env = { ...process.env, TSX_TSCONFIG_PATH: join(repoRoot, 'frontend', 'tsconfig.json') };
const failed = [];

for (const script of scripts) {
  console.log(`\n=== ${script} ===`);
  const result = spawnSync('npx', ['-y', 'tsx', join(testDir, script)], {
    cwd: repoRoot,
    env,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  // A crash before the first assertion (signal, or a module-resolution error)
  // is a failure too - that is precisely the mode that hid ias-template.
  if (result.status !== 0) failed.push(`${script} (exit ${result.status ?? `signal ${result.signal}`})`);
}

console.log(`\n${scripts.length - failed.length}/${scripts.length} scenario scripts passed.`);
if (failed.length > 0) {
  for (const entry of failed) console.error(`  FAILED  ${entry}`);
  process.exit(1);
}
