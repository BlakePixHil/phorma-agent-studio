/**
 * Payload redaction (design §10, P1-12).
 *
 * Sits in front of persistence, never in the middle of execution: hosts pass
 * `redact: value => redactor.scrub(value)` into `RunOptions` and wrap their
 * persistence sink with `redactor.event(...)`, while the live monitor keeps full
 * fidelity in memory.
 *
 * Three passes, in this fixed order, because a secret must never survive because
 * a JSON parse failed:
 *
 * 1. **Literals** — every registered secret of {@link MIN_SECRET_LEN} characters
 *    or more is replaced in the RAW text, before any parse attempt, so a value
 *    that straddles a JSON string escape still goes.
 * 2. **Structural rules** — when the text parses as JSON, `path` and `key` rules
 *    are applied by walking the structure to {@link MAX_REDACT_DEPTH} levels.
 *    Anything nested deeper is left structurally unchanged.
 * 3. **Pattern rules** — applied to the raw text when it is not JSON, and to
 *    individual string values when it is.
 *
 * `scrub` is total (never throws, always returns a string) and idempotent:
 * already-redacted values carry a marker (`[redacted]` / `fnv1a:`) that the
 * second pass recognises and leaves alone.
 *
 * Zero runtime dependencies: `fnv1a` and `canonicalJson` come from `./state.js`,
 * so a `hash` fingerprint computed on the desktop matches one computed in the
 * worker byte for byte.
 */

import type { RunEvent } from './events.js';
import { canonicalJson, fnv1a } from './state.js';
import type { RedactionRule } from './types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Bounds and markers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Shortest literal worth scrubbing. Anything shorter is far more likely to be a
 * common word than a credential, and blanket-replacing it would corrupt every
 * payload it touches (Requirement 15.4).
 */
export const MIN_SECRET_LEN = 8;

/** Structural walk depth cap. Deeper values are left unchanged (15.5). */
export const MAX_REDACT_DEPTH = 32;

/** Rules accepted per configuration; the first 64 are applied in order (15.1). */
export const MAX_REDACTION_RULES = 64;

/** `pattern` rule source-length cap. A longer source is rejected (15.16). */
export const MAX_PATTERN_SOURCE_LEN = 256;

/** Per-rule, per-input match budget for `pattern` rules (15.14, 15.15). */
export const PATTERN_MATCH_BUDGET_MS = 100;

/** Replacement written by `mask`, and the marker that keeps `scrub` idempotent. */
export const REDACTED = '[redacted]';

/** Written in place of an output the host was told never to persist (15.11). */
export const NOT_PERSISTED = '[not persisted]';

/** Prefix on a `hash` replacement, so a fingerprint is never re-fingerprinted. */
export const HASH_PREFIX = 'fnv1a:';

/** Event fields blanked entirely for a `noPersistNodeIds` node (15.11). */
const NO_PERSIST_FIELDS = ['output', 'body'] as const;

/** Event fields that must survive redaction verbatim (15.17). */
const PRESERVED_EVENT_FIELDS = ['type', 'nodeId'] as const;

// ─────────────────────────────────────────────────────────────────────────────
// Public surface
// ─────────────────────────────────────────────────────────────────────────────

export interface RedactionConfig {
  /** 0 to 64 rules. Applied in declaration order; the first match wins. */
  rules?: readonly RedactionRule[];
  /** Literal values always scrubbed — seeded from every ResolvedConnection. */
  literals?: readonly string[];
  /** Node ids whose payloads are never persisted at all. */
  noPersistNodeIds?: readonly string[];
}

export interface Redactor {
  /** Registers secret values discovered at run time (connection resolution). */
  addLiterals(values: readonly string[]): void;
  /** Scrubs one string. Total: never throws, always returns a string. */
  scrub(value: string): string;
  /** Wraps a RunEvent, returning a persistence-safe copy. */
  event(event: RunEvent): RunEvent;
  /**
   * Rules rejected at construction time — an oversized or uncompilable `pattern`
   * source, or a rule past the 64-rule cap. Every other rule still applies
   * (Requirement 15.16), so hosts surface these rather than failing a run.
   */
  readonly ruleErrors: readonly string[];
}

/** A rule with its regex compiled exactly once (Requirement 15.14). */
interface CompiledRule {
  readonly kind: RedactionRule['kind'];
  readonly value: string;
  readonly replace: 'mask' | 'hash' | 'drop';
  /** Present for `pattern` rules that compiled. */
  readonly regex?: RegExp;
  /** Pre-split `path` segments, `$`-prefix stripped. */
  readonly segments?: readonly string[];
  /** Lower-cased `key` value, so property-name matching ignores case. */
  readonly keyLower?: string;
}

/**
 * Builds a redactor. Compiles every `pattern` rule once and normalises `path`
 * rules to segment lists, so `scrub` does no parsing work per call.
 */
export function createRedactor(config: RedactionConfig = {}): Redactor {
  const ruleErrors: string[] = [];
  const rules = compileRules(config.rules ?? [], ruleErrors);

  // Longest-first so an overlapping pair of secrets always redacts the same way.
  const literals = new Set<string>();
  const noPersist = new Set(config.noPersistNodeIds ?? []);
  let literalsSorted: string[] = [];

  const rebuild = (): void => {
    literalsSorted = [...literals].sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0));
  };

  const addLiterals = (values: readonly string[]): void => {
    if (!values) return;
    let added = false;
    for (const value of values) {
      if (typeof value !== 'string' || value.length < MIN_SECRET_LEN) continue;
      if (literals.has(value)) continue;
      literals.add(value);
      added = true;
    }
    if (added) rebuild();
  };

  addLiterals(config.literals ?? []);

  const scrub = (value: string): string => {
    const text = typeof value === 'string' ? value : String(value ?? '');
    if (text.length === 0) return text;

    const withoutLiterals = scrubLiterals(text, literalsSorted);

    // Structural rules need JSON. Parse the literal-scrubbed text first; if the
    // replacement broke a document that WAS valid JSON (a literal spanning
    // structural characters), fall back to the original parse so structure
    // survives — literals are re-applied to every decoded string in the walk.
    const parsed = tryParseJson(withoutLiterals) ?? tryParseJson(text);
    if (parsed !== undefined) return stringifyWalked(parsed.value, rules, literalsSorted, withoutLiterals);

    const patterned = applyPatternsToText(withoutLiterals, rules);
    // A `drop` replacement can turn "prose plus JSON" into plain JSON. Walking it
    // now keeps `scrub(scrub(x)) === scrub(x)`, which a second call would
    // otherwise break by re-serialising the document.
    const late = tryParseJson(patterned);
    if (late !== undefined) return stringifyWalked(late.value, rules, literalsSorted, patterned);
    return patterned;
  };

  const event = (source: RunEvent): RunEvent => {
    if (!source || typeof source !== 'object') return source;
    const record = source as unknown as Record<string, unknown>;
    const nodeId = typeof record['nodeId'] === 'string' ? (record['nodeId'] as string) : undefined;
    const blank = nodeId !== undefined && noPersist.has(nodeId);
    const copy: Record<string, unknown> = {};

    for (const key of Object.keys(record)) {
      const raw = record[key];
      if ((PRESERVED_EVENT_FIELDS as readonly string[]).includes(key)) {
        copy[key] = raw;
        continue;
      }
      if (blank && (NO_PERSIST_FIELDS as readonly string[]).includes(key) && typeof raw === 'string') {
        copy[key] = NOT_PERSISTED;
        continue;
      }
      copy[key] = scrubEventValue(raw, scrub, 0);
    }
    return copy as unknown as RunEvent;
  };

  return {
    addLiterals,
    scrub,
    event,
    get ruleErrors() {
      return ruleErrors;
    },
  };
}

/** Walks a parsed document and re-serialises it; falls back to `text` on failure. */
function stringifyWalked(
  value: unknown,
  rules: readonly CompiledRule[],
  literals: readonly string[],
  fallback: string,
): string {
  try {
    return JSON.stringify(walk(value, '', 0, rules, literals)) ?? fallback;
  } catch {
    // Unreachable for parsed JSON, but `scrub` is total by contract.
    return fallback;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Rule compilation
// ─────────────────────────────────────────────────────────────────────────────

function compileRules(rules: readonly RedactionRule[], errors: string[]): CompiledRule[] {
  const compiled: CompiledRule[] = [];
  const list = Array.isArray(rules) ? rules : [];

  for (let i = 0; i < list.length; i++) {
    if (compiled.length >= MAX_REDACTION_RULES) {
      errors.push(`redaction rule ${i}: ignored, more than ${MAX_REDACTION_RULES} rules supplied`);
      continue;
    }
    const rule = list[i];
    if (!rule || typeof rule.value !== 'string' || rule.value.length === 0) {
      errors.push(`redaction rule ${i}: ignored, missing value`);
      continue;
    }
    if (rule.kind !== 'path' && rule.kind !== 'key' && rule.kind !== 'pattern') {
      errors.push(`redaction rule ${i}: ignored, unknown kind '${String(rule.kind)}'`);
      continue;
    }
    const replace = rule.replace ?? 'mask';

    if (rule.kind === 'pattern') {
      if (rule.value.length > MAX_PATTERN_SOURCE_LEN) {
        errors.push(
          `redaction rule ${i} (pattern): rejected, source is ${rule.value.length} characters, limit is ${MAX_PATTERN_SOURCE_LEN}`,
        );
        continue;
      }
      let regex: RegExp;
      try {
        regex = new RegExp(rule.value, 'g');
      } catch (error) {
        errors.push(
          `redaction rule ${i} (pattern): rejected, ${error instanceof Error ? error.message : 'invalid regular expression'}`,
        );
        continue;
      }
      compiled.push({ kind: 'pattern', value: rule.value, replace, regex });
      continue;
    }

    if (rule.kind === 'path') {
      compiled.push({ kind: 'path', value: rule.value, replace, segments: pathSegments(rule.value) });
      continue;
    }

    compiled.push({ kind: 'key', value: rule.value, replace, keyLower: rule.value.toLowerCase() });
  }

  return compiled;
}

/** `$.a.b[0].c` and `a.b.0.c` both normalise to `['a','b','0','c']`. */
function pathSegments(path: string): string[] {
  return path
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter((segment, index) => segment.length > 0 && !(index === 0 && segment === '$'));
}

// ─────────────────────────────────────────────────────────────────────────────
// Pass 1: literals
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Replaces every registered literal with {@link REDACTED}. Plain `split`/`join`
 * so no regex metacharacter in a secret can change the meaning of the pass, and
 * so a 1 MB input stays linear per literal.
 */
function scrubLiterals(text: string, literals: readonly string[]): string {
  let out = text;
  for (const literal of literals) {
    if (literal.length < MIN_SECRET_LEN) continue;
    if (!out.includes(literal)) continue;
    out = out.split(literal).join(REDACTED);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pass 2: structural walk
// ─────────────────────────────────────────────────────────────────────────────

interface Parsed {
  readonly value: unknown;
}

function tryParseJson(text: string): Parsed | undefined {
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;
  const first = trimmed[0] as string;
  // Cheap pre-filter: only containers are worth walking, and it keeps a bare
  // number or `true` from being rewritten by a JSON round trip.
  if (first !== '{' && first !== '[') return undefined;
  try {
    return { value: JSON.parse(trimmed) as unknown };
  } catch {
    return undefined;
  }
}

/**
 * Applies matching rules to every entry of a container, recursing while the depth
 * budget allows.
 *
 * Loop invariant: on entry `depth <= MAX_REDACT_DEPTH`, and every entry already
 * visited has had the first matching rule applied. Values below the depth cap are
 * returned untouched, so a hostile payload cannot drive unbounded recursion.
 */
function walk(
  node: unknown,
  path: string,
  depth: number,
  rules: readonly CompiledRule[],
  literals: readonly string[],
): unknown {
  if (depth > MAX_REDACT_DEPTH) return node;

  if (Array.isArray(node)) {
    const out: unknown[] = [];
    for (let i = 0; i < node.length; i++) {
      const childPath = joinPath(path, String(i));
      const replaced = applyRules(node[i], childPath, String(i), rules);
      // Arrays keep their length: a `drop` on an element becomes `null` rather
      // than a hole, so the scrubbed text still parses with the same shape.
      out.push(
        replaced.matched
          ? replaced.replace === 'drop'
            ? null
            : replaced.value
          : descend(node[i], childPath, depth, rules, literals),
      );
    }
    return out;
  }

  if (isPlainContainer(node)) {
    const source = node as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source)) {
      const childPath = joinPath(path, key);
      const replaced = applyRules(source[key], childPath, key, rules);
      if (replaced.matched) {
        if (replaced.replace === 'drop') continue;
        out[key] = replaced.value;
        continue;
      }
      out[key] = descend(source[key], childPath, depth, rules, literals);
    }
    return out;
  }

  return node;
}

function descend(
  child: unknown,
  childPath: string,
  depth: number,
  rules: readonly CompiledRule[],
  literals: readonly string[],
): unknown {
  if (isContainer(child)) {
    return depth + 1 > MAX_REDACT_DEPTH ? child : walk(child, childPath, depth + 1, rules, literals);
  }
  // A string value that matched no rule still gets the literal pass, this time
  // against the DECODED text, so a secret containing an escape sequence goes.
  return typeof child === 'string' ? scrubLiterals(child, literals) : child;
}

interface RuleOutcome {
  readonly matched: boolean;
  readonly replace: 'mask' | 'hash' | 'drop';
  readonly value: unknown;
}

const NO_MATCH: RuleOutcome = { matched: false, replace: 'mask', value: undefined };

/** First matching rule wins, in declaration order (Requirement 15.1). */
function applyRules(value: unknown, path: string, key: string, rules: readonly CompiledRule[]): RuleOutcome {
  if (isAlreadyRedacted(value)) return NO_MATCH;

  for (const rule of rules) {
    if (!matchesRule(rule, value, path, key)) continue;
    switch (rule.replace) {
      case 'drop':
        return { matched: true, replace: 'drop', value: undefined };
      case 'hash':
        return { matched: true, replace: 'hash', value: hashOf(value) };
      default:
        return { matched: true, replace: 'mask', value: REDACTED };
    }
  }
  return NO_MATCH;
}

function matchesRule(rule: CompiledRule, value: unknown, path: string, key: string): boolean {
  switch (rule.kind) {
    case 'path':
      return matchesPath(rule.segments ?? [], path);
    case 'key':
      return key.toLowerCase() === rule.keyLower;
    case 'pattern':
      return typeof value === 'string' && rule.regex !== undefined && matchesPattern(rule.regex, value);
    default:
      return false;
  }
}

/** Exact segment match, with `*` matching exactly one segment (any array index). */
function matchesPath(segments: readonly string[], path: string): boolean {
  if (segments.length === 0) return false;
  const actual = path.length === 0 ? [] : path.split('.');
  if (actual.length !== segments.length) return false;
  for (let i = 0; i < segments.length; i++) {
    const want = segments[i] as string;
    if (want !== '*' && want !== actual[i]) return false;
  }
  return true;
}

function joinPath(path: string, key: string): string {
  return path.length === 0 ? key : `${path}.${key}`;
}

/**
 * `fnv1a` over the canonical JSON form, so two values differing only in object
 * key order fingerprint identically (Requirement 15.9).
 */
function hashOf(value: unknown): string {
  try {
    return `${HASH_PREFIX}${fnv1a(canonicalJson(value))}`;
  } catch {
    return `${HASH_PREFIX}${fnv1a(String(value))}`;
  }
}

/** True for a value a previous `scrub` already replaced (keeps scrub idempotent). */
function isAlreadyRedacted(value: unknown): boolean {
  return typeof value === 'string' && (value === REDACTED || value === NOT_PERSISTED || value.startsWith(HASH_PREFIX));
}

function isContainer(value: unknown): boolean {
  return Array.isArray(value) || isPlainContainer(value);
}

function isPlainContainer(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ─────────────────────────────────────────────────────────────────────────────
// Pass 3: pattern rules on raw text
// ─────────────────────────────────────────────────────────────────────────────

/** Applies every `pattern` rule to text that is not JSON (Requirement 15.6). */
function applyPatternsToText(text: string, rules: readonly CompiledRule[]): string {
  let out = text;
  for (const rule of rules) {
    if (rule.kind !== 'pattern' || rule.regex === undefined) continue;
    out = replaceWithBudget(rule.regex, out, rule.replace);
  }
  return out;
}

/**
 * Replaces every match under a {@link PATTERN_MATCH_BUDGET_MS} budget. A rule that
 * exhausts its budget is abandoned for this input and the text is returned
 * unchanged, so the remaining rules still run and `scrub` still returns
 * (Requirement 15.15).
 */
function replaceWithBudget(regex: RegExp, text: string, replace: 'mask' | 'hash' | 'drop'): string {
  regex.lastIndex = 0;
  const started = Date.now();
  let out = '';
  let cursor = 0;
  let iterations = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    if (++iterations % 64 === 0 && Date.now() - started > PATTERN_MATCH_BUDGET_MS) {
      return text;
    }
    const found = match[0];
    if (found.length === 0) {
      // Zero-length match: step past it so the scan always terminates.
      regex.lastIndex = match.index + 1;
      if (match.index >= text.length) break;
      continue;
    }
    out += text.slice(cursor, match.index);
    out += isAlreadyRedacted(found) ? found : replacementFor(found, replace);
    cursor = match.index + found.length;
  }

  if (cursor === 0) return text;
  return out + text.slice(cursor);
}

function replacementFor(match: string, replace: 'mask' | 'hash' | 'drop'): string {
  switch (replace) {
    case 'drop':
      return '';
    case 'hash':
      return hashOf(match);
    default:
      return REDACTED;
  }
}

/**
 * Membership test used by `pattern` rules inside the JSON walk. A single regex
 * match is not interruptible in JavaScript, so the guards here are the compiled
 * source cap ({@link MAX_PATTERN_SOURCE_LEN}) and the iteration budget in
 * {@link replaceWithBudget}; the shared `g` regex has its cursor reset both sides
 * of the call so a rule never carries state between values.
 */
function matchesPattern(regex: RegExp, value: string): boolean {
  regex.lastIndex = 0;
  const hit = regex.test(value);
  regex.lastIndex = 0;
  return hit;
}

// ─────────────────────────────────────────────────────────────────────────────
// Event scrubbing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Scrubs every string reachable from an event field, preserving numbers, booleans
 * and the shape of `scope`. `type` and `nodeId` are handled by the caller and
 * never rewritten (Requirement 15.17).
 */
function scrubEventValue(value: unknown, scrub: (text: string) => string, depth: number): unknown {
  if (typeof value === 'string') return scrub(value);
  if (depth >= MAX_REDACT_DEPTH) return value;
  if (Array.isArray(value)) return value.map((item) => scrubEventValue(item, scrub, depth + 1));
  if (isPlainContainer(value)) {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source)) out[key] = scrubEventValue(source[key], scrub, depth + 1);
    return out;
  }
  return value;
}
