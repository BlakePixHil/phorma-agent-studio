/**
 * Workflow variables (document-delivery-primitives Requirement 1): validation,
 * resolution, template and expression access, and the precedence rule that a
 * payload can never shadow a configured value.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { compileExpression, type Json } from './expr.js';
import { interpolatePayload } from './payload.js';
import type { WorkflowVariable } from './types.js';
import {
  coerceVariableValue,
  expressionVariableReferences,
  looksLikeSecretVariableName,
  resolveWorkflowVariables,
  templateVariableReferences,
  validateWorkflowVariables,
  VARIABLE_VALUE_MAX_BYTES,
} from './variables.js';

const v = (name: string, type: WorkflowVariable['type'], value: WorkflowVariable['value']): WorkflowVariable => ({
  name,
  type,
  value,
});

describe('validateWorkflowVariables', () => {
  it('accepts a well-formed list', () => {
    expect(
      validateWorkflowVariables([
        v('limit', 'number', 20),
        v('dryRun', 'boolean', true),
        v('tags', 'list', ['a', 'b']),
        v('brief', 'markdown', '# Hi'),
        v('maxTokens', 'number', 400),
      ]),
    ).toEqual([]);
  });

  it.each([
    ['an invalid name', [v('9lives', 'text', 'x')], /invalid/],
    ['a duplicate name', [v('a', 'text', 'x'), v('a', 'text', 'y')], /more than once/],
    ['a type mismatch', [v('n', 'number', 'twenty')], /valid number/],
    ['an unknown type', [{ name: 'x', type: 'date', value: '' }], /usable type/],
    ['a credential name', [v('apiKey', 'text', 'abc')], /Connection/],
    ['a credential value', [v('note', 'text', 'use sk-ABCDEFGHIJKLMNOPQRSTUV')], /Connection/],
    ['a credential inside a list', [v('items', 'list', ['ok', 're_ABCDEFGHIJKLMNOPQR'])], /Connection/],
    ['an oversized value', [v('big', 'text', 'x'.repeat(VARIABLE_VALUE_MAX_BYTES + 1))], /limit/],
  ])('refuses %s', (_label, list, message) => {
    const issues = validateWorkflowVariables(list);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.map(issue => issue.message).join(' ')).toMatch(message);
  });

  it('never throws, whatever it is handed (Requirement 1.7)', () => {
    fc.assert(
      fc.property(fc.anything(), value => {
        expect(Array.isArray(validateWorkflowVariables(value))).toBe(true);
      }),
    );
  });

  it('names only compound credential words, not every "token"', () => {
    expect(looksLikeSecretVariableName('maxTokens')).toBe(false);
    expect(looksLikeSecretVariableName('authToken')).toBe(true);
    expect(looksLikeSecretVariableName('client_secret')).toBe(true);
  });
});

describe('resolveWorkflowVariables', () => {
  it('coerces hand-edited values and drops invalid ones', () => {
    expect(
      resolveWorkflowVariables({
        variables: [
          v('limit', 'number', '20' as unknown as number),
          v('on', 'boolean', 'true' as unknown as boolean),
          v('lines', 'list', 'a\n b \n\n c' as unknown as string[]),
          v('broken', 'number', 'NaN-ish'),
          v('password', 'text', 'hunter22'),
        ],
      }),
    ).toEqual({ limit: 20, on: true, lines: ['a', 'b', 'c'] });
  });

  it('returns an empty scope for absent settings', () => {
    expect(resolveWorkflowVariables(undefined)).toEqual({});
    expect(coerceVariableValue('list', 5)).toBeUndefined();
  });
});

describe('templates and expressions read vars (Requirements 1.4, 1.5)', () => {
  const scope = { vars: { name: 'Ada', limit: 3, tags: ['x', 'y'] } };

  it('renders strings raw and other values as JSON', () => {
    expect(interpolatePayload('{{vars.name}} {{vars.limit}} {{vars.tags}}', '{}', scope)).toBe(
      'Ada 3 ["x","y"]',
    );
  });

  it('leaves an unknown variable verbatim', () => {
    expect(interpolatePayload('{{vars.missing}}', '{}', scope)).toBe('{{vars.missing}}');
  });

  it('reads vars in an expression, including inside a sub-expression', () => {
    const ctx = { $: { rows: [1, 2, 3, 4, 5] } as Json, $text: '', nowMs: 0, vars: scope.vars };
    expect(compileExpression('vars.limit + 1').evaluate(ctx)).toBe(4);
    expect(compileExpression("filter($.rows, 'item <= vars.limit')").evaluate(ctx)).toEqual([1, 2, 3]);
    expect(compileExpression('vars.absent').evaluate({ ...ctx, vars: undefined })).toBeNull();
  });

  it('Requirement 1.6: a payload field named vars never shadows a variable', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (configured, injected) => {
        const payload = JSON.stringify({ vars: { flag: injected } });
        const vars = { flag: configured };
        expect(interpolatePayload('{{vars.flag}}', payload, { vars })).toBe(configured);
        const ctx = { $: JSON.parse(payload) as Json, $text: payload, nowMs: 0, vars };
        expect(compileExpression('vars.flag').evaluate(ctx)).toBe(configured);
        // The payload field stays reachable explicitly.
        expect(compileExpression('$.vars.flag').evaluate(ctx)).toBe(injected);
      }),
    );
  });
});

describe('reference scanning', () => {
  it('finds template and expression references', () => {
    expect(templateVariableReferences('Hi {{ vars.name }} and {{vars.tags.0}} {{name}}')).toEqual([
      'name',
      'tags',
    ]);
    expect(expressionVariableReferences("filter($.x, 'item > vars.min') && vars.on && $.vars.no")).toEqual([
      'min',
      'on',
    ]);
  });
});
