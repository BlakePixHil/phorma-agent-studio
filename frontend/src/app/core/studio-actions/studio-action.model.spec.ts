import {
  actionFail,
  actionOk,
  argList,
  argNum,
  argStr,
  toolDefinitionOf,
  validateArgs,
  type StudioAction,
} from './studio-action.model';

function action(overrides: Partial<StudioAction> = {}): StudioAction {
  return {
    id: 'test_action',
    label: 'Test action',
    description: 'A test action.',
    surface: 'evals',
    access: 'write',
    risk: 'silent',
    run: () => actionOk(),
    ...overrides,
  };
}

describe('validateArgs', () => {
  it('accepts declared params and drops unknown extras', () => {
    const result = validateArgs(
      action({
        params: {
          name: { type: 'string', description: 'Name.', required: true },
          count: { type: 'number', description: 'Count.' },
        },
      }),
      { name: 'Smoke', count: 3, chatter: 'ignored' },
    );
    expect(result.ok).toBeTrue();
    if (!result.ok) return;
    expect(result.args).toEqual({ name: 'Smoke', count: 3 });
  });

  it('names the missing required parameter', () => {
    const result = validateArgs(
      action({ params: { suiteId: { type: 'string', description: 'Id.', required: true } } }),
      {},
    );
    expect(result.ok).toBeFalse();
    if (result.ok) return;
    expect(result.message).toContain("'suiteId'");
    expect(result.message).toContain('required');
  });

  it('names the parameter whose type is wrong', () => {
    const result = validateArgs(
      action({ params: { limit: { type: 'number', description: 'Limit.' } } }),
      { limit: 'lots' },
    );
    expect(result.ok).toBeFalse();
    if (result.ok) return;
    expect(result.message).toContain("'limit'");
    expect(result.message).toContain('number');
  });

  it('coerces stringified numbers and booleans, because providers stringify args', () => {
    const result = validateArgs(
      action({
        params: {
          limit: { type: 'number', description: 'Limit.' },
          approved: { type: 'boolean', description: 'Approved.' },
        },
      }),
      { limit: '12', approved: 'false' },
    );
    expect(result.ok).toBeTrue();
    if (!result.ok) return;
    expect(argNum(result.args, 'limit')).toBe(12);
    expect(result.args['approved']).toBeFalse();
  });

  it('rejects a value outside a declared enum', () => {
    const result = validateArgs(
      action({
        params: {
          matcher: { type: 'string', description: 'Matcher.', enum: ['exact', 'contains'] },
        },
      }),
      { matcher: 'vibes' },
    );
    expect(result.ok).toBeFalse();
    if (result.ok) return;
    expect(result.message).toContain('exact, contains');
  });

  it('keeps an empty string, so a value can be cleared', () => {
    const result = validateArgs(
      action({ params: { note: { type: 'string', description: 'Note.' } } }),
      { note: '' },
    );
    expect(result.ok).toBeTrue();
    if (!result.ok) return;
    expect(result.args['note']).toBe('');
    // argStr treats empty as absent, which is what name-like params want.
    expect(argStr(result.args, 'note')).toBeUndefined();
  });

  it('accepts any type for an `any` param', () => {
    const target = action({ params: { value: { type: 'any', description: 'Value.' } } });
    for (const value of [true, 42, 'text']) {
      const result = validateArgs(target, { value });
      expect(result.ok).withContext(String(value)).toBeTrue();
    }
  });

  it('rejects a non-object argument payload', () => {
    const result = validateArgs(action(), ['nope']);
    expect(result.ok).toBeFalse();
  });

  it('reads string lists', () => {
    const result = validateArgs(
      action({ params: { tags: { type: 'string[]', description: 'Tags.' } } }),
      { tags: ['a', 'b'] },
    );
    expect(result.ok).toBeTrue();
    if (!result.ok) return;
    expect(argList(result.args, 'tags')).toEqual(['a', 'b']);
  });
});

describe('toolDefinitionOf', () => {
  it('derives the tool name, description and schema from the registry entry', () => {
    const definition = toolDefinitionOf(
      action({
        id: 'eval_add_case',
        description: 'Adds a case.',
        params: {
          suiteId: { type: 'string', description: 'Suite id.', required: true },
          tags: { type: 'string[]', description: 'Tags.' },
          matcher: { type: 'string', description: 'Matcher.', enum: ['exact'] },
        },
      }),
    );
    expect(definition.name).toBe('eval_add_case');
    expect(definition.description).toBe('Adds a case.');
    const parameters = definition.parameters as {
      type: string;
      properties: Record<string, Record<string, unknown>>;
      required: string[];
    };
    expect(parameters.type).toBe('object');
    expect(parameters.required).toEqual(['suiteId']);
    expect(parameters.properties['tags']).toEqual({
      description: 'Tags.',
      type: 'array',
      items: { type: 'string' },
    });
    expect(parameters.properties['matcher']['enum']).toEqual(['exact']);
    // An `any` param stays untyped so providers accept string, number or boolean.
    const loose = toolDefinitionOf(
      action({ params: { value: { type: 'any', description: 'Value.' } } }),
    );
    const looseParams = loose.parameters as { properties: Record<string, Record<string, unknown>> };
    expect(looseParams.properties['value']).toEqual({ description: 'Value.' });
  });

  it('emits an empty schema for a no-parameter action', () => {
    const definition = toolDefinitionOf(action({ params: undefined }));
    expect(definition.parameters).toEqual({ type: 'object', properties: {}, required: [] });
  });
});

describe('action results', () => {
  it('carries a single-sentence message on failure', () => {
    expect(actionFail('Suite not found.')).toEqual({ ok: false, message: 'Suite not found.' });
  });

  it('omits data when none is given', () => {
    expect(actionOk()).toEqual({ ok: true });
    expect(actionOk({ suiteId: 's1' }, { revertable: false })).toEqual({
      ok: true,
      data: { suiteId: 's1' },
      revertable: false,
    });
  });
});
