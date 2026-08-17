#!/usr/bin/env node
/**
 * check-adapter-real.mjs
 *
 * Two guards over one file set.
 *
 * A. The Host_Adapter is real. Production code under `src/aws/` must not reach
 *    for a test fake, every capability the Runtime_Host_Contract names must have
 *    an owning adapter that actually talks to an AWS service, the Server_Entry
 *    must really listen, the image must really be built, and `src/core/` must
 *    stay pure (Req 13.1, 13.2, 13.3, 13.4).
 *
 * B. The package creates no Platform_Prerequisite (Req 5.9). A
 *    Platform_Prerequisite is an AWS resource the operator's platform team owns
 *    and whose identifier the operator supplies: the Deployment_Identity trust,
 *    the Permissions_Boundary, the VPC, the subnets, the App_CMK, the
 *    notification topic and the CDK bootstrap stack.
 *
 *    The rule is CREATION-only. Reading or referencing a Platform_Prerequisite
 *    identifier is exactly how this package is meant to work, so
 *    `bootstrapQualifier`, the bootstrap image repository ARN derived from it,
 *    the `imageUri` repository ARN parse, `ManagedPolicy.fromManagedPolicyArn`,
 *    `Vpc.fromVpcAttributes`, `Key.fromKeyArn` and the Preflight bootstrap stack
 *    lookup all pass unflagged. So do the task, execution, deployment,
 *    scheduler-invoke and integration roles the host stack creates under the
 *    configured boundary: those are the estate's own identities, not stand-ins
 *    for a prerequisite.
 *
 *    Asserted two ways: in source, that `PhormaAwsHostStack` is the only CDK
 *    stack declared in the package and that nothing under `bin/` or `scripts/`
 *    invokes `cdk bootstrap` or declares a bootstrap stack; and against the
 *    template synthesized from a fully populated Deploy_Config_File, that it
 *    declares no VPC, no subnet, no KMS key, and no IAM role or managed policy
 *    named by a Platform_Prerequisite the configuration already supplies.
 *
 * Standalone: `node scripts/check-adapter-real.mjs [--root <dir>] [--no-synth]`
 * Programmatic: `import { checkAdapterReal } from './check-adapter-real.mjs'`
 * and call it with any root directory, which is how the property test drives it
 * against seeded violating fixtures.
 *
 * Feature: aws-byo-deploy
 * Validates: Requirements 5.9, 13.1, 13.2, 13.3, 13.4
 */
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Module specifiers production code under `src/aws/` may never import. */
const FAKE_MODULE_BASENAMES = [
  'fake-run-table.js',
  'fake-monitor.js',
  'fake-secrets-manager.js',
  'fake-scheduler.js',
];

/** Node builtins `src/core/` may never import - `core/` is pure and does no I/O. */
const FORBIDDEN_CORE_BUILTINS = ['node:fs', 'node:http', 'node:net', 'node:child_process'];

/** Directories never walked: build output, dependencies and VCS metadata. */
const SKIP_DIRS = new Set(['node_modules', 'cdk.out', 'dist', '.git', 'coverage']);

/**
 * This file's own path, relative to the package root.
 *
 * The bootstrap scan covers `bin/` and `scripts/`, and this guard necessarily
 * spells out the very tokens it forbids. Skipping itself keeps the patterns
 * readable instead of assembled from fragments.
 */
const SELF_RELATIVE_PATH = 'scripts/check-adapter-real.mjs';

/** The only CDK stack the package may declare. */
const ALLOWED_STACK_CLASS = 'PhormaAwsHostStack';

// ---------------------------------------------------------------------------
// File-system helpers
// ---------------------------------------------------------------------------

/**
 * Recursively collect files under `dir` whose name ends with one of `exts`.
 * Returns absolute paths. A missing directory yields an empty list so the guard
 * can report "expected file absent" itself rather than crashing.
 */
async function collectFiles(dir, exts) {
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
      if (SKIP_DIRS.has(entry.name)) continue;
      files.push(...(await collectFiles(full, exts)));
    } else if (exts.some((ext) => entry.name.endsWith(ext))) {
      files.push(full);
    }
  }
  return files;
}

/** Read a file, or `undefined` when it does not exist. */
async function readIfPresent(path) {
  try {
    return await readFile(path, 'utf-8');
  } catch {
    return undefined;
  }
}

/** POSIX-style path relative to the root, for stable violation messages. */
function rel(root, path) {
  return relative(root, path).replaceAll('\\', '/');
}

// ---------------------------------------------------------------------------
// Source scanning helpers
// ---------------------------------------------------------------------------

/** A line that is only a comment declares nothing and imports nothing. */
function isCommentLine(line) {
  return /^\s*(?:\/\/|\/\*|\*)/.test(line);
}

const SPECIFIER_PATTERNS = [
  // static `import ... from 'x'` / `export ... from 'x'`, including the
  // `} from 'x'` tail of a multi-line import
  /\bfrom\s*['"]([^'"]+)['"]/g,
  // dynamic `import('x')`
  /\bimport\s*\(\s*['"]([^'"]+)['"]/g,
  // `require('x')`
  /\brequire\s*\(\s*['"]([^'"]+)['"]/g,
  // side-effect `import 'x'`
  /^\s*import\s*['"]([^'"]+)['"]/g,
];

/**
 * Every module specifier the source imports, with its line number. Comment-only
 * lines are skipped: a specifier named in prose is documentation, not a
 * dependency, and several adapters legitimately name `@aws-sdk/*` or `node:http`
 * in a doc comment to explain what they do NOT import.
 */
function importSpecifiers(content) {
  const found = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isCommentLine(line)) continue;
    for (const pattern of SPECIFIER_PATTERNS) {
      for (const match of line.matchAll(pattern)) {
        found.push({ specifier: match[1], line: i + 1 });
      }
    }
  }
  return found;
}

/** True for `*.spec.ts` - test code, exempt from the production-code rules. */
function isSpecFile(path) {
  return /\.spec\.[cm]?tsx?$/.test(path);
}

// ---------------------------------------------------------------------------
// A. The Host_Adapter is real
// ---------------------------------------------------------------------------

/**
 * No production module under `src/aws/` imports a test fake (Req 13.1, 13.2).
 * The adapter layer is what talks to AWS; a fake reaching production means the
 * check pipeline would be proving the fake, not the deployment.
 */
async function checkNoFakeImports(root, violations) {
  const files = await collectFiles(join(root, 'src', 'aws'), ['.ts']);
  for (const file of files) {
    if (isSpecFile(file)) continue;
    const content = await readIfPresent(file);
    if (content === undefined) continue;
    for (const { specifier, line } of importSpecifiers(content)) {
      if (specifier.includes('/test/')) {
        violations.push(
          `${rel(root, file)}:${line}: production code imports test-only module "${specifier}".`,
        );
        continue;
      }
      if (FAKE_MODULE_BASENAMES.some((name) => specifier.endsWith(name))) {
        violations.push(
          `${rel(root, file)}:${line}: production code imports the fake "${specifier}".`,
        );
      }
    }
  }
}

/**
 * No production module under `src/aws/` names a `Fake*` type (Req 13.1, 13.2).
 *
 * Scanned naively over every line, comments included: production code should not
 * name a fake type at all, not even in prose, because a named fake is the thing
 * that makes a reviewer believe the adapter is wired to one.
 */
async function checkNoFakeIdentifiers(root, violations) {
  const files = await collectFiles(join(root, 'src', 'aws'), ['.ts']);
  for (const file of files) {
    if (isSpecFile(file)) continue;
    const content = await readIfPresent(file);
    if (content === undefined) continue;
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const match = /\bFake[A-Z]\w*/.exec(lines[i]);
      if (match) {
        violations.push(
          `${rel(root, file)}:${i + 1}: production code names the fake type "${match[0]}".`,
        );
      }
    }
  }
}

/**
 * The ten capability names the Runtime_Host_Contract declares, read out of
 * `src/core/host-contract.ts` so the guard cannot drift from the contract.
 */
async function readCapabilityNames(root, violations) {
  const path = join(root, 'src', 'core', 'host-contract.ts');
  const content = await readIfPresent(path);
  if (content === undefined) {
    violations.push('src/core/host-contract.ts is absent - the Runtime_Host_Contract is missing.');
    return [];
  }
  const block = /RUNTIME_HOST_CAPABILITIES\s*=\s*Object\.freeze\(\s*\[([^\]]*)\]/.exec(content);
  if (!block) {
    violations.push(
      'src/core/host-contract.ts declares no RUNTIME_HOST_CAPABILITIES array literal.',
    );
    return [];
  }
  return [...block[1].matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]);
}

/**
 * Every capability has an owning adapter that exists and really calls AWS
 * (Req 13.1, 13.3). An owner with no `@aws-sdk/*` import is a stub.
 */
async function checkCapabilityOwners(root, violations) {
  const capabilities = await readCapabilityNames(root, violations);
  const mapPath = join(root, 'src', 'aws', 'capability-map.json');
  const raw = await readIfPresent(mapPath);
  if (raw === undefined) {
    violations.push('src/aws/capability-map.json is absent - no capability has a declared owner.');
    return;
  }
  let map;
  try {
    map = JSON.parse(raw);
  } catch (err) {
    violations.push(`src/aws/capability-map.json is not valid JSON: ${err.message}`);
    return;
  }

  for (const capability of capabilities) {
    const owner = map[capability];
    if (typeof owner !== 'string' || owner.length === 0) {
      violations.push(`capability "${capability}" has no owner in src/aws/capability-map.json.`);
      continue;
    }
    const ownerPath = join(root, owner);
    const content = await readIfPresent(ownerPath);
    if (content === undefined) {
      violations.push(
        `capability "${capability}" names owner "${owner}", which does not exist.`,
      );
      continue;
    }
    const usesSdk = importSpecifiers(content).some((s) => s.specifier.startsWith('@aws-sdk/'));
    if (!usesSdk) {
      violations.push(
        `capability "${capability}" owner "${owner}" carries no @aws-sdk/* import - it cannot be a real adapter.`,
      );
    }
  }

  for (const key of Object.keys(map)) {
    if (!capabilities.includes(key)) {
      violations.push(
        `src/aws/capability-map.json declares "${key}", which is not a Runtime_Host_Contract capability.`,
      );
    }
  }
}

/** The Server_Entry really serves HTTP (Req 13.1, 13.3). */
async function checkServerEntry(root, violations) {
  const path = join(root, 'src', 'server', 'index.ts');
  const content = await readIfPresent(path);
  if (content === undefined) {
    violations.push('src/server/index.ts is absent - there is no Server_Entry.');
    return;
  }
  const importsCreateServer = importSpecifiers(content).some(
    (s) => s.specifier === 'node:http',
  ) && /\bcreateServer\b/.test(content);
  if (!importsCreateServer) {
    violations.push('src/server/index.ts does not take `createServer` from `node:http`.');
  }
  if (!/\.listen\s*\(/.test(content)) {
    violations.push('src/server/index.ts never calls `.listen(` - it serves nothing.');
  }
}

/**
 * The image is really built, carries the binary the container health check runs,
 * and starts the bundle the build stage produced (Req 13.4).
 */
async function checkDockerfile(root, violations) {
  const path = join(root, 'Dockerfile');
  const content = await readIfPresent(path);
  if (content === undefined) {
    violations.push('Dockerfile is absent - the Container_Image cannot be built.');
    return;
  }
  if (!/\bapt-get\s+install\b[^\n]*\bcurl\b/.test(content) && !/\binstall\b[^\n]*\bcurl\b/.test(content)) {
    violations.push(
      'Dockerfile does not install `curl`, which the Fargate container health check invokes.',
    );
  }

  // The bundled entry is whatever the build stage writes, so the CMD assertion is
  // derived from the Dockerfile rather than hardcoded.
  const outfile = /--outfile=(\S+)/.exec(content);
  const entry = outfile ? outfile[1].split('/').pop() : 'server.mjs';
  const cmd = /^\s*CMD\s+(.+)$/m.exec(content);
  if (!cmd) {
    violations.push('Dockerfile declares no CMD - the image would start nothing.');
  } else if (!cmd[1].includes(entry)) {
    violations.push(
      `Dockerfile CMD does not name the bundled entry "${entry}": ${cmd[1].trim()}`,
    );
  }
}

/**
 * `src/core/` stays pure: no AWS SDK, no I/O builtin (Req 13.1, 13.2).
 * Import specifiers only - a doc comment naming `node:http` to explain what the
 * module deliberately does not use is not a dependency.
 */
async function checkCorePurity(root, violations) {
  const files = await collectFiles(join(root, 'src', 'core'), ['.ts']);
  for (const file of files) {
    const content = await readIfPresent(file);
    if (content === undefined) continue;
    for (const { specifier, line } of importSpecifiers(content)) {
      if (specifier.startsWith('@aws-sdk/')) {
        violations.push(`${rel(root, file)}:${line}: src/core/ imports "${specifier}".`);
      }
      if (FORBIDDEN_CORE_BUILTINS.includes(specifier)) {
        violations.push(
          `${rel(root, file)}:${line}: src/core/ imports the I/O builtin "${specifier}".`,
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// B. No Platform_Prerequisite is created - source half
// ---------------------------------------------------------------------------

/** `PhormaAwsHostStack` is the only CDK stack the package declares (Req 5.9). */
async function checkSingleStackDeclaration(root, violations) {
  const files = await collectFiles(root, ['.ts', '.mts', '.mjs', '.js']);
  const declared = [];
  for (const file of files) {
    // A spec file is test code: it never deploys, and the guard's own property
    // test necessarily carries violating fixture source as string literals.
    if (isSpecFile(file)) continue;
    const content = await readIfPresent(file);
    if (content === undefined) continue;
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (isCommentLine(lines[i])) continue;
      const match = /\bclass\s+([A-Za-z_$][\w$]*)\s+extends\s+(?:[\w$]+\.)?(?:Nested)?Stack\b/.exec(
        lines[i],
      );
      if (!match) continue;
      declared.push({ name: match[1], where: `${rel(root, file)}:${i + 1}` });
    }
  }

  for (const { name, where } of declared) {
    if (name !== ALLOWED_STACK_CLASS) {
      violations.push(
        `${where}: declares CDK stack "${name}". ${ALLOWED_STACK_CLASS} is the only stack this package may declare (Req 5.9).`,
      );
    }
  }
  if (!declared.some((d) => d.name === ALLOWED_STACK_CLASS)) {
    violations.push(`${ALLOWED_STACK_CLASS} is not declared anywhere in the package.`);
  }
}

/**
 * Nothing under `bin/` or `scripts/` bootstraps an environment (Req 5.9).
 *
 * Comment-only lines are skipped, and the co-occurrence forms require the `cdk`
 * token beside the verb, so `bootstrapQualifier` and prose about the operator's
 * own bootstrap step both pass. Only an invocation or a declaration fails.
 */
async function checkNoBootstrapScript(root, violations) {
  const dirs = [join(root, 'bin'), join(root, 'scripts')];
  const patterns = [
    { re: /\bcdk\s+bootstrap\b/i, what: 'invokes `cdk bootstrap`' },
    { re: /['"]cdk['"][^\n]*['"]bootstrap['"]/, what: 'passes `bootstrap` to the cdk CLI' },
    { re: /\bbootstrapEnvironment\b/, what: 'calls the CDK bootstrap API' },
    { re: /\bCDKToolkit\b/, what: 'names the CDK bootstrap stack' },
    { re: /\bclass\s+[\w$]*Bootstrap[\w$]*\s+extends\b/, what: 'declares a bootstrap stack' },
    { re: /\bnew\s+[\w$]*Bootstrap[\w$]*Stack\b/, what: 'instantiates a bootstrap stack' },
  ];

  for (const dir of dirs) {
    const files = await collectFiles(dir, ['.ts', '.mts', '.mjs', '.js']);
    for (const file of files) {
      const relPath = rel(root, file);
      if (relPath === SELF_RELATIVE_PATH || isSpecFile(file)) continue;
      const content = await readIfPresent(file);
      if (content === undefined) continue;
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (isCommentLine(lines[i])) continue;
        for (const { re, what } of patterns) {
          if (re.test(lines[i])) {
            violations.push(
              `${relPath}:${i + 1}: ${what} - the package creates no Platform_Prerequisite (Req 5.9): ${lines[i].trim()}`,
            );
            break;
          }
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// B. No Platform_Prerequisite is created - synthesized template half
// ---------------------------------------------------------------------------

/**
 * A fully populated Deploy_Config_File: every Platform_Prerequisite supplied, so
 * the template has no excuse to create one. The names are chosen not to collide
 * with anything the stack itself names, which is what makes the collision check
 * below meaningful.
 */
const FULL_CONFIG = Object.freeze({
  accountId: '123456789012',
  region: 'us-east-1',
  namePrefix: 'guard',
  permissionsBoundaryArn: 'arn:aws:iam::123456789012:policy/platform-estate-boundary',
  bootstrapQualifier: 'guardqr',
  appCmkArn: 'arn:aws:kms:us-east-1:123456789012:key/8f7c1d20-3b2a-4c55-9e11-6a0b7d4e5f33',
  vpc: {
    id: 'vpc-0a1b2c3d4e5f60718',
    subnetIds: ['subnet-0a1b2c3d4e5f60719', 'subnet-0a1b2c3d4e5f6071a'],
  },
  dataSourceSecurityGroupId: 'sg-0a1b2c3d4e5f6071b',
  egressAllowList: ['api.anthropic.com', 'api.openai.com'],
  costAllocationTags: { app: 'phorma', owner: 'platform' },
  retentionDays: 30,
  alarmNotificationArn: 'arn:aws:sns:us-east-1:123456789012:platform-estate-alarms',
  imageUri: '210987654321.dkr.ecr.us-east-1.amazonaws.com/platform/phorma-host:1.2.3',
  deployTrust: {
    identityCenter: {
      permissionSetArn: 'arn:aws:sso:::permissionSet/ssoins-1111111111111111/ps-2222222222222222',
    },
    githubOidc: {
      providerArn: 'arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com',
      repository: 'acme/estate',
      branch: 'main',
      environment: 'production',
    },
  },
});

/** Resource types the template must declare zero of (Req 5.9). */
const FORBIDDEN_RESOURCE_TYPES = ['AWS::EC2::VPC', 'AWS::EC2::Subnet', 'AWS::KMS::Key'];

/**
 * Every identifier the configuration already supplies, in both ARN and bare-name
 * form. A created IAM role or managed policy carrying one of these would be
 * standing in for a prerequisite the operator owns.
 */
function suppliedIdentifiers(config) {
  const arns = [
    config.permissionsBoundaryArn,
    config.appCmkArn,
    config.alarmNotificationArn,
    config.deployTrust?.identityCenter?.permissionSetArn,
    config.deployTrust?.githubOidc?.providerArn,
  ].filter((v) => typeof v === 'string' && v.length > 0);

  const identifiers = new Set([
    ...arns,
    config.vpc?.id,
    ...(config.vpc?.subnetIds ?? []),
    config.dataSourceSecurityGroupId,
  ]);
  for (const arn of arns) {
    // The resource name is the last path segment, or the last colon field for the
    // colon-terminated ARN shapes (SNS topics).
    identifiers.add(arn.slice(arn.lastIndexOf('/') + 1));
    identifiers.add(arn.slice(arn.lastIndexOf(':') + 1));
  }
  identifiers.delete(undefined);
  identifiers.delete('');
  return identifiers;
}

/**
 * Synthesize the host stack from `FULL_CONFIG` and assert the template creates
 * no Platform_Prerequisite.
 *
 * The TypeScript sources load through `tsx`, which is a runtime dependency of
 * this package, so the guard needs no build step.
 */
async function checkSynthesizedTemplate(root, violations) {
  const stackPath = join(root, 'src', 'infra', 'stack.ts');
  const configPath = join(root, 'src', 'core', 'config.ts');

  let cdk;
  let assertions;
  let stackModule;
  let configModule;
  try {
    const { tsImport } = await import('tsx/esm/api');
    cdk = await import('aws-cdk-lib');
    assertions = await import('aws-cdk-lib/assertions');
    stackModule = await tsImport(pathToFileURL(stackPath).href, import.meta.url);
    configModule = await tsImport(pathToFileURL(configPath).href, import.meta.url);
  } catch (err) {
    violations.push(`could not load the CDK app for template assertions: ${err.message}`);
    return;
  }

  const Stack = stackModule[ALLOWED_STACK_CLASS];
  if (typeof Stack !== 'function') {
    violations.push(`src/infra/stack.ts does not export ${ALLOWED_STACK_CLASS}.`);
    return;
  }

  // Prove the fixture really is a valid Deploy_Config_File, then keep the fields
  // the parser passes through unchanged.
  let config;
  try {
    config = {
      ...configModule.parseAwsDeployConfig(structuredClone(FULL_CONFIG)),
      imageUri: FULL_CONFIG.imageUri,
      deployTrust: structuredClone(FULL_CONFIG.deployTrust),
    };
  } catch (err) {
    violations.push(
      `the fully populated Deploy_Config_File no longer parses, so the template assertions could not run: ${err.message}`,
    );
    return;
  }

  let template;
  try {
    const app = new cdk.App();
    const stack = new Stack(app, 'PlatformPrerequisiteGuardStack', {
      env: { account: config.accountId, region: config.region },
      stackName: `${config.namePrefix}-host`,
      synthesizer: new cdk.DefaultStackSynthesizer({ qualifier: config.bootstrapQualifier }),
      config,
    });
    template = assertions.Template.fromStack(stack).toJSON();
  } catch (err) {
    violations.push(`synthesis from the fully populated Deploy_Config_File failed: ${err.message}`);
    return;
  }

  const resources = template.Resources ?? {};

  for (const type of FORBIDDEN_RESOURCE_TYPES) {
    const created = Object.entries(resources)
      .filter(([, r]) => r.Type === type)
      .map(([id]) => id);
    if (created.length > 0) {
      violations.push(
        `synthesized template declares ${created.length} ${type} (${created.join(', ')}). ` +
          'That resource is a Platform_Prerequisite the operator supplies (Req 5.9).',
      );
    }
  }

  const supplied = suppliedIdentifiers(config);
  for (const [logicalId, resource] of Object.entries(resources)) {
    if (resource.Type !== 'AWS::IAM::Role' && resource.Type !== 'AWS::IAM::ManagedPolicy') continue;
    const props = resource.Properties ?? {};
    for (const name of [props.RoleName, props.ManagedPolicyName]) {
      if (typeof name !== 'string') continue;
      if (supplied.has(name)) {
        violations.push(
          `synthesized template creates ${resource.Type} "${logicalId}" named "${name}", ` +
            'which a configured Platform_Prerequisite field already supplies (Req 5.9).',
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Run every check against `root`, which may be any directory laid out like the
 * `cloud-aws` package. Returns the violation lines - empty means the guard
 * passed.
 *
 * `synth` runs the template half, which needs a loadable CDK app. Fixture trees
 * that carry only the files under test pass `synth: false`.
 */
export async function checkAdapterReal({ root, synth = true } = {}) {
  const base = resolve(root ?? '.');
  const violations = [];

  await checkNoFakeImports(base, violations);
  await checkNoFakeIdentifiers(base, violations);
  await checkCapabilityOwners(base, violations);
  await checkServerEntry(base, violations);
  await checkDockerfile(base, violations);
  await checkCorePurity(base, violations);
  await checkSingleStackDeclaration(base, violations);
  await checkNoBootstrapScript(base, violations);
  if (synth) await checkSynthesizedTemplate(base, violations);

  return violations;
}

/** Parse `--root <dir>` and `--no-synth` out of argv. */
function parseArgs(argv) {
  const options = { root: resolve(import.meta.dirname, '..'), synth: true };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root' && argv[i + 1]) {
      options.root = resolve(argv[++i]);
    } else if (argv[i] === '--no-synth') {
      options.synth = false;
    }
  }
  return options;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (invokedDirectly) {
  const options = parseArgs(process.argv.slice(2));
  const violations = await checkAdapterReal(options);
  if (violations.length > 0) {
    console.error('Adapter-real check FAILED:');
    for (const v of violations) console.error(`  ${v}`);
    process.exit(1);
  }
  console.log(
    'Adapter-real check passed: no fake reaches production, every capability has a real owner, ' +
      'the Server_Entry listens, the image builds, src/core/ is pure, and the package creates no Platform_Prerequisite.',
  );
}
