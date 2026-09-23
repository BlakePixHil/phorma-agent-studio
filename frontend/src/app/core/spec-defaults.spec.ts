/**
 * The pure default materialization and the Canonical_Spec_Hash
 * (multi-organisation-phorma, Requirements 12.3, 12.4; design section 10;
 * Property 28's studio half).
 *
 * The claim these tests exist for is the one a proposal comparison rests on: two
 * machines with DIFFERENT application defaults must compute the SAME hash for the
 * same spec, or every comparison reports a difference nobody made. That is the
 * invariance property below, and it is why `materializeSpecDefaults` only fills a
 * node carrying NEITHER a provider nor a model.
 */

import fc from 'fast-check';

import { canonicalSpecHash, graphsOf, materializeSpecDefaults, type SpecDefaults } from './spec-defaults';
import type { ModelProviderId, WorkflowNode, WorkflowSpec } from './workflow.model';

const DEFAULTS: SpecDefaults = { provider: 'anthropic', model: 'claude-sonnet-5', temperature: 0.4 };

function agent(id: string, data: Record<string, unknown> = {}): WorkflowNode {
  return {
    id,
    name: `Agent ${id}`,
    kind: 'agent',
    category: 'agent',
    icon: 'ti ti-robot',
    position: { x: 0, y: 0 },
    ports: [
      { id: `${id}-input`, name: 'Input', role: 'message-in' },
      { id: `${id}-output`, name: 'Output', role: 'message-out' },
    ],
    data: { prompt: 'Say hello.', ...data },
  } as WorkflowNode;
}

function spec(nodes: WorkflowNode[], subNodes?: WorkflowNode[]): WorkflowSpec {
  return {
    version: 1,
    id: 'wf-defaults',
    name: 'Defaults',
    graph: { nodes, connections: [] },
    savedAt: '2026-09-23T00:00:00Z',
    ...(subNodes
      ? {
          subWorkflows: {
            'sub-a': { id: 'sub-a', name: 'Sub A', graph: { nodes: subNodes, connections: [] } },
          },
        }
      : {}),
  };
}

/** A node's resolved model fields, for an assertion that reads as a sentence. */
function modelOf(node: WorkflowNode): { provider?: string; model?: string; temperature?: number } {
  return node.data as { provider?: string; model?: string; temperature?: number };
}

describe('spec defaults', () => {
  it('bakes the application default into an agent that inherits it', () => {
    const resolved = materializeSpecDefaults(spec([agent('a')]), DEFAULTS);
    expect(modelOf(resolved.graph.nodes[0]).provider).toBe('anthropic');
    expect(modelOf(resolved.graph.nodes[0]).model).toBe('claude-sonnet-5');
    expect(modelOf(resolved.graph.nodes[0]).temperature).toBe(0.4);
  });

  it('leaves an explicit provider and model alone, including its temperature', () => {
    const explicit = agent('a', { provider: 'ollama', model: 'llama3.2', temperature: 0.9 });
    const resolved = materializeSpecDefaults(spec([explicit]), DEFAULTS);
    expect(modelOf(resolved.graph.nodes[0])).toEqual(
      jasmine.objectContaining({ provider: 'ollama', model: 'llama3.2', temperature: 0.9 }),
    );
  });

  it('reaches every graph in the embedded closure, not just the root', () => {
    const resolved = materializeSpecDefaults(spec([agent('a')], [agent('b')]), DEFAULTS);
    const sub = resolved.subWorkflows?.['sub-a'];
    expect(modelOf(sub!.graph.nodes[0]).model).toBe('claude-sonnet-5');
    expect(graphsOf(resolved).length).toBe(2);
  });

  it('never mutates its argument', () => {
    const original = spec([agent('a')], [agent('b')]);
    const before = JSON.stringify(original);
    materializeSpecDefaults(original, DEFAULTS);
    expect(JSON.stringify(original)).toBe(before);
  });

  it('leaves a non-agent node untouched', () => {
    const trigger = {
      ...agent('t'),
      kind: 'manual-trigger',
      data: { label: 'Start' },
    } as WorkflowNode;
    const resolved = materializeSpecDefaults(spec([trigger]), DEFAULTS);
    expect(JSON.stringify(resolved.graph.nodes[0].data)).toBe(JSON.stringify({ label: 'Start' }));
  });

  it('hashes a spec whose agents are all explicit identically for ANY defaults', () => {
    // Property 28's studio half, and the claim the whole proposal comparison rests
    // on: an editor's studio and a builder's studio hold different application
    // defaults, so a hash that moved with them would report drift on a spec that
    // has not changed. Pinned on CONTENTS too - the first expectation rules out a
    // function that hashes a constant.
    const providers: ModelProviderId[] = ['anthropic', 'openai', 'gemini', 'ollama'];
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 6 }),
        fc.constantFrom(...providers),
        fc.string({ minLength: 1, maxLength: 24 }),
        fc.double({ min: 0, max: 2, noNaN: true }),
        fc.string({ minLength: 1, maxLength: 24 }),
        (count, provider, model, temperature, prompt) => {
          const explicit = Array.from({ length: count }, (_unused, index) =>
            agent(`a${index}`, { prompt, provider: 'ollama', model: 'llama3.2' }),
          );
          const subject = spec(explicit, [agent('s0', { provider: 'ollama', model: 'llama3.2' })]);
          const one = canonicalSpecHash(subject, DEFAULTS);
          const other = canonicalSpecHash(subject, { provider, model, temperature });
          expect(one).toBe(other);
          // And the control: a spec that DOES inherit hashes differently under
          // different defaults, so the invariance above is a property of explicit
          // specs rather than of a hash that ignores the model fields.
          const inheriting = spec([agent('a0', { prompt })]);
          expect(canonicalSpecHash(inheriting, DEFAULTS)).not.toBe(
            canonicalSpecHash(inheriting, { provider: 'openai', model: 'gpt-5.5', temperature: 1 }),
          );
        },
      ),
      { numRuns: 60 },
    );
  });

  it('agrees with a hash taken over the already-materialized spec', () => {
    // This is what makes the studio and the worker agree (design section 10.4).
    // The worker never materializes: it hashes what it was given, which a studio
    // materialized at push time. So hashing `spec` with the studio's defaults must
    // equal hashing the MATERIALIZED spec with any defaults at all, or the frozen
    // `live_spec_hash` and a freshly computed one would never match.
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 5 }), count => {
        const subject = spec(
          Array.from({ length: count }, (_unused, index) => agent(`a${index}`)),
          [agent('s0')],
        );
        const materialized = materializeSpecDefaults(subject, DEFAULTS);
        expect(canonicalSpecHash(subject, DEFAULTS)).toBe(
          canonicalSpecHash(materialized, { provider: 'openai', model: 'gpt-5.5', temperature: 1 }),
        );
      }),
      { numRuns: 40 },
    );
  });

  it('is stable across key order, because the hash is over canonical JSON', () => {
    const a = spec([agent('a', { provider: 'ollama', model: 'llama3.2' })]);
    const b = spec([agent('a', { model: 'llama3.2', provider: 'ollama' })]);
    expect(canonicalSpecHash(a, DEFAULTS)).toBe(canonicalSpecHash(b, DEFAULTS));
  });
});
