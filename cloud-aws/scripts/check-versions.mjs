#!/usr/bin/env node
/**
 * Asserts that all five monorepo packages carry the same version number and
 * that every dependency and devDependency in cloud-aws is an exact pin
 * (a bare version, no ^, ~, range or tag).
 *
 * Local workspace links (file:, link:, workspace:, portal:) are exempt - they
 * carry no registry version to pin.
 *
 * Validates: Requirements 6.1, 8.8, 13.9, 13.10
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const packages = [
  'frontend/package.json',
  'backend/package.json',
  'cloud/package.json',
  'engine/package.json',
  'cloud-aws/package.json',
];

let failures = 0;

// --- Check 1: all five packages share one version number ---

const versions = packages.map(pkg => {
  const json = JSON.parse(readFileSync(resolve(root, pkg), 'utf8'));
  return { pkg, version: json.version };
});

const distinct = [...new Set(versions.map(v => v.version))];
if (distinct.length !== 1) {
  console.error('Version mismatch across packages:');
  for (const { pkg, version } of versions) {
    console.error(`  ${pkg}: ${version}`);
  }
  failures++;
} else {
  console.log(`All 5 packages at version ${distinct[0]}`);
}

// --- Check 2: every cloud-aws dependency is an exact pin ---

const cloudAwsPkg = JSON.parse(
  readFileSync(resolve(root, 'cloud-aws/package.json'), 'utf8'),
);

/** A local link carries no registry version, so there is nothing to pin. */
const LOCAL_LINK = /^(file|link|workspace|portal):/;

/** Exact semver: major.minor.patch plus an optional prerelease and build. */
const EXACT_SEMVER =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

let pinned = 0;
for (const field of ['dependencies', 'devDependencies']) {
  for (const [name, spec] of Object.entries(cloudAwsPkg[field] ?? {})) {
    if (LOCAL_LINK.test(spec)) {
      continue;
    }
    if (!EXACT_SEMVER.test(spec)) {
      console.error(
        `cloud-aws ${field}.${name} must be an exact pin, got: "${spec}"`,
      );
      failures++;
    } else {
      pinned++;
    }
  }
}

if (!cloudAwsPkg.dependencies?.['aws-cdk-lib']) {
  console.error('aws-cdk-lib is not declared as a dependency in cloud-aws/package.json');
  failures++;
}

if (!cloudAwsPkg.dependencies?.['tsx']) {
  console.error(
    'tsx must be a runtime dependency of cloud-aws - the CLI launcher spawns it at runtime',
  );
  failures++;
}

if (failures === 0) {
  console.log(`All ${pinned} cloud-aws dependencies are exact pins`);
}

if (failures > 0) {
  process.exit(1);
}
