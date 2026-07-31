import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { RunEvent } from './events.js';
import {
  createRedactor,
  HASH_PREFIX,
  MIN_SECRET_LEN,
  NOT_PERSISTED,
  REDACTED,
} from './redact.js';
import { canonicalJson } from './state.js';
import type { RedactionRule } from './types.js';
import { jsonArb, runEventArb, type Json } from './test/generators.js';

/**
 * Property 7: Redaction removes every secret and is idempotent (design §10).
 *
 * 34. **Secret exclusion.** ∀ registered literal `s` with `len(s) ≥ MIN_SECRET_LEN`,
 *     ∀ input `x`: `s` does not occur in `scrub(x)`.
 * 35. **Idempotence.** ∀ `x`: `scrub(scrub(x)) === scrub(x)`.
 * 36. **Structure preservation.** ∀ JSON `x`: `scrub(x)` parses as JSON, and its
 *     shape differs from `x` only at paths matched by a rule.
 * 37. **Hash stability.** ∀ structurally equal `v`, `v'`: `hash`-replacement yields
 *     the same fingerprint.
 * 38. **Totality.** ∀ string `x` (including invalid JSON, lone surrogates, 1 MB
 *     inputs): `scrub` returns a string and never throws.
 * 39. **Event safety.** ∀ `RunEvent` `e`: `redactor.event(e)` has the same `type`
 *     and `nodeId`, and carries no field value containing a registered literal.
 *
 * **Validates: Requirements 15.3, 15.5, 15.7, 15.8, 15.9, 15.17**
 *
 * Two scoping notes on the generators, both following the requirement text rather
 * than narrowing the claims:
 *
 * - Secrets are injected at the sites a resolved connection value can actually
 *   reach a payload: whole string values, substrings of string values, and raw
 *   text. They are not injected as JSON *property names* (15.3 covers occurrences
 *   in text and inside escaped string values), and never into `type` / `nodeId`,
 *   which 15.17 requires to survive verbatim.
 * - Claim 35 quantifies over the INPUT, so the rule set is part of the fixture.
 *   Pattern sources are realistic credential shapes; a pattern crafted to match
 *   its own `hash` replacement is a configuration question, not an input.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Generators
// ─────────────────────────────────────────────────────────────────────────────

/** Property names the shared `jsonArb` draws from; `token` makes key rules fire. */
const DOC_KEYS = ['id', 'name', 'amount', 'status', 'nested', 'items', 'token'] as const;

const docArb = jsonArb({ maxDepth: 3, keys: DOC_KEYS });

/**
 * A registered secret. Both a plain ASCII form and a hostile form (quotes,
 * backslashes, control characters, lone surrogates) so the escape-spanning half
 * of Requirement 15.3 is exercised. Redaction markers are excluded: a marker
 * registered as a secret would be "found" in its own replacement.
 */
const secretArb: fc.Arbitrary<string> = fc
  .oneof(
    { weight: 2, arbitrary: fc.string({ minLength: MIN_SECRET_LEN, maxLength: 32 }) },
    {
      weight: 1,
      arbitrary: fc.string({ unit: 'binary', minLength: MIN_SECRET_LEN, maxLength: 24 }),
    },
    {
      weight: 1,
      arbitrary: fc
        .string({ minLength: 4, maxLength: 12 })
        .map((tail) => `sk-live_"${tail}\\n${tail}`),
    },
  )
  .filter(
    (secret) =>
      secret.length >= MIN_SECRET_LEN &&
      !REDACTED.includes(secret) &&
      !NOT_PERSISTED.includes(secret) &&
      !HASH_PREFIX.includes(secret),
  );

const secretsArb: fc.Arbitrary<string[]> = fc.array(secretArb, { minLength: 1, maxLength: 3 });

const replaceArb = fc.constantFrom<'mask' | 'hash' | 'drop'>('mask', 'hash', 'drop');

const KEY_RULE_VALUES = ['token', 'Token', 'TOKEN', 'secret', 'amount'] as const;
const PATH_RULE_VALUES = ['$.token', '$.nested.token', '$.items[0]', '$.items.*', 'name'] as const;
/** Realistic credential shapes, all well under MAX_PATTERN_SOURCE_LEN. */
const PATTERN_RULE_VALUES = [
  'sk-[A-Za-z0-9]{8,}',
  'Bearer [A-Za-z0-9._-]{10,}',
  '[0-9]{4}-[0-9]{4}-[0-9]{4}-[0-9]{4}',
  '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}',
] as const;

const keyRuleArb: fc.Arbitrary<RedactionRule> = fc.record({
  kind: fc.constant('key' as const),
  value: fc.constantFrom(...KEY_RULE_VALUES),
  replace: replaceArb,
});

const pathRuleArb: fc.Arbitrary<RedactionRule> = fc.record({
  kind: fc.constant('path' as const),
  value: fc.constantFrom(...PATH_RULE_VALUES),
  replace: replaceArb,
});

const patternRuleArb: fc.Arbitrary<RedactionRule> = fc.record({
  kind: fc.constant('pattern' as const),
  value: fc.constantFrom(...PATTERN_RULE_VALUES),
  replace: replaceArb,
});

/** `path` and `key` rules only — the two kinds the structural walk applies. */
const structuralRulesArb: fc.Arbitrary<RedactionRule[]> = fc.array(
  fc.oneof(keyRuleArb, pathRuleArb),
  { maxLength: 4 },
);

const anyRulesArb: fc.Arbitrary<RedactionRule[]> = fc.array(
  fc.oneof(keyRuleArb, pathRuleArb, patternRuleArb),
  { maxLength: 4 },
);

/** Deterministic PRNG, so a shrunk counterexample replays exactly. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Places secrets into string leaves of a document, whole or as a substring. */
function sprinkleSecrets(value: Json, secrets: readonly string[], rand: () => number): Json {
  if (Array.isArray(value)) return value.map((item) => sprinkleSecrets(item, secrets, rand));
  if (value !== null && typeof value === 'object') {
    const out: { [key: string]: Json } = {};
    for (const [key, child] of Object.entries(value)) {
      out[key] = sprinkleSecrets(child as Json, secrets, rand);
    }
    return out;
  }
  if (typeof value === 'string' && secrets.length > 0 && rand() < 0.7) {
    const secret = secrets[Math.floor(rand() * secrets.length)] as string;
    return rand() < 0.5 ? secret : `prefix ${secret} suffix`;
  }
  return value;
}

/** Reorders every object's own keys at every depth; array order is preserved. */
function permuteKeys(value: Json, rand: () => number): Json {
  if (Array.isArray(value)) return value.map((item) => permuteKeys(item, rand));
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value);
    for (let i = keys.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [keys[i], keys[j]] = [keys[j] as string, keys[i] as string];
    }
    const out: { [key: string]: Json } = {};
    for (const key of keys) out[key] = permuteKeys((value as { [key: string]: Json })[key] as Json, rand);
    return out;
  }
  return value;
}

/** Every string reachable from a value, including property names. */
function reachableStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') {
    out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) reachableStrings(item, out);
    return out;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out.push(key);
      reachableStrings(child, out);
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Claim 34: secret exclusion
// ─────────────────────────────────────────────────────────────────────────────

describe('Property 7 claim 34: no registered secret survives scrub', () => {
  it('removes every secret from a JSON document, including escaped occurrences', () => {
    fc.assert(
      fc.property(secretsArb, docArb, fc.integer(), anyRulesArb, (secrets, doc, seed, rules) => {
        const redactor = createRedactor({ rules });
        redactor.addLiterals(secrets);
        // Guaranteed carriers plus opportunistic ones in the generated document.
        const payload: Json = {
          evidence: secrets as Json,
          note: `see ${secrets[0] as string} for detail`,
          payload: sprinkleSecrets(doc, secrets, mulberry32(seed)),
        };
        const text = JSON.stringify(payload);
        // Sanity check on the decoded form: a secret needing JSON escapes (NUL,
        // quote, lone surrogate) is present as a VALUE even when the raw text
        // holds it escaped — which is exactly the case 15.3 calls out.
        const carried = reachableStrings(JSON.parse(text) as unknown);
        for (const secret of secrets) {
          expect(carried.some((found) => found.includes(secret))).toBe(true);
        }

        const scrubbed = redactor.scrub(text);
        for (const secret of secrets) {
          // Not in the raw text, and not in any decoded string either.
          expect(scrubbed.includes(secret)).toBe(false);
          for (const found of reachableStrings(JSON.parse(scrubbed) as unknown)) {
            expect(found.includes(secret)).toBe(false);
          }
        }
      }),
    );
  });

  it('removes every secret from text that is not JSON', () => {
    fc.assert(
      fc.property(
        secretsArb,
        fc.string({ maxLength: 40 }),
        fc.string({ maxLength: 40 }),
        anyRulesArb,
        (secrets, head, tail, rules) => {
          const redactor = createRedactor({ rules, literals: secrets });
          const text = `${head}${secrets.join(' | ')}${tail}`;
          const scrubbed = redactor.scrub(text);
          for (const secret of secrets) expect(scrubbed.includes(secret)).toBe(false);
        },
      ),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Claim 35: idempotence
// ─────────────────────────────────────────────────────────────────────────────

describe('Property 7 claim 35: scrub is idempotent', () => {
  it('holds scrub(scrub(x)) === scrub(x) for JSON documents', () => {
    fc.assert(
      fc.property(secretsArb, docArb, fc.integer(), anyRulesArb, (secrets, doc, seed, rules) => {
        const redactor = createRedactor({ rules, literals: secrets });
        const text = JSON.stringify(sprinkleSecrets(doc, secrets, mulberry32(seed)));
        const once = redactor.scrub(text);
        expect(redactor.scrub(once)).toBe(once);
      }),
    );
  });

  it('holds scrub(scrub(x)) === scrub(x) for arbitrary text', () => {
    fc.assert(
      fc.property(
        secretsArb,
        fc.oneof(
          fc.string({ maxLength: 200 }),
          fc.string({ unit: 'binary', maxLength: 120 }),
          fc.constantFrom(
            '{"token":"sk-ABCDEFGHIJ"}',
            'contact a@b.co and card 1234-5678-9012-3456',
            'Bearer abcdefghijklmnop trailing prose',
            '{"a":[{"b":',
            '[1,2,3',
            '',
          ),
        ),
        anyRulesArb,
        (secrets, text, rules) => {
          const redactor = createRedactor({ rules, literals: secrets });
          const once = redactor.scrub(text);
          expect(redactor.scrub(once)).toBe(once);
        },
      ),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Claim 36: structure preservation
// ─────────────────────────────────────────────────────────────────────────────

/** `$.a.b[0]` and `a.b.0` both normalise to `['a','b','0']` (mirrors §10). */
function ruleSegments(path: string): string[] {
  return path
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter((segment, index) => segment.length > 0 && !(index === 0 && segment === '$'));
}

function kindOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/** path → kind for every node of a parsed document, root keyed by `''`. */
function shapeOf(value: unknown, path = '', out = new Map<string, string>()): Map<string, string> {
  out.set(path, kindOf(value));
  if (Array.isArray(value)) {
    value.forEach((item, i) => shapeOf(item, path === '' ? String(i) : `${path}.${i}`, out));
  } else if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      shapeOf(child, path === '' ? key : `${path}.${key}`, out);
    }
  }
  return out;
}

function alreadyRedacted(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    (value === REDACTED || value === NOT_PERSISTED || value.startsWith(HASH_PREFIX))
  );
}

/** Independent oracle for "this path is matched by a rule" (key/path rules). */
function collectMatched(
  value: unknown,
  path: string,
  rules: readonly RedactionRule[],
  out = new Set<string>(),
): Set<string> {
  const visit = (child: unknown, key: string, childPath: string): void => {
    if (!alreadyRedacted(child) && matchesAnyRule(rules, key, childPath)) {
      out.add(childPath);
      return;
    }
    collectMatched(child, childPath, rules, out);
  };

  if (Array.isArray(value)) {
    value.forEach((item, i) => visit(item, String(i), path === '' ? String(i) : `${path}.${i}`));
  } else if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      visit(child, key, path === '' ? key : `${path}.${key}`);
    }
  }
  return out;
}

function matchesAnyRule(rules: readonly RedactionRule[], key: string, path: string): boolean {
  return rules.some((rule) => {
    if (rule.kind === 'key') return key.toLowerCase() === rule.value.toLowerCase();
    if (rule.kind !== 'path') return false;
    const want = ruleSegments(rule.value);
    const actual = path.length === 0 ? [] : path.split('.');
    if (want.length === 0 || want.length !== actual.length) return false;
    return want.every((segment, i) => segment === '*' || segment === actual[i]);
  });
}

/** True when `path` is itself matched or sits under a matched ancestor. */
function underMatched(path: string, matched: ReadonlySet<string>): boolean {
  const segments = path.split('.');
  for (let i = 1; i <= segments.length; i++) {
    if (matched.has(segments.slice(0, i).join('.'))) return true;
  }
  return false;
}

describe('Property 7 claim 36: structure survives redaction outside matched paths', () => {
  it('returns parseable JSON whose shape differs only at rule-matched paths', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.dictionary(fc.constantFrom(...DOC_KEYS), docArb, { maxKeys: 5 }) as fc.Arbitrary<Json>,
          fc.array(docArb, { maxLength: 5 }) as fc.Arbitrary<Json>,
        ),
        structuralRulesArb,
        secretsArb,
        (doc, rules, secrets) => {
          const redactor = createRedactor({ rules, literals: secrets });
          const text = JSON.stringify(doc);
          const scrubbed = redactor.scrub(text);

          // Parses as JSON (Requirement 15.5).
          const output = JSON.parse(scrubbed) as unknown;
          const input = JSON.parse(text) as unknown;

          const matched = collectMatched(input, '', rules);
          const before = shapeOf(input);
          const after = shapeOf(output);

          for (const [path, kind] of before) {
            if (underMatched(path, matched)) continue;
            expect(after.get(path)).toBe(kind);
          }
          for (const path of after.keys()) {
            if (underMatched(path, matched)) continue;
            expect(before.has(path)).toBe(true);
          }
        },
      ),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Claim 37: hash stability
// ─────────────────────────────────────────────────────────────────────────────

describe('Property 7 claim 37: hash replacement is stable under key reordering', () => {
  it('fingerprints two key permutations of the same value identically', () => {
    fc.assert(
      fc.property(docArb, fc.integer(), (value, seed) => {
        const redactor = createRedactor({ rules: [{ kind: 'key', value: 'token', replace: 'hash' }] });
        const permuted = permuteKeys(value, mulberry32(seed));
        expect(canonicalJson(permuted)).toBe(canonicalJson(value));

        const fingerprint = (candidate: Json): unknown =>
          (JSON.parse(redactor.scrub(JSON.stringify({ token: candidate }))) as { token?: unknown })
            .token;

        const left = fingerprint(value);
        const right = fingerprint(permuted);
        expect(typeof left).toBe('string');
        expect(String(left).startsWith(HASH_PREFIX)).toBe(true);
        expect(right).toBe(left);
      }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Claim 38: totality
// ─────────────────────────────────────────────────────────────────────────────

describe('Property 7 claim 38: scrub is total', () => {
  it('returns a string for any input, valid JSON or not', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string({ maxLength: 300 }),
          fc.string({ unit: 'binary', maxLength: 200 }),
          fc.constantFrom(
            '',
            '   ',
            '{',
            '{"a":',
            '[[[[',
            'null',
            '\ud800',
            '\udfff lone trailing surrogate',
            '{"a":"\ud83d\ude00"}',
          ),
        ),
        anyRulesArb,
        secretsArb,
        (text, rules, secrets) => {
          const redactor = createRedactor({ rules, literals: secrets });
          const scrubbed = redactor.scrub(text);
          expect(typeof scrubbed).toBe('string');
        },
      ),
    );
  });

  it('handles a 1 MB input within the 1000 ms budget', () => {
    const secret = 'sk-live-0123456789abcdef';
    const redactor = createRedactor({
      rules: [{ kind: 'pattern', value: '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}' }],
      literals: [secret],
    });
    const chunk = `lorem ipsum ${secret} dolor sit amet person@example.com `;
    let text = '';
    while (text.length < 1_048_576) text += chunk;
    text = text.slice(0, 1_048_576);

    const started = Date.now();
    const scrubbed = redactor.scrub(text);
    const elapsed = Date.now() - started;

    expect(typeof scrubbed).toBe('string');
    expect(scrubbed.includes(secret)).toBe(false);
    expect(elapsed).toBeLessThan(1000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Claim 39: event safety
// ─────────────────────────────────────────────────────────────────────────────

/** Appends a secret to string fields, leaving `type` and `nodeId` untouched. */
function injectIntoEvent(event: RunEvent, secret: string, rand: () => number): RunEvent {
  const record = event as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    out[key] = key === 'type' || key === 'nodeId' ? value : injectIntoValue(value, secret, rand);
  }
  return out as unknown as RunEvent;
}

function injectIntoValue(value: unknown, secret: string, rand: () => number): unknown {
  if (typeof value === 'string') return rand() < 0.7 ? `${value}${secret}` : value;
  if (Array.isArray(value)) return value.map((item) => injectIntoValue(item, secret, rand));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out[key] = injectIntoValue(child, secret, rand);
    }
    return out;
  }
  return value;
}

describe('Property 7 claim 39: events keep their identity and carry no secret', () => {
  it('preserves type and nodeId while removing every registered literal', () => {
    fc.assert(
      fc.property(runEventArb, secretArb, fc.integer(), anyRulesArb, (event, secret, seed, rules) => {
        const identity = event as unknown as Record<string, unknown>;
        // 15.17 keeps `type`/`nodeId` verbatim, so a literal that happens to be a
        // substring of one of them is out of scope for this claim.
        fc.pre(!String(identity['type'] ?? '').includes(secret));
        fc.pre(!String(identity['nodeId'] ?? '').includes(secret));

        const redactor = createRedactor({ rules, literals: [secret] });
        const carrier = injectIntoEvent(event, secret, mulberry32(seed));
        const redacted = redactor.event(carrier) as unknown as Record<string, unknown>;
        const source = carrier as unknown as Record<string, unknown>;

        // Requirement 15.17.
        expect(redacted['type']).toBe(source['type']);
        expect(redacted['nodeId']).toBe(source['nodeId']);
        expect(Object.keys(redacted).sort()).toEqual(Object.keys(source).sort());

        for (const found of reachableStrings(redacted)) {
          expect(found.includes(secret)).toBe(false);
        }
      }),
    );
  });
});
