#!/usr/bin/env node
/**
 * check-imports-declared.mjs
 *
 * Asserts that every BARE import specifier under `bin/`, `src/aws/` and
 * `src/cli/` resolves to a package that `cloud-aws/package.json` declares at an
 * exact version (no `^`, `~`, range or dist-tag).
 *
 * This is the reverse direction of `check-versions.mjs`. That script asserts
 * every entry IN the manifest is an exact pin; this one asserts every specifier
 * actually IMPORTED is in the manifest. Both directions are needed: the CLI shim
 * previously imported eight packages the manifest never declared, so `plan`,
 * `request`, `monitor-url` and `doctor` all died on module resolution in a fresh
 * install.
 *
 * "Bare" means a package specifier, not a path. `@aws-sdk/client-ec2` and
 * `tsx/esm/api` are bare; `./ports.js` and `../core/config.js` are not. A
 * subpath resolves to its owning package, so `tsx/esm/api` needs `tsx` declared,
 * while `@aws-sdk/client-dynamodb` is itself the package name (a scoped package
 * is `@scope/name`, and only a third segment onward is a subpath).
 *
 * All four import forms are caught, because missing any one of them makes the
 * guard nearly blind:
 *   - static value import        `import x from 'pkg'`
 *   - static type-only import    `import type { X } from 'pkg'`  (ports.ts is
 *                               entirely type-only imports)
 *   - dynamic import expression  `await import('pkg')`           (preflight.ts
 *                               and the CLI shim load the SDK this way on
 *                               purpose)
 *   - re-export                  `export { x } from 'pkg'`, `export type {...}`
 * plus bare side-effect imports and `require()`.
 *
 * Exemptions, each with a reason:
 *   - Node builtins (`node:fs`, `node:child_process`, ...) are not npm packages,
 *     so there is nothing to declare. `bin/phorma-aws.mjs` and
 *     `src/server/index.ts` rely on them.
 *   - A local link (`file:`, `link:`, `workspace:`, `portal:`) is declared but
 *     carries no registry version, so the exact-pin half does not apply.
 *     `@phorma/engine` is `file:../engine`. `check-versions.mjs` exempts local
 *     links for the same reason.
 *   - Non-package schemes (`data:`, `http:`, `file:`) are not package
 *     specifiers.
 *
 * `*.spec.ts` files under the scanned directories ARE in scope, deliberately: a
 * spec importing an undeclared package is the same fresh-install failure, just
 * on the test path. A declaration in `devDependencies` satisfies the guard,
 * since spec files never ship in the container image. Today that covers `vitest`
 * and `fast-check`.
 *
 * The guard does NOT check that a package is physically present in
 * `node_modules` - that would make it depend on install state and would make it
 * unusable against a seeded fixture tree.
 *
 * Runs standalone (`node scripts/check-imports-declared.mjs`), optionally
 * against another root (`--root <dir>`), and exports `checkImportsDeclared(root)`
 * so a test can point it at a fixture tree.
 *
 * Validates: Requirements 6.1, 6.3, 8.8
 */
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { isBuiltin } from 'node:module';
import { pathToFileURL } from 'node:url';

/**
 * Directories whose imports must be declared. `src/cli/` may not exist yet.
 *
 * `src/shim/` is in scope because it is bundled into a Lambda by `shim/build.ts`.
 * An undeclared specifier there fails the bundle, which fails synthesis, which is
 * the same fresh-install class of failure this guard exists for.
 */
const SCOPE_DIRS = ['bin', 'src/aws', 'src/cli', 'src/shim'];

/** Source extensions worth scanning. `.d.ts` counts - its imports are real. */
const SOURCE_EXTENSIONS = ['.mjs', '.cjs', '.js', '.mts', '.cts', '.ts'];

/** A local link carries no registry version, so there is nothing to pin. */
const LOCAL_LINK = /^(?:file|link|workspace|portal):/;

/** Exact semver: major.minor.patch plus an optional prerelease and build. */
const EXACT_SEMVER =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/**
 * Specifier-bearing forms, applied per line.
 *
 * `from '...'` covers static value imports, `import type` and both re-export
 * shapes, because all four end in the same `from` clause.
 */
const SPECIFIER_PATTERNS = [
  /(?:^|[^\w$.])from\s*['"]([^'"]+)['"]/g, // static value, type-only, re-export
  /\bimport\s*\(\s*['"]([^'"]+)['"]/g, // dynamic import expression
  /\brequire\s*\(\s*['"]([^'"]+)['"]/g, // CommonJS interop
  /^\s*import\s+['"]([^'"]+)['"]/g, // bare side-effect import
];

/**
 * Recursively collect scannable source files under a directory.
 * A missing directory yields nothing - `src/cli/` is created later and the
 * guard must pick it up the moment it appears without failing before then.
 */
async function collectSourceFiles(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      files.push(...(await collectSourceFiles(full)));
    } else if (SOURCE_EXTENSIONS.some(ext => entry.name.endsWith(ext))) {
      files.push(full);
    }
  }
  return files;
}

/**
 * A path specifier, not a package. Covers relative, absolute POSIX and Windows
 * drive paths.
 */
function isPathSpecifier(spec) {
  return spec.startsWith('.') || spec.startsWith('/') || /^[A-Za-z]:[\\/]/.test(spec);
}

/**
 * The package a bare specifier resolves to. `@scope/name` is the package;
 * `@scope/name/sub` and `name/sub` are subpaths of theirs. Returns null for a
 * malformed scoped specifier such as a bare `@aws-sdk`.
 */
function packageNameOf(spec) {
  const parts = spec.split('/');
  if (spec.startsWith('@')) {
    if (parts.length < 2 || !parts[1]) return null;
    return `${parts[0]}/${parts[1]}`;
  }
  return parts[0];
}

/**
 * Extract every bare import specifier from one source file, with line numbers.
 *
 * Comment handling is line-based and deliberately conservative: whole-line
 * comments and block comments are skipped, but a trailing comment is not
 * stripped. The failure mode is a loud false positive on a commented-out
 * import, never a silently skipped real one.
 */
function extractSpecifiers(content) {
  const found = [];
  const lines = content.split('\n');
  let inBlockComment = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (inBlockComment) {
      if (trimmed.includes('*/')) inBlockComment = false;
      continue;
    }
    if (trimmed.startsWith('/*')) {
      if (!trimmed.includes('*/')) inBlockComment = true;
      continue;
    }
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;

    for (const pattern of SPECIFIER_PATTERNS) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(line)) !== null) {
        found.push({ specifier: match[1], line: i + 1 });
      }
    }
  }
  return found;
}

/**
 * Run the guard against a package root (the directory holding package.json).
 * Returns the violation list plus counts, so a caller can assert on either.
 */
export async function checkImportsDeclared(root) {
  const pkgRoot = resolve(root);
  const violations = [];

  let manifest;
  try {
    manifest = JSON.parse(await readFile(join(pkgRoot, 'package.json'), 'utf-8'));
  } catch (e) {
    return {
      violations: [`failed to read package.json in ${pkgRoot}: ${e.message}`],
      filesScanned: 0,
      packagesChecked: 0,
      scannedDirs: [],
    };
  }

  const declared = new Map(
    Object.entries({
      ...(manifest.dependencies ?? {}),
      ...(manifest.devDependencies ?? {}),
    }),
  );

  const scannedDirs = [];
  const files = [];
  for (const dir of SCOPE_DIRS) {
    const dirFiles = await collectSourceFiles(join(pkgRoot, dir));
    if (dirFiles.length > 0) {
      scannedDirs.push(dir);
      files.push(...dirFiles);
    }
  }

  // Anti-vacuity: if not one scope directory carries a source file, the guard
  // proved nothing and must say so rather than reporting success.
  if (scannedDirs.length === 0) {
    violations.push(
      `no source file found under any of ${SCOPE_DIRS.join(', ')} in ${pkgRoot} - the guard would pass vacuously`,
    );
  }

  const packages = new Set();

  for (const file of files) {
    const content = await readFile(file, 'utf-8');
    const relPath = file.slice(pkgRoot.length + 1).replaceAll('\\', '/');

    for (const { specifier, line } of extractSpecifiers(content)) {
      const where = `${relPath}:${line}`;

      if (isPathSpecifier(specifier)) continue;
      // Builtins ship with Node; they are not npm packages. Covers both the
      // `node:` prefix and a legacy bare builtin name.
      if (isBuiltin(specifier)) continue;
      // Any other scheme (data:, http:, file:) is not a package specifier.
      if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(specifier)) continue;

      const name = packageNameOf(specifier);
      if (name === null) {
        violations.push(`${where}: "${specifier}" is not a resolvable package specifier`);
        continue;
      }

      packages.add(name);

      if (!declared.has(name)) {
        violations.push(
          `${where}: imports "${specifier}" but "${name}" is not declared in cloud-aws/package.json`,
        );
        continue;
      }

      const range = declared.get(name);
      if (LOCAL_LINK.test(range)) continue; // local link, no registry version to pin

      if (!EXACT_SEMVER.test(range)) {
        violations.push(
          `${where}: imports "${specifier}" but "${name}" is declared as "${range}", which is not an exact pin`,
        );
      }
    }
  }

  return {
    violations,
    filesScanned: files.length,
    packagesChecked: packages.size,
    scannedDirs,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const invokedDirectly =
  process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url;

if (invokedDirectly) {
  const rootFlag = process.argv.indexOf('--root');
  const root =
    rootFlag !== -1 && process.argv[rootFlag + 1]
      ? process.argv[rootFlag + 1]
      : resolve(import.meta.dirname, '..');

  const { violations, filesScanned, packagesChecked, scannedDirs } =
    await checkImportsDeclared(root);

  if (violations.length > 0) {
    console.error('Declared-import check FAILED:');
    for (const v of violations) {
      console.error(`  ${v}`);
    }
    process.exit(1);
  }

  console.log(
    `Declared-import check passed: ${packagesChecked} package specifiers across ${filesScanned} files in ${scannedDirs.join(', ')} are all declared at exact versions.`,
  );
}
