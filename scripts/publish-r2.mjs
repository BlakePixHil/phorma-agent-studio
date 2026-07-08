#!/usr/bin/env node
/**
 * CI-only script: syncs release assets from a GitHub Release into the
 * Cloudflare R2 `phorma-releases` bucket and updates the manifest files the
 * in-app updater and download website consume.
 *
 * Layout in R2:
 *   stable/{version}/{filename}        — installer + .sig for each platform
 *   stable/latest.json                 — Tauri updater manifest (latest version)
 *   stable/releases.json               — version list + notes for the website
 *
 * Usage (from repo root, in CI):
 *   node scripts/publish-r2.mjs v0.2.0 release-assets
 *
 * Requires wrangler CLI (installed globally in CI) and R2_* env vars.
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const tag = process.argv[2];

if (!tag || !tag.startsWith('v')) {
  console.error('Usage: node scripts/publish-r2.mjs <vX.Y.Z> <asset-dir>');
  process.exit(1);
}

const version = tag.slice(1); // strip leading 'v'
const bucket = 'phorma-releases';
const prefix = `stable/${version}`;

function r2put(localPath, key) {
  execSync(`wrangler r2 object put "${bucket}/${key}" --file="${localPath}" --remote`, {
    stdio: 'inherit',
    env: process.env,
  });
}

function r2get(key) {
  try {
    const out = execSync(`wrangler r2 object get "${bucket}/${key}" --pipe --remote`, {
      env: process.env,
    });
    return out.toString('utf8');
  } catch {
    return null;
  }
}

// ── Upload all assets from the release directory ──────────────────────────
// The release-downloader action may nest files under a tag-named subdir
// (e.g. release-assets/v0.2.0-beta.2/). Resolve to whichever exists.
let assetDir = resolve(root, process.argv[3] ?? 'release-assets');
if (!existsSync(assetDir)) {
  console.error(`Asset directory not found: ${assetDir}`);
  process.exit(1);
}
// If the directory contains a single subdirectory (the tag name), descend.
const entries = readdirSync(assetDir, { withFileTypes: true });
if (entries.length === 1 && entries[0].isDirectory()) {
  assetDir = join(assetDir, entries[0].name);
  console.log(`Descending into subdirectory: ${assetDir}`);
}

const files = readdirSync(assetDir);
console.log(`Uploading ${files.length} assets to ${prefix}/...`);

for (const file of files) {
  const localPath = join(assetDir, file);
  r2put(localPath, `${prefix}/${file}`);
  console.log(`  ${file}`);
}

// ── Build latest.json (Tauri updater manifest) ────────────────────────────
// The tauri-action emits a latest.json per target; we merge them into one
// keyed by platform. The Worker endpoint reads this and serves the right entry.
const latestByTarget = {};

for (const file of files) {
  if (file === 'latest.json') {
    // The action's own latest.json — read it for the version + notes.
    try {
      const raw = readFileSync(join(assetDir, file), 'utf8');
      const parsed = JSON.parse(raw);
      latestByTarget._meta = {
        version: parsed.version,
        notes: parsed.notes,
        pub_date: parsed.pub_date,
      };
    } catch {
      // Not all targets emit a top-level latest.json; that's fine.
    }
    continue;
  }
  // Map filenames to Tauri target identifiers.
  // e.g. Phorma-Agent-Studio_0.2.0_x64-setup.exe -> windows-x64
  //      Phorma-Agent-Studio_0.2.0_aarch64.app.tar.gz -> darwin-aarch64
  //      Phorma-Agent-Studio_0.2.0_amd64.AppImage -> linux-x64
  const lower = file.toLowerCase();
  const stripped = lower.replace(/\.sig$/, '');
  let target = null;
  if (stripped.endsWith('.exe') || stripped.endsWith('.msi')) {
    target = 'windows-x64';
  } else if (stripped.endsWith('.app.tar.gz') || stripped.endsWith('.dmg')) {
    // Arch is embedded in the filename (e.g. _aarch64.app.tar.gz / _x64.dmg).
    target = lower.includes('aarch64') || lower.includes('arm64') ? 'darwin-aarch64' : 'darwin-x64';
    // DMGs are download-only; the updater consumes .app.tar.gz. Keep the
    // .app.tar.gz URL when both exist by letting it overwrite the dmg entry
    // below only if no url is set yet or the existing one is a dmg.
  } else if (stripped.endsWith('.appimage')) {
    target = 'linux-x64';
  } else if (stripped.endsWith('.deb')) {
    target = 'linux-x64-deb';
  }

  if (target) {
    if (!latestByTarget[target]) latestByTarget[target] = {};
    const entry = latestByTarget[target];
    const url = `https://phorma-agent-studio-cloud.phorma-agent-studio.workers.dev/download/stable/${version}/${file}`;
    if (lower.endsWith('.sig')) {
      entry.signature = readFileSync(join(assetDir, file), 'utf8').trim();
    } else if (stripped.endsWith('.dmg')) {
      // DMG is the human download; the updater uses .app.tar.gz. Keep them apart.
      entry.installerUrl = url;
      entry.installerName = file;
      if (!entry.url) {
        entry.url = url;
        entry.name = file;
      }
    } else {
      entry.url = url;
      entry.name = file;
      if (!entry.installerUrl) {
        entry.installerUrl = url;
        entry.installerName = file;
      }
    }
  }
}

const meta = latestByTarget._meta || {};
const latestManifest = {
  version: meta.version || version,
  notes: meta.notes || '',
  pub_date: meta.pub_date || new Date().toISOString(),
  platforms: latestByTarget,
};
delete latestManifest.platforms._meta;

const tmpLatest = join(root, '.tmp-latest.json');
writeFileSync(tmpLatest, JSON.stringify(latestManifest, null, 2));
r2put(tmpLatest, 'stable/latest.json');
console.log('Updated stable/latest.json');

// ── Update releases.json (append this version) ────────────────────────────
let releases = [];
const existing = r2get('stable/releases.json');
if (existing) {
  try {
    releases = JSON.parse(existing);
  } catch {
    releases = [];
  }
}

// Replace if this version already exists, else append.
releases = releases.filter(r => r.version !== latestManifest.version);
releases.unshift({
  version: latestManifest.version,
  pub_date: latestManifest.pub_date,
  notes: latestManifest.notes,
});
releases = releases.slice(0, 50); // cap history

const tmpReleases = join(root, '.tmp-releases.json');
writeFileSync(tmpReleases, JSON.stringify(releases, null, 2));
r2put(tmpReleases, 'stable/releases.json');
console.log('Updated stable/releases.json');

console.log('R2 publish complete.');
