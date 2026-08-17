/**
 * check-engine-alias.mjs
 *
 * Asserts that the tsconfig.json `@phorma/engine` path alias exists and that no
 * file in cloud-aws/src imports a relative path crossing into `../engine`.
 *
 * This ensures cloud-aws always resolves engine source through the alias, never
 * through a brittle relative path.
 *
 * Validates: Requirements 1.2, 1.7
 */
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const PKG_ROOT = resolve(import.meta.dirname, '..');
const SRC_DIR = join(PKG_ROOT, 'src');

const violations = [];

/**
 * Strip comments from JSONC so `tsconfig.json` can be parsed.
 *
 * `tsconfig.json` is JSONC by definition, and this one carries comments
 * explaining why `resolveJsonModule` is on. A bare `JSON.parse` fails on them,
 * which used to take this guard down for a reason that had nothing to do with the
 * engine alias. The scan is string-aware, so a `//` inside a value (a URL, a path)
 * survives, and escapes inside strings are honoured.
 */
function stripJsonComments(text) {
  let out = '';
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const next = text[i + 1];

    if (inLineComment) {
      if (char === '\n') {
        inLineComment = false;
        out += char;
      }
      continue;
    }
    if (inBlockComment) {
      if (char === '*' && next === '/') {
        inBlockComment = false;
        i++;
      }
      continue;
    }
    if (inString) {
      out += char;
      if (char === '\\') {
        out += next ?? '';
        i++;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }
    if (char === '/' && next === '/') {
      inLineComment = true;
      i++;
      continue;
    }
    if (char === '/' && next === '*') {
      inBlockComment = true;
      i++;
      continue;
    }
    out += char;
  }
  return out;
}

// 1. Assert the tsconfig path alias exists
const tsconfigPath = join(PKG_ROOT, 'tsconfig.json');
let tsconfig;
try {
  const raw = await readFile(tsconfigPath, 'utf-8');
  tsconfig = JSON.parse(stripJsonComments(raw));
} catch (e) {
  console.error(`Failed to read tsconfig.json: ${e.message}`);
  process.exit(1);
}

const paths = tsconfig?.compilerOptions?.paths;
if (!paths || !paths['@phorma/engine']) {
  violations.push('tsconfig.json is missing the @phorma/engine path alias');
}
if (!paths || !paths['@phorma/engine/*']) {
  violations.push('tsconfig.json is missing the @phorma/engine/* path alias');
}

// 2. Scan all .ts files in src/ for relative imports crossing into ../engine
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

const files = await collectTsFiles(SRC_DIR);

// Pattern: import/export from a path that resolves to ../engine or deeper
// Catches:
//   import { foo } from '../../engine/src/bar'
//   import type { X } from '../../../engine/src/types'
//   export { Y } from '../../engine/src/index'
//   const m = import('../../engine/src/bar')
const relativeEngineImport = /(?:from|import\s*\()\s*['"]([^'"]*)['"]/g;

for (const file of files) {
  const content = await readFile(file, 'utf-8');
  const relPath = file.slice(PKG_ROOT.length + 1).replaceAll('\\', '/');
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    // Skip comments
    if (/^\s*\/\//.test(line) || /^\s*\*/.test(line)) continue;

    let match;
    relativeEngineImport.lastIndex = 0;
    while ((match = relativeEngineImport.exec(line)) !== null) {
      const specifier = match[1];
      // Check if it's a relative path that crosses into engine
      if (specifier.startsWith('.') && /\.\.\/.*engine/.test(specifier)) {
        violations.push(
          `${relPath}:${lineNum}: relative import crossing into engine/ found: "${specifier}" - use @phorma/engine alias instead`
        );
      }
    }
  }
}

if (violations.length > 0) {
  console.error('Engine alias check FAILED:');
  for (const v of violations) {
    console.error(`  ${v}`);
  }
  process.exit(1);
}

console.log('Engine alias check passed: @phorma/engine path alias exists and no relative engine imports found.');
