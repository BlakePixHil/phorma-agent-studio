import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  HASH_PREFIX,
  MAX_PATTERN_SOURCE_LEN,
  MAX_REDACT_DEPTH,
  MAX_REDACTION_RULES,
  MIN_SECRET_LEN,
  REDACTED,
  createRedactor,
} from './redact.js';
import type { RedactionRule } from './types.js';

/**
 * Rule kinds and the redaction budgets (Requirements 15.4, 15.5, 15.15, 15.16).
 *
 * Construction never throws: a rejected rule lands on `Redactor.ruleErrors` and
 * every other rule still applies, so these tests assert on that list rather than
 * on a thrown error.
 *
 * The match-budget case drives `Date.now` explicitly. A genuine 100 ms regex
 * blow-up is machine-dependent and would make the suite slow and flaky; the
 * budget check itself is what is under test, so the clock is the only thing
 * substituted, and the real matcher still runs over real input.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

/** Wraps `depth` nested objects around `leaf`, so `leaf`'s keys sit at that depth. */
function nest(depth: number, leaf: unknown): unknown {
  let node: unknown = leaf;
  for (let i = 0; i < depth; i++) node = { next: node };
  return node;
}

function parse(text: string): unknown {
  return JSON.parse(text) as unknown;
}

// ─────────────────────────────────────────────────────────────────────────────
// Rule kinds
// ─────────────────────────────────────────────────────────────────────────────

describe('rule kinds (15.1)', () => {
  it('matches a key rule regardless of property-name case', () => {
    const redactor = createRedactor({ rules: [{ kind: 'key', value: 'apikey' }] });

    const out = parse(redactor.scrub(JSON.stringify({ ApiKey: 'live-value', other: 'kept' })));

    expect(out).toEqual({ ApiKey: REDACTED, other: 'kept' });
  });

  it('matches a path rule only at the addressed location', () => {
    const redactor = createRedactor({ rules: [{ kind: 'path', value: '$.user.token' }] });

    const out = parse(
      redactor.scrub(JSON.stringify({ user: { token: 'a', name: 'ada' }, token: 'top-level' })),
    );

    expect(out).toEqual({ user: { token: REDACTED, name: 'ada' }, token: 'top-level' });
  });

  it('matches one segment per `*` in a path rule, including array indexes', () => {
    const redactor = createRedactor({ rules: [{ kind: 'path', value: 'items.*.token' }] });

    const out = parse(
      redactor.scrub(
        JSON.stringify({ items: [{ token: 'a' }, { token: 'b', keep: 1 }], token: 'top-level' }),
      ),
    );

    expect(out).toEqual({
      items: [{ token: REDACTED }, { token: REDACTED, keep: 1 }],
      token: 'top-level',
    });
  });

  it('matches a pattern rule against string values inside JSON', () => {
    const redactor = createRedactor({ rules: [{ kind: 'pattern', value: 'sk-[a-z0-9]+' }] });

    const out = parse(redactor.scrub(JSON.stringify({ key: 'sk-abc123', count: 4 })));

    expect(out).toEqual({ key: REDACTED, count: 4 });
  });

  it('applies each replacement mode: mask, hash and drop', () => {
    const redactor = createRedactor({
      rules: [
        { kind: 'key', value: 'masked', replace: 'mask' },
        { kind: 'key', value: 'hashed', replace: 'hash' },
        { kind: 'key', value: 'dropped', replace: 'drop' },
      ],
    });

    const out = parse(
      redactor.scrub(JSON.stringify({ masked: 'a', hashed: 'b', dropped: 'c', keep: 'd' })),
    ) as Record<string, unknown>;

    expect(out['masked']).toBe(REDACTED);
    expect(String(out['hashed'])).toMatch(new RegExp(`^${HASH_PREFIX}`));
    expect('dropped' in out).toBe(false);
    expect(out['keep']).toBe('d');
  });

  it('replaces a dropped array element with null so the shape survives', () => {
    const redactor = createRedactor({ rules: [{ kind: 'key', value: '1', replace: 'drop' }] });

    const out = parse(redactor.scrub(JSON.stringify(['a', 'b', 'c'])));

    expect(out).toEqual(['a', null, 'c']);
  });

  it('applies the first matching rule in declaration order', () => {
    const redactor = createRedactor({
      rules: [
        { kind: 'key', value: 'token', replace: 'mask' },
        { kind: 'key', value: 'token', replace: 'drop' },
      ],
    });

    expect(parse(redactor.scrub(JSON.stringify({ token: 'a' })))).toEqual({ token: REDACTED });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 15.4 Short literals pass through
// ─────────────────────────────────────────────────────────────────────────────

describe('short literals (15.4)', () => {
  it('leaves a literal shorter than 8 characters unchanged and still applies the rest', () => {
    const redactor = createRedactor({ literals: ['short', 'LONG-SECRET-VALUE'] });

    const out = redactor.scrub('short LONG-SECRET-VALUE short');

    expect(out).toBe(`short ${REDACTED} short`);
  });

  it('redacts a literal of exactly the minimum length', () => {
    const literal = 'a'.repeat(MIN_SECRET_LEN);
    const redactor = createRedactor({ literals: [literal] });

    expect(redactor.scrub(`value=${literal}`)).toBe(`value=${REDACTED}`);
  });

  it('ignores a short literal added at run time and keeps redacting the long ones', () => {
    const redactor = createRedactor();
    redactor.addLiterals(['pw', 'RUNTIME-SECRET-1']);

    expect(redactor.scrub('pw=pw token=RUNTIME-SECRET-1')).toBe(`pw=pw token=${REDACTED}`);
  });

  it('still applies structural rules when the only literal is too short', () => {
    const redactor = createRedactor({
      literals: ['abc'],
      rules: [{ kind: 'key', value: 'token' }],
    });

    const out = parse(redactor.scrub(JSON.stringify({ token: 'abc', note: 'abc' })));

    expect(out).toEqual({ token: REDACTED, note: 'abc' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 15.5 Depth cut-off
// ─────────────────────────────────────────────────────────────────────────────

describe('structural depth cap (15.5)', () => {
  const rules: readonly RedactionRule[] = [{ kind: 'key', value: 'secret' }];

  it('redacts a key sitting at exactly the depth cap', () => {
    const redactor = createRedactor({ rules });
    const input = JSON.stringify(nest(MAX_REDACT_DEPTH, { secret: 'value' }));

    const text = redactor.scrub(input);

    expect(text).toContain(REDACTED);
    expect(text).not.toContain('value');
  });

  it('leaves a key nested deeper than the cap structurally unchanged', () => {
    const redactor = createRedactor({ rules });
    const input = JSON.stringify(nest(MAX_REDACT_DEPTH + 1, { secret: 'value' }));

    const text = redactor.scrub(input);

    expect(text).not.toContain(REDACTED);
    expect(parse(text)).toEqual(parse(input));
  });

  it('returns text that still parses as JSON for a document deeper than the cap', () => {
    const redactor = createRedactor({ rules });
    const input = JSON.stringify(nest(MAX_REDACT_DEPTH + 20, { secret: 'value', keep: [1, 2] }));

    expect(() => parse(redactor.scrub(input))).not.toThrow();
  });

  it('redacts shallow matches in a document that also nests past the cap', () => {
    const redactor = createRedactor({ rules });
    const input = JSON.stringify({
      secret: 'shallow',
      deep: nest(MAX_REDACT_DEPTH + 5, { secret: 'buried' }),
    });

    const out = parse(redactor.scrub(input)) as Record<string, unknown>;

    expect(out['secret']).toBe(REDACTED);
    expect(JSON.stringify(out['deep'])).toContain('buried');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 15.15 Exhausted match budget
// ─────────────────────────────────────────────────────────────────────────────

describe('pattern match budget (15.15)', () => {
  const rules: readonly RedactionRule[] = [
    { kind: 'pattern', value: 'z' },
    { kind: 'pattern', value: 'SECRETTOKEN' },
  ];
  const input = `${'z'.repeat(200)} token=SECRETTOKEN`;

  it('applies both pattern rules while the budget holds', () => {
    const out = createRedactor({ rules }).scrub(input);

    expect(out).not.toContain('z');
    expect(out).toContain(`token=${REDACTED}`);
  });

  it('abandons the rule that exhausts its budget, applies the rest and returns a string', () => {
    // First reading starts the budget; every later reading is past it.
    let readings = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => (readings++ === 0 ? 0 : 10_000));

    const out = createRedactor({ rules }).scrub(input);

    expect(typeof out).toBe('string');
    expect(out).toContain('z'.repeat(200));
    expect(out).toContain(`token=${REDACTED}`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 15.16 Rejected rules
// ─────────────────────────────────────────────────────────────────────────────

describe('rejected rules (15.16)', () => {
  it('rejects a pattern source over the length cap and reports the rule index', () => {
    const oversized = 'a'.repeat(MAX_PATTERN_SOURCE_LEN + 1);
    const redactor = createRedactor({
      rules: [
        { kind: 'key', value: 'keep-working' },
        { kind: 'pattern', value: oversized },
      ],
    });

    expect(redactor.ruleErrors).toHaveLength(1);
    expect(redactor.ruleErrors[0]).toContain('rule 1');
    expect(redactor.ruleErrors[0]).toContain(String(MAX_PATTERN_SOURCE_LEN));
  });

  it('keeps applying the surviving rules after a rejection', () => {
    const redactor = createRedactor({
      rules: [
        { kind: 'pattern', value: 'a'.repeat(MAX_PATTERN_SOURCE_LEN + 1) },
        { kind: 'key', value: 'token' },
      ],
    });

    const out = parse(redactor.scrub(JSON.stringify({ token: 'live', keep: 'kept' })));

    expect(out).toEqual({ token: REDACTED, keep: 'kept' });
  });

  it('accepts a pattern source at exactly the length cap', () => {
    const atCap = 'a'.repeat(MAX_PATTERN_SOURCE_LEN);
    const redactor = createRedactor({ rules: [{ kind: 'pattern', value: atCap }] });

    expect(redactor.ruleErrors).toEqual([]);
    expect(redactor.scrub(atCap)).toBe(REDACTED);
  });

  it('rejects an uncompilable pattern source without throwing at construction', () => {
    const redactor = createRedactor({ rules: [{ kind: 'pattern', value: '([unclosed' }] });

    expect(redactor.ruleErrors).toHaveLength(1);
    expect(redactor.ruleErrors[0]).toContain('rule 0');
    expect(redactor.scrub('plain text')).toBe('plain text');
  });

  it('ignores rules past the rule-count cap and reports each one', () => {
    const rules: RedactionRule[] = [];
    for (let i = 0; i < MAX_REDACTION_RULES; i++) rules.push({ kind: 'key', value: `k${i}` });
    rules.push({ kind: 'key', value: 'over-the-cap' });

    const redactor = createRedactor({ rules });

    expect(redactor.ruleErrors).toHaveLength(1);
    expect(redactor.ruleErrors[0]).toContain(String(MAX_REDACTION_RULES));
    const out = parse(redactor.scrub(JSON.stringify({ k0: 'a', 'over-the-cap': 'b' })));
    expect(out).toEqual({ k0: REDACTED, 'over-the-cap': 'b' });
  });
});
