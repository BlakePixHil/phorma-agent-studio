/**
 * Plan_Op -> Studio_Action translation (Requirements 4.2, 4.3).
 *
 * Pure and Angular-free so the legacy-compatibility rule is directly
 * testable: a chat thread persisted before the Action_Registry existed
 * contains the five graph op forms, and every one of them must still replay
 * with the behaviour it had, which means mapping to the same graph action with
 * the same arguments.
 */

import type { PlanOp } from '../assistant-chat.model';

/** Studio_Action ids the five legacy Plan_Op forms map onto. */
export const LEGACY_OP_ACTIONS = {
  add: 'graph_add_node',
  connect: 'graph_connect_nodes',
  update: 'graph_update_node',
  remove: 'graph_remove_node',
  disconnect: 'graph_remove_connection',
} as const;

/** One dispatchable call derived from a Plan_Op. */
export interface PlanOpCall {
  /** Studio_Action id, or null when the op form is unrecognised. */
  id: string | null;
  args: Record<string, unknown>;
  /** Temp handle to bind to the created node id, for `add` ops. */
  ref?: string;
}

/** Substitutes plan refs appearing as string values. */
function resolve(value: string | undefined, refs: ReadonlyMap<string, string>): string | undefined {
  if (!value) return undefined;
  return refs.get(value) ?? value;
}

/**
 * Maps a Plan_Op to the Studio_Action id and arguments it dispatches as.
 * `refs` carries temp-handle to real-node-id bindings collected earlier in the
 * same plan.
 */
export function planOpCall(op: PlanOp, refs: ReadonlyMap<string, string>): PlanOpCall {
  switch (op.op) {
    case 'add':
      return {
        id: LEGACY_OP_ACTIONS.add,
        args: { type: op.type, name: op.name, prompt: op.prompt },
        ref: op.ref,
      };
    case 'connect':
      return {
        id: LEGACY_OP_ACTIONS.connect,
        args: {
          sourceNodeId: resolve(op.from, refs),
          targetNodeId: resolve(op.to, refs),
          sourcePort: op.fromPort,
          targetPort: op.toPort,
        },
      };
    case 'update':
      return {
        id: LEGACY_OP_ACTIONS.update,
        args: { nodeId: resolve(op.node, refs), name: op.name, prompt: op.prompt },
      };
    case 'remove':
      return {
        id: LEGACY_OP_ACTIONS.remove,
        args: { nodeId: resolve(op.node, refs) },
      };
    case 'disconnect':
      return {
        id: LEGACY_OP_ACTIONS.disconnect,
        args: { connectionId: op.connection },
      };
    case 'action':
      return {
        id: op.action ?? null,
        // Action_Op arguments may carry plan refs too (a later step editing a
        // node this plan just added), so resolve every string value.
        args: resolveRefsIn(op.args ?? {}, refs),
      };
    default:
      return { id: null, args: {} };
  }
}

/** Substitutes plan refs appearing as string argument values. */
export function resolveRefsIn(
  args: Record<string, unknown>,
  refs: ReadonlyMap<string, string>,
): Record<string, unknown> {
  if (refs.size === 0) return args;
  const resolved: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    resolved[key] = typeof value === 'string' ? (refs.get(value) ?? value) : value;
  }
  return resolved;
}
