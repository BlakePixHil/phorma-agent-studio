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
    id: 'email',
    label: 'Email',
    description:
      'Read, search, send, reply, and forward email across Gmail, Outlook, Yahoo, and iCloud. Uses an app password — no OAuth setup.',
    icon: 'ti ti-mail',
    command: 'npx',
    args: ['--yes', '@n24q02m/better-email-mcp@latest'],
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
