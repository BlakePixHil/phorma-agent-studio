import { findNodeForConnector, type WorkflowConnection, type WorkflowNode, type WorkflowSpec } from './workflow.model';

export type WorkflowDiffKind = 'added' | 'removed' | 'changed' | 'moved';

export interface WorkflowDiffEntry {
  kind: WorkflowDiffKind;
  icon: string;
  text: string;
}

/** Returns a human-readable structural diff from `base` to `target`. */
export function diffWorkflowSpecs(base: WorkflowSpec, target: WorkflowSpec): WorkflowDiffEntry[] {
  const entries: WorkflowDiffEntry[] = [];

  if (base.name !== target.name) changed(entries, `Renamed workflow from "${base.name}" to "${target.name}"`);
  if ((base.description ?? '') !== (target.description ?? '')) changed(entries, 'Changed workflow description');
  if (!equal(base.settings ?? {}, target.settings ?? {})) changed(entries, 'Changed workflow settings');
  if (!equal(base.subWorkflows ?? {}, target.subWorkflows ?? {})) {
    changed(entries, 'Changed embedded workflow registry');
  }

  const baseNodes = new Map(base.graph.nodes.map(node => [node.id, node]));
  const targetNodes = new Map(target.graph.nodes.map(node => [node.id, node]));
  let moved = 0;

  for (const node of base.graph.nodes) {
    if (!targetNodes.has(node.id)) entries.push(entry('removed', `Removed ${node.kind} "${node.name}"`));
  }
  for (const node of target.graph.nodes) {
    const previous = baseNodes.get(node.id);
    if (!previous) {
      entries.push(entry('added', `Added ${node.kind} "${node.name}"`));
      continue;
    }
    if (previous.name !== node.name) changed(entries, `Renamed node "${previous.name}" to "${node.name}"`);
    if (previous.description !== node.description) changed(entries, `Changed description on "${node.name}"`);
    if (!equal(previous.ports, node.ports)) changed(entries, `Changed ports on "${node.name}"`);
    describeDataChanges(entries, previous, node);
    if (!equal(previous.position, node.position)) moved += 1;
  }

  describeConnectionChanges(entries, base, target);
  if (moved > 0) entries.push(entry('moved', `Repositioned ${moved} node${moved === 1 ? '' : 's'}`));
  return entries;
}

/** Semantic equality used to suppress no-op version snapshots. */
export function workflowSpecsEqual(a: WorkflowSpec, b: WorkflowSpec): boolean {
  return diffWorkflowSpecs(a, b).length === 0;
}

function describeDataChanges(entries: WorkflowDiffEntry[], previous: WorkflowNode, node: WorkflowNode): void {
  const before = previous.data as Record<string, unknown>;
  const after = node.data as Record<string, unknown>;
  const labels: Record<string, string> = {
    prompt: 'prompt',
    provider: 'model provider',
    model: 'model',
    region: 'model region',
    temperature: 'temperature',
    maxTokens: 'token limit',
    retry: 'retry policy',
    fallback: 'fallback model',
    timeoutSec: 'timeout',
    errorPortId: 'error branch',
    compressionDisabled: 'context compression',
    skills: 'attached skills',
  };
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) {
    if (equal(before[key], after[key])) continue;
    changed(entries, `Changed ${labels[key] ?? humanize(key)} on "${node.name}"`);
  }
}

function describeConnectionChanges(entries: WorkflowDiffEntry[], base: WorkflowSpec, target: WorkflowSpec): void {
  const before = new Map(base.graph.connections.map(connection => [connectionKey(connection), connection]));
  const after = new Map(target.graph.connections.map(connection => [connectionKey(connection), connection]));
  for (const [key, connection] of before) {
    if (!after.has(key)) entries.push(entry('removed', `Removed ${connectionLabel(base, connection)}`));
  }
  for (const [key, connection] of after) {
    if (!before.has(key)) entries.push(entry('added', `Added ${connectionLabel(target, connection)}`));
  }
}

function connectionKey(connection: WorkflowConnection): string {
  return `${connection.outputId}|${connection.inputId}|${connection.kind}|${connection.label ?? ''}`;
}

function connectionLabel(spec: WorkflowSpec, connection: WorkflowConnection): string {
  const output = findNodeForConnector(spec.graph, connection.outputId);
  const input = findNodeForConnector(spec.graph, connection.inputId);
  const from = output?.node.name ?? connection.outputId;
  const to = input?.node.name ?? connection.inputId;
  return `${connection.kind === 'tool-link' ? 'tool link' : 'handoff'} from "${from}" to "${to}"`;
}

function changed(entries: WorkflowDiffEntry[], text: string): void {
  entries.push(entry('changed', text));
}

function entry(kind: WorkflowDiffKind, text: string): WorkflowDiffEntry {
  const icons: Record<WorkflowDiffKind, string> = {
    added: 'ti ti-plus',
    removed: 'ti ti-minus',
    changed: 'ti ti-pencil',
    moved: 'ti ti-arrows-move',
  };
  return { kind, icon: icons[kind], text };
}

function humanize(value: string): string {
  return value.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
}

function equal(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
