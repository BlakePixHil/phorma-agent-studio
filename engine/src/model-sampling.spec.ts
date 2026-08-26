import { describe, expect, it } from 'vitest';

import { acceptsSamplingParams, buildWireRequest, type ModelRequest } from './model.js';
import type { ModelProviderId } from './types.js';

/**
 * Anthropic retired the sampling knobs from Claude Opus 4.7 onward: sending
 * `temperature` to Sonnet 5 or Opus 4.7+ is a hard 400 ("`temperature` is
 * deprecated for this model"), on the direct API, on Bedrock Converse, and on
 * any OpenAI-compatible endpoint that forwards the field. The engine therefore
 * has to OMIT the field for those models rather than pick a safe value - there
 * is no accepted value.
 *
 * Regression: a Bedrock agent on `au.anthropic.claude-sonnet-5` failed every
 * call because the temperature travelled in `inferenceConfig`.
 */
function request(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return {
    provider: 'bedrock',
    model: 'au.anthropic.claude-sonnet-5',
    system: 'system',
    messages: [{ role: 'user', content: 'hello' }],
    temperature: 0.7,
    ...overrides,
  };
}

describe('acceptsSamplingParams', () => {
  // Every spelling the same retired-knob model arrives under. The point of the
  // id-based rule is that all four resolve identically.
  it.each([
    'claude-sonnet-5',
    'anthropic/claude-sonnet-5',
    'au.anthropic.claude-sonnet-5',
    'us.anthropic.claude-sonnet-5',
    'anthropic.claude-sonnet-5-20260115-v1:0',
    'claude-opus-4-7',
    'eu.anthropic.claude-opus-4-8',
    'anthropic/claude-opus-5',
    'claude-fable-5',
    'CLAUDE-SONNET-5',
  ])('%s does not accept sampling params', model => {
    expect(acceptsSamplingParams(model)).toBe(false);
  });

  // Models that still take a temperature. `claude-sonnet-4-5` is the important
  // one: it rejects `temperature` and `top_p` TOGETHER, not `temperature`
  // alone, and the engine never sends `top_p`.
  it.each([
    'claude-sonnet-4-5',
    'au.anthropic.claude-sonnet-4-5',
    'anthropic.claude-sonnet-4-6-v1',
    'anthropic/claude-3-5-haiku',
    'gpt-5-mini',
    'gemini-3.5-flash',
    'llama3.2',
    '',
  ])('%s accepts sampling params', model => {
    expect(acceptsSamplingParams(model)).toBe(true);
  });
});

describe('wire bodies omit temperature for retired-knob models', () => {
  it('Bedrock Converse leaves temperature out of inferenceConfig', () => {
    const body = JSON.parse(buildWireRequest(request()).body) as {
      inferenceConfig: Record<string, unknown>;
    };
    expect('temperature' in body.inferenceConfig).toBe(false);
    // maxTokens still travels - the whole config is not dropped.
    expect(body.inferenceConfig['maxTokens']).toBeGreaterThan(0);
  });

  it('Bedrock Converse still sends temperature for a model that takes it', () => {
    const body = JSON.parse(
      buildWireRequest(request({ model: 'au.anthropic.claude-sonnet-4-5' })).body,
    ) as { inferenceConfig: Record<string, unknown> };
    expect(body.inferenceConfig['temperature']).toBe(0.7);
  });

  // The same model reaches three different wire formats, so the omission has to
  // hold in all of them - `JSON.stringify` drops the undefined property.
  it.each<[ModelProviderId, string]>([
    ['anthropic', 'claude-sonnet-5'],
    ['openrouter', 'anthropic/claude-sonnet-5'],
    ['phorma-cloud', 'anthropic/claude-sonnet-5'],
  ])('%s omits the temperature key entirely', (provider, model) => {
    const wire = buildWireRequest(request({ provider, model }));
    expect(JSON.parse(wire.body)).not.toHaveProperty('temperature');
    expect(wire.body).not.toContain('temperature');
  });

  it('openai-compatible providers keep temperature for other models', () => {
    const body = JSON.parse(
      buildWireRequest(request({ provider: 'openai', model: 'gpt-5-mini' })).body,
    ) as { temperature?: number };
    expect(body.temperature).toBe(0.7);
  });
});
