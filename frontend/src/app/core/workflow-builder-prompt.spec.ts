import { LEGACY_OP_ACTIONS } from './studio-actions/plan-op';
import {
  PLAN_OP_SHORTHAND_ACTIONS,
  buildAgentSystemPrompt,
  buildAskSystemPrompt,
  buildPlanSystemPrompt,
  summarizeContextWorkflows,
  summarizeGraph,
} from './workflow-builder-prompt';
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

/**
 * Capability narrowing of the two prompts that name actions in PROSE
 * (multi-organisation-phorma Requirement 8.3).
 *
 * `summarizeActions` narrows itself, so the catalogue block needed nothing. These
 * two did: the Plan output format declares five shorthand op forms that are NOT
 * registry entries - they are aliases for graph actions - and the Agent "How to
 * work" block names two action ids in prose. Both would otherwise offer a caller
 * a step that can only fail at apply.
 *
 * **Validates: Requirements 8.3, 8.4**
 */
describe('prompt narrowing by capability', () => {
  /** A catalogue stub that permits exactly the ids it is given. */
  function catalogue(allowed: readonly string[]): {
    summarizeActions: () => string;
    availableIds: () => ReadonlySet<string>;
  } {
    return {
      summarizeActions: () => allowed.map(id => `- ${id}: does a thing`).join('\n'),
      availableIds: () => new Set(allowed),
    };
  }

  const EVERY_SHORTHAND_ACTION = Object.values(PLAN_OP_SHORTHAND_ACTIONS);

  it('maps each shorthand to the action plan-op.ts dispatches it as', () => {
    // Two tables, one mapping. A drift here narrows a shorthand against the wrong
    // action's declared minimum, which no type would catch.
    expect(PLAN_OP_SHORTHAND_ACTIONS).toEqual({ ...LEGACY_OP_ACTIONS });
  });

  it('offers every shorthand op form when every graph action is available', () => {
    const prompt = buildPlanSystemPrompt(emptyGraph(), catalogue(EVERY_SHORTHAND_ACTION));

    for (const op of Object.keys(PLAN_OP_SHORTHAND_ACTIONS)) {
      expect(prompt).withContext(op).toContain(`"op": "${op}"`);
    }
    expect(prompt).toContain('"op": "action"');
    expect(prompt).toContain('stay available for canvas edits');
  });

  it('withholds a shorthand whose action the level does not allow', () => {
    // An editor: prompt and rename edits, but not the shape of the graph.
    const prompt = buildPlanSystemPrompt(
      emptyGraph(),
      catalogue([PLAN_OP_SHORTHAND_ACTIONS['update']]),
    );

    expect(prompt).toContain('"op": "update"');
    for (const op of ['add', 'connect', 'remove', 'disconnect']) {
      expect(prompt).withContext(op).not.toContain(`"op": "${op}"`);
    }
    // The `action` op is never withheld: the registry catalogue above it is what
    // narrows, so the form stays and the list of ids shrinks.
    expect(prompt).toContain('"op": "action"');
    expect(prompt).toContain('("update")');
  });

  it('says plainly that there are no canvas shorthands when there are none', () => {
    const prompt = buildPlanSystemPrompt(emptyGraph(), catalogue(['run_start']));

    for (const op of Object.keys(PLAN_OP_SHORTHAND_ACTIONS)) {
      expect(prompt).withContext(op).not.toContain(`"op": "${op}"`);
    }
    // A plan is still possible, through the action op alone.
    expect(prompt).toContain('"op": "action"');
    expect(prompt).toContain('no canvas shorthands available');
  });

  it('keeps the plan output format valid JSON shape whatever is withheld', () => {
    const prompt = buildPlanSystemPrompt(emptyGraph(), catalogue(['run_start']));
    const block = prompt.slice(prompt.indexOf('{\n  "summary"'));
    // A filtered list must not leave a dangling comma or an empty "ops" array -
    // the model copies this shape literally.
    expect(block).not.toContain(',\n  ]');
    expect(block).toContain('"ops": [\n    { "op": "action"');
  });

  it('stops telling an Agent-mode caller to call graph actions it does not have', () => {
    const asBuilder = buildAgentSystemPrompt(emptyGraph(), catalogue(EVERY_SHORTHAND_ACTION));
    expect(asBuilder).toContain('Call graph_add_node');
    expect(asBuilder).toContain('Call graph_connect_nodes');

    const asOperator = buildAgentSystemPrompt(emptyGraph(), catalogue(['run_start']));
    expect(asOperator).not.toContain('Call graph_add_node');
    expect(asOperator).not.toContain('Call graph_connect_nodes');
    // The rest of the section survives, so the block never renders headerless.
    expect(asOperator).toContain('## How to work');
    expect(asOperator).toContain('For anything off the canvas');
  });

  it('leaves the Ask prompt read-only and unnarrowed beyond its catalogue', () => {
    const prompt = buildAskSystemPrompt(emptyGraph(), catalogue(['run_read_state']));
    expect(prompt).toContain('- run_read_state');
    expect(prompt).toContain('READ access only');
  });
});
