/**
 * Property tests for the declared-import guard (`check-imports-declared.mjs`).
 *
 * The guard is only worth having if it is BOTH complete and quiet: it must flag
 * every bare specifier under `bin/`, `src/aws/` and `src/cli/` whose owning
 * package is missing from the manifest or declared at anything other than an
 * exact pin, and it must stay silent on everything else. A guard that flags an
 * unseeded import is as wrong as one that misses a seeded one, so every case
 * asserts the violation list EXACTLY rather than merely non-empty.
 *
 * Each run seeds a throwaway package root in the OS temp directory carrying a
 * fixed set of negative controls (relative import, `node:` and legacy bare
 * builtins, the `@phorma/engine` local link, a subpath of a declared exact
 * package, a package named only inside a doc comment, and an undeclared package
 * imported from OUTSIDE the three scope directories) plus exactly one seeded
 * violation whose directory, extension, import form, package name and
 * declaration state are all generated.
 *
 * The four fixtures the task names - an undeclared specifier, a declared
 * specifier at a caret range, a dynamic import and a type-only import - are
 * points inside that generated space, and are also pinned as an explicit
 * table-driven case for traceability.
 *
 * Validates: Requirements 6.1, 6.3, 8.8
 */

// Feature: aws-byo-deploy, Property 25: Every import specifier is declared at an exact version

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fc from 'fast-check';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkImportsDeclared } from './check-imports-declared.mjs';

interface CheckResult {
  violations: string[];
  filesScanned: number;
  packagesChecked: number;
  scannedDirs: string[];
}

/** The guard is untyped JS by design (it also runs standalone under node). */
const runGuard = checkImportsDeclared as (root: string) => Promise<CheckResult>;

/** `cloud-aws/` itself - the real tree the guard protects. */
const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));

// ---------------------------------------------------------------------------
// Fixture shape
// ---------------------------------------------------------------------------

type ScopeDir = 'bin' | 'src/aws' | 'src/cli';

type ImportForm =
  | 'static-value'
  | 'type-only'
  | 'reexport'
  | 'reexport-type'
  | 'dynamic'
  | 'side-effect'
  | 'require';

type Declaration = 'undeclared' | { range: string; section: 'dependencies' | 'devDependencies' };

interface SeedCase {
  dir: ScopeDir;
  extension: string;
  form: ImportForm;
  packageName: string;
  withSubpath: boolean;
  declaration: Declaration;
}

const IMPORT_FORMS: ImportForm[] = [
  'static-value',
  'type-only',
  'reexport',
  'reexport-type',
  'dynamic',
  'side-effect',
  'require',
];

/** Ranges that are declarations but not exact pins. A caret is the named case. */
const NON_EXACT_RANGES = ['^1.2.3', '~1.2.3', '>=1.0.0 <2.0.0', '1.x', 'latest', '*', '^0.0.1-beta.1'];

/** Extensions where a given form is at least plausible source. */
function extensionsFor(form: ImportForm): string[] {
  switch (form) {
    case 'type-only':
    case 'reexport-type':
      return ['.ts', '.mts', '.cts', '.d.ts'];
    case 'require':
      return ['.cjs', '.cts', '.js'];
    default:
      return ['.mjs', '.cjs', '.js', '.mts', '.cts', '.ts'];
  }
}

/** One line carrying one bare specifier, in each form the guard claims to catch. */
function importLineFor(form: ImportForm, specifier: string): string {
  switch (form) {
    case 'static-value':
      return `import seeded from '${specifier}';`;
    case 'type-only':
      return `import type { Seeded } from '${specifier}';`;
    case 'reexport':
      return `export { seeded } from '${specifier}';`;
    case 'reexport-type':
      return `export type { Seeded } from '${specifier}';`;
    case 'dynamic':
      return `const seeded = import('${specifier}');`;
    case 'side-effect':
      return `import '${specifier}';`;
    case 'require':
      return `const seeded = require('${specifier}');`;
  }
}

// ---------------------------------------------------------------------------
// Negative controls - the guard must stay silent on every line below
// ---------------------------------------------------------------------------

const CONTROLS_TS = `/**
 * Negative controls. Every specifier here is either exempt or declared exact.
 *
 * A package named only in prose: fx-doc-only-pkg
 * A commented-out import, which the guard must not see:
 * import { thing } from 'fx-doc-comment-pkg';
 */
import { readFile } from 'node:fs/promises';
import { join } from 'path';
import { runWorkflow } from '@phorma/engine';
import { tsImport } from 'tsx/esm/api';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { helper } from './helper.js';

export const controls = [readFile, join, runWorkflow, tsImport, DynamoDBClient, helper];
`;

const HELPER_TS = `export const helper = 'helper';\n`;

const OUT_OF_SCOPE_TS = `// Outside bin/, src/aws/ and src/cli/, so the guard deliberately ignores it.
import { thing } from 'fx-never-declared-out-of-scope';

export const reexported = thing;
`;

function fixtureManifest(
  deps: Record<string, string>,
  devDeps: Record<string, string>,
): string {
  return JSON.stringify(
    {
      name: 'fixture-cloud-aws',
      private: true,
      type: 'module',
      dependencies: {
        '@phorma/engine': 'file:../engine',
        '@aws-sdk/client-dynamodb': '3.1110.0',
        tsx: '4.23.12',
        ...deps,
      },
      devDependencies: {
        vitest: '4.1.10',
        ...devDeps,
      },
    },
    null,
    2,
  );
}

/**
 * Write a fixture package root: manifest, negative controls, and optionally one
 * seeded violation. Returns the exact violation string the guard must report,
 * or null when nothing was seeded.
 */
async function writeFixture(root: string, seed: SeedCase | null): Promise<string | null> {
  const deps: Record<string, string> = {};
  const devDeps: Record<string, string> = {};
  if (seed && seed.declaration !== 'undeclared') {
    const target = seed.declaration.section === 'dependencies' ? deps : devDeps;
    target[seed.packageName] = seed.declaration.range;
  }

  await mkdir(join(root, 'src', 'aws'), { recursive: true });
  await mkdir(join(root, 'src', 'core'), { recursive: true });
  await writeFile(join(root, 'package.json'), fixtureManifest(deps, devDeps), 'utf-8');
  await writeFile(join(root, 'src', 'aws', 'controls.ts'), CONTROLS_TS, 'utf-8');
  await writeFile(join(root, 'src', 'aws', 'helper.ts'), HELPER_TS, 'utf-8');
  await writeFile(join(root, 'src', 'core', 'out-of-scope.ts'), OUT_OF_SCOPE_TS, 'utf-8');

  if (!seed) return null;

  const specifier = seed.withSubpath ? `${seed.packageName}/sub/entry` : seed.packageName;
  const fileName = `seeded${seed.extension}`;
  const content = [
    '// Seeded fixture: exactly one violating specifier, on line 2.',
    importLineFor(seed.form, specifier),
    '',
  ].join('\n');

  const dirAbs = join(root, ...seed.dir.split('/'));
  await mkdir(dirAbs, { recursive: true });
  await writeFile(join(dirAbs, fileName), content, 'utf-8');

  const where = `${seed.dir}/${fileName}:2`;
  return seed.declaration === 'undeclared'
    ? `${where}: imports "${specifier}" but "${seed.packageName}" is not declared in cloud-aws/package.json`
    : `${where}: imports "${specifier}" but "${seed.packageName}" is declared as "${seed.declaration.range}", which is not an exact pin`;
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

const NAME_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789-'.split('');

const segmentArb = fc
  .array(fc.constantFrom(...NAME_CHARS), { minLength: 1, maxLength: 10 })
  .map(chars => chars.join(''));

/**
 * Fixture package names. The `fx-` prefix keeps every generated name clear of
 * Node builtins and of the packages the controls declare, so a generated name
 * can never accidentally become exempt or already-declared.
 */
const packageNameArb = fc.oneof(
  segmentArb.map(s => `fx-${s}`),
  fc.tuple(segmentArb, segmentArb).map(([scope, name]) => `@fx-${scope}/pkg-${name}`),
);

const seedCaseArb: fc.Arbitrary<SeedCase> = fc
  .record({
    dir: fc.constantFrom<ScopeDir>('bin', 'src/aws', 'src/cli'),
    form: fc.constantFrom(...IMPORT_FORMS),
    packageName: packageNameArb,
    withSubpath: fc.boolean(),
    declaration: fc.oneof(
      fc.constant<Declaration>('undeclared'),
      fc.record({
        range: fc.constantFrom(...NON_EXACT_RANGES),
        section: fc.constantFrom<'dependencies' | 'devDependencies'>(
          'dependencies',
          'devDependencies',
        ),
      }),
    ),
  })
  .chain(base =>
    fc.constantFrom(...extensionsFor(base.form)).map(extension => ({ ...base, extension })),
  );

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('check-imports-declared - Property 25: every import specifier is declared at an exact version', () => {
  let baseDir: string;
  let counter = 0;

  beforeAll(async () => {
    baseDir = await mkdtemp(join(tmpdir(), 'phorma-imports-declared-'));
  });

  afterAll(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  async function freshRoot(): Promise<string> {
    const root = join(baseDir, `root-${counter++}`);
    await mkdir(root, { recursive: true });
    return root;
  }

  /**
   * **Validates: Requirements 6.1, 6.3, 8.8**
   *
   * The real tree is the assertion that catches an actual regression: no
   * specifier under `bin/`, `src/aws/` or `src/cli/` may reach an undeclared or
   * loosely pinned package.
   */
  it('reports no violation against the real cloud-aws tree', async () => {
    const result = await runGuard(PACKAGE_ROOT);

    expect(result.violations).toEqual([]);
    expect(result.scannedDirs).toContain('bin');
    expect(result.scannedDirs).toContain('src/aws');
    expect(result.filesScanned).toBeGreaterThan(0);
    expect(result.packagesChecked).toBeGreaterThan(0);
  });

  /**
   * **Validates: Requirements 6.1, 6.3, 8.8**
   *
   * The negative controls on their own must be silent. Without this, a noisy
   * baseline would be indistinguishable from a correctly detected seed.
   */
  it('reports no violation for a fixture of negative controls only', async () => {
    const root = await freshRoot();
    await writeFixture(root, null);

    const result = await runGuard(root);

    expect(result.violations).toEqual([]);
    expect(result.scannedDirs).toEqual(['src/aws']);
  });

  /**
   * **Validates: Requirements 6.1, 6.3, 8.8**
   *
   * The property: for any scope directory, extension, import form, package name
   * and non-exact-or-absent declaration, the guard reports EXACTLY the seeded
   * violation - nothing missed, nothing invented.
   */
  it('reports exactly the seeded violation for any generated directory, extension, import form and declaration state', async () => {
    await fc.assert(
      fc.asyncProperty(seedCaseArb, async seed => {
        const root = await freshRoot();
        try {
          const expected = await writeFixture(root, seed);
          const result = await runGuard(root);

          expect(result.violations).toEqual([expected]);
          expect(result.scannedDirs).toContain(seed.dir);
          expect(result.scannedDirs).toContain('src/aws');
          expect(result.filesScanned).toBeGreaterThanOrEqual(3);
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      }),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 6.1, 6.3, 8.8**
   *
   * The four fixtures the task names, pinned explicitly so a regression in any
   * one of them fails with an obvious label rather than a shrunk counterexample.
   */
  it('flags the four named fixture shapes', async () => {
    const namedCases: Array<{ label: string; seed: SeedCase }> = [
      {
        label: 'an undeclared specifier',
        seed: {
          dir: 'src/aws',
          extension: '.ts',
          form: 'static-value',
          packageName: 'fx-undeclared',
          withSubpath: false,
          declaration: 'undeclared',
        },
      },
      {
        label: 'a declared specifier at a caret range',
        seed: {
          dir: 'src/aws',
          extension: '.ts',
          form: 'static-value',
          packageName: 'fx-caret',
          withSubpath: false,
          declaration: { range: '^1.2.3', section: 'dependencies' },
        },
      },
      {
        label: 'a dynamic import of an undeclared package',
        seed: {
          dir: 'bin',
          extension: '.mjs',
          form: 'dynamic',
          packageName: '@fx-dynamic/pkg-client',
          withSubpath: false,
          declaration: 'undeclared',
        },
      },
      {
        label: 'a type-only import at a caret range',
        seed: {
          dir: 'src/cli',
          extension: '.ts',
          form: 'type-only',
          packageName: 'fx-type-only',
          withSubpath: false,
          declaration: { range: '^1.2.3', section: 'devDependencies' },
        },
      },
    ];

    for (const { label, seed } of namedCases) {
      const root = await freshRoot();
      const expected = await writeFixture(root, seed);
      const result = await runGuard(root);

      expect(result.violations, `fixture: ${label}`).toEqual([expected]);
    }
  });

  /**
   * **Validates: Requirements 6.1, 6.3, 8.8**
   *
   * Anti-vacuity. A tree with no source file in any scope directory proves
   * nothing, so it must report a violation rather than a clean pass - otherwise
   * a renamed or relocated source directory would silently disable the guard.
   */
  it('reports a violation for a root with no source file in any scope directory', async () => {
    const root = await freshRoot();
    await mkdir(join(root, 'src', 'core'), { recursive: true });
    await writeFile(join(root, 'package.json'), fixtureManifest({}, {}), 'utf-8');
    await writeFile(join(root, 'src', 'core', 'out-of-scope.ts'), OUT_OF_SCOPE_TS, 'utf-8');

    const result = await runGuard(root);

    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toContain('vacuously');
    expect(result.scannedDirs).toEqual([]);
    expect(result.filesScanned).toBe(0);
  });
});
