// Feature: aws-byo-deploy, Property 26: Layer boundaries hold across the file set
/**
 * Property 26: Layer boundaries hold across the file set.
 *
 * The subject is `scripts/check-adapter-real.mjs` itself. A guard is only worth
 * the confidence the estate places in it, so it is exercised two ways:
 *
 * 1. Against the REAL package tree, template half included, where it must report
 *    nothing. That is the assertion that catches an actual regression.
 * 2. Against generated fixture trees in `os.tmpdir()`, each seeded with an
 *    arbitrary subset of violation kinds. The guard must report EXACTLY the
 *    seeded violations: a guard that flags an unseeded file is as wrong as one
 *    that misses a seeded one, so the count is asserted as well as the content.
 *
 * Every fixture also carries the negative controls the guard is most likely to
 * regress on - a doc comment naming `@aws-sdk/*` and `node:http` under
 * `src/core/`, `bootstrapQualifier` in prose and in code under `bin/`, the
 * creation-only `from*Arn` imports, and `*.spec.ts` files that legitimately name
 * a fake and a fixture stack. The exact-count assertion is what proves they stay
 * unflagged.
 *
 * Fixtures are written outside the repository. Writing them under `cloud-aws/`
 * would put them inside the guard's own walk and beside `cdk.out`, which carries
 * whole-repo asset copies.
 *
 * Validates: Requirements 8.1, 8.10, 13.1, 13.2
 */

import fc from 'fast-check';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkAdapterReal } from './check-adapter-real.mjs';

/** The real `cloud-aws` package root - this file's parent directory. */
const PACKAGE_ROOT = fileURLToPath(new URL('../', import.meta.url));

// ---------------------------------------------------------------------------
// Violation kinds
// ---------------------------------------------------------------------------

/** The layer-boundary breaches a fixture can be seeded with. */
type ViolationKind =
  /** A non-spec file under `src/aws/` imports a specifier containing `/test/`. */
  | 'aws-imports-test-module'
  /** A non-spec file under `src/aws/` imports a fake module by basename. */
  | 'aws-imports-fake-module'
  /** A non-spec file under `src/aws/` names a `Fake[A-Z]` type. */
  | 'aws-names-fake-type'
  /** A capability owner exists but carries no `@aws-sdk/*` import. */
  | 'stub-capability-owner'
  /** A file under `src/core/` imports an AWS SDK client. */
  | 'core-imports-sdk'
  /** A file under `src/core/` imports an I/O builtin. */
  | 'core-imports-io-builtin'
  /** A second CDK stack class is declared in the package. */
  | 'second-cdk-stack'
  /** A file under `bin/` bootstraps an environment. */
  | 'bin-bootstraps-environment';

const VIOLATION_KINDS: readonly ViolationKind[] = [
  'aws-imports-test-module',
  'aws-imports-fake-module',
  'aws-names-fake-type',
  'stub-capability-owner',
  'core-imports-sdk',
  'core-imports-io-builtin',
  'second-cdk-stack',
  'bin-bootstraps-environment',
];

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/** The ten Runtime_Host_Contract capability names, as owner-file-safe slugs. */
const CAPABILITY_NAMES = [
  'spec',
  'journal',
  'runHistory',
  'runEvents',
  'usageLedger',
  'workflowState',
  'connections',
  'schedules',
  'monitor',
  'lease',
] as const;

/** A short lowercase file-name fragment, kept legible for shrunk counterexamples. */
const slug = fc
  .array(fc.constantFrom('a', 'b', 'c', 'd', 'e', 'r', 's', 't', 'u', 'x'), {
    minLength: 3,
    maxLength: 8,
  })
  .map((chars) => chars.join(''));

/** A module specifier that reaches into the test layer. */
const testSpecifier = fc.constantFrom(
  '../test/fake-run-table.js',
  '../test/generators.js',
  './test/helpers.js',
  '../../src/test/fake-monitor.js',
);

/** A fake module referenced by basename, without a `/test/` segment. */
const fakeModuleSpecifier = fc.constantFrom(
  './fake-run-table.js',
  '../fake-monitor.js',
  './doubles/fake-secrets-manager.js',
  '../doubles/fake-scheduler.js',
);

/** A `Fake[A-Z]` type name. */
const fakeTypeName = fc
  .constantFrom('RunTable', 'Monitor', 'Scheduler', 'SecretsManager', 'DocumentTableClient')
  .map((suffix) => `Fake${suffix}`);

/** An AWS SDK package the pure layer must never import. */
const sdkPackage = fc.constantFrom(
  '@aws-sdk/client-dynamodb',
  '@aws-sdk/lib-dynamodb',
  '@aws-sdk/client-scheduler',
  '@aws-sdk/credential-providers',
);

/** An I/O builtin the pure layer must never import. */
const ioBuiltin = fc.constantFrom('node:fs', 'node:http', 'node:net', 'node:child_process');

/** A second stack class name, and the `extends` form it is declared with. */
const extraStackName = fc.constantFrom('EstateStack', 'SecondStack', 'PortalStack', 'DataStack');
const extraStackBase = fc.constantFrom('cdk.Stack', 'Stack', 'cdk.NestedStack');

/** One line under `bin/` whose effect is to bootstrap an environment. */
const bootstrapLine = fc.constantFrom(
  "const command = 'cdk bootstrap aws://123456789012/us-east-1';",
  "execFileSync('cdk', ['bootstrap', '--qualifier', qualifier]);",
  'await bootstrapEnvironment(environment, sdkProvider);',
  'const bootstrapStack = CDKToolkit;',
);

/** Everything a fixture tree is derived from. */
interface Seed {
  readonly kinds: readonly ViolationKind[];
  readonly capabilities: readonly (typeof CAPABILITY_NAMES)[number][];
  readonly brokenCapabilityIndex: number;
  readonly slug: string;
  readonly testSpecifier: string;
  readonly fakeModuleSpecifier: string;
  readonly fakeTypeName: string;
  readonly sdkPackage: string;
  readonly ioBuiltin: string;
  readonly extraStackName: string;
  readonly extraStackBase: string;
  readonly bootstrapLine: string;
}

const seedArbitrary: fc.Arbitrary<Seed> = fc.record({
  kinds: fc.uniqueArray(fc.constantFrom(...VIOLATION_KINDS), {
    minLength: 0,
    maxLength: VIOLATION_KINDS.length,
  }),
  capabilities: fc.uniqueArray(fc.constantFrom(...CAPABILITY_NAMES), {
    minLength: 1,
    maxLength: CAPABILITY_NAMES.length,
  }),
  brokenCapabilityIndex: fc.nat({ max: CAPABILITY_NAMES.length - 1 }),
  slug,
  testSpecifier,
  fakeModuleSpecifier,
  fakeTypeName,
  sdkPackage,
  ioBuiltin,
  extraStackName,
  extraStackBase,
  bootstrapLine,
});

// ---------------------------------------------------------------------------
// Fixture tree
// ---------------------------------------------------------------------------

/** The owner module path for a capability, relative to the fixture root. */
function ownerPath(capability: string): string {
  return `src/aws/owner-${capability.toLowerCase()}.ts`;
}

/**
 * A complete fixture tree as a path-to-content map.
 *
 * With `kinds` empty the tree satisfies every check, so the guard must report
 * nothing. Each seeded kind adds or rewrites exactly one file and must produce
 * exactly one violation.
 */
function buildFixture(seed: Seed): Record<string, string> {
  const seeded = new Set(seed.kinds);
  const capabilities = seed.capabilities;
  const broken = capabilities[seed.brokenCapabilityIndex % capabilities.length];

  const files: Record<string, string> = {};

  // The image really builds, installs the health-check binary and starts the
  // bundle the build stage wrote.
  files['Dockerfile'] = [
    'FROM public.ecr.aws/docker/library/node:22-slim AS build',
    'WORKDIR /app',
    'RUN npx esbuild src/server/index.ts --bundle --platform=node --outfile=dist/server.mjs',
    '',
    'FROM public.ecr.aws/docker/library/node:22-slim',
    'RUN apt-get update && apt-get install -y curl && rm -rf /var/lib/apt/lists/*',
    'COPY --from=build /app/dist/server.mjs ./server.mjs',
    'CMD ["node", "server.mjs"]',
    '',
  ].join('\n');

  // The Runtime_Host_Contract the guard reads its capability list out of.
  files['src/core/host-contract.ts'] = [
    '/** The capabilities a Host_Adapter must own. */',
    'export const RUNTIME_HOST_CAPABILITIES = Object.freeze([',
    ...capabilities.map((capability) => `  '${capability}',`),
    '] as const);',
    '',
  ].join('\n');

  // NEGATIVE CONTROL: a pure module whose doc comment spells out the very
  // imports it refuses to make. Comment-only lines carry no dependency.
  files['src/core/keys.ts'] = [
    '/**',
    ' * Pure key helpers. No I/O, no SDK.',
    ' *',
    " * Never: import { DynamoDBClient } from '@aws-sdk/client-dynamodb';",
    " * Never: import { createServer } from 'node:http';",
    ' */',
    'export function runKey(runId: string): string {',
    "  return 'run#' + runId;",
    '}',
    '',
  ].join('\n');

  // The Server_Entry really listens.
  files['src/server/index.ts'] = [
    "import { createServer } from 'node:http';",
    '',
    'const server = createServer((_req, res) => {',
    '  res.writeHead(200);',
    '  res.end();',
    '});',
    '',
    'server.listen(8080);',
    '',
  ].join('\n');

  // NEGATIVE CONTROL: the only permitted stack, referencing every
  // Platform_Prerequisite by identifier. Reading one is how this package works;
  // only creating one is a violation.
  files['src/infra/stack.ts'] = [
    "import * as cdk from 'aws-cdk-lib';",
    "import * as ec2 from 'aws-cdk-lib/aws-ec2';",
    "import * as iam from 'aws-cdk-lib/aws-iam';",
    "import * as kms from 'aws-cdk-lib/aws-kms';",
    '',
    'export class PhormaAwsHostStack extends cdk.Stack {',
    '  constructor(scope: cdk.App, id: string, props: cdk.StackProps) {',
    '    super(scope, id, props);',
    "    const boundary = iam.ManagedPolicy.fromManagedPolicyArn(this, 'Boundary', boundaryArn);",
    "    const vpc = ec2.Vpc.fromVpcAttributes(this, 'Vpc', vpcAttributes);",
    "    const key = kms.Key.fromKeyArn(this, 'AppCmk', appCmkArn);",
    '    void boundary;',
    '    void vpc;',
    '    void key;',
    '  }',
    '}',
    '',
  ].join('\n');

  // NEGATIVE CONTROL: `bootstrapQualifier` in prose AND in code, plus a comment
  // naming the operator's own bootstrap step.
  files['bin/phorma-aws.mjs'] = [
    '#!/usr/bin/env node',
    '// The operator runs cdk bootstrap themselves - the platform team owns that',
    '// step. This CLI only reads the qualifier the estate was bootstrapped with.',
    "export const bootstrapQualifier = 'guardqr';",
    'export const qualifier = bootstrapQualifier;',
    '',
  ].join('\n');

  // NEGATIVE CONTROL: a spec file under `bin/` naming the forbidden invocation.
  // Test code never deploys, so it is exempt - which is what lets this very
  // file carry violating fixture source.
  files['bin/phorma-aws.spec.ts'] = [
    "import { describe, it } from 'vitest';",
    '',
    "describe('cli', () => {",
    "  it('never bootstraps', () => {",
    "    const forbidden = 'cdk bootstrap';",
    '    void forbidden;',
    '  });',
    '});',
    '',
  ].join('\n');

  // NEGATIVE CONTROL: a spec file under `src/aws/` that legitimately imports a
  // fake and declares a fixture stack.
  files['src/aws/adapter.spec.ts'] = [
    "import * as cdk from 'aws-cdk-lib';",
    "import { FakeRunTable } from '../test/fake-run-table.js';",
    '',
    'export class FixtureStack extends cdk.Stack {}',
    'export const table = new FakeRunTable();',
    '',
  ].join('\n');

  // The fake the test layer really owns, so the seeded import is plausible.
  files['src/test/fake-run-table.ts'] = [
    '/** In-memory Run_Table stand-in used by the property tests. */',
    'export class FakeRunTable {',
    '  readonly items = new Map<string, unknown>();',
    '}',
    '',
  ].join('\n');

  // One real adapter per capability. Each carries an `@aws-sdk` import, and a doc
  // comment naming the fake module it refuses to import (comment, so unflagged).
  for (const capability of capabilities) {
    const isBroken = seeded.has('stub-capability-owner') && capability === broken;
    files[ownerPath(capability)] = [
      '/**',
      ` * The ${capability} capability owner.`,
      ' *',
      " * Never: import { table } from '../test/fake-run-table.js';",
      ' */',
      ...(isBroken ? [] : ["import { DynamoDBClient } from '@aws-sdk/client-dynamodb';"]),
      '',
      isBroken
        ? 'export function client(): unknown {'
        : 'export function client(): DynamoDBClient {',
      isBroken ? '  return {};' : '  return new DynamoDBClient({});',
      '}',
      '',
    ].join('\n');
  }

  // The capability map: exactly the contract capabilities, no more.
  files['src/aws/capability-map.json'] =
    JSON.stringify(
      Object.fromEntries(capabilities.map((capability) => [capability, ownerPath(capability)])),
      null,
      2,
    ) + '\n';

  // -- seeded violations ----------------------------------------------------

  if (seeded.has('aws-imports-test-module')) {
    files[`src/aws/seeded-${seed.slug}.ts`] = [
      `import { helper } from '${seed.testSpecifier}';`,
      '',
      'export const wired = helper;',
      '',
    ].join('\n');
  }

  if (seeded.has('aws-imports-fake-module')) {
    files[`src/aws/direct-${seed.slug}.ts`] = [
      `import { helper } from '${seed.fakeModuleSpecifier}';`,
      '',
      'export const wired = helper;',
      '',
    ].join('\n');
  }

  if (seeded.has('aws-names-fake-type')) {
    files[`src/aws/named-${seed.slug}.ts`] = [
      "import { DynamoDBClient } from '@aws-sdk/client-dynamodb';",
      '',
      `export type Backend = ${seed.fakeTypeName};`,
      '',
      'export const real: DynamoDBClient | undefined = undefined;',
      '',
    ].join('\n');
  }

  if (seeded.has('core-imports-sdk')) {
    files[`src/core/impure-${seed.slug}.ts`] = [
      `import * as sdk from '${seed.sdkPackage}';`,
      '',
      'export const wired = sdk;',
      '',
    ].join('\n');
  }

  if (seeded.has('core-imports-io-builtin')) {
    files[`src/core/io-${seed.slug}.ts`] = [
      `import * as io from '${seed.ioBuiltin}';`,
      '',
      'export const wired = io;',
      '',
    ].join('\n');
  }

  if (seeded.has('second-cdk-stack')) {
    files[`src/infra/extra-${seed.slug}.ts`] = [
      "import * as cdk from 'aws-cdk-lib';",
      '',
      `export class ${seed.extraStackName} extends ${seed.extraStackBase} {}`,
      '',
      'void cdk;',
      '',
    ].join('\n');
  }

  if (seeded.has('bin-bootstraps-environment')) {
    files[`bin/seeded-${seed.slug}.mjs`] = [
      '// A helper the operator must never need.',
      seed.bootstrapLine,
      '',
    ].join('\n');
  }

  return files;
}

/** Materialize a fixture tree in a fresh temp directory outside the repository. */
async function writeFixture(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'phorma-adapter-guard-'));
  for (const [relativePath, content] of Object.entries(files)) {
    const target = join(root, relativePath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, 'utf-8');
  }
  return root;
}

// ---------------------------------------------------------------------------
// Expected violations
// ---------------------------------------------------------------------------

/**
 * The predicate identifying the one violation each seeded kind must produce.
 *
 * The predicates are pairwise disjoint: each names the file it was seeded into
 * and the message fragment for its own rule, so a single violation can never be
 * counted twice and an unseeded file cannot satisfy any of them.
 */
function matcherFor(seed: Seed, kind: ViolationKind): (violation: string) => boolean {
  const broken = seed.capabilities[seed.brokenCapabilityIndex % seed.capabilities.length];
  switch (kind) {
    case 'aws-imports-test-module':
      return (v) =>
        v.includes(`src/aws/seeded-${seed.slug}.ts:`) &&
        v.includes(`imports test-only module "${seed.testSpecifier}"`);
    case 'aws-imports-fake-module':
      return (v) =>
        v.includes(`src/aws/direct-${seed.slug}.ts:`) &&
        v.includes(`imports the fake "${seed.fakeModuleSpecifier}"`);
    case 'aws-names-fake-type':
      return (v) =>
        v.includes(`src/aws/named-${seed.slug}.ts:`) &&
        v.includes(`names the fake type "${seed.fakeTypeName}"`);
    case 'stub-capability-owner':
      return (v) =>
        v.includes(`capability "${broken}" owner "${ownerPath(broken)}"`) &&
        v.includes('carries no @aws-sdk/* import');
    case 'core-imports-sdk':
      return (v) =>
        v.includes(`src/core/impure-${seed.slug}.ts:`) &&
        v.includes(`src/core/ imports "${seed.sdkPackage}"`);
    case 'core-imports-io-builtin':
      return (v) =>
        v.includes(`src/core/io-${seed.slug}.ts:`) &&
        v.includes(`imports the I/O builtin "${seed.ioBuiltin}"`);
    case 'second-cdk-stack':
      return (v) =>
        v.includes(`src/infra/extra-${seed.slug}.ts:`) &&
        v.includes(`declares CDK stack "${seed.extraStackName}"`);
    case 'bin-bootstraps-environment':
      return (v) =>
        v.includes(`bin/seeded-${seed.slug}.mjs:`) && v.includes('creates no Platform_Prerequisite');
  }
}

// ---------------------------------------------------------------------------
// Property 26
// ---------------------------------------------------------------------------

describe('Property 26: Layer boundaries hold across the file set', () => {
  it(
    'reports nothing against the real package tree',
    async () => {
      const violations = await checkAdapterReal({ root: PACKAGE_ROOT });
      expect(violations, `adapter-real guard reported:\n  ${violations.join('\n  ')}`).toEqual([]);
    },
    180_000,
  );

  it('reports nothing against a fixture tree that satisfies every check', async () => {
    const seed: Seed = {
      kinds: [],
      capabilities: CAPABILITY_NAMES,
      brokenCapabilityIndex: 0,
      slug: 'clean',
      testSpecifier: '../test/fake-run-table.js',
      fakeModuleSpecifier: './fake-run-table.js',
      fakeTypeName: 'FakeRunTable',
      sdkPackage: '@aws-sdk/client-dynamodb',
      ioBuiltin: 'node:fs',
      extraStackName: 'EstateStack',
      extraStackBase: 'cdk.Stack',
      bootstrapLine: "const command = 'cdk bootstrap';",
    };
    const root = await writeFixture(buildFixture(seed));
    try {
      const violations = await checkAdapterReal({ root, synth: false });
      expect(violations, `clean fixture reported:\n  ${violations.join('\n  ')}`).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reports exactly the seeded violations for any subset of violation kinds', async () => {
    await fc.assert(
      fc.asyncProperty(seedArbitrary, async (seed) => {
        const root = await writeFixture(buildFixture(seed));
        try {
          const violations = await checkAdapterReal({ root, synth: false });
          const report = violations.length === 0 ? '(none)' : violations.join('\n  ');

          // Every seeded violation is reported, exactly once.
          for (const kind of seed.kinds) {
            const hits = violations.filter(matcherFor(seed, kind));
            expect(hits, `seeded ${kind} reported ${hits.length} times in:\n  ${report}`).toHaveLength(
              1,
            );
          }

          // And nothing else is: an unseeded file flagged is as wrong as a
          // seeded one missed. This is what holds the negative controls.
          expect(
            violations,
            `expected ${seed.kinds.length} violation(s) for [${seed.kinds.join(', ')}], got:\n  ${report}`,
          ).toHaveLength(seed.kinds.length);
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      }),
      { numRuns: 100 },
    );
  }, 180_000);
});
