#!/usr/bin/env node
/**
 * check-capability-isolation.mjs
 *
 * Two checks over the studio's capability module, modelled on
 * `scripts/check-telemetry-isolation.mjs` - which exists because "an import added
 * here does not fail the build; it fails at runtime, in a user's app, as a blank
 * screen on startup".
 *
 * 1. THE IMPORT ALLOWLISTS of the studio's two DI-leaf session services,
 *    `frontend/src/app/core/capability.service.ts` and
 *    `frontend/src/app/core/active-owner.service.ts`. One check over a table of
 *    files rather than a second guard, because the reason both files exist is the
 *    same reason and a separate script would be a second place to keep it.
 *
 *    `capability.service.ts`:
 *    `PanelRegistryService` injects that service and the layout shell reads the
 *    registry at startup, so anything reachable from it is constructed while the
 *    first frame is being built. The known NG0200 cycle is
 *    `RunControllerService -> ModelTransportService -> PhormaCloudService ->
 *    CloudService -> RunControllerService`, and the service must reach no member of
 *    it (Requirement 7.2). It currently injects NOTHING, which is stronger than the
 *    design sketch asked for and is documented in the file itself. An allowlist
 *    entry the file no longer imports is ALSO a failure, so the list keeps
 *    describing the real dependency surface.
 *
 *    `active-owner.service.ts`: the stronger case of the two, because the active
 *    owner is read ON the transport path - every Phorma Cloud request attaches
 *    `X-Phorma-Owner` beside its bearer, and `IndexedDbStorageService` reads it to
 *    scope a local row. It must reach no `CloudService`, no `PhormaCloudService`
 *    and no `WorkflowService`; the owner LIST is pushed in from the verified
 *    `/api/me` answer and the SWITCH is performed by `OwnerSwitchService`, which
 *    components inject (Requirement 20.5).
 *
 * 2. THE TOKEN SCAN over `frontend/src/app/`. A `CapabilityLevel` literal in a
 *    COMPARISON POSITION outside the capability module is a capability decision
 *    made somewhere other than the one seam that is allowed to make it
 *    (Requirements 7.4, 7.5). A comparison position is an equality test, a `??` or
 *    `||` default, a `case` label, a ternary branch, or an argument to
 *    `atLeastLevel` / `allows`.
 *
 *    A `minLevel:` DECLARATION is PERMITTED, and has to be: `DEFAULT_TABS` and
 *    every Action_Registry entry declare one. A declaration is DATA; a comparison
 *    is a DECISION. That asymmetry is also why the absent-means-`operator` default
 *    lives inside `CapabilityService.allows` rather than at each call site, where
 *    `?? 'operator'` WOULD be a decision and WOULD fail this scan.
 *
 *    Scoped to comparison positions rather than to any occurrence, because
 *    `'admin'` legitimately appears in unrelated strings all over the studio. The
 *    file exemption list is explicit and short, so widening it is a visible
 *    decision rather than a side effect.
 *
 * Both checks carry the vacuous-pass guards the telemetry guard established: zero
 * import specifiers means the parser broke rather than the file being clean, and
 * the same goes for zero scanned files, zero level literals anywhere in the tree,
 * and zero `minLevel:` declarations on the panel registry.
 *
 * Run: node scripts/check-capability-isolation.mjs
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const SERVICE = 'frontend/src/app/core/capability.service.ts';
const OWNER_SERVICE = 'frontend/src/app/core/active-owner.service.ts';
const CONTRACT = 'frontend/src/app/core/capabilities.ts';
const SCAN_ROOT = 'frontend/src/app';
const REGISTRY = 'frontend/src/app/core/panel-registry.service.ts';

/**
 * The DI leaves, and every module specifier each one is allowed to reference.
 *
 * A table rather than two scripts: both files are leaves for the same reason, and
 * the failure they guard against is the same failure. Each entry's value is the
 * allowlist, keyed by specifier so the reason travels with it.
 */
const LEAVES = [
  {
    file: SERVICE,
    why:
      'PanelRegistryService injects it and the layout shell reads that registry\n' +
      '        at startup, so anything reachable from it is constructed while the\n' +
      '        first frame is being built',
    allowed: {
      '@angular/core': 'framework primitives only - signal, computed, Injectable',
      './capabilities': 'the contract module, which has no imports of its own',
    },
  },
  {
    file: OWNER_SERVICE,
    why:
      'the active owner is read ON the transport path - every Phorma Cloud\n' +
      '        request attaches X-Phorma-Owner beside its bearer, and\n' +
      '        IndexedDbStorageService reads it to scope a local row',
    allowed: {
      '@angular/core': 'framework primitives only - signal, computed, Injectable',
    },
  },
];

/**
 * The files allowed to compare a level token. The contract declares the tokens and
 * the service is the one seam that decides with them; their specs have to name
 * levels to test either.
 */
const EXEMPT = new Set([
  CONTRACT,
  'frontend/src/app/core/capabilities.spec.ts',
  SERVICE,
  'frontend/src/app/core/capability.service.spec.ts',
]);

/** The wire tokens, kept in step with `CapabilityLevel` in the contract module. */
const LEVELS = ['operator', 'editor', 'builder', 'admin'];

/** A quoted level literal, either quote style. */
const LITERAL = `['"](?:${LEVELS.join('|')})['"]`;

/**
 * Comparison positions, each with the sentence reported when it matches. Adding a
 * position here is how the guard is tightened; the list is deliberately closed
 * rather than "any occurrence", see the header.
 */
const COMPARISONS = [
  { why: 'an equality comparison', pattern: `(?:===|!==|==|!=)\\s*${LITERAL}` },
  { why: 'an equality comparison', pattern: `${LITERAL}\\s*(?:===|!==|==|!=)` },
  { why: 'a ?? or || default', pattern: `(?:\\?\\?|\\|\\|)\\s*${LITERAL}` },
  { why: 'a switch case label', pattern: `\\bcase\\s+${LITERAL}\\s*:` },
  { why: 'a ternary branch', pattern: `\\?\\s*${LITERAL}\\s*:` },
  {
    why: 'an argument to a capability comparison',
    pattern: `\\b(?:atLeastLevel|allows)\\s*\\(\\s*${LITERAL}`,
  },
];

const failures = [];

// ─── Check 1: the import allowlists ────────────────────────────────────────

for (const leaf of LEAVES) {
  if (existsSync(resolve(ROOT, leaf.file))) continue;
  console.error(
    `  FAIL: ${leaf.file} does not exist. If the service moved, move this guard ` +
      'with it - a silently skipped isolation check is worse than none.',
  );
  console.error('\ncheck-capability-isolation FAILED with 1 failure(s).');
  process.exit(1);
}

/**
 * Blanks comments and template-literal bodies while leaving single- and
 * double-quoted strings verbatim, because the level tokens ARE quoted strings and
 * the scan below has to read them.
 *
 * A character scanner rather than a chain of `replace` calls: a crude
 * `//[^\n]*` strip deletes the rest of any line holding a `https://` string, which
 * would let a violation on that line pass unseen. Offsets are preserved (every
 * removed character becomes a space, newlines kept) so a reported line number is
 * the real one.
 */
function stripNonCode(source) {
  const out = [];
  let index = 0;
  let state = 'code';
  let quote = '';
  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];
    if (state === 'code') {
      if (char === '/' && next === '/') {
        state = 'line-comment';
        out.push('  ');
        index += 2;
        continue;
      }
      if (char === '/' && next === '*') {
        state = 'block-comment';
        out.push('  ');
        index += 2;
        continue;
      }
      if (char === '`') {
        state = 'template';
        out.push('`');
        index += 1;
        continue;
      }
      if (char === "'" || char === '"') {
        state = 'string';
        quote = char;
        out.push(char);
        index += 1;
        continue;
      }
      out.push(char);
      index += 1;
      continue;
    }
    if (state === 'line-comment') {
      if (char === '\n') {
        state = 'code';
        out.push('\n');
      } else {
        out.push(' ');
      }
      index += 1;
      continue;
    }
    if (state === 'block-comment') {
      if (char === '*' && next === '/') {
        state = 'code';
        out.push('  ');
        index += 2;
        continue;
      }
      out.push(char === '\n' ? '\n' : ' ');
      index += 1;
      continue;
    }
    if (state === 'template') {
      if (char === '\\') {
        out.push('  ');
        index += 2;
        continue;
      }
      if (char === '`') {
        state = 'code';
        out.push('`');
        index += 1;
        continue;
      }
      out.push(char === '\n' ? '\n' : ' ');
      index += 1;
      continue;
    }
    // state === 'string'
    if (char === '\\') {
      out.push(source.slice(index, index + 2));
      index += 2;
      continue;
    }
    if (char === quote || char === '\n') {
      state = 'code';
    }
    out.push(char);
    index += 1;
  }
  return out.join('');
}

/** An HTML template: only `<!-- -->` comments hide text, and quoting is nested. */
function stripHtmlComments(source) {
  return source.replace(/<!--[\s\S]*?-->/g, match => match.replace(/[^\n]/g, ' '));
}

/** Static `from '...'`, side-effect `import '...'`, dynamic `import('...')`, `require('...')`. */
const IMPORT_PATTERNS = [
  /\bfrom\s*['"]([^'"]+)['"]/g,
  /\bimport\s*['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
];

let importsChecked = 0;

for (const leaf of LEAVES) {
  const code = stripNonCode(readFileSync(resolve(ROOT, leaf.file), 'utf-8'));
  const imported = new Set();
  for (const pattern of IMPORT_PATTERNS) {
    for (const [, specifier] of code.matchAll(pattern)) {
      imported.add(specifier.replace(/\.(?:js|ts|mjs)$/, ''));
    }
  }
  importsChecked += imported.size;

  if (imported.size === 0) {
    failures.push(
      `no import specifiers were found in ${leaf.file}. The parser in this guard ` +
        'no longer matches the file, so it is passing vacuously - fix the parser.',
    );
  }

  for (const specifier of [...imported].sort()) {
    if (specifier in leaf.allowed) continue;
    failures.push(
      `${leaf.file} imports "${specifier}", which is not on its allowlist.\n` +
        `        This service must stay a DI leaf: ${leaf.why},\n` +
        '        so it may reach no member of the RunControllerService ->\n' +
        '        ModelTransportService -> PhormaCloudService -> CloudService cycle\n' +
        '        (Requirements 7.2, 20.5).\n' +
        `        Allowed: ${Object.keys(leaf.allowed).join(', ')}.\n` +
        '        Session values here are PUSHED in by whoever already holds the\n' +
        '        verified /api/me answer - so the answer is almost never a new\n' +
        '        import. If one is genuinely a leaf and genuinely needed, widen\n' +
        '        LEAVES in this script AND section 17.1 of\n' +
        '        .kiro/specs/multi-organisation-phorma/design.md in the same change.',
    );
  }

  for (const specifier of Object.keys(leaf.allowed)) {
    if (!imported.has(specifier)) {
      failures.push(
        `${leaf.file}'s allowlist lists "${specifier}", which the file no longer ` +
          'imports - prune it so the allowlist keeps describing the real ' +
          'dependency surface.',
      );
    }
  }
}

// ─── Check 2: the token scan ───────────────────────────────────────────────

const scanRootAbsolute = resolve(ROOT, SCAN_ROOT);

if (!existsSync(scanRootAbsolute)) {
  failures.push(
    `${SCAN_ROOT} does not exist, so the token scan examined nothing. Move this ` +
      'guard with the tree it guards.',
  );
}

/** Every `.ts` and `.html` file under the scan root, repo-relative, posix separators. */
function collectFiles(directory) {
  const collected = [];
  for (const entry of readdirSync(directory)) {
    const absolute = join(directory, entry);
    if (statSync(absolute).isDirectory()) {
      collected.push(...collectFiles(absolute));
      continue;
    }
    if (/\.(?:ts|html)$/.test(entry)) {
      collected.push(relative(ROOT, absolute).split('\\').join('/'));
    }
  }
  return collected;
}

const files = existsSync(scanRootAbsolute) ? collectFiles(scanRootAbsolute) : [];

if (files.length === 0 && existsSync(scanRootAbsolute)) {
  failures.push(
    `the token scan found no .ts or .html file under ${SCAN_ROOT}. The walker in ` +
      'this guard is broken, so the scan is passing vacuously.',
  );
}

/** Any level literal at all, used only for the vacuous-pass guard below. */
const ANY_LITERAL = new RegExp(LITERAL, 'g');

let literalsSeen = 0;
let registryDeclarations = 0;
let scanned = 0;

for (const file of files) {
  if (EXEMPT.has(file)) continue;
  scanned += 1;
  const source = readFileSync(resolve(ROOT, file), 'utf-8');
  const code = file.endsWith('.html') ? stripHtmlComments(source) : stripNonCode(source);
  literalsSeen += [...code.matchAll(ANY_LITERAL)].length;
  if (file === REGISTRY) {
    registryDeclarations = [...code.matchAll(new RegExp(`minLevel\\s*:\\s*${LITERAL}`, 'g'))].length;
  }
  for (const { why, pattern } of COMPARISONS) {
    for (const match of code.matchAll(new RegExp(pattern, 'g'))) {
      const line = code.slice(0, match.index).split('\n').length;
      failures.push(
        `${file}:${line} compares a CapabilityLevel token in ${why}: ` +
          `${match[0].trim()}\n` +
          '        A capability decision belongs in CapabilityService and nowhere\n' +
          '        else (Requirements 7.4, 7.5). Declare a minimum as DATA instead -\n' +
          '        `minLevel: ...` on the DEFAULT_TABS or action entry - and let the\n' +
          '        one filter seam, `capability.allows(entry.minLevel)`, decide. For a\n' +
          '        capability rather than a level, `capability.can(...)` names what the\n' +
          '        surface actually needs. Never `?? \'operator\'` here: that default\n' +
          '        lives inside the capability module.',
      );
    }
  }
}

if (scanned === 0 && files.length > 0) {
  failures.push(
    'every file under the scan root was exempt, so the token scan examined ' +
      'nothing. Shrink EXEMPT.',
  );
}

if (scanned > 0 && literalsSeen === 0) {
  failures.push(
    `no CapabilityLevel literal was found anywhere in ${scanned} scanned file(s). ` +
      'DEFAULT_TABS declares four of them, so the scanner is not reading what it ' +
      'thinks it is - fix it rather than trusting the pass.',
  );
}

if (existsSync(resolve(ROOT, REGISTRY)) && registryDeclarations === 0) {
  failures.push(
    `${REGISTRY} declares no minLevel on any tab entry. Either the subtractive ` +
      'panel registration of Requirement 7.3 has been removed, or the declaration ' +
      'moved and this guard is now checking the wrong file.',
  );
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`  FAIL: ${failure}`);
  console.error(`\ncheck-capability-isolation FAILED with ${failures.length} failure(s).`);
  process.exit(1);
}

console.log(
  `check-capability-isolation passed: ${importsChecked} import(s) across ${LEAVES.length} DI ` +
    `leaf/leaves, all on their allowlists; ${scanned} file(s) scanned, ${literalsSeen} level ` +
    `literal(s) seen, ${registryDeclarations} declared tab minimum(s), no comparison outside ` +
    'the capability module.',
);
