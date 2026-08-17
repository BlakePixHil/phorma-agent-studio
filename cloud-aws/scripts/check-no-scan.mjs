#!/usr/bin/env node
/**
 * check-no-scan.mjs
 *
 * Asserts that no DynamoDB Scan operation is referenced anywhere in cloud-aws/src.
 * The Run_Table design guarantees single-partition access only; a Scan would violate
 * the cost model and the partition-scoping invariant.
 *
 * Validates: Requirements 13.8, 18.6
 */
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const PKG_ROOT = resolve(import.meta.dirname, '..');
const SRC_DIR = join(PKG_ROOT, 'src');

/**
 * Recursively collect all .ts files under a directory.
 */
async function collectTsFiles(dir) {
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
      files.push(...(await collectTsFiles(full)));
    } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.mts')) {
      files.push(full);
    }
  }
  return files;
}

const violations = [];
const files = await collectTsFiles(SRC_DIR);

// Patterns that indicate a DynamoDB Scan operation
const SCAN_PATTERNS = [
  // Import of ScanCommand or ScanInput from AWS SDK
  /\bScanCommand\b/,
  /\bScanInput\b/,
  // Method call .scan(
  /\.scan\s*\(/,
  // Operation string literal
  /operation\s*:\s*['"]Scan['"]/,
  // Import of Scan from DynamoDB SDK module specifiers
  /from\s+['"]@aws-sdk\/[^'"]*['"].*\bScan\b/,
  /\bScan\b.*from\s+['"]@aws-sdk\/[^'"]*['"]/,
];

for (const file of files) {
  const content = await readFile(file, 'utf-8');
  const relPath = file.slice(PKG_ROOT.length + 1).replaceAll('\\', '/');
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    // Skip single-line comments
    if (/^\s*\/\//.test(line)) continue;
    // Skip block comment lines
    if (/^\s*\*/.test(line)) continue;

    for (const pattern of SCAN_PATTERNS) {
      if (pattern.test(line)) {
        violations.push(`${relPath}:${lineNum}: DynamoDB Scan reference found: ${line.trim()}`);
        break; // one violation per line is enough
      }
    }
  }
}

if (violations.length > 0) {
  console.error('No-scan check FAILED. DynamoDB Scan references found in cloud-aws/src:');
  for (const v of violations) {
    console.error(`  ${v}`);
  }
  process.exit(1);
}

console.log('No-scan check passed: no DynamoDB Scan operations found in cloud-aws/src.');
