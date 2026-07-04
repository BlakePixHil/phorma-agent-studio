/**
 * Node catalog — every node type a user can drag onto the canvas.
 *
 * Replaces Phorma Code's primitive/palette preset system. Registry-driven:
 * adding a new node type means adding an entry here (plus, when it has
 * behaviour, an executor in the engine) — the palette, canvas, and panels
 * pick it up automatically.
 */

import type {
  AgentNodeData,
  McpToolData,
  NodeCategory,
  WorkflowNode,
  WorkflowNodeData,
  WorkflowNodeKind,
  WorkflowPort,
} from './workflow.model';

/** MIME type used for palette → canvas drag-and-drop payloads. */
export const PHORMA_NODE_MIME = 'application/x-phorma-node';

export interface NodeCatalogEntry {
  /** Stable preset id (also the drag payload). */
  id: string;
  label: string;
  description: string;
  /** Tabler icon class (`ti ti-*`). */
  icon: string;
  category: NodeCategory;
  kind: WorkflowNodeKind;
  /** Extra search terms for the palette filter. */
  keywords?: string[];
  /** Default display name for freshly dropped nodes. */
  defaultName: string;
  /** Port blueprint; ids are generated fresh per instance. */
  ports: { name: string; role: WorkflowPort['role'] }[];
  /** Kind-specific default configuration for freshly dropped nodes. */
  defaultData: () => WorkflowNodeData;
}

/** Section ordering + labels for the Agents palette. */
export const NODE_CATEGORY_SECTIONS: { category: NodeCategory; label: string }[] = [
  { category: 'agent', label: 'Agents' },
  { category: 'trigger', label: 'Triggers' },
  { category: 'tool', label: 'Tools' },
  { category: 'flow', label: 'Flow' },
];

/**
 * New agents carry no provider/model — they inherit the application default
 * model (Settings → Models) until the user picks one explicitly in the
 * Prompt panel. Resolution happens at run time (local) or push time (cloud).
 */
function agentData(prompt: string): AgentNodeData {
  return { prompt };
}

const AGENT_PORTS: NodeCatalogEntry['ports'] = [
  { name: 'Task', role: 'message-in' },
  { name: 'Result', role: 'message-out' },
  { name: 'Tools', role: 'tools' },
];

const TOOL_PORTS: NodeCatalogEntry['ports'] = [{ name: 'Tool', role: 'tools' }];

export const NODE_CATALOG: NodeCatalogEntry[] = [
  // ── Agents ─────────────────────────────────────────────────────────────────
  {
    id: 'agent-blank',
    label: 'Agent',
    description: 'A blank agent — bring your own prompt.',
    icon: 'ti ti-robot',
    category: 'agent',
    kind: 'agent',
    keywords: ['llm', 'assistant', 'worker'],
    defaultName: 'New Agent',
    ports: AGENT_PORTS,
    defaultData: () =>
      agentData('# Role\n\nYou are a helpful agent.\n\n# Task\n\n{{input}}\n'),
  },
  {
    id: 'agent-researcher',
    label: 'Researcher',
    description: 'Gathers facts and sources before anyone else acts.',
    icon: 'ti ti-zoom-question',
    category: 'agent',
    kind: 'agent',
    keywords: ['research', 'facts', 'investigate'],
    defaultName: 'Researcher',
    ports: AGENT_PORTS,
    defaultData: () =>
      agentData(
        '# Role\n\nYou are a meticulous researcher. Investigate the task below and produce concise, well-organized findings.\n\n# Rules\n\n- Cite where each fact came from (tool results, given context).\n- Distinguish facts from assumptions.\n- If information is missing, say so explicitly.\n\n# Task\n\n{{input}}\n',
      ),
  },
  {
    id: 'agent-writer',
    label: 'Writer',
    description: 'Turns findings and briefs into polished prose.',
    icon: 'ti ti-pencil',
    category: 'agent',
    kind: 'agent',
    keywords: ['write', 'draft', 'compose', 'copy'],
    defaultName: 'Writer',
    ports: AGENT_PORTS,
    defaultData: () =>
      agentData(
        '# Role\n\nYou are a skilled writer. Turn the material below into clear, engaging prose.\n\n# Rules\n\n- Match the tone requested in the task; default to plain professional English.\n- Keep structure scannable: headings, short paragraphs.\n\n# Material\n\n{{input}}\n',
      ),
  },
  {
    id: 'agent-reviewer',
    label: 'Reviewer',
    description: 'Critiques work against requirements before it ships.',
    icon: 'ti ti-eye-check',
    category: 'agent',
    kind: 'agent',
    keywords: ['review', 'critique', 'qa', 'check'],
    defaultName: 'Reviewer',
    ports: AGENT_PORTS,
    defaultData: () =>
      agentData(
        '# Role\n\nYou are an exacting reviewer. Assess the work below against its requirements.\n\n# Output\n\n- A verdict: APPROVE or REVISE.\n- A numbered list of specific, actionable issues (empty when approving).\n\n# Work to review\n\n{{input}}\n',
      ),
  },
  {
    id: 'agent-classifier',
    label: 'Classifier',
    description: 'Sorts incoming work into exactly one category.',
    icon: 'ti ti-category',
    category: 'agent',
    kind: 'agent',
    keywords: ['classify', 'triage', 'label', 'sort'],
    defaultName: 'Classifier',
    ports: AGENT_PORTS,
    defaultData: () =>
      agentData(
        '# Role\n\nYou are a precise classifier. Assign the input below to exactly one of the allowed categories.\n\n# Rules\n\n- Respond with the category name only — no explanation.\n- When uncertain, pick the closest category rather than inventing one.\n\n# Input\n\n{{input}}\n',
      ),
  },
  {
    id: 'agent-coordinator',
    label: 'Coordinator',
    description: 'Breaks work down and delegates to other agents.',
    icon: 'ti ti-sitemap',
    category: 'agent',
    kind: 'agent',
    keywords: ['orchestrate', 'delegate', 'manager', 'plan'],
    defaultName: 'Coordinator',
    ports: AGENT_PORTS,
    defaultData: () =>
      agentData(
        '# Role\n\nYou are a coordinator. Break the task below into steps, decide what to do yourself versus hand off, and keep the overall goal in sight.\n\n# Rules\n\n- Delegate via your handoffs when a specialist exists for a step.\n- Summarize progress when handing work onward.\n\n# Task\n\n{{input}}\n',
      ),
  },

  // ── Triggers ───────────────────────────────────────────────────────────────
  {
    id: 'trigger-manual',
    label: 'Manual',
    description: 'Starts the workflow from the Run button.',
    icon: 'ti ti-player-play',
    category: 'trigger',
    kind: 'manual-trigger',
    keywords: ['start', 'run', 'begin'],
    defaultName: 'Manual Trigger',
    ports: [{ name: 'Start', role: 'message-out' }],
    defaultData: () => ({}),
  },
  {
    id: 'trigger-schedule',
    label: 'Schedule',
    description: 'Starts the workflow on a cron schedule (cloud).',
    icon: 'ti ti-clock-play',
    category: 'trigger',
    kind: 'schedule-trigger',
    keywords: ['cron', 'timer', 'recurring'],
    defaultName: 'Schedule',
    ports: [{ name: 'Tick', role: 'message-out' }],
    defaultData: () => ({ cron: '0 9 * * 1-5' }),
  },
  {
    id: 'trigger-webhook',
    label: 'Webhook',
    description: 'Starts the workflow from an HTTP request (cloud).',
    icon: 'ti ti-webhook',
    category: 'trigger',
    kind: 'webhook-trigger',
    keywords: ['http', 'endpoint', 'api', 'incoming'],
    defaultName: 'Webhook',
    ports: [{ name: 'Request', role: 'message-out' }],
    defaultData: () => ({ path: '' }),
  },

  // ── Tools ──────────────────────────────────────────────────────────────────
  {
    id: 'tool-http',
    label: 'HTTP Request',
    description: 'Lets an agent call any HTTP API.',
    icon: 'ti ti-world',
    category: 'tool',
    kind: 'http-tool',
    keywords: ['api', 'rest', 'fetch', 'request'],
    defaultName: 'HTTP Request',
    ports: TOOL_PORTS,
    defaultData: () => ({ method: 'GET', url: '' }),
  },
  {
    id: 'tool-web-search',
    label: 'Web Search',
    description: 'Lets an agent search the web.',
    icon: 'ti ti-world-search',
    category: 'tool',
    kind: 'web-search-tool',
    keywords: ['search', 'google', 'lookup'],
    defaultName: 'Web Search',
    ports: TOOL_PORTS,
    defaultData: () => ({ maxResults: 5 }),
  },
  {
    id: 'tool-mcp',
    label: 'MCP Server',
    description: 'Exposes every tool from a Model Context Protocol server.',
    icon: 'ti ti-plug-connected',
    category: 'tool',
    kind: 'mcp-tool',
    keywords: ['mcp', 'extension', 'integration', 'plugin'],
    defaultName: 'MCP Server',
    ports: TOOL_PORTS,
    defaultData: () => ({ transport: 'stdio', command: '', args: [] }),
  },

  // ── Flow ───────────────────────────────────────────────────────────────────
  {
    id: 'flow-router',
    label: 'Router',
    description: 'Branches the flow — each out port is a route.',
    icon: 'ti ti-arrows-split-2',
    category: 'flow',
    kind: 'router',
    keywords: ['branch', 'decision', 'switch', 'if'],
    defaultName: 'Router',
    ports: [
      { name: 'In', role: 'message-in' },
      { name: 'Route A', role: 'message-out' },
      { name: 'Route B', role: 'message-out' },
    ],
    defaultData: () => ({ instructions: '' }),
  },
  {
    id: 'flow-parallel',
    label: 'Parallel',
    description: 'Fans the task out to several agents at once.',
    icon: 'ti ti-arrows-shuffle',
    category: 'flow',
    kind: 'parallel',
    keywords: ['fan-out', 'concurrent', 'split'],
    defaultName: 'Parallel',
    ports: [
      { name: 'In', role: 'message-in' },
      { name: 'Branch A', role: 'message-out' },
      { name: 'Branch B', role: 'message-out' },
    ],
    defaultData: () => ({}),
  },
  {
    id: 'flow-aggregator',
    label: 'Aggregator',
    description: 'Waits for parallel branches and merges their results.',
    icon: 'ti ti-arrows-join-2',
    category: 'flow',
    kind: 'aggregator',
    keywords: ['fan-in', 'merge', 'join', 'combine'],
    defaultName: 'Aggregator',
    ports: [
      { name: 'Input A', role: 'message-in' },
      { name: 'Input B', role: 'message-in' },
      { name: 'Merged', role: 'message-out' },
    ],
    defaultData: () => ({}),
  },
  {
    id: 'flow-approval',
    label: 'Approval Gate',
    description: 'Pauses the run until a human approves.',
    icon: 'ti ti-user-check',
    category: 'flow',
    kind: 'approval-gate',
    keywords: ['human', 'review', 'pause', 'confirm', 'hitl'],
    defaultName: 'Approval Gate',
    ports: [
      { name: 'In', role: 'message-in' },
      { name: 'Approved', role: 'message-out' },
      { name: 'Rejected', role: 'message-out' },
    ],
    defaultData: () => ({ message: '' }),
  },
];

// ── MCP presets ─────────────────────────────────────────────────────────────

/** A configurable environment variable for an MCP preset. */
export interface McpEnvField {
  /** The env var name passed to the spawned process (e.g. `IMAP_SERVER`). */
  name: string;
  /** Human-readable label for the properties panel. */
  label: string;
  /** Extra help text shown under the input. */
  description?: string;
  /** Whether the value is a secret (rendered as a password input). */
  secret: boolean;
  /** Input placeholder. */
  placeholder?: string;
}

/** A pre-configured MCP server users can drag-and-drop from the palette. */
export interface McpPreset {
  /** Stable preset id (also the palette drag payload, prefixed `mcp-preset:`). */
  id: string;
  label: string;
  description: string;
  /** Tabler icon class (`ti ti-*`). */
  icon: string;
  /** The executable to spawn (e.g. `uvx`, `npx`). */
  command: string;
  /** Arguments passed to the command. */
  args: string[];
  /** Secret env vars the server expects (values stored in the OS keychain). */
  envSchema: McpEnvField[];
  /** Extra search terms for the palette filter. */
  keywords?: string[];
}

/**
 * Registry of pre-configured MCP servers. Adding a new preset = one entry
 * here; the palette, properties panel, and node instantiation pick it up
 * automatically.
 */
export const MCP_PRESETS: McpPreset[] = [
  {
    id: 'email-reader',
    label: 'Email Reader',
    description: 'Read, search, and download attachments from an IMAP inbox.',
    icon: 'ti ti-mail',
    command: 'uvx',
    args: ['--from', 'git+https://github.com/karateboss/mcp_email_reader@main', 'mcp_email_reader'],
    keywords: ['email', 'imap', 'inbox', 'mail', 'read'],
    envSchema: [
      {
        name: 'IMAP_SERVER',
        label: 'IMAP server',
        description: 'Your email provider’s IMAP host (e.g. imap.gmail.com).',
        secret: false,
        placeholder: 'imap.gmail.com',
      },
      {
        name: 'EMAIL_ACCOUNT',
        label: 'Email account',
        description: 'The email address to read from.',
        secret: false,
        placeholder: 'you@example.com',
      },
      {
        name: 'EMAIL_PASSWORD_ENC',
        label: 'Encrypted password',
        description: 'Your email password encrypted with the secret key below.',
        secret: true,
        placeholder: '••••••••',
      },
      {
        name: 'EMAIL_SECRET_KEY',
        label: 'Secret key',
        description: 'The key used to encrypt/decrypt the password.',
        secret: true,
        placeholder: '••••••••',
      },
    ],
  },
];

/** Finds an MCP preset by id. */
export function findMcpPreset(id: string): McpPreset | undefined {
  return MCP_PRESETS.find(preset => preset.id === id);
}

/** Prefix used for synthesized catalog entries derived from MCP presets. */
const MCP_PRESET_PREFIX = 'mcp-preset:';

/** Finds a catalog entry by preset id (also resolves MCP preset ids). */
export function findCatalogEntry(id: string): NodeCatalogEntry | undefined {
  const direct = NODE_CATALOG.find(entry => entry.id === id);
  if (direct) return direct;
  if (id.startsWith(MCP_PRESET_PREFIX)) {
    return mcpPresetToCatalogEntry(id.slice(MCP_PRESET_PREFIX.length));
  }
  return undefined;
}

/** Finds the catalog entry that produced a node of the given kind. */
export function findCatalogEntryByKind(kind: string): NodeCatalogEntry | undefined {
  return NODE_CATALOG.find(entry => entry.kind === kind);
}

/**
 * Synthesizes a transient catalog entry from an MCP preset so the existing
 * palette → canvas drop/click path works without special-casing.
 */
function mcpPresetToCatalogEntry(presetId: string): NodeCatalogEntry | undefined {
  const preset = findMcpPreset(presetId);
  if (!preset) return undefined;
  return {
    id: `${MCP_PRESET_PREFIX}${preset.id}`,
    label: preset.label,
    description: preset.description,
    icon: preset.icon,
    category: 'tool',
    kind: 'mcp-tool',
    keywords: preset.keywords,
    defaultName: preset.label,
    ports: TOOL_PORTS,
    defaultData: () => ({
      transport: 'stdio',
      command: preset.command,
      args: [...preset.args],
      envKeys: preset.envSchema.map(field => field.name),
      presetId: preset.id,
    } as McpToolData),
  };
}

/** Catalog-entry id for a given MCP preset (the palette drag payload). */
export function mcpPresetEntryId(presetId: string): string {
  return `${MCP_PRESET_PREFIX}${presetId}`;
}

let nodeCounter = 0;

function freshId(prefix: string): string {
  nodeCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${nodeCounter}`;
}

/** Instantiates a catalog entry as a canvas node at the given position. */
export function buildNodeFromCatalog(
  entry: NodeCatalogEntry,
  position: { x: number; y: number },
): WorkflowNode {
  const nodeId = freshId('node');
  return {
    id: nodeId,
    name: entry.defaultName,
    kind: entry.kind,
    category: entry.category,
    icon: entry.icon,
    position,
    ports: entry.ports.map((port, index) => ({
      id: freshId(`${nodeId}-p${index}`),
      name: port.name,
      role: port.role,
    })),
    data: entry.defaultData(),
    description: entry.description,
  };
}
