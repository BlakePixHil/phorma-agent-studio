import type { PlanOp } from '../assistant-chat.model';
import { LEGACY_OP_ACTIONS, planOpCall, resolveRefsIn } from './plan-op';

const NO_REFS = new Map<string, string>();

describe('planOpCall - legacy Plan_Op compatibility (Requirement 4.3)', () => {
  it('maps an add op to graph_add_node with its original arguments', () => {
    const op: PlanOp = {
      op: 'add',
      ref: 'a1',
      type: 'agent-researcher',
      name: 'Researcher',
      prompt: '# Researcher\n\n{{input}}',
    };
    expect(planOpCall(op, NO_REFS)).toEqual({
      id: LEGACY_OP_ACTIONS.add,
      args: { type: 'agent-researcher', name: 'Researcher', prompt: '# Researcher\n\n{{input}}' },
      ref: 'a1',
    });
  });

  it('maps a connect op, resolving refs to real node ids', () => {
    const refs = new Map([
      ['a1', 'node-1'],
      ['a2', 'node-2'],
    ]);
    const op: PlanOp = { op: 'connect', from: 'a1', to: 'a2', fromPort: 'Route A' };
    expect(planOpCall(op, refs)).toEqual({
      id: LEGACY_OP_ACTIONS.connect,
      args: {
        sourceNodeId: 'node-1',
        targetNodeId: 'node-2',
        sourcePort: 'Route A',
        targetPort: undefined,
      },
    });
  });

  it('passes through an id that is not a ref', () => {
    const op: PlanOp = { op: 'connect', from: 'node-existing', to: 'node-other' };
    const call = planOpCall(op, new Map([['a1', 'node-1']]));
    expect(call.args['sourceNodeId']).toBe('node-existing');
    expect(call.args['targetNodeId']).toBe('node-other');
  });

  it('maps update, remove and disconnect ops', () => {
    expect(planOpCall({ op: 'update', node: 'n1', name: 'Renamed' }, NO_REFS)).toEqual({
      id: LEGACY_OP_ACTIONS.update,
      args: { nodeId: 'n1', name: 'Renamed', prompt: undefined },
    });
    expect(planOpCall({ op: 'remove', node: 'n1' }, NO_REFS)).toEqual({
      id: LEGACY_OP_ACTIONS.remove,
      args: { nodeId: 'n1' },
    });
    expect(planOpCall({ op: 'disconnect', connection: 'conn-1' }, NO_REFS)).toEqual({
      id: LEGACY_OP_ACTIONS.disconnect,
      args: { connectionId: 'conn-1' },
    });
  });

  it('covers every legacy op form', () => {
    for (const op of ['add', 'connect', 'update', 'remove', 'disconnect'] as const) {
      expect(planOpCall({ op }, NO_REFS).id).withContext(op).toBe(LEGACY_OP_ACTIONS[op]);
    }
  });
});

describe('planOpCall - Action_Ops (Requirement 4.1)', () => {
  it('dispatches the named studio action with its arguments', () => {
    const op: PlanOp = {
      op: 'action',
      action: 'eval_create_suite',
      args: { name: 'Smoke tests' },
    };
    expect(planOpCall(op, NO_REFS)).toEqual({
      id: 'eval_create_suite',
      args: { name: 'Smoke tests' },
    });
  });

  it('substitutes plan refs inside action arguments', () => {
    const op: PlanOp = {
      op: 'action',
      action: 'prompt_write',
      args: { nodeId: 'a1', prompt: 'Body' },
    };
    const call = planOpCall(op, new Map([['a1', 'node-7']]));
    expect(call.args).toEqual({ nodeId: 'node-7', prompt: 'Body' });
  });

  it('reports a missing action id as unrecognised rather than guessing', () => {
    expect(planOpCall({ op: 'action' }, NO_REFS).id).toBeNull();
    expect(planOpCall({ op: 'nonsense' } as unknown as PlanOp, NO_REFS).id).toBeNull();
  });
});

describe('resolveRefsIn', () => {
  it('returns the same object when there are no refs to substitute', () => {
    const args = { nodeId: 'a1' };
    expect(resolveRefsIn(args, NO_REFS)).toBe(args);
  });

  it('leaves non-string values alone', () => {
    const resolved = resolveRefsIn(
      { limit: 5, approved: true, nodeId: 'a1' },
      new Map([['a1', 'node-1']]),
    );
    expect(resolved).toEqual({ limit: 5, approved: true, nodeId: 'node-1' });
  });
});
