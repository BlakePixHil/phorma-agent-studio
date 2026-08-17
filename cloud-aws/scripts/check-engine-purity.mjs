/**
 * check-engine-purity.mjs
 *
 * Rejects any `@aws-sdk/*` value import, type-only import or dynamic import
 * expression in `engine/src`, and any AWS-derived identifier outside the
 * declared allow-list.
 *
 * "AWS-derived identifier" means:
 * - An exported or top-level declared symbol whose name starts with `aws`/`AWS`
 *   or contains `Aws`/`AWS` as a word component
 * - A module specifier (import/export from) referencing an aws-sdk or cloud-aws
 *   package
 *
 * The allow-list names the six identifiers the spec explicitly permits in
 * engine/src. Any new AWS coupling must go through a spec amendment.
 *
 * Validates: Requirements 1.2, 1.7
 */
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..', '..');
const ENGINE_SRC = join(ROOT, 'engine', 'src');

/** Identifiers and string values the spec explicitly allows in engine/src. */
const ALLOW_LIST = new Set([
  'aws-sigv4',
  'bedrock',
  'aws-secrets-manager',
  'aws-fargate',
  'awsSecretName',
  'AWS_CAPABILITIES',
]);

/**
 * Recursively collect all .ts files under a directory.
 */
async function collectTsFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectTsFiles(full)));
    } else if (entry.name.endsWith('.ts')) {
      files.push(full);
    }
  }
  return files;
}

const violations = [];
const files = await collectTsFiles(ENGINE_SRC);

for (const file of files) {
  const content = await readFile(file, 'utf-8');
  const relPath = file.slice(ROOT.length + 1).replaceAll('\\', '/');
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    // --- Check 1: @aws-sdk/* module specifiers ---
    // Catches value imports, type-only imports, dynamic imports and requires.
    if (/['"]@aws-sdk\/[^'"]*['"]/.test(line)) {
      violations.push(`${relPath}:${lineNum}: @aws-sdk/* reference: ${line.trim()}`);
    }

    // --- Check 2: cloud-aws module specifiers ---
    if (/(?:from|import\s*\(|require\s*\()\s*['"][^'"]*cloud-aws[^'"]*['"]/.test(line)) {
      violations.push(`${relPath}:${lineNum}: cloud-aws import: ${line.trim()}`);
    }

    // --- Check 3: AWS-derived exported/declared identifiers ---
    // Match declarations: export/const/let/var/function/class/type/interface/enum
    // that introduce an identifier starting with AWS/Aws/aws that is not in the
    // allow-list.
    const declMatch = line.match(
      /(?:export\s+)?(?:const|let|var|function\*?|class|type|interface|enum)\s+([A-Za-z_$][A-Za-z0-9_$]*)/
    );
    if (declMatch) {
      const id = declMatch[1];
      if (/^(?:aws|AWS|Aws)/.test(id) && !ALLOW_LIST.has(id)) {
        violations.push(
          `${relPath}:${lineNum}: AWS-derived declaration "${id}" is not in the allow-list: ${line.trim()}`
        );
      }
    }

    // Also catch `export { Foo as AwsBar }` re-exports
    const reExportMatch = line.matchAll(/\bas\s+([A-Za-z_$][A-Za-z0-9_$]*)/g);
    for (const m of reExportMatch) {
      const id = m[1];
      if (/^(?:aws|AWS|Aws)/.test(id) && !ALLOW_LIST.has(id)) {
        violations.push(
          `${relPath}:${lineNum}: AWS-derived re-export alias "${id}" is not in the allow-list: ${line.trim()}`
        );
      }
    }
  }
}

if (violations.length > 0) {
  console.error('Engine purity check FAILED. Prohibited references in engine/src:');
  for (const v of violations) {
    console.error(`  ${v}`);
  }
  process.exit(1);
}

console.log('Engine purity check passed: no @aws-sdk imports, no cloud-aws imports, no unauthorized AWS identifiers in engine/src.');
