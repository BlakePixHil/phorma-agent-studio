#!/usr/bin/env node
/**
 * check-telemetry-secrets.mjs
 *
 * Two secrets guard the telemetry admin surface, and NEITHER may ever reach a
 * browser:
 *
 * 1. `TELEMETRY_ADMIN_USER_IDS` - the Owner_Allowlist. It exists ONLY as a
 *    Worker secret on `cloud/` (`npx wrangler secret put TELEMETRY_ADMIN_USER_IDS
 *    --env hosted`). Authorization is decided server side; the dashboard presents
 *    a Clerk session token and reads the answer. A copy of the allowlist in
 *    client code would not just leak who the owners are, it would invite a
 *    client-side authorization check that an attacker edits away
 *    (Requirements 10.15, 11.4).
 * 2. The Clerk SECRET key. The dashboard ships the Clerk PUBLISHABLE key
 *    (`pk_test_...` / `pk_live_...`), which is public by design and is exactly
 *    what Requirement 10.15 asks build configuration to carry. An `sk_`-prefixed
 *    key or a `CLERK_SECRET` reference in a browser bundle is a real leak:
 *    that key can mint sessions for any user.
 *
 * So this guard checks the source trees AND the built artifact. The source scan
 * catches the mistake at the moment it is written; the bundle scan catches the
 * case where a secret arrives through a path no source grep would show - an
 * environment file replacement, a `define` in `angular.json`, a transitive
 * dependency, or an `.env` inlined at build time.
 *
 * `sk_` is matched with an identifier boundary in front of it so ordinary words
 * (`risk_score`, `task_id`, `mask_url`) cannot trip the check, and `pk_` is
 * deliberately NOT matched. Every pattern is proved against a positive and a
 * negative canary before the scan runs, so a pattern that stopped working fails
 * loudly instead of passing vacuously.
 *
 * The script lives in `scripts/`, outside both scanned source trees and the
 * dashboard `dist/`, so the literals below cannot match themselves.
 *
 * Run: node scripts/check-telemetry-secrets.mjs [--require-bundle]
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SELF = resolve(fileURLToPath(import.meta.url));

/** Client source trees. Nothing here ends up anywhere but a browser. */
const SOURCE_TREES = ['frontend/src', 'admin/src'];

/**
 * The dashboard production build output (`admin/angular.json` -> `outputPath`).
 * `.github/workflows/ci.yml` runs the admin production build BEFORE this guard,
 * so in CI the bundle is always present - see the missing-bundle handling below.
 */
const BUNDLE_DIR = 'admin/dist/admin/browser';

/** Extensions worth reading. Fonts and images cannot carry a reviewable string. */
const TEXT = new Set([
  '.css',
  '.html',
  '.js',
  '.json',
  '.map',
  '.md',
  '.mjs',
  '.scss',
  '.svg',
  '.ts',
  '.txt',
  '.webmanifest',
]);

/**
 * The Owner_Allowlist secret name. Forbidden in client SOURCE as a bare literal:
 * even a comment mentioning it belongs in `admin/README.md`, not in a file that
 * compiles into a browser bundle, because a comment is how a real read starts.
 */
const ALLOWLIST_SECRET = 'TELEMETRY_ADMIN_USER_IDS';

const SOURCE_PATTERNS = [
  {
    label: `Owner_Allowlist Worker secret name (${ALLOWLIST_SECRET})`,
    pattern: new RegExp(ALLOWLIST_SECRET, 'g'),
    positive: `env.${ALLOWLIST_SECRET}`,
    remedy:
      'the Owner_Allowlist is a Worker secret on `cloud/` and authorization is\n' +
      '        decided server side. The dashboard must not name it, read it, or explain\n' +
      '        it in a comment - put that prose in `admin/README.md` instead.',
  },
];

const BUNDLE_PATTERNS = [
  ...SOURCE_PATTERNS,
  {
    label: 'Clerk secret key (`sk_test_` / `sk_live_`)',
    pattern: /(?<![A-Za-z0-9_$])sk_(?:test|live)_[A-Za-z0-9]/g,
    positive: 'sk_test_0123456789abcdef',
    remedy:
      'the dashboard may ship only the PUBLISHABLE key (`pk_...`). A secret key in\n' +
      '        a browser bundle can mint a session for any user - rotate it in the Clerk\n' +
      '        dashboard NOW, then remove it from build configuration.',
  },
  {
    label: 'secret-key-shaped `sk_` literal',
    pattern: /(?<![A-Za-z0-9_$])sk_[A-Za-z0-9]{24,}/g,
    positive: `sk_${'a'.repeat(28)}`,
    remedy:
      'this has the shape of a secret key with an unrecognized flavour. If it is\n' +
      '        genuinely not a key, narrow the pattern in this guard rather than deleting it.',
  },
  {
    label: 'Clerk secret key reference (`CLERK_SECRET`)',
    pattern: /clerk[_-]?secret/gi,
    positive: 'CLERK_SECRET_KEY',
    remedy:
      'nothing in the browser has any use for the Clerk secret key, so a reference\n' +
      '        to one means a server-side value was wired into the client build.',
  },
];

/**
 * Strings that must match NOTHING. An over-broad pattern that fires on ordinary
 * code is a guard the next person disables, so the noise is a failure too.
 */
const NEGATIVE_CANARIES = [
  'const risk_score = 1;',
  'task_id',
  'mask_url',
  'clerkPublishableKey',
  'pk_test_0123456789abcdef',
  'pk_live_0123456789abcdef',
  'asked_for_it',
];

const failures = [];
const warnings = [];

/** Every text file under `dir`, recursively. `node_modules` is never client source. */
function textFiles(dir) {
  const out = [];
  const walk = (absolute) => {
    for (const dirent of readdirSync(absolute, { withFileTypes: true })) {
      if (dirent.name === 'node_modules' || dirent.name === '.angular') continue;
      const child = resolve(absolute, dirent.name);
      if (dirent.isDirectory()) {
        walk(child);
        continue;
      }
      if (child === SELF) continue;
      const dot = dirent.name.lastIndexOf('.');
      if (dot < 0 || !TEXT.has(dirent.name.slice(dot).toLowerCase())) continue;
      out.push(child);
    }
  };
  walk(dir);
  return out;
}

/** A match rendered without echoing the secret it found. */
function redact(match) {
  return match.length > 10 ? `${match.slice(0, 10)}...` : match;
}

function scan(files, patterns, label) {
  for (const absolute of files) {
    const source = readFileSync(absolute, 'utf-8');
    const shown = relative(ROOT, absolute).replace(/\\/g, '/');
    for (const { label: what, pattern, remedy } of patterns) {
      for (const match of source.matchAll(new RegExp(pattern.source, pattern.flags))) {
        const line = source.slice(0, match.index).split('\n').length;
        failures.push(
          `${shown}:${line} contains ${what} ("${redact(match[0])}") in the ${label}.\n` +
            `        ${remedy}`,
        );
      }
    }
  }
}

// ── Canaries: prove the detectors work before trusting a clean scan ──────────
for (const { label, pattern, positive } of BUNDLE_PATTERNS) {
  if (!new RegExp(pattern.source, pattern.flags).test(positive)) {
    failures.push(
      `the pattern for ${label} no longer matches its own known-bad sample, so ` +
        'every scan below would pass vacuously - fix the pattern.',
    );
  }
  for (const clean of NEGATIVE_CANARIES) {
    if (new RegExp(pattern.source, pattern.flags).test(clean)) {
      failures.push(
        `the pattern for ${label} matches "${clean}", which is legitimate code. ` +
          'Narrow it - a guard that cries wolf gets switched off.',
      );
    }
  }
}

// ── Client source trees ─────────────────────────────────────────────────────
let sourceCount = 0;
for (const tree of SOURCE_TREES) {
  const absolute = resolve(ROOT, tree);
  if (!existsSync(absolute)) {
    failures.push(
      `${tree} does not exist. If the package moved, move this guard with it - a ` +
        'silently skipped secret check is worse than none.',
    );
    continue;
  }
  const files = textFiles(absolute);
  if (files.length === 0) {
    failures.push(`${tree} yielded no scannable files, so the scan is vacuous - fix the walker.`);
    continue;
  }
  sourceCount += files.length;
  scan(files, SOURCE_PATTERNS, 'client source');
}

// ── Built dashboard bundle ──────────────────────────────────────────────────
/**
 * A missing bundle is a FAILURE in CI and a warning locally. CI runs the admin
 * production build first, so absence there means the guard was reordered ahead of
 * the build and would otherwise start passing without checking anything. Locally,
 * a developer who has never built the dashboard should still get the source scan
 * instead of a failure they can only fix with a two-minute build.
 */
const requireBundle = process.argv.includes('--require-bundle') || Boolean(process.env.CI);
const bundleAbsolute = resolve(ROOT, BUNDLE_DIR);
let bundleCount = 0;
let bundleScanned = false;

if (!existsSync(bundleAbsolute) || !statSync(bundleAbsolute).isDirectory()) {
  const message =
    `${BUNDLE_DIR} does not exist, so the built dashboard was not scanned. Run ` +
    '`cd admin; npm run build` first.';
  if (requireBundle) {
    failures.push(
      `${message}\n` +
        '        This is fatal here because CI (or --require-bundle) promised the bundle ' +
        'would\n        exist. Order this guard AFTER the admin production build step.',
    );
  } else {
    warnings.push(message);
  }
} else {
  const files = textFiles(bundleAbsolute);
  if (files.length === 0) {
    failures.push(
      `${BUNDLE_DIR} exists but holds no scannable files, so the bundle scan is ` +
        'vacuous - check the output path against `admin/angular.json`.',
    );
  } else {
    bundleCount = files.length;
    bundleScanned = true;
    scan(files, BUNDLE_PATTERNS, 'built dashboard bundle');
  }
}

for (const warning of warnings) console.warn(`  WARN: ${warning}`);

if (failures.length > 0) {
  for (const failure of failures) console.error(`  FAIL: ${failure}`);
  console.error(`\ncheck-telemetry-secrets FAILED with ${failures.length} failure(s).`);
  process.exit(1);
}

const bundleNote = bundleScanned
  ? `${bundleCount} file(s) in ${BUNDLE_DIR}`
  : `${BUNDLE_DIR} SKIPPED (not built)`;
console.log(
  `check-telemetry-secrets passed: ${sourceCount} client source file(s) carry no ` +
    `${ALLOWLIST_SECRET}, ${bundleNote}.`,
);
