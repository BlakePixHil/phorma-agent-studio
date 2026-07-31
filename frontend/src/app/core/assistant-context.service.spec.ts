import { TestBed } from '@angular/core/testing';
import { computed, signal } from '@angular/core';

import { AssistantContextService } from './assistant-context.service';
import { WorkflowService, type OpenWorkflowDoc } from './workflow.service';
import { emptyGraph, type WorkflowGraph, type WorkflowNode } from './workflow.model';

function node(id: string): WorkflowNode {
  return {
    id,
    name: id,
    kind: 'agent',
    category: 'agent',
    icon: 'ti ti-robot',
    position: { x: 0, y: 0 },
    ports: [],
    data: { prompt: 'body' },
  };
}

function graphOf(nodeCount: number): WorkflowGraph {
  return { ...emptyGraph(), nodes: Array.from({ length: nodeCount }, (_, i) => node(`n${i}`)) };
}

function doc(docId: string, overrides: Partial<OpenWorkflowDoc> = {}): OpenWorkflowDoc {
  return {
    docId,
    workflowId: `wf-${docId}`,
    name: `Workflow ${docId}`,
    description: '',
    graph: graphOf(2),
    settings: {},
    dirty: false,
    ...overrides,
  };
}

/**
 * The active workflow is always context; extra tabs are opt-in and keyed by
 * open-tab id, so they survive being unsaved and drop themselves when the tab
 * closes.
 */
describe('AssistantContextService', () => {
  const docs = signal<OpenWorkflowDoc[]>([]);
  const activeDocId = signal<string | null>(null);
  let context: AssistantContextService;

  beforeEach(() => {
    docs.set([doc('d1'), doc('d2'), doc('d3')]);
    activeDocId.set('d1');
    const fakeWorkflow = {
      documents: docs.asReadonly(),
      activeDocId: activeDocId.asReadonly(),
      activeDoc: computed(() => docs().find(item => item.docId === activeDocId()) ?? null),
    };
    TestBed.configureTestingModule({
      providers: [{ provide: WorkflowService, useValue: fakeWorkflow }],
    });
    context = TestBed.inject(AssistantContextService);
  });

  it('puts the active workflow in context with no user action', () => {
    expect(context.active()?.docId).toBe('d1');
    expect(context.active()?.active).toBeTrue();
    expect(context.extras()).toEqual([]);
    expect(context.has('d1')).toBeTrue();
    expect(context.isActive('d1')).toBeTrue();
  });

  it('reports node and connection counts for the strip', () => {
    docs.set([doc('d1', { graph: graphOf(5) })]);
    expect(context.active()?.nodes).toBe(5);
    expect(context.active()?.connections).toBe(0);
  });

  it('adds an extra tab, in the order it was added', () => {
    context.add('d3');
    context.add('d2');
    expect(context.extras().map(item => item.docId)).toEqual(['d3', 'd2']);
    expect(context.items().map(item => item.docId)).toEqual(['d1', 'd3', 'd2']);
  });

  it('ignores a duplicate add', () => {
    context.add('d2');
    context.add('d2');
    expect(context.extras().length).toBe(1);
  });

  it('never lists the active workflow twice', () => {
    context.add('d2');
    activeDocId.set('d2');
    expect(context.active()?.docId).toBe('d2');
    expect(context.extras()).toEqual([]);
    // It is still remembered, so switching away restores the chip rather than
    // silently losing what the user added.
    activeDocId.set('d1');
    expect(context.extras().map(item => item.docId)).toEqual(['d2']);
  });

  it('drops an extra when its tab closes', () => {
    context.add('d2');
    expect(context.extras().length).toBe(1);
    docs.set([doc('d1'), doc('d3')]);
    expect(context.extras()).toEqual([]);
  });

  it('toggles and removes', () => {
    context.toggle('d2');
    expect(context.has('d2')).toBeTrue();
    context.toggle('d2');
    expect(context.has('d2')).toBeFalse();
    context.add('d2');
    context.add('d3');
    context.remove('d2');
    expect(context.extras().map(item => item.docId)).toEqual(['d3']);
    context.clear();
    expect(context.extras()).toEqual([]);
  });

  it('exposes the extra documents for prompt assembly, active excluded', () => {
    context.add('d2');
    context.add('d3');
    activeDocId.set('d3');
    expect(context.extraDocuments().map(item => item.docId)).toEqual(['d2']);
  });

  it('surfaces the unsaved flag so the chip can show a dirty dot', () => {
    docs.set([doc('d1'), doc('d2', { dirty: true, workflowId: null })]);
    context.add('d2');
    const extra = context.extras()[0];
    expect(extra.dirty).toBeTrue();
    expect(extra.workflowId).toBeNull();
  });
});
