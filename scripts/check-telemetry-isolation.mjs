#!/usr/bin/env node
/**
 * check-telemetry-isolation.mjs
 *
 * `TelemetryService` must stay a DI LEAF. The known NG0200 cycle is
 * `RunControllerService -> ModelTransportService -> PhormaCloudService ->
 * CloudService -> RunControllerService`, and several of those services now inject
 * `TelemetryService` as counter call sites - so `TelemetryService` may inject
 * none of them. An import added here does not fail the build; it fails at
 * runtime, in a user's app, as a blank screen on startup.
 *
 * The allowlist below is also how two requirements hold structurally instead of
 * by convention:
 *
 * - Requirement 3.5: telemetry reads neither the `usage_ledger` cloud table nor
 *   the local `usage` IndexedDB store. It has no reference through which it
 *   could - no storage service, no settings service, nothing on the usage path.
 * - Requirement 5.8: telemetry raises no toast and writes no console entry. It
 *   does not import `ToastService` or the console service.
 *
 * So this guard checks the one thing that keeps all three true: the import list
 * of `frontend/src/app/core/telemetry.service.ts` stays inside ALLOWED. Adding
 * an import there is a CI failure, not a review comment - see the "DI safety"
 * section of `.kiro/specs/telemetry-phone-home/design.md`.
 *
 * Run: node scripts/check-telemetry-isolation.mjs
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVICE = 'frontend/src/app/core/telemetry.service.ts';

/**
 * Every module specifier `telemetry.service.ts` is allowed to reference, and why
 * it is safe. All seven are leaves: three telemetry modules with no imports of
 * their own beyond types, two constant modules, `TauriService` (which injects
 * nothing) and Angular itself.
 */
const ALLOWED = {
  '@angular/core': 'framework primitives only',
  './app-version': 'constant module, no imports',
  './phorma-cloud-url': 'leaf module that owns the base URL, deliberately not a service',
  './tauri.service': 'the ONE injected service - a leaf that injects nothing',
  './telemetry-catalog': 'pure catalog, structural twin of the Worker one',
  './telemetry-core': 'pure state algebra, no Angular',
  './telemetry-storage': 'localStorage adapter, no Angular',
};

const failures = [];
const absolute = resolve(ROOT, SERVICE);

if (!existsSync(absolute)) {
  console.error(
    `  FAIL: ${SERVICE} does not exist. If the service moved, move this guard with ` +
      'it - a silently skipped isolation check is worse than none.',
  );
  console.error('\ncheck-telemetry-isolation FAILED with 1 failure(s).');
  process.exit(1);
}

const source = readFileSync(absolute, 'utf-8');

/**
 * Comments and template literals are stripped first: the file's own header
 * documents this allowlist and names forbidden services in prose, and a doc
 * comment must not be able to fail or to pass the check.
 */
const code = source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/[^\n]*/g, '')
  .replace(/`(?:[^`\\]|\\[\s\S])*`/g, '``');

/** Static `from '...'`, side-effect `import '...'`, dynamic `import('...')`, `require('...')`. */
const PATTERNS = [
  /\bfrom\s*['"]([^'"]+)['"]/g,
  /\bimport\s*['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
];

const found = new Set();
for (const pattern of PATTERNS) {
  for (const [, specifier] of code.matchAll(pattern)) {
    found.add(specifier.replace(/\.(?:js|ts|mjs)$/, ''));
  }
}

if (found.size === 0) {
  failures.push(
    `no import specifiers were found in ${SERVICE}. The parser in this guard no ` +
      'longer matches the file, so it is passing vacuously - fix the parser.',
  );
}

for (const specifier of [...found].sort()) {
  if (specifier in ALLOWED) continue;
  failures.push(
    `${SERVICE} imports "${specifier}", which is not on the allowlist.\n` +
      '        TelemetryService must stay a DI leaf: services on the\n' +
      '        RunControllerService -> ModelTransportService -> PhormaCloudService ->\n' +
      '        CloudService cycle inject IT, so it may inject none of them, no toast or\n' +
      '        console service, and nothing on the usage path (Requirements 3.5, 5.8).\n' +
      `        Allowed: ${Object.keys(ALLOWED).join(', ')}.\n` +
      '        Move the logic into telemetry-core.ts, pass the value in from the call\n' +
      '        site, or read it through a leaf module like phorma-cloud-url.ts. If the\n' +
      '        import is genuinely a leaf and genuinely needed, widen ALLOWED in this\n' +
      '        script AND the "DI safety" section of\n' +
      '        .kiro/specs/telemetry-phone-home/design.md in the same change.',
  );
}

for (const specifier of Object.keys(ALLOWED)) {
  if (!found.has(specifier)) {
    failures.push(
      `ALLOWED lists "${specifier}", which ${SERVICE} no longer imports - prune it ` +
        'so the allowlist keeps describing the real dependency surface.',
    );
  }
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`  FAIL: ${failure}`);
  console.error(`\ncheck-telemetry-isolation FAILED with ${failures.length} failure(s).`);
  process.exit(1);
}

console.log(
  `check-telemetry-isolation passed: ${found.size} import(s) in ${SERVICE}, all on the allowlist.`,
);
