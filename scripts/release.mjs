#!/usr/bin/env node
/**
 * Single-command version bump across the monorepo.
 *
 * Keeps every package manifest and the Tauri/Cargo configs in sync so the
 * release pipeline, the in-app "About" display, and the updater endpoint all
 * agree on a single version. Run from the repo root:
 *
 *   node scripts/release.mjs 0.2.0           # bump + commit + tag
 *   node scripts/release.mjs 0.2.0 --dry-run # list targets only; writes nothing
 *
 * The private updater key is never touched here - signing happens in CI via
 * the TAURI_SIGNING_PRIVATE_KEY / _PASSWORD secrets.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const targets = [
  'backend/src-tauri/tauri.conf.json',
  'backend/src-tauri/Cargo.toml',
  'backend/package.json',
  'cloud/package.json',
  'cloud-aws/package.json',
  'engine/package.json',
  'frontend/package.json',
  // Source constants, not manifests: the worker bundle and the Angular app
  // cannot import JSON, so each carries a literal that must track the release.
  // The worker's stamp is what tells a BYO user their deploy is behind.
  'cloud/src/build-info.ts',
  'frontend/src/app/core/app-version.ts',
];

function setJsonVersion(path, version) {
  const json = JSON.parse(readFileSync(resolve(root, path), 'utf8'));
  json.version = version;
  writeFileSync(resolve(root, path), JSON.stringify(json, null, 2) + '\n');
}

function setTomlVersion(path, version) {
  const file = resolve(root, path);
  const lines = readFileSync(file, 'utf8').split('\n');
  let bumped = false;
  const out = lines.map(line => {
    if (!bumped && /^version\s*=/.test(line)) {
      bumped = true;
      return `version = "${version}"`;
    }
    return line;
  });
  writeFileSync(file, out.join('\n'));
}

function setTauriConfVersion(path, version) {
  const json = JSON.parse(readFileSync(resolve(root, path), 'utf8'));
  json.version = version;
  writeFileSync(resolve(root, path), JSON.stringify(json, null, 2) + '\n');
}

/**
 * Rewrites the single-quoted string literal in an exported constant, e.g.
 * `export const WORKER_BUILD = '0.2.0';`. Throws rather than silently doing
 * nothing, because a missed stamp ships a worker that lies about its version.
 */
function setConstVersion(path, version) {
  const file = resolve(root, path);
  const before = readFileSync(file, 'utf8');
  const after = before.replace(
    /(export const \w+ = ')[^']*(';)/,
    `$1${version}$2`,
  );
  if (after === before) {
    throw new Error(`Could not find a version constant to bump in ${path}`);
  }
  writeFileSync(file, after);
}

const version = process.argv[2];
const dryRun = process.argv.includes('--dry-run');

if (!version || !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) {
  console.error('Usage: node scripts/release.mjs <semver> [--dry-run]');
  process.exit(1);
}

console.log(`Bumping to ${version}${dryRun ? ' (dry run - nothing is written)' : ''}...`);

for (const target of targets) {
  // A dry run must leave the tree untouched. It used to rewrite every file and
  // skip only the git steps, which left a dirty tree indistinguishable from a
  // real bump.
  if (dryRun) {
    console.log(`  would bump ${target}`);
    continue;
  }
  if (target.endsWith('.toml')) setTomlVersion(target, version);
  else if (target.endsWith('tauri.conf.json')) setTauriConfVersion(target, version);
  else if (target.endsWith('.ts')) setConstVersion(target, version);
  else setJsonVersion(target, version);
  console.log(`  ${target}`);
}

if (dryRun) {
  console.log('Dry run - no files changed, no git writes.');
  process.exit(0);
}

const tag = `v${version}`;
execSync(`git add ${targets.join(' ')}`, { cwd: root, stdio: 'inherit' });
execSync(`git commit -m "release: ${version}"`, { cwd: root, stdio: 'inherit' });
execSync(`git tag ${tag}`, { cwd: root, stdio: 'inherit' });
console.log(`Committed and tagged ${tag}. Push with: git push origin main ${tag}`);
