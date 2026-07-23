import { diffWorkflowSpecs, workflowSpecsEqual } from './workflow-diff';
import type { WorkflowNode, WorkflowSpec } from './workflow.model';

function node(id: string, name: string, prompt: string, x = 0): WorkflowNode {
  return {
    id,
    name,
    kind: 'agent',
    category: 'agent',
    icon: 'ti ti-robot',
    position: { x, y: 0 },
    ports: [
      { id: `${id}-input`, name: 'Input', role: 'message-in' },
      { id: `${id}-output`, name: 'Output', role: 'message-out' },
    ],
    data: { prompt },
  };
}

function spec(nodes: WorkflowNode[]): WorkflowSpec {
  return { version: 1, id: 'wf-test', name: 'Test', graph: { nodes, connections: [] }, savedAt: '2026-07-23T00:00:00Z' };
}

describe('workflow diff', () => {
  it('ignores save timestamps for semantic equality', () => {
    const a = spec([node('a', 'Agent', 'Prompt')]);
    const b = { ...structuredClone(a), savedAt: '2026-07-23T01:00:00Z' };
    expect(workflowSpecsEqual(a, b)).toBeTrue();
  });

  it('describes data edits and collapses position changes', () => {
    const changes = diffWorkflowSpecs(
      spec([node('a', 'Agent', 'Before')]),
      spec([node('a', 'Agent', 'After', 120)]),
    );
    expect(changes.map(change => change.text)).toEqual([
      'Changed prompt on "Agent"',
      'Repositioned 1 node',
    ]);
  });

  it('describes node additions and removals', () => {
    const changes = diffWorkflowSpecs(
      spec([node('a', 'Old', 'Prompt')]),
      spec([node('b', 'New', 'Prompt')]),
    );
    expect(changes.map(change => change.kind)).toEqual(['removed', 'added']);
  });

  it('treats embedded workflow registry edits as semantic changes', () => {
    const a = spec([node('a', 'Agent', 'Prompt')]);
    const b = {
      ...structuredClone(a),
      subWorkflows: {
        child: {
          id: 'child',
          name: 'Child',
          graph: { nodes: [node('c', 'Child Agent', 'Prompt')], connections: [] },
        },
      },
    };
    expect(diffWorkflowSpecs(a, b).map(change => change.text)).toContain(
      'Changed embedded workflow registry',
    );
    expect(workflowSpecsEqual(a, b)).toBeFalse();
  });
});
