import { describe, expect, it } from 'vitest';

import {
  buildWireRequest,
  createStreamParser,
  supportsReasoningRequest,
  type ModelChunk,
  type ModelRequest,
} from './model.js';

/**
 * Visible reasoning ("thinking") for the assistant chat: how each adapter asks
 * for it, and how the reasoning state a provider needs back on the next tool
 * round is captured from the stream and replayed verbatim.
 */
function request(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return {
    provider: 'anthropic',
    model: 'claude-sonnet-5',
    system: 'system',
    messages: [{ role: 'user', content: 'hello' }],
    temperature: 0.4,
    maxTokens: 4096,
    ...overrides,
  };
}

function body(req: ModelRequest): Record<string, unknown> {
  return JSON.parse(buildWireRequest(req).body) as Record<string, unknown>;
}

function parse(req: ModelRequest, lines: string[]): ModelChunk[] {
  const parser = createStreamParser(req);
  const chunks = lines.flatMap(line => parser.push(line));
  return [...chunks, ...parser.end()];
}

describe('supportsReasoningRequest', () => {
  it.each([
    ['openrouter', 'deepseek/deepseek-r1'],
    ['phorma-cloud', 'anthropic/claude-sonnet-5'],
    ['anthropic', 'claude-sonnet-5'],
    ['anthropic', 'claude-opus-4-6'],
    ['anthropic', 'claude-sonnet-4-5'],
    ['anthropic', 'claude-3-7-sonnet-latest'],
  ] as const)('%s / %s can be asked to reason', (provider, model) => {
    expect(supportsReasoningRequest(provider, model)).toBe(true);
  });

  it.each([
    ['anthropic', 'claude-3-5-haiku-latest'],
    ['openai', 'gpt-5-mini'],
    ['ollama', 'deepseek-r1'],
    ['bedrock', 'au.anthropic.claude-sonnet-5'],
  ] as const)('%s / %s cannot', (provider, model) => {
    expect(supportsReasoningRequest(provider, model)).toBe(false);
  });
});

describe('Anthropic thinking request', () => {
  it('omits thinking when reasoning is not requested', () => {
    expect(body(request())).not.toHaveProperty('thinking');
  });

  it('asks adaptive models for summarized thinking with headroom on max_tokens', () => {
    const wire = body(request({ reasoning: { effort: 'medium' } }));
    expect(wire['thinking']).toEqual({ type: 'adaptive', display: 'summarized' });
    expect(wire['max_tokens']).toBe(4096 + 4096);
    expect(wire).not.toHaveProperty('temperature');
  });

  it('gives manual-only models a budget below max_tokens and drops temperature', () => {
    const wire = body(request({ model: 'claude-sonnet-4-5', reasoning: { effort: 'low' } }));
    const thinking = wire['thinking'] as { type: string; budget_tokens: number };
    expect(thinking.type).toBe('enabled');
    expect(thinking.budget_tokens).toBeGreaterThanOrEqual(1024);
    expect(thinking.budget_tokens).toBeLessThan(wire['max_tokens'] as number);
    expect(wire).not.toHaveProperty('temperature');
  });

  it('ignores the request for models that cannot think', () => {
    const wire = body(request({ model: 'claude-3-5-haiku-latest', reasoning: { effort: 'high' } }));
    expect(wire).not.toHaveProperty('thinking');
    expect(wire['temperature']).toBe(0.4);
    expect(wire['max_tokens']).toBe(4096);
  });
});

describe('OpenRouter reasoning request', () => {
  it('sends unified reasoning effort and inflates max_tokens by its share', () => {
    const wire = body(
      request({ provider: 'phorma-cloud', model: 'anthropic/claude-sonnet-5', reasoning: { effort: 'medium' } }),
    );
    expect(wire['reasoning']).toEqual({ effort: 'medium' });
    // medium = 50% of max_tokens goes to reasoning, so the visible budget stays 4096.
    expect(wire['max_tokens']).toBe(8192);
  });

  it('never sends reasoning to plain OpenAI-compatible providers', () => {
    const wire = body(request({ provider: 'ollama', model: 'deepseek-r1', reasoning: { effort: 'high' } }));
    expect(wire).not.toHaveProperty('reasoning');
    expect(wire['max_tokens']).toBe(4096);
  });
});

describe('Anthropic thinking replay', () => {
  const stream = [
    'data: {"type":"message_start","message":{"usage":{"input_tokens":10}}}',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Let me "}}',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"check."}}',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"SIG=="}}',
    'data: {"type":"content_block_stop","index":0}',
    'data: {"type":"content_block_start","index":1,"content_block":{"type":"redacted_thinking","data":"ENC"}}',
    'data: {"type":"content_block_stop","index":1}',
    'data: {"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"toolu_1","name":"lookup"}}',
    'data: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{}"}}',
    'data: {"type":"content_block_stop","index":2}',
    'data: {"type":"message_stop"}',
  ];

  it('streams thinking text and emits the signed blocks for replay', () => {
    const chunks = parse(request(), stream);
    expect(chunks.filter(c => c.type === 'thinking').map(c => (c as { text: string }).text)).toEqual([
      'Let me ',
      'check.',
    ]);
    const replay = chunks.find(c => c.type === 'reasoning-replay');
    expect(replay).toEqual({
      type: 'reasoning-replay',
      replay: {
        format: 'anthropic',
        blocks: [
          { type: 'thinking', thinking: 'Let me check.', signature: 'SIG==' },
          { type: 'redacted_thinking', data: 'ENC' },
        ],
      },
    });
  });

  it('echoes the blocks first, verbatim, on the next tool round', () => {
    const chunks = parse(request(), stream);
    const replay = chunks.find(c => c.type === 'reasoning-replay');
    if (replay?.type !== 'reasoning-replay') throw new Error('no replay');
    const next = body(
      request({
        reasoning: { effort: 'medium' },
        messages: [
          { role: 'user', content: 'hello' },
          {
            role: 'assistant-tool-calls',
            calls: [{ id: 'toolu_1', name: 'lookup', arguments: '{}' }],
            reasoning: replay.replay,
          },
          { role: 'tool-results', results: [{ id: 'toolu_1', name: 'lookup', content: 'ok' }] },
        ],
      }),
    );
    const assistant = (next['messages'] as { role: string; content: { type: string }[] }[])[1];
    expect(assistant.content.map(block => block.type)).toEqual(['thinking', 'redacted_thinking', 'tool_use']);
  });

  it('does not leak Anthropic blocks into an OpenAI-compatible body', () => {
    const wire = body(
      request({
        provider: 'openrouter',
        messages: [
          {
            role: 'assistant-tool-calls',
            calls: [{ id: 'c', name: 'n', arguments: '{}' }],
            reasoning: { format: 'anthropic', blocks: [{ type: 'thinking' }] },
          },
        ],
      }),
    );
    const assistant = (wire['messages'] as Record<string, unknown>[])[1];
    expect(assistant).not.toHaveProperty('reasoning_details');
  });
});

describe('OpenRouter reasoning_details replay', () => {
  const req = request({ provider: 'phorma-cloud', model: 'anthropic/claude-sonnet-5' });
  const stream = [
    'data: {"choices":[{"delta":{"reasoning":"Think","reasoning_details":[{"type":"reasoning.text","text":"Think","index":0,"format":"anthropic-claude-v1"}]}}]}',
    'data: {"choices":[{"delta":{"reasoning":"ing","reasoning_details":[{"type":"reasoning.text","text":"ing","index":0}]}}]}',
    'data: {"choices":[{"delta":{"reasoning_details":[{"type":"reasoning.text","signature":"S","index":0}]}}]}',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"lookup","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}',
    'data: [DONE]',
  ];

  it('streams readable reasoning once and merges detail fragments by index', () => {
    const chunks = parse(req, stream);
    expect(chunks.filter(c => c.type === 'thinking').map(c => (c as { text: string }).text).join('')).toBe(
      'Thinking',
    );
    const replay = chunks.find(c => c.type === 'reasoning-replay');
    expect(replay).toEqual({
      type: 'reasoning-replay',
      replay: {
        format: 'openrouter',
        blocks: [
          {
            type: 'reasoning.text',
            text: 'Thinking',
            signature: 'S',
            index: 0,
            format: 'anthropic-claude-v1',
          },
        ],
      },
    });
  });

  it('sends reasoning_details back on the assistant tool-call message', () => {
    const wire = body({
      ...req,
      messages: [
        {
          role: 'assistant-tool-calls',
          calls: [{ id: 'c1', name: 'lookup', arguments: '{}' }],
          reasoning: { format: 'openrouter', blocks: [{ type: 'reasoning.text', text: 'x' }] },
        },
      ],
    });
    const assistant = (wire['messages'] as Record<string, unknown>[])[1];
    expect(assistant['reasoning_details']).toEqual([{ type: 'reasoning.text', text: 'x' }]);
  });

  it('emits no replay chunk for a stream without reasoning', () => {
    const chunks = parse(req, ['data: {"choices":[{"delta":{"content":"hi"}}]}', 'data: [DONE]']);
    expect(chunks.some(c => c.type === 'reasoning-replay')).toBe(false);
  });
});
