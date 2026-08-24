#!/usr/bin/env node
/**
 * check-admin-conventions.mjs
 *
 * The `admin/` dashboard is a SECOND Angular package, so none of the studio's
 * habits carry over automatically and none of its reviewers are looking at it
 * every day. Three conventions there fail silently, which is exactly why they get
 * a guard instead of a review comment (Requirement 10.14):
 *
 * 1. `pi pi-*` icon classes. `primeicons` is not installed anywhere in this repo -
 *    icons are the Tabler webfont (`ti ti-*`). A `pi pi-` class compiles, builds,
 *    and renders NOTHING: an empty box where an icon should be.
 * 2. `p-dialog`. The repo has zero PrimeNG dialogs by design; dialogs are bespoke
 *    overlays following the confirm-dialog pattern. One `p-dialog` brings a
 *    parallel overlay stack, its own z-index and its own focus behaviour.
 * 3. A PrimeNG control with no explicit size. Omitting it silently renders
 *    PrimeNG's larger default, so the control still works and the row it sits in
 *    is misaligned by a few pixels. The rule is `size="small"` on `pButton`,
 *    `p-select`, `p-inputnumber`, `p-checkbox`, `p-selectbutton` and
 *    `p-toggleswitch`, and `pSize="small"` on `pInputText` / `pTextarea`.
 *
 * All three are template facts, and the dashboard's templates are mostly INLINE
 * `template:` strings in the component `.ts` files (the shell is the one
 * `templateUrl`). Scanning a `.ts` file whole would read its doc comments and its
 * `styles:` block too - and those legitimately discuss `p-table`, `.p-button`
 * selectors and this very allowlist - so the scan BLANKS everything outside a
 * `template:` template literal, preserving offsets so reported line numbers still
 * point at the real line.
 *
 * Completeness comes from the same forced-decision shape `check-deploy-bundle.mjs`
 * uses: every `<p-*>` element found must be in SIZED_ELEMENTS, BANNED_ELEMENTS or
 * NO_SIZE_ELEMENTS with a reason. A newly introduced PrimeNG element cannot slip
 * through as "not one of the ones we check".
 *
 * Run: node scripts/check-admin-conventions.mjs
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCAN_ROOT = resolve(ROOT, 'admin', 'src');

/** PrimeNG elements that MUST carry an explicit size, and the attribute that sets it. */
const SIZED_ELEMENTS = {
  'p-button': 'size',
  'p-checkbox': 'size',
  'p-datepicker': 'size',
  'p-inputnumber': 'size',
  'p-multiselect': 'size',
  'p-select': 'size',
  'p-selectbutton': 'size',
  'p-textarea': 'pSize',
  'p-toggleswitch': 'size',
};

/** PrimeNG directives that must carry an explicit size, and the attribute that sets it. */
const SIZED_DIRECTIVES = {
  pButton: 'size',
  pInputText: 'pSize',
  pTextarea: 'pSize',
};

/** PrimeNG elements this repo does not use at all, and why. */
const BANNED_ELEMENTS = {
  'p-dialog':
    'the repo has zero p-dialog usage - dialogs are bespoke overlays following the ' +
    'confirm-dialog pattern, so a PrimeNG dialog would bring a second overlay stack',
};

/** PrimeNG elements with no size to set, and why. Keeps the p-* check total. */
const NO_SIZE_ELEMENTS = {
  'p-chart': 'a canvas wrapper - it takes width and height, and has no size token',
};

/** The only accepted static size value. */
const EXPECTED_SIZE = 'small';

const failures = [];

/** Every `.html` and `.ts` file under `admin/src`. */
function sourceFiles(directory) {
  const files = [];
  for (const dirent of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, dirent.name);
    if (dirent.isDirectory()) {
      if (dirent.name === 'node_modules') continue;
      files.push(...sourceFiles(path));
      continue;
    }
    if (/\.(?:html|ts)$/.test(dirent.name)) files.push(path);
  }
  return files;
}

/** Replaces every character of `text` except newlines with a space. */
function blank(text) {
  return text.replace(/[^\n]/g, ' ');
}

/**
 * A `.ts` file reduced to its inline template regions: same length, same line
 * breaks, everything outside a `template: ` template literal blanked. Offsets
 * therefore still map to the real line, and comments and `styles:` blocks cannot
 * be read as markup.
 */
function inlineTemplateView(source) {
  const chars = blank(source).split('');
  let regions = 0;
  for (const match of source.matchAll(/\btemplate\s*:\s*`/g)) {
    const open = match.index + match[0].length;
    let close = open;
    while (close < source.length) {
      if (source[close] === '\\') {
        close += 2;
        continue;
      }
      if (source[close] === '`') break;
      close += 1;
    }
    if (close >= source.length) continue;
    for (let i = open; i < close; i += 1) chars[i] = source[i];
    regions += 1;
  }
  return { view: chars.join(''), regions };
}

/** Elements in `template`, as `{name, closing, text, index}`, comments blanked. */
function elementsOf(template) {
  const source = template.replace(/<!--[\s\S]*?-->/g, blank);
  const elements = [];
  for (let i = 0; i < source.length; i += 1) {
    if (source[i] !== '<') continue;
    const head = /^<(\/?)([a-zA-Z][\w-]*)/.exec(source.slice(i, i + 80));
    if (!head) continue;
    // Walk to the tag end, respecting quoted attribute values so a `>` inside
    // one (an Angular expression, for example) does not end the tag early.
    let end = i + head[0].length;
    let quote = null;
    while (end < source.length) {
      const char = source[end];
      if (quote !== null) {
        if (char === quote) quote = null;
      } else if (char === '"' || char === "'") {
        quote = char;
      } else if (char === '>') {
        break;
      }
      end += 1;
    }
    elements.push({
      name: head[2],
      closing: head[1] === '/',
      text: source.slice(i, Math.min(end + 1, source.length)),
      index: i,
    });
    i = end;
  }
  return elements;
}

/**
 * The attributes of one tag, keyed by canonical name - `[size]`, `size` and
 * `[attr.size]` all reduce to `size` - carrying whether the value was bound and
 * the static value if it was not.
 */
function attributesOf(tagText) {
  const body = tagText.replace(/^<\/?[a-zA-Z][\w-]*/, '').replace(/\/?>$/, '');
  const attributes = new Map();
  const pattern = /([*#@[(]?[a-zA-Z_][\w.:$-]*[\])]?)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'))?/g;
  for (const [, raw, doubleQuoted, singleQuoted] of body.matchAll(pattern)) {
    const bound = /^[[(]/.test(raw);
    const name = raw.replace(/^[*#@[(]+/, '').replace(/[\])]+$/, '');
    attributes.set(name, {
      bound,
      value: doubleQuoted ?? singleQuoted ?? null,
    });
  }
  return attributes;
}

/** 1-based line number of `index` within `source`. */
function lineOf(source, index) {
  return source.slice(0, index).split('\n').length;
}

/**
 * Records a failure for a control whose size attribute is missing or wrong.
 * `subject` names the control the way the author wrote it.
 */
function checkSize(attributes, attribute, subject, where) {
  const declared = attributes.get(attribute);
  if (declared === undefined) {
    failures.push(
      `${where}: ${subject} carries no ${attribute} attribute. Add ` +
        `${attribute}="${EXPECTED_SIZE}" - without it PrimeNG renders its larger ` +
        'default and the row misaligns by a few pixels (Requirement 10.14).',
    );
    return;
  }
  if (declared.bound) return;
  if (declared.value !== EXPECTED_SIZE) {
    failures.push(
      `${where}: ${subject} sets ${attribute}="${declared.value ?? ''}". The dashboard ` +
        `uses ${attribute}="${EXPECTED_SIZE}" on every control, so neighbouring ` +
        'controls keep one height (Requirement 10.14).',
    );
  }
}

const templates = [];
for (const path of sourceFiles(SCAN_ROOT)) {
  const source = readFileSync(path, 'utf-8');
  const label = relative(ROOT, path).replace(/\\/g, '/');
  if (path.endsWith('.html')) {
    templates.push({ label, source, template: source, inline: false });
    continue;
  }
  const { view, regions } = inlineTemplateView(source);
  if (/@Component\s*\(/.test(source) && regions === 0 && !/\btemplateUrl\s*:/.test(source)) {
    failures.push(
      `${label} declares a component with neither an inline template this guard ` +
        'could find nor a templateUrl. The template parser in this script no longer ' +
        'matches the file, so it is passing vacuously - fix the parser.',
    );
  }
  if (regions > 0) templates.push({ label, source, template: view, inline: true });
}

let inlineCount = 0;
let controlsChecked = 0;

for (const { label, source, template, inline } of templates) {
  if (inline) inlineCount += 1;

  for (const match of template.matchAll(/\bpi\s+pi-[\w-]+/g)) {
    failures.push(
      `${label}:${lineOf(source, match.index)}: "${match[0]}" is a PrimeIcons class. ` +
        '`primeicons` is not installed, so it renders nothing - use the Tabler ' +
        'webfont (`ti ti-*`) instead (Requirement 10.14).',
    );
  }

  for (const element of elementsOf(template)) {
    // Opening tags only, so a banned element is reported once rather than twice.
    if (element.closing) continue;
    const where = `${label}:${lineOf(source, element.index)}`;
    const banned = BANNED_ELEMENTS[element.name];
    if (banned !== undefined) {
      failures.push(`${where}: <${element.name}> is not used in this repo - ${banned}.`);
      continue;
    }

    const attributes = attributesOf(element.text);
    const sizeAttribute = SIZED_ELEMENTS[element.name];
    if (sizeAttribute !== undefined) {
      checkSize(attributes, sizeAttribute, `<${element.name}>`, where);
      controlsChecked += 1;
    } else if (element.name.startsWith('p-') && !(element.name in NO_SIZE_ELEMENTS)) {
      failures.push(
        `${where}: <${element.name}> is a PrimeNG element this guard does not ` +
          'classify. Add it to SIZED_ELEMENTS with the attribute that sets its size, ' +
          'to NO_SIZE_ELEMENTS with a reason, or to BANNED_ELEMENTS - so a new control ' +
          'forces a decision instead of skipping the size check.',
      );
    }

    for (const [directive, attribute] of Object.entries(SIZED_DIRECTIVES)) {
      if (!attributes.has(directive)) continue;
      checkSize(attributes, attribute, `<${element.name} ${directive}>`, where);
      controlsChecked += 1;
    }
  }
}

if (templates.length === 0) {
  failures.push(
    `no templates were found under ${relative(ROOT, SCAN_ROOT).replace(/\\/g, '/')}. If the ` +
      'dashboard moved, move this guard with it - a silently skipped convention check ' +
      'is worse than none.',
  );
}

if (inlineCount === 0) {
  failures.push(
    'no INLINE templates were found. The dashboard components hold their markup in ' +
      '`template:` strings, so finding none means the inline scan is broken and the ' +
      'guard is passing vacuously - fix inlineTemplateView.',
  );
}

if (controlsChecked === 0) {
  failures.push(
    'no PrimeNG controls were found in any dashboard template. The shell alone has ' +
      'buttons and text inputs, so finding none means the element parser is broken - ' +
      'fix elementsOf.',
  );
}

for (const name of Object.keys(NO_SIZE_ELEMENTS)) {
  const used = templates.some(({ template }) => new RegExp(`<${name}[\\s/>]`).test(template));
  if (!used) {
    failures.push(
      `NO_SIZE_ELEMENTS lists "${name}", which no dashboard template uses - prune it ` +
        'so the exemption list keeps describing the real markup.',
    );
  }
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`  FAIL: ${failure}`);
  console.error(`\ncheck-admin-conventions FAILED with ${failures.length} failure(s).`);
  process.exit(1);
}

console.log(
  `check-admin-conventions passed: ${templates.length} template(s) scanned ` +
    `(${inlineCount} inline), ${controlsChecked} PrimeNG control(s) verified.`,
);
