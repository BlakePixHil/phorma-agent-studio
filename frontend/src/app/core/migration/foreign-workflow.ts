/**
 * Deterministic pre-parsers for the migration converter (EPIC 5): recognize
 * a pasted n8n / Flowise / Dify workflow export and normalize it into a
 * compact intermediate summary the LLM maps onto Phorma's node catalog.
 *
 * Pure module — no Angular imports. The LLM does the semantic mapping;
 * this file only does shape detection and lossless extraction, so nothing
 * here needs updating when catalogs change.
 */

export type ForeignWorkflowSource = 'n8n' | 'flowise' | 'dify';

/** One node of a foreign workflow, normalized. */
export interface ForeignNode {
  id: string;
  /** The source tool's type identifier (e.g. `n8n-nodes-base.httpRequest`). */
  type: string;
  name: string;
  /** Compact JSON of the node's parameters (clipped). */
  parameters?: string;
}

/** One edge of a foreign workflow, normalized. */
export interface ForeignEdge {
  from: string;
  to: string;
  /** Optional branch/output label (e.g. n8n output index, router branch). */
  label?: string;
}

/** A normalized foreign workflow ready for LLM conversion. */
export interface ForeignWorkflow {
  source: ForeignWorkflowSource;
  name?: string;
  nodes: ForeignNode[];
  edges: ForeignEdge[];
}

/** Max chars of parameter JSON kept per node (context budget). */
const PARAMS_CLIP = 600;

/** Clips + serializes a parameters object for the model's context. */
function clipParams(params: unknown): string | undefined {
  if (!params || typeof params !== 'object' || Object.keys(params).length === 0) {
    return undefined;
  }
  const json = JSON.stringify(params);
  return json.length > PARAMS_CLIP ? `${json.slice(0, PARAMS_CLIP)}…` : json;
}

/**
 * Attempts to parse `text` as a supported foreign workflow export.
 * Returns null when the text is not recognizable (callers treat that as
 * "just a normal chat message").
 */
export function detectForeignWorkflow(text: string): ForeignWorkflow | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{')) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;

  const n8n = parseN8n(obj);
  if (n8n) return n8n;
  const flowise = parseFlowise(obj);
  if (flowise) return flowise;
  const dify = parseDify(obj);
  if (dify) return dify;
  return null;
}

/** n8n export: `{ nodes: [{name,type,parameters,…}], connections: {…} }`. */
function parseN8n(obj: Record<string, unknown>): ForeignWorkflow | null {
  if (!Array.isArray(obj['nodes']) || typeof obj['connections'] !== 'object') return null;
  const rawNodes = obj['nodes'] as Record<string, unknown>[];
  if (rawNodes.length === 0 || !rawNodes.every(n => typeof n['type'] === 'string')) return null;
  // n8n node types are namespaced (`n8n-nodes-base.*`, `@n8n/n8n-nodes-langchain.*`).
  if (!rawNodes.some(n => String(n['type']).includes('n8n'))) return null;

  const nodes: ForeignNode[] = rawNodes.map((n, i) => ({
    id: String(n['name'] ?? n['id'] ?? `node-${i}`),
    type: String(n['type']),
    name: String(n['name'] ?? `Node ${i + 1}`),
    parameters: clipParams(n['parameters']),
  }));

  // connections: { "<nodeName>": { main: [ [ {node, type, index} ] ] } }
  const edges: ForeignEdge[] = [];
  const connections = obj['connections'] as Record<string, unknown>;
  for (const [fromName, byType] of Object.entries(connections)) {
    if (!byType || typeof byType !== 'object') continue;
    for (const [outType, outputs] of Object.entries(byType as Record<string, unknown>)) {
      if (!Array.isArray(outputs)) continue;
      outputs.forEach((branch, branchIndex) => {
        if (!Array.isArray(branch)) return;
        for (const target of branch) {
          const t = target as Record<string, unknown>;
          if (typeof t['node'] !== 'string') continue;
          edges.push({
            from: fromName,
            to: t['node'],
            label:
              outputs.length > 1
                ? `${outType} output ${branchIndex}`
                : outType !== 'main'
                  ? outType
                  : undefined,
          });
        }
      });
    }
  }

  return {
    source: 'n8n',
    name: typeof obj['name'] === 'string' ? obj['name'] : undefined,
    nodes,
    edges,
  };
}

/** Flowise export: `{ nodes: [{id,data:{name,label,inputs}}], edges: [{source,target}] }`. */
function parseFlowise(obj: Record<string, unknown>): ForeignWorkflow | null {
  if (!Array.isArray(obj['nodes']) || !Array.isArray(obj['edges'])) return null;
  const rawNodes = obj['nodes'] as Record<string, unknown>[];
  if (rawNodes.length === 0) return null;
  // Flowise nodes carry a `data` object with `name`/`category`.
  if (!rawNodes.every(n => n['data'] && typeof n['data'] === 'object')) return null;

  const nodes: ForeignNode[] = rawNodes.map((n, i) => {
    const data = n['data'] as Record<string, unknown>;
    return {
      id: String(n['id'] ?? `node-${i}`),
      type: String(data['name'] ?? data['type'] ?? 'unknown'),
      name: String(data['label'] ?? data['name'] ?? `Node ${i + 1}`),
      parameters: clipParams(data['inputs']),
    };
  });

  const edges: ForeignEdge[] = (obj['edges'] as Record<string, unknown>[])
    .filter(e => typeof e['source'] === 'string' && typeof e['target'] === 'string')
    .map(e => ({ from: String(e['source']), to: String(e['target']) }));

  return { source: 'flowise', nodes, edges };
}

/**
 * Dify DSL (app export, JSON form): `{ app: {...}, workflow: { graph: { nodes, edges } } }`.
 * (Dify's native export is YAML; users can convert or paste the JSON body.)
 */
function parseDify(obj: Record<string, unknown>): ForeignWorkflow | null {
  const workflow = obj['workflow'] as Record<string, unknown> | undefined;
  const graph = workflow?.['graph'] as Record<string, unknown> | undefined;
  if (!graph || !Array.isArray(graph['nodes']) || !Array.isArray(graph['edges'])) return null;

  const rawNodes = graph['nodes'] as Record<string, unknown>[];
  if (rawNodes.length === 0) return null;

  const nodes: ForeignNode[] = rawNodes.map((n, i) => {
    const data = (n['data'] ?? {}) as Record<string, unknown>;
    return {
      id: String(n['id'] ?? `node-${i}`),
      type: String(data['type'] ?? 'unknown'),
      name: String(data['title'] ?? data['type'] ?? `Node ${i + 1}`),
      parameters: clipParams(data),
    };
  });

  const edges: ForeignEdge[] = (graph['edges'] as Record<string, unknown>[])
    .filter(e => typeof e['source'] === 'string' && typeof e['target'] === 'string')
    .map(e => ({ from: String(e['source']), to: String(e['target']) }));

  const app = obj['app'] as Record<string, unknown> | undefined;
  return {
    source: 'dify',
    name: typeof app?.['name'] === 'string' ? (app['name'] as string) : undefined,
    nodes,
    edges,
  };
}

/** Serializes a foreign workflow into a compact block for the model. */
export function summarizeForeignWorkflow(foreign: ForeignWorkflow): string {
  const nodes = foreign.nodes
    .map(
      n =>
        `- id=${n.id} type=${n.type} name="${n.name}"${n.parameters ? ` params=${n.parameters}` : ''}`,
    )
    .join('\n');
  const edges =
    foreign.edges.length === 0
      ? '(none)'
      : foreign.edges
          .map(e => `- ${e.from} -> ${e.to}${e.label ? ` [${e.label}]` : ''}`)
          .join('\n');
  return `Source tool: ${foreign.source}${foreign.name ? `\nWorkflow name: "${foreign.name}"` : ''}\n\nNodes:\n${nodes}\n\nEdges:\n${edges}`;
}
