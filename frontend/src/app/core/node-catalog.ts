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
  AggregateNodeData,
  AssertNodeData,
  DecideNodeData,
  HttpRequestNodeData,
  McpToolData,
  NodeCategory,
  NotifyNodeData,
  SqlQueryNodeData,
  StateGetNodeData,
  StateSetNodeData,
  TransformNodeData,
  WorkflowNode,
  WorkflowNodeData,
  WorkflowNodeKind,
  WorkflowPort,
} from './workflow.model';
import { CONNECTOR_STEP_PREFIX } from './connectors.model';
// Pure leaf module (no Angular, no service deps), so importing it here cannot
// introduce a DI edge into the catalog.
import { buildScheduleCron, localTimeZone } from './schedule-cron';

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
  /**
   * Palette sub-section this entry belongs to. Absent means the section named
   * after its `category` (see `NODE_CATEGORY_SECTIONS`). Data nodes set `Data`
   * so they group together while keeping the sky `flow` accent on canvas.
   */
  section?: string;
  /** Default display name for freshly dropped nodes. */
  defaultName: string;
  /** Port blueprint; ids are generated fresh per instance. */
  ports: { name: string; role: WorkflowPort['role'] }[];
  /** Kind-specific default configuration for freshly dropped nodes. */
  defaultData: () => WorkflowNodeData;
}

/** Section ordering + labels for the Agents palette.
 * Tools is intentionally last so the MCP Servers sub-section (rendered
 * underneath the tool entries) sits at the bottom of the palette. */
export const NODE_CATEGORY_SECTIONS: { category: NodeCategory; label: string }[] = [
  { category: 'agent', label: 'Agents' },
  { category: 'trigger', label: 'Triggers' },
  { category: 'flow', label: 'Flow' },
  { category: 'tool', label: 'Tools' },
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

/** Palette sub-section holding the deterministic data nodes. */
export const DATA_SECTION_LABEL = 'Data';

/** The `In` → `Out` blueprint shared by the pure data nodes. */
const DATA_IN_OUT: NodeCatalogEntry['ports'] = [
  { name: 'In', role: 'message-in' },
  { name: 'Out', role: 'message-out' },
];

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
    // 09:00 weekdays in the USER's zone, compiled to the UTC cron the runtime
    // executes. A hardcoded `0 9 * * 1-5` was 9am UTC, which the editor now
    // correctly shows as some unrelated local hour - a default nobody asked for.
    defaultData: () => {
      const timezone = localTimeZone();
      return {
        timezone,
        cron: buildScheduleCron(
          { frequency: 'weekly', hour: 9, minute: 0, weekdays: [1, 2, 3, 4, 5], dayOfMonth: 1 },
          timezone,
        ),
      };
    },
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
  {
    id: 'trigger-portal',
    label: 'Portal',
    description: 'Publishes the workflow as a shareable chat or form page.',
    icon: 'ti ti-world-share',
    category: 'trigger',
    kind: 'portal-trigger',
    keywords: ['publish', 'public', 'share', 'chat', 'form', 'endpoint', 'link'],
    defaultName: 'Portal',
    ports: [{ name: 'Message', role: 'message-out' }],
    // Runnable defaults: a public chat page needs zero configuration.
    defaultData: () => ({
      mode: 'chat' as const,
      access: 'public' as const,
      theme: 'auto' as const,
      showBranding: true,
    }),
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
  {
    id: 'flow-for-each',
    label: 'ForEach',
    description: 'Runs the loop body once per item of a JSON array.',
    icon: 'ti ti-repeat',
    category: 'flow',
    kind: 'for-each',
    keywords: ['loop', 'iterate', 'batch', 'each', 'map', 'items'],
    defaultName: 'ForEach',
    ports: [
      { name: 'In', role: 'message-in' },
      { name: 'Each item', role: 'message-out' },
      { name: 'Done', role: 'message-out' },
    ],
    defaultData: () => ({ itemsPath: '', concurrency: 1, continueOnError: true }),
  },
  {
    id: 'flow-wait-event',
    label: 'Wait for Event',
    description: 'Suspends the run until an external event arrives.',
    icon: 'ti ti-hourglass-high',
    category: 'flow',
    kind: 'wait-event',
    keywords: ['wait', 'webhook', 'event', 'suspend', 'resume', 'callback', 'sign'],
    defaultName: 'Wait for Event',
    ports: [
      { name: 'In', role: 'message-in' },
      { name: 'Resumed', role: 'message-out' },
    ],
    defaultData: () => ({ correlationKey: '', message: '' }),
  },
  {
    id: 'flow-ask-user',
    label: 'Ask User',
    description: 'Pauses the run and asks the user a free-text question.',
    icon: 'ti ti-message-question',
    category: 'flow',
    kind: 'ask-user',
    keywords: ['ask', 'question', 'input', 'human', 'prompt', 'clarify', 'response', 'hitl'],
    defaultName: 'Ask User',
    ports: [
      { name: 'In', role: 'message-in' },
      { name: 'Answered', role: 'message-out' },
    ],
    defaultData: () => ({ question: '', responseKey: 'userResponse' }),
  },
  {
    id: 'flow-execute-workflow',
    label: 'Execute Workflow',
    description: 'Runs another saved workflow and returns its result.',
    icon: 'ti ti-stack-2',
    category: 'flow',
    kind: 'execute-workflow',
    keywords: ['workflow', 'sub-workflow', 'nested', 'call', 'reuse'],
    defaultName: 'Execute Workflow',
    ports: [
      { name: 'Task', role: 'message-in' },
      { name: 'Result', role: 'message-out' },
    ],
    defaultData: () => ({}),
  },
  {
    id: 'flow-error-handler',
    label: 'Error Handler',
    description: 'Runs its subtree when the workflow fails — notify, clean up, escalate.',
    icon: 'ti ti-lifebuoy',
    category: 'flow',
    kind: 'error-handler',
    keywords: ['error', 'failure', 'catch', 'recover', 'notify', 'fallback'],
    defaultName: 'Error Handler',
    ports: [{ name: 'Error', role: 'message-out' }],
    defaultData: () => ({}),
  },

  // ── Data ───────────────────────────────────────────────────────────────────
  // Deterministic steps executed by the graph walk, never chosen by an agent.
  // They keep `category: 'flow'` (and its sky accent) but group under their own
  // `Data` palette section, rendered between Flow and Tools.
  {
    id: 'data-http-request',
    label: 'HTTP Request (step)',
    description: 'Calls an HTTP API as a deterministic step — no agent involved.',
    icon: 'ti ti-api',
    category: 'flow',
    kind: 'http-request',
    section: DATA_SECTION_LABEL,
    keywords: ['api', 'rest', 'fetch', 'sync', 'integration', 'request'],
    defaultName: 'HTTP Request',
    ports: [
      { name: 'In', role: 'message-in' },
      { name: 'Response', role: 'message-out' },
      { name: 'On error', role: 'message-out' },
    ],
    defaultData: (): HttpRequestNodeData => ({
      method: 'GET',
      url: '',
      responseMode: 'json',
      bodyMode: 'none',
      pagination: { mode: 'none' },
      retry: { maxAttempts: 3, backoffMs: 1000, idempotent: true, honorRetryAfter: true },
      fixtures: 'off',
    }),
  },
  {
    id: 'data-sql-query',
    label: 'SQL Query',
    description: 'Runs a parameterised SQL statement against a connection and returns its rows.',
    icon: 'ti ti-database-search',
    category: 'flow',
    kind: 'sql-query',
    section: DATA_SECTION_LABEL,
    keywords: ['sql', 'database', 'query', 'rows', 'postgres', 'mysql', 'select'],
    defaultName: 'SQL Query',
    ports: [
      { name: 'In', role: 'message-in' },
      { name: 'Rows', role: 'message-out' },
      { name: 'On error', role: 'message-out' },
    ],
    defaultData: (): SqlQueryNodeData => ({
      statement: '',
      params: [],
      maxRows: 10_000,
      resultKey: 'rows',
      fixtures: 'off',
    }),
  },
  {
    id: 'data-transform',
    label: 'Transform',
    description: 'Maps, casts and renames payload fields with expressions.',
    icon: 'ti ti-transform',
    category: 'flow',
    kind: 'transform',
    section: DATA_SECTION_LABEL,
    keywords: ['map', 'shape', 'field', 'rename', 'cast', 'project'],
    defaultName: 'Transform',
    ports: DATA_IN_OUT,
    defaultData: (): TransformNodeData => ({ fields: [], mode: 'record' }),
  },
  {
    id: 'data-aggregate',
    label: 'Aggregate',
    description: 'Groups, joins or pivots rows into summary records.',
    icon: 'ti ti-chart-bar',
    category: 'flow',
    kind: 'aggregate',
    section: DATA_SECTION_LABEL,
    keywords: ['group', 'join', 'pivot', 'sum', 'count', 'summarise'],
    defaultName: 'Aggregate',
    ports: DATA_IN_OUT,
    defaultData: (): AggregateNodeData => ({ op: 'group', group: { by: [], metrics: [] } }),
  },
  {
    id: 'data-assert',
    label: 'Assert',
    description: 'Guards the run — checks conditions before anything is written.',
    icon: 'ti ti-shield-check',
    category: 'flow',
    kind: 'assert',
    section: DATA_SECTION_LABEL,
    keywords: ['guard', 'check', 'validate', 'expect', 'threshold'],
    defaultName: 'Assert',
    ports: [
      { name: 'In', role: 'message-in' },
      { name: 'Passed', role: 'message-out' },
      { name: 'Failed', role: 'message-out' },
    ],
    defaultData: (): AssertNodeData => ({ assertions: [], onBreach: 'fail' }),
  },
  {
    id: 'data-state-get',
    label: 'State Get',
    description: 'Reads a durable per-workflow state value, such as a sync watermark.',
    icon: 'ti ti-bookmark',
    category: 'flow',
    kind: 'state-get',
    section: DATA_SECTION_LABEL,
    keywords: ['state', 'read', 'watermark', 'cursor', 'memory', 'durable'],
    defaultName: 'State Get',
    ports: DATA_IN_OUT,
    defaultData: (): StateGetNodeData => ({ key: '', resultKey: 'state' }),
  },
  {
    id: 'data-state-set',
    label: 'State Set',
    description: 'Writes a durable per-workflow value, delta hash or watermark.',
    icon: 'ti ti-bookmark-plus',
    category: 'flow',
    kind: 'state-set',
    section: DATA_SECTION_LABEL,
    keywords: ['state', 'write', 'watermark', 'delta', 'checkpoint', 'durable'],
    defaultName: 'State Set',
    ports: DATA_IN_OUT,
    defaultData: (): StateSetNodeData => ({ key: '', valueExpression: '', semantics: 'value' }),
  },
  {
    id: 'data-notify',
    label: 'Notify',
    description: 'Sends an email, webhook or chat message about the run.',
    icon: 'ti ti-bell',
    category: 'flow',
    kind: 'notify',
    section: DATA_SECTION_LABEL,
    keywords: ['notify', 'alert', 'email', 'webhook', 'chat', 'message'],
    defaultName: 'Notify',
    ports: [
      { name: 'In', role: 'message-in' },
      { name: 'Sent', role: 'message-out' },
      { name: 'On error', role: 'message-out' },
    ],
    defaultData: (): NotifyNodeData => ({ channel: 'webhook' }),
  },
  {
    id: 'data-decide',
    label: 'Decide',
    description: 'Asks System One typed yes/no, choice and score questions about the input in one fast call.',
    icon: 'ti ti-scale',
    category: 'flow',
    kind: 'decide',
    section: DATA_SECTION_LABEL,
    keywords: ['decide', 'classify', 'judge', 'score', 'system one', 'jev', 'typesafe', 'probability', 'triage'],
    defaultName: 'Decide',
    ports: [
      { name: 'In', role: 'message-in' },
      { name: 'Decided', role: 'message-out' },
      { name: 'On error', role: 'message-out' },
    ],
    defaultData: (): DecideNodeData => ({
      questions: [
        {
          id: 'urgent',
          type: 'noul',
          instructions: 'Does the input convey urgency or time pressure?',
        },
      ],
      resultKey: 'decisions',
    }),
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

/**
 * A user-provided command argument for an MCP preset (e.g. the allowed
 * directory for the filesystem server). Rendered as a plain text input in the
 * properties panel. Each field maps to one trailing positional argument
 * appended after the preset's static `args`, in declaration order.
 */
export interface McpArgField {
  /** Label shown in the properties panel. */
  label: string;
  /** Extra help text shown under the input. */
  description?: string;
  /** Input placeholder. */
  placeholder?: string;
  /** Default value seeded into `args` when the node is created. */
  default?: string;
}

/**
 * Guided-setup metadata for OAuth providers whose authorization server does
 * NOT support dynamic client registration (RFC 7591) — the user must register
 * an OAuth app with the provider once and paste its credentials.
 */
export interface McpOAuthSetup {
  /**
   * URL of the provider page where the user registers an OAuth app. May
   * contain a `{callback}` placeholder which the UI substitutes with the
   * URL-encoded redirect URI (pre-filling the form where supported).
   */
  registerUrlTemplate: string;
  /** Whether the provider requires a client secret at the token endpoint. */
  needsClientSecret?: boolean;
  /** One-line provider-specific instruction shown in the setup UI. */
  note?: string;
  /**
   * An app-provided OAuth client baked into the preset (the pattern GitHub's
   * own MCP binary uses). When set, users get true one-click Connect — no
   * registration step. The secret is public/non-confidential by design;
   * PKCE binds each authorization code to its login attempt. A user-stored
   * client (per node) still takes precedence.
   */
  defaultClient?: { clientId: string; clientSecret?: string };
}

/** A pre-configured MCP server users can drag-and-drop from the palette. */
export interface McpPreset {
  /** Stable preset id (also the palette drag payload, prefixed `mcp-preset:`). */
  id: string;
  label: string;
  description: string;
  /** Tabler icon class (`ti ti-*`). */
  icon: string;
  /**
   * How the server runs. `stdio` (default) spawns a local process on desktop;
   * `sse` connects to a remote HTTP endpoint (works in browser + cloud too).
   */
  transport?: 'stdio' | 'sse';
  /** For `sse` presets: the remote MCP endpoint URL. */
  url?: string;
  /**
   * For `sse` presets: the env var (in `envSchema`) whose secret value is sent
   * as `Authorization: Bearer <value>`. Omit for unauthenticated servers.
   */
  authKey?: string;
  /**
   * How an `sse` preset authenticates: `bearer` (static token via `authKey`)
   * or `oauth` (interactive OAuth 2.1, via the Connect button). Defaults to
   * `bearer` when `authKey` is set, otherwise unauthenticated.
   */
  authMode?: 'bearer' | 'oauth';
  /**
   * For `oauth` presets whose provider lacks dynamic client registration:
   * guided one-time OAuth-app setup (register link, client secret needs).
   * Omit for providers that support RFC 7591 — no setup UI is shown.
   */
  oauthSetup?: McpOAuthSetup;
  /** The executable to spawn for `stdio` presets (e.g. `uvx`, `npx`). */
  command?: string;
  /** Static arguments passed to the command, before any `argFields`. */
  args?: string[];
  /** Secret env vars the server expects (values stored in the OS keychain). */
  envSchema: McpEnvField[];
  /**
   * Preset id of a remote (`sse`) equivalent of this local server, when one
   * exists. Only meaningful on a `stdio` preset: it is what lets the studio
   * offer a concrete fix ("use X instead") when a workflow carrying this node
   * is bound for a host that cannot spawn a local process, rather than just
   * reporting that the node is undeployable.
   */
  remoteAlternativeId?: string;
  /**
   * User-provided trailing positional arguments (e.g. an allowed directory).
   * Appended to `args` in order when the node is instantiated and editable
   * from the properties panel. Not secrets.
   */
  argFields?: McpArgField[];
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
    id: 'email-remote',
    label: 'Email (send-only)',
    description:
      'Send email through Resend’s hosted MCP server with an API key. Runs in the cloud, so scheduled and deployed workflows can send mail. Sending needs a verified domain; it cannot read an existing inbox.',
    icon: 'ti ti-mail-forward',
    transport: 'sse',
    url: 'https://mcp.resend.com/mcp',
    // Bearer rather than OAuth deliberately: a static token is the ONLY MCP
    // credential a deployed worker can resolve today (`MCP_<AUTHKEY>` worker
    // secret). An OAuth session would not survive the trip to the cloud.
    authKey: 'RESEND_API_KEY',
    keywords: ['email', 'mail', 'send', 'resend', 'smtp', 'remote', 'cloud', 'notify'],
    envSchema: [
      {
        name: 'RESEND_API_KEY',
        label: 'Resend API key',
        description:
          'Create one at resend.com/api-keys, and verify your sending domain at resend.com/domains. Sent as a bearer token to the Resend MCP server.',
        secret: true,
        placeholder: 're_…',
      },
    ],
  },
  {
    id: 'email',
    label: 'Email',
    description:
      'Read, search, send, reply, and forward email across Gmail, Outlook, Yahoo, and iCloud with an app password. Runs locally, so it cannot be deployed to the cloud — use the remote “Email (send-only)” server for scheduled workflows.',
    icon: 'ti ti-mail',
    command: 'npx',
    args: ['--yes', '@n24q02m/better-email-mcp@latest'],
    remoteAlternativeId: 'email-remote',
    keywords: ['email', 'imap', 'smtp', 'inbox', 'mail', 'gmail', 'outlook', 'send'],
    envSchema: [
      {
        name: 'EMAIL_CREDENTIALS',
        label: 'Email credentials',
        description:
          'Format: you@example.com:app-password. The IMAP/SMTP host is auto-discovered from the address. Use comma-separated pairs for multiple accounts.',
        secret: true,
        placeholder: 'you@gmail.com:app-password',
      },
    ],
  },
  {
    id: 'filesystem',
    label: 'Filesystem',
    description: 'Read, write, and search files within an allowed directory.',
    icon: 'ti ti-folder',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem'],
    keywords: ['file', 'files', 'filesystem', 'directory', 'disk', 'read', 'write'],
    envSchema: [],
    argFields: [
      {
        label: 'Allowed directory',
        description: 'The only directory the server may access. An absolute path is recommended.',
        placeholder: '/Users/you/projects',
      },
    ],
  },
  {
    id: 'git',
    label: 'Git',
    description: 'Read, search, and manipulate local Git repositories.',
    icon: 'ti ti-git-branch',
    command: 'uvx',
    args: ['mcp-server-git'],
    keywords: ['git', 'repository', 'repo', 'version control', 'commit', 'diff'],
    envSchema: [],
  },
  {
    id: 'fetch',
    label: 'Fetch',
    description: 'Fetch a URL and convert its contents to clean markdown for the model.',
    icon: 'ti ti-world-www',
    command: 'uvx',
    args: ['mcp-server-fetch'],
    keywords: ['fetch', 'url', 'web', 'http', 'scrape', 'markdown', 'page'],
    envSchema: [],
  },
  {
    id: 'memory',
    label: 'Memory',
    description: 'A knowledge-graph-based persistent memory the agent can read and write.',
    icon: 'ti ti-brain',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-memory'],
    keywords: ['memory', 'knowledge graph', 'remember', 'persistent', 'notes'],
    envSchema: [],
  },
  {
    id: 'sequential-thinking',
    label: 'Sequential Thinking',
    description: 'Structured step-by-step reasoning through a sequence of revisable thoughts.',
    icon: 'ti ti-list-numbers',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
    keywords: ['thinking', 'reasoning', 'sequential', 'plan', 'steps', 'chain of thought'],
    envSchema: [],
  },
  {
    id: 'brave-search',
    label: 'Brave Search',
    description: 'Web, news, image, video, and local search via the Brave Search API.',
    icon: 'ti ti-search',
    command: 'npx',
    args: ['-y', '@brave/brave-search-mcp-server', '--transport', 'stdio'],
    keywords: ['search', 'brave', 'web', 'news', 'images', 'video', 'internet'],
    envSchema: [
      {
        name: 'BRAVE_API_KEY',
        label: 'Brave API key',
        description: 'Create one at api-dashboard.search.brave.com.',
        secret: true,
        placeholder: 'BSA…',
      },
    ],
  },
  {
    id: 'postgres',
    label: 'Postgres',
    description:
      'Query a PostgreSQL database, inspect schema, and get health and index-tuning insights. Read-only by default.',
    icon: 'ti ti-database',
    command: 'uvx',
    // `restricted` = read-only transactions; the safe default for LLM-driven
    // access. Users can switch to unrestricted via Advanced args.
    args: ['postgres-mcp', '--access-mode=restricted'],
    keywords: ['postgres', 'postgresql', 'database', 'sql', 'db', 'query'],
    envSchema: [
      {
        name: 'DATABASE_URI',
        label: 'Connection URI',
        description: 'Full Postgres connection string. Contains your password, so it is stored as a secret.',
        secret: true,
        placeholder: 'postgresql://user:password@host:5432/dbname',
      },
    ],
  },
  {
    id: 'slack',
    label: 'Slack',
    description:
      'List channels, post messages, reply to threads, add reactions, and read history in a Slack workspace.',
    icon: 'ti ti-brand-slack',
    command: 'npx',
    args: ['-y', '@zencoderai/slack-mcp-server'],
    keywords: ['slack', 'chat', 'message', 'channel', 'workspace', 'notify'],
    envSchema: [
      {
        name: 'SLACK_BOT_TOKEN',
        label: 'Bot User OAuth token',
        description: 'The xoxb- token from your Slack app’s OAuth & Permissions page.',
        secret: true,
        placeholder: 'xoxb-…',
      },
      {
        name: 'SLACK_TEAM_ID',
        label: 'Team ID',
        description: 'Your workspace/team ID (starts with T).',
        secret: false,
        placeholder: 'T01234567',
      },
    ],
  },
  {
    id: 'atlassian-remote',
    label: 'Jira & Confluence (OAuth)',
    description:
      'Atlassian’s official Rovo MCP server, authorized by signing in with your Atlassian account. The sign-in session stays on this device, so deployed and scheduled workflows can’t authenticate with it yet. Local runs only.',
    icon: 'ti ti-brand-jira',
    transport: 'sse',
    // Atlassian's official remote endpoint. Supports dynamic client
    // registration, so no guided `oauthSetup` step is needed.
    url: 'https://mcp.atlassian.com/v1/mcp/authv2',
    authMode: 'oauth',
    keywords: [
      'jira', 'confluence', 'atlassian', 'rovo', 'issue', 'ticket', 'sprint',
      'backlog', 'jql', 'board', 'epic', 'story', 'remote', 'oauth', 'cloud',
    ],
    envSchema: [],
  },
  {
    id: 'jira',
    label: 'Jira',
    description:
      'Search issues with JQL, read and create issues, add comments, and transition status. Runs locally, so it cannot be deployed to the cloud.',
    icon: 'ti ti-brand-jira',
    command: 'uvx',
    args: ['mcp-atlassian'],
    remoteAlternativeId: 'atlassian-remote',
    keywords: [
      'jira', 'atlassian', 'issue', 'ticket', 'bug', 'sprint', 'backlog',
      'jql', 'board', 'project', 'epic', 'story',
    ],
    envSchema: [
      {
        name: 'JIRA_URL',
        label: 'Jira site URL',
        description:
          'Your Atlassian Cloud site. For Server/Data Center use the base URL of your instance (v8.14+).',
        secret: false,
        placeholder: 'https://your-company.atlassian.net',
      },
      {
        name: 'JIRA_USERNAME',
        label: 'Account email',
        description: 'The Atlassian account email the API token belongs to.',
        secret: false,
        placeholder: 'you@company.com',
      },
      {
        name: 'JIRA_API_TOKEN',
        label: 'API token',
        description:
          'Create one at id.atlassian.com/manage-profile/security/api-tokens. Server/Data Center users paste a personal access token instead.',
        secret: true,
        placeholder: 'ATATT…',
      },
    ],
  },
  {
    id: 'github',
    label: 'GitHub (token)',
    description:
      'Manage repositories, issues, pull requests, and code via GitHub’s official remote MCP server, authenticated with a personal access token.',
    icon: 'ti ti-brand-github',
    transport: 'sse',
    url: 'https://api.githubcopilot.com/mcp/',
    authKey: 'GITHUB_TOKEN',
    keywords: ['github', 'git', 'repo', 'issue', 'pull request', 'pr', 'code', 'pat', 'token'],
    envSchema: [
      {
        name: 'GITHUB_TOKEN',
        label: 'GitHub token',
        description:
          'A fine-grained personal access token (or PAT). Sent as a bearer token to the GitHub MCP server.',
        secret: true,
        placeholder: 'github_pat_… or ghp_…',
      },
    ],
  },
  {
    id: 'github-oauth',
    label: 'GitHub (OAuth)',
    description:
      'GitHub’s official remote MCP server, authorized by signing in with GitHub. One-time setup: register a free OAuth app on your account (guided).',
    icon: 'ti ti-brand-github',
    transport: 'sse',
    url: 'https://api.githubcopilot.com/mcp/',
    authMode: 'oauth',
    // GitHub's OAuth authorization server supports neither dynamic client
    // registration nor secret-less token exchange (the client secret is
    // REQUIRED at the token endpoint even for public clients; PKCE binds the
    // code). So users register their own OAuth app once — the register link
    // pre-fills the form, including the callback URL.
    oauthSetup: {
      registerUrlTemplate:
        'https://github.com/settings/applications/new' +
        '?oauth_application%5Bname%5D=Phorma%20Agent%20Studio' +
        '&oauth_application%5Burl%5D=https%3A%2F%2Fphorma.dev' +
        '&oauth_application%5Bcallback_url%5D={callback}',
      needsClientSecret: true,
      note: 'GitHub requires both the Client ID and a Client secret — generate the secret on the app page after registering.',
    },
    keywords: ['github', 'git', 'repo', 'issue', 'pull request', 'pr', 'code', 'oauth', 'sign in'],
    envSchema: [],
  },
  {
    id: 'remote-mcp-oauth',
    label: 'Remote MCP (OAuth)',
    description:
      'Connect to any OAuth-protected remote MCP server. Enter its URL, then click Connect to authorize.',
    icon: 'ti ti-plug-connected',
    transport: 'sse',
    url: '',
    authMode: 'oauth',
    keywords: ['mcp', 'remote', 'oauth', 'custom', 'server', 'url'],
    envSchema: [],
  },
  {
    id: 'xero',
    label: 'Xero',
    description:
      'Xero’s official MCP server: contacts, invoices, manual journals, reports, and chart of accounts for one organisation (Custom Connection).',
    icon: 'ti ti-wallet',
    command: 'npx',
    args: ['-y', '@xeroapi/xero-mcp-server@latest'],
    keywords: ['xero', 'accounting', 'invoice', 'journal', 'ledger', 'bookkeeping'],
    envSchema: [
      {
        name: 'XERO_CLIENT_ID',
        label: 'Client ID',
        description:
          'From a Xero Custom Connection (developer.xero.com → New app → Custom Connection). One connection per organisation.',
        secret: false,
        placeholder: 'ABCDEF0123456789…',
      },
      {
        name: 'XERO_CLIENT_SECRET',
        label: 'Client secret',
        description: 'The Custom Connection client secret.',
        secret: true,
        placeholder: '…',
      },
    ],
  },
  {
    id: 'phorma-practice',
    label: 'Practice Suite',
    description:
      'Accounting-practice automation: multi-entity Xero (pay runs, payroll figures, journals), XPM jobs and clients, IAS PDF generation, and e-signatures. One firm login covers every client organisation.',
    icon: 'ti ti-briefcase',
    command: 'npx',
    args: ['-y', 'tsx', 'mcp/phorma-practice-mcp/src/stdio.ts'],
    keywords: [
      'practice', 'accounting', 'xero', 'xpm', 'payroll', 'ias', 'paygw', 'bas',
      'tax', 'journal', 'esign', 'annature', 'firm', 'entity', 'lodgement',
    ],
    envSchema: [
      {
        name: 'XERO_CLIENT_ID',
        label: 'Xero app Client ID',
        description: 'The firm’s Xero OAuth app (standard web app, offline_access scope).',
        secret: false,
        placeholder: 'ABCDEF0123456789…',
      },
      {
        name: 'XERO_CLIENT_SECRET',
        label: 'Xero app Client secret',
        description: 'The firm’s Xero OAuth app secret.',
        secret: true,
        placeholder: '…',
      },
      {
        name: 'XERO_REFRESH_TOKEN',
        label: 'Xero refresh token',
        description:
          'From the one-time firm consent flow. The server refreshes access tokens automatically and can reach every connected client organisation.',
        secret: true,
        placeholder: '…',
      },
      {
        name: 'XPM_PRACTICE_TENANT_ID',
        label: 'XPM practice tenant ID',
        description:
          'The PRACTICEMANAGER tenant id (run the xero_list_entities tool once to find it). Needed for job-list tools; requires Xero App Partner approval for XPM scopes.',
        secret: false,
        placeholder: 'xxxxxxxx-xxxx-…',
      },
      {
        name: 'ANNATURE_ID',
        label: 'Annature API ID',
        description: 'From the Annature dashboard → Developers. Used by the e-signature tools.',
        secret: false,
        placeholder: '…',
      },
      {
        name: 'ANNATURE_KEY',
        label: 'Annature API key',
        description: 'The matching Annature API key.',
        secret: true,
        placeholder: '…',
      },
    ],
  },
];

/** Finds an MCP preset by id. */
export function findMcpPreset(id: string): McpPreset | undefined {
  return MCP_PRESETS.find(preset => preset.id === id);
}

/**
 * Where an MCP server runs, and whether a deployed worker can actually
 * authenticate it. This is the single most consequential fact about an MCP
 * node - a local server cannot be deployed at all, and an OAuth session never
 * reaches a deployed worker either - so it is shown as an icon everywhere a
 * server or node appears rather than spelled into labels.
 */
export type McpTransportKind = 'local' | 'remote' | 'oauth';

/**
 * `local` unless the transport is explicitly remote; a remote server using
 * interactive OAuth is `oauth` (its session cannot reach a deployed worker -
 * see the engine's `mcpOAuth` capability), everything else remote is
 * `remote`. Matches `defaultData()`.
 */
export function mcpTransportKind(transport: string | undefined, authMode?: string): McpTransportKind {
  if (transport !== 'sse') return 'local';
  return authMode === 'oauth' ? 'oauth' : 'remote';
}

/**
 * Tabler icon for a transport. Remote deliberately has NO entry: it is drawn
 * with the Phorma Cloud glyph (`app-phorma-cloud-icon`) so "runs in our cloud"
 * carries the product's own mark. Canvas painting, which has no DOM, uses
 * {@link MCP_TRANSPORT_CANVAS_ICON} instead.
 */
export const MCP_LOCAL_ICON = 'ti ti-device-desktop';

/** Sign-in (OAuth) transport icon: a remote server, but deliberately not the
 * cloud glyph - its session is not something a deployed worker can use. */
export const MCP_OAUTH_ICON = 'ti ti-key';

/** Canvas-only glyphs: Canvas2D paints from the icon font, so it needs a
 * Tabler class for every transport. `ti-cloud` stands in for the SVG mark. */
export const MCP_TRANSPORT_CANVAS_ICON: Record<McpTransportKind, string> = {
  local: MCP_LOCAL_ICON,
  remote: 'ti ti-cloud',
  oauth: MCP_OAUTH_ICON,
};

/** Tooltip / aria text explaining what a transport means for deployment. */
export const MCP_TRANSPORT_LABEL: Record<McpTransportKind, string> = {
  local: 'Local server - runs on this machine, cannot be deployed to the cloud',
  remote: 'Remote server - runs in the cloud, works in deployed workflows',
  oauth: 'Sign-in (OAuth) server - the signed-in session stays on this device, so it cannot be deployed or scheduled',
};

/** Prefix used for synthesized catalog entries derived from MCP presets. */
const MCP_PRESET_PREFIX = 'mcp-preset:';

/**
 * Resolver for `connector-step:` ids, installed by `ConnectorsService` (P1-14).
 *
 * Installed connectors are RUNTIME state, so they cannot live in the
 * compile-time `NODE_CATALOG` this module owns. A one-function seam is what lets
 * every existing consumer of {@link findCatalogEntry} - the canvas drop, the
 * click-to-add path, the AI router, the test harness - instantiate a connector
 * step with no changes and, crucially, no dependency-injection edge from
 * `WorkflowService` into `ConnectorsService` (which would close a cycle through
 * `ConnectionsService`, and NG0200 is already a hazard on the run path).
 *
 * `NODE_CATALOG` itself is untouched: this is a second lookup, exactly like the
 * MCP preset branch, not a mutable catalog.
 */
type ConnectorStepResolver = (entryId: string) => NodeCatalogEntry | undefined;
let connectorStepResolver: ConnectorStepResolver | undefined;

/** Installs (or clears, with `undefined`) the connector-step resolver. */
export function registerConnectorStepResolver(resolver: ConnectorStepResolver | undefined): void {
  connectorStepResolver = resolver;
}

/** Finds a catalog entry by preset id (also resolves MCP presets and connector steps). */
export function findCatalogEntry(id: string): NodeCatalogEntry | undefined {
  const direct = NODE_CATALOG.find(entry => entry.id === id);
  if (direct) return direct;
  if (id.startsWith(MCP_PRESET_PREFIX)) {
    return mcpPresetToCatalogEntry(id.slice(MCP_PRESET_PREFIX.length));
  }
  if (id.startsWith(CONNECTOR_STEP_PREFIX)) return connectorStepResolver?.(id);
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
    defaultData: () =>
      preset.transport === 'sse'
        ? ({
            transport: 'sse',
            url: preset.url,
            // Auth secrets (if any) are still tracked as envKeys so the
            // properties panel + settings can collect them; authKey names the
            // one used as the bearer token.
            envKeys: preset.envSchema.map(field => field.name),
            authKey: preset.authKey,
            authMode: preset.authMode ?? (preset.authKey ? 'bearer' : undefined),
            presetId: preset.id,
          } as McpToolData)
        : ({
            transport: 'stdio',
            command: preset.command ?? '',
            // Static args, then one trailing positional per argField (seeded
            // with its default, if any). Users edit these in the panel.
            args: [
              ...(preset.args ?? []),
              ...(preset.argFields ?? []).map(field => field.default ?? ''),
            ],
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
