import { TestBed } from '@angular/core/testing';

import { WorkflowService } from './workflow.service';
import { TauriService } from './tauri.service';
import type { WorkflowGraph, WorkflowNode } from './workflow.model';

/**
 * Requirement 1.4: a proposed `tool-link` edge whose source or target
 * endpoint is a Data_Node is rejected by the Canvas_Validator's underlying
 * graph mutation BEFORE it is added — the graph is left unchanged and no
 * connection appears in it. `workflow.model.spec.ts` covers the pure
 * `toolLinkRejection` predicate directly; this exercises the same rule at
 * the point where a connection actually would have been mutated into the
 * graph (`WorkflowService.addConnection`, the call `GraphCanvas` makes
 * after consulting the same predicate to build its own toast message).
 *
 * Data_Nodes never carry a `tools` port through the real catalog
 * (Requirement 1.1 declares message ports only), so a `tools`-role port is
 * attached by hand here — the only way to actually route an edge INTO the
 * `toolLinkRejection` branch of `addConnection` rather than the earlier
 * plain port-role mismatch, and the defensive case Requirement 1.4 exists
 * to cover regardless of how such a port came to exist.
 */
describe('WorkflowService.addConnection tool-link rejection (Requirement 1.4)', () => {
  let workflow: WorkflowService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [{ provide: TauriService, useValue: { isDesktop: true } }],
    });
    workflow = TestBed.inject(WorkflowService);
    workflow.newWorkflow();
  });

  function toolsPort(node: WorkflowNode): string {
    return node.ports.find(port => port.role === 'tools')!.id;
  }

  /** A data node with an (unrealistic, hand-attached) `tools` port. */
  function dataNodeWithToolsPort(id: string): WorkflowNode {
    return {
      id,
      name: 'HTTP Request',
      kind: 'http-request',
      category: 'flow',
      icon: 'ti ti-api',
      position: { x: 200, y: 0 },
      ports: [
        { id: `${id}-in`, name: 'In', role: 'message-in' },
        { id: `${id}-tools`, name: 'Tools', role: 'tools' },
      ],
      data: { method: 'GET', url: '' },
    };
  }

  it('rejects an agent-to-data-node tool-link, leaving the graph unchanged', () => {
    const agent = workflow.addNodeFromCatalog('agent-blank', { x: 0, y: 0 });
    expect(agent).toBeTruthy();
    const dataNode = dataNodeWithToolsPort('data-http-1');
    workflow.replaceGraph({
      nodes: [...workflow.graph().nodes, dataNode],
      connections: [],
    } satisfies WorkflowGraph);

    const before = workflow.graph();
    expect(before.connections).toEqual([]);

    const result = workflow.addConnection(`${toolsPort(agent!)}-out`, `${dataNode.id}-tools-in`);

    expect(result).toBeNull();
    const after = workflow.graph();
    expect(after.connections).toEqual([]);
    expect(after).toEqual(before);
  });

  it('rejects a data-node-to-agent tool-link, leaving the graph unchanged', () => {
    const dataNode = dataNodeWithToolsPort('data-sql-1');
    const agent = workflow.addNodeFromCatalog('agent-blank', { x: 200, y: 0 });
    expect(agent).toBeTruthy();
    workflow.replaceGraph({
      nodes: [...workflow.graph().nodes, dataNode],
      connections: [],
    } satisfies WorkflowGraph);

    const before = workflow.graph();

    const result = workflow.addConnection(
      `${dataNode.id}-tools-out`,
      `${toolsPort(agent!)}-in`,
    );

    expect(result).toBeNull();
    expect(workflow.graph().connections).toEqual([]);
    expect(workflow.graph()).toEqual(before);
  });

  it('still allows a real tool-link between an agent and a tool node', () => {
    const agent = workflow.addNodeFromCatalog('agent-blank', { x: 0, y: 0 });
    const httpTool = workflow.addNodeFromCatalog('tool-http', { x: 200, y: 0 });
    expect(agent).toBeTruthy();
    expect(httpTool).toBeTruthy();

    const result = workflow.addConnection(
      `${toolsPort(agent!)}-out`,
      `${toolsPort(httpTool!)}-in`,
    );

    expect(result).toBeTruthy();
    expect(result?.kind).toBe('tool-link');
    expect(workflow.graph().connections.length).toBe(1);
  });

  it('still allows a handoff into and out of a data node', () => {
    const trigger = workflow.addNodeFromCatalog('trigger-manual', { x: 0, y: 0 });
    const transformNode = workflow.addNodeFromCatalog('data-transform', { x: 200, y: 0 });
    expect(trigger).toBeTruthy();
    expect(transformNode).toBeTruthy();

    const outPort = trigger!.ports.find(port => port.role === 'message-out')!.id;
    const inPort = transformNode!.ports.find(port => port.role === 'message-in')!.id;
    const result = workflow.addConnection(`${outPort}-out`, `${inPort}-in`);

    expect(result).toBeTruthy();
    expect(result?.kind).toBe('handoff');
  });
});
