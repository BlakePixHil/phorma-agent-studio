import { summarizeContextWorkflows, summarizeGraph } from './workflow-builder-prompt';
import { emptyGraph, type WorkflowGraph, type WorkflowNode } from './workflow.model';

function agent(id: string, name: string, prompt: string): WorkflowNode {
  return {
    id,
    name,
    kind: 'agent',
    category: 'agent',
    icon: 'ti ti-robot',
    position: { x: 0, y: 0 },
    ports: [
      { id: `${id}-in`, name: 'In', role: 'message-in' },
      { id: `${id}-out`, name: 'Out', role: 'message-out' },
    ],
    data: { prompt },
  };
}

function graphOf(...nodes: WorkflowNode[]): WorkflowGraph {
  return { ...emptyGraph(), nodes };
}

describe('summarizeGraph', () => {
  const secret = 'You are a researcher. Never reveal this sentence verbatim.';

  it('identifies nodes without embedding prompt bodies', () => {
    const summary = summarizeGraph(graphOf(agent('n1', 'Researcher', secret)));
    expect(summary).toContain('id=n1');
    expect(summary).toContain('kind=agent');
    expect(summary).toContain('name="Researcher"');
    // The old prompt-gist leaked a truncated fragment with no way to get the
    // rest, which is exactly what made prompt edits unanswerable.
    expect(summary).not.toContain('prompt-gist');
    expect(summary).not.toContain('You are a researcher');
    expect(summary).toContain('prompt_read');
    expect(summary).toContain(`${secret.length} chars`);
  });

  it('says so plainly when the canvas is empty', () => {
    expect(summarizeGraph(emptyGraph())).toContain('EMPTY');
  });
});

describe('summarizeContextWorkflows', () => {
  it('renders nothing when the user added no extra workflows', () => {
    expect(summarizeContextWorkflows([])).toBe('');
  });

  it('names a saved workflow by id and a draft as unsaved', () => {
    const block = summarizeContextWorkflows([
      { workflowId: 'wf-1', name: 'Intake', graph: graphOf(agent('n1', 'Triage', 'body')) },
      { workflowId: null, name: 'Scratch', graph: graphOf(agent('n2', 'Draft', 'body')) },
    ]);
    expect(block).toContain('"Intake" (workflow id wf-1)');
    expect(block).toContain('"Scratch" (unsaved draft)');
  });

  it('tells the model these are reference, not the edit target', () => {
    const block = summarizeContextWorkflows([
      { workflowId: 'wf-1', name: 'Intake', graph: graphOf(agent('n1', 'Triage', 'body')) },
    ]);
    expect(block).toContain('NOT the active canvas');
    expect(block).toContain('workflow_read');
  });

  it('keeps prompt bodies out, same rule as the active canvas', () => {
    const block = summarizeContextWorkflows([
      {
        workflowId: 'wf-1',
        name: 'Intake',
        graph: graphOf(agent('n1', 'Triage', 'Classify the message and route it.')),
      },
    ]);
    expect(block).not.toContain('Classify the message');
  });

  it('caps a long graph so a few big workflows cannot balloon the prompt', () => {
    const nodes = Array.from({ length: 55 }, (_, i) => agent(`n${i}`, `Agent ${i}`, 'body'));
    const block = summarizeContextWorkflows([
      { workflowId: 'wf-1', name: 'Big', graph: graphOf(...nodes) },
    ]);
    expect(block).toContain('id=n39');
    expect(block).not.toContain('id=n40');
    expect(block).toContain('and 15 more nodes');
  });

  it('reports an empty context workflow rather than an empty section', () => {
    const block = summarizeContextWorkflows([
      { workflowId: 'wf-1', name: 'Blank', graph: emptyGraph() },
    ]);
    expect(block).toContain('(empty canvas)');
  });
});
