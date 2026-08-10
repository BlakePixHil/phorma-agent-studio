/**
 * Workflow templates — prebuilt, ready-to-run workflow specs users open from
 * the Workflows panel. A template materializes as a fresh unsaved tab via
 * `WorkflowService.importSpec()`; saving links it into the library.
 *
 * Keep this file free of Angular imports (plain data + builders), mirroring
 * the node catalog's registry-driven discipline: adding a template = one
 * entry in {@link WORKFLOW_TEMPLATES}.
 */

import type {
  AgentNodeData,
  ForEachNodeData,
  HttpToolData,
  NodeCategory,
  WaitEventNodeData,
  WorkflowConnection,
  WorkflowGraph,
  WorkflowNode,
  WorkflowNodeData,
  WorkflowNodeKind,
  WorkflowPort,
  WorkflowSpec,
} from './workflow.model';
import { findMcpPreset } from './node-catalog';

export interface WorkflowTemplate {
  /** Stable template id. */
  id: string;
  label: string;
  description: string;
  /** Tabler icon class (`ti ti-*`). */
  icon: string;
  /** Builds a fresh spec (safe to open multiple times — tabs are separate docs). */
  build(): WorkflowSpec;
}

// ── Spec-building helpers (stable, template-scoped ids) ──────────────────────

interface TemplateNodeInit {
  id: string;
  name: string;
  kind: WorkflowNodeKind;
  category: NodeCategory;
  icon: string;
  x: number;
  y: number;
  ports: { key: string; name: string; role: WorkflowPort['role'] }[];
  data: WorkflowNodeData;
  description?: string;
}

function node(init: TemplateNodeInit): WorkflowNode {
  return {
    id: init.id,
    name: init.name,
    kind: init.kind,
    category: init.category,
    icon: init.icon,
    position: { x: init.x, y: init.y },
    ports: init.ports.map(port => ({ id: `${init.id}-${port.key}`, name: port.name, role: port.role })),
    data: init.data,
    description: init.description,
  };
}

let connectionCounter = 0;
function connect(
  fromNodeId: string,
  fromPortKey: string,
  toNodeId: string,
  toPortKey: string,
  kind: WorkflowConnection['kind'] = 'handoff',
): WorkflowConnection {
  connectionCounter += 1;
  return {
    id: `${fromNodeId}-to-${toNodeId}-${connectionCounter}`,
    outputId: `${fromNodeId}-${fromPortKey}-out`,
    inputId: `${toNodeId}-${toPortKey}-in`,
    kind,
  };
}

const AGENT_PORTS: TemplateNodeInit['ports'] = [
  { key: 'task', name: 'Task', role: 'message-in' },
  { key: 'result', name: 'Result', role: 'message-out' },
  { key: 'tools', name: 'Tools', role: 'tools' },
];

function agent(
  id: string,
  name: string,
  x: number,
  y: number,
  prompt: string,
  description?: string,
  /** Optional AgentNodeData overrides (e.g. toolResultCapChars, maxToolRounds). */
  dataOverride?: Partial<Omit<AgentNodeData, 'prompt'>>,
): WorkflowNode {
  return node({
    id,
    name,
    kind: 'agent',
    category: 'agent',
    icon: 'ti ti-robot',
    x,
    y,
    ports: AGENT_PORTS,
    data: { prompt, ...dataOverride } satisfies AgentNodeData,
    description,
  });
}

// ── Template: Monthly IAS (PAYGW) ────────────────────────────────────────────

/**
 * The monthly Instalment Activity Statement workflow for an accounting firm:
 * find open IAS jobs in XPM, and for each client entity verify pay runs,
 * extract payroll figures, journal the PAYGW liability in Xero, send the IAS
 * summary for e-signature, then hand staff a lodgement pack for the manual
 * XPM/ATO steps (the XPM tax API gap — see mcp/phorma-practice-mcp/SPIKE-FINDINGS.md).
 */
function buildIasWorkflow(): WorkflowSpec {
  connectionCounter = 0;
  const practicePreset = findMcpPreset('phorma-practice');
  const emailPreset = findMcpPreset('email');

  const nodes: WorkflowNode[] = [
    node({
      id: 'tpl-ias-trigger',
      name: 'Start of month',
      kind: 'schedule-trigger',
      category: 'trigger',
      icon: 'ti ti-clock-play',
      x: 80,
      y: 320,
      ports: [{ key: 'tick', name: 'Tick', role: 'message-out' }],
      data: { cron: '0 8 1 * *' },
      description: '8am on the 1st — kicks off last month’s IAS round.',
    }),

    agent(
      'tpl-ias-jobs',
      'IAS Job Finder',
      360,
      320,
      [
        '# Role',
        '',
        'You find the IAS jobs due for processing this month.',
        '',
        '# Steps',
        '',
        '1. Call `xpm_list_open_jobs` with filter "IAS".',
        '2. Work out last month as YYYY-MM (today minus one month).',
        '3. For each job, call `xpm_get_client` to fetch the client contacts; pick the responsible',
        '   signer (first contact with an email, preferring positions like Director or Trustee).',
        '',
        '# Output',
        '',
        'STRICT JSON only, no prose:',
        '{"month":"YYYY-MM","jobs":[{"jobId":"…","jobName":"…","entity":"<client name>",',
        '"clientId":"…","signerName":"…","signerEmail":"…","month":"YYYY-MM"}]}',
        '',
        'Include `month` on EVERY job so downstream steps are self-contained.',
        'If there are no jobs, output {"month":"YYYY-MM","jobs":[]}.',
      ].join('\n'),
      'Reads the open IAS job list from XPM and resolves each entity’s signer.',
    ),

    node({
      id: 'tpl-ias-loop',
      name: 'Each IAS job',
      kind: 'for-each',
      category: 'flow',
      icon: 'ti ti-repeat',
      x: 640,
      y: 320,
      ports: [
        { key: 'input', name: 'In', role: 'message-in' },
        { key: 'each', name: 'Each item', role: 'message-out' },
        { key: 'done', name: 'Done', role: 'message-out' },
      ],
      data: { itemsPath: 'jobs', concurrency: 1, continueOnError: true } satisfies ForEachNodeData,
      description: 'One pass per client entity; a failed entity is recorded and the batch continues.',
    }),

    agent(
      'tpl-ias-prep',
      'Entity Preparer',
      920,
      140,
      [
        '# Role',
        '',
        'You verify one entity is ready for its monthly IAS. The task JSON has entity, jobId,',
        'month, signerName, signerEmail.',
        '',
        '# Steps',
        '',
        '1. Idempotency: call `xero_payroll_activity_summary` for {{entity}} and {{month}} — but first',
        '   call `xero_check_payruns_posted`. If ANY pay run is unposted, this entity is NOT ready.',
        '2. When ready, note grossWages and taxWithheld from the activity summary.',
        '3. Call `xero_list_accounts` with filter "PAYG" and pick the PAYG Withholding Payable account',
        '   code; then filter "ATO" for the ATO Integrated Client Account code.',
        '',
        '# Output',
        '',
        'STRICT JSON only. Ready:',
        '{"route":"PROCEED","jobId":"…","entity":"…","month":"…","grossWages":0,"taxWithheld":0,',
        '"paygAccountCode":"…","atoAccountCode":"…","signerName":"…","signerEmail":"…"}',
        '',
        'Not ready (unposted pay runs or figures unavailable):',
        '{"route":"SKIP","jobId":"…","entity":"…","month":"…","reason":"<why>"}',
      ].join('\n'),
      'Checks pay runs are posted, pulls the payroll figures, finds the journal account codes.',
    ),

    node({
      id: 'tpl-ias-router',
      name: 'Ready?',
      kind: 'router',
      category: 'flow',
      icon: 'ti ti-arrows-split-2',
      x: 1200,
      y: 140,
      ports: [
        { key: 'input', name: 'In', role: 'message-in' },
        { key: 'proceed', name: 'PROCEED', role: 'message-out' },
        { key: 'skip', name: 'SKIP', role: 'message-out' },
      ],
      data: { instructions: '' },
      description: 'Entities with unposted pay runs exit here and appear in the run summary.',
    }),

    node({
      id: 'tpl-ias-gate-journal',
      name: 'Approve journal',
      kind: 'approval-gate',
      category: 'flow',
      icon: 'ti ti-user-check',
      x: 1480,
      y: 140,
      ports: [
        { key: 'input', name: 'In', role: 'message-in' },
        { key: 'approved', name: 'Approved', role: 'message-out' },
        { key: 'rejected', name: 'Rejected', role: 'message-out' },
      ],
      data: {
        message:
          'Review the extracted figures before the PAYGW journal is posted to Xero ' +
          '(Dr PAYG Withholding Payable / Cr ATO Integrated Client Account).',
      },
      description: 'Human check on the figures before anything is written to Xero.',
    }),

    agent(
      'tpl-ias-journal',
      'Journal & Send',
      1760,
      140,
      [
        '# Role',
        '',
        'You post the PAYGW journal and send the IAS for signing. The task JSON carries entity,',
        'month, grossWages, taxWithheld, account codes, jobId, and the signer.',
        '',
        '# Steps',
        '',
        '1. Call `xero_create_manual_journal` for {{entity}}: narration "IAS {{month}} — PAYGW",',
        '   date = last day of {{month}}, lines: +{{taxWithheld}} on {{paygAccountCode}} (debit),',
        '   -{{taxWithheld}} on {{atoAccountCode}} (credit).',
        '2. Call `ias_generate_pdf` with the entity, period, grossWages, taxWithheld.',
        '3. Call `esign_send` with that document, signer {{signerName}} <{{signerEmail}}>,',
        '   subject "IAS {{month}} — {{entity}} — please sign", and correlationKey "signed:{{jobId}}".',
        '',
        '# Output',
        '',
        'STRICT JSON only:',
        '{"jobId":"…","entity":"…","month":"…","grossWages":0,"taxWithheld":0,',
        '"journalId":"…","journalDeepLink":"…","envelopeId":"…"}',
      ].join('\n'),
      'Posts the balanced PAYGW journal, generates the IAS PDF, sends it for e-signature.',
    ),

    node({
      id: 'tpl-ias-wait',
      name: 'Await signature',
      kind: 'wait-event',
      category: 'flow',
      icon: 'ti ti-hourglass-high',
      x: 2040,
      y: 140,
      ports: [
        { key: 'input', name: 'In', role: 'message-in' },
        { key: 'resumed', name: 'Resumed', role: 'message-out' },
      ],
      data: {
        correlationKey: 'signed:{{jobId}}',
        message: 'Waiting for the client to e-sign the IAS. Resumes on the signature webhook.',
        // A week to sign; on expiry the entity lands in the exceptions
        // report instead of blocking the batch forever.
        timeoutHours: 168,
      } satisfies WaitEventNodeData,
      description: 'Suspends (up to 7 days) until the e-sign completion event arrives.',
    }),

    agent(
      'tpl-ias-pack',
      'Lodgement Pack',
      2320,
      140,
      [
        '# Role',
        '',
        'The client has signed. Assemble the lodgement pack for staff. The task JSON carries the',
        'entity, month, figures, journal reference, and envelope id.',
        '',
        '# Steps',
        '',
        '1. Call `ias_lodgement_pack` with entityName, period {{month}}, grossWages, taxWithheld,',
        '   journalId, journalDeepLink, signedDocumentNote mentioning envelope {{envelopeId}},',
        '   and xpmJobId {{jobId}}.',
        '',
        '# Output',
        '',
        'Return the pack markdown followed by one line of JSON:',
        '{"jobId":"{{jobId}}","entity":"{{entity}}","month":"{{month}}","taxWithheld":{{taxWithheld}}}',
      ].join('\n'),
      'Builds the per-entity pack staff use for the manual XPM Tax steps.',
    ),

    node({
      id: 'tpl-ias-gate-lodge',
      name: 'Lodged in XPM?',
      kind: 'approval-gate',
      category: 'flow',
      icon: 'ti ti-user-check',
      x: 2600,
      y: 140,
      ports: [
        { key: 'input', name: 'In', role: 'message-in' },
        { key: 'approved', name: 'Approved', role: 'message-out' },
        { key: 'rejected', name: 'Rejected', role: 'message-out' },
      ],
      data: {
        message:
          'Complete the manual steps from the pack: enter W1/W2 in XPM Tax, approve, and lodge to ' +
          'the ATO (the XPM tax screens have no public API). Approve once lodged.',
      },
      description: 'The human checkpoint covering XPM’s missing tax-lodgement API.',
    }),

    agent(
      'tpl-ias-close',
      'Job Closer',
      2880,
      140,
      [
        '# Role',
        '',
        'The IAS has been lodged. Close out the job.',
        '',
        '# Steps',
        '',
        '1. Call `xpm_update_job_state` with the jobId from the task and state "Completed".',
        '',
        '# Output',
        '',
        'STRICT JSON only:',
        '{"jobId":"…","entity":"…","month":"…","status":"lodged","taxWithheld":0}',
      ].join('\n'),
      'Marks the XPM job Completed after lodgement.',
    ),

    agent(
      'tpl-ias-summary',
      'Run Summary',
      920,
      540,
      [
        '# Role',
        '',
        'The batch has finished. The task JSON is {"results":[…],"exceptions":[…]} — one entry per',
        'entity: lodged entities carry status "lodged"; skipped ones carry route "SKIP" with a',
        'reason; exceptions carry an error.',
        '',
        '# Steps',
        '',
        '1. Write a concise markdown report: totals (entities processed, lodged, skipped, failed),',
        '   a table of lodged entities with their PAYGW amounts, and an "Action needed" section',
        '   listing every skip/failure with its reason.',
        '2. If an email tool is attached, send the report to the recipient specified in the',
        '   task input (or the address you configure in this agent\'s prompt) with subject',
        '   "Monthly IAS run — summary". Edit this prompt to set the recipient address.',
        '',
        '# Output',
        '',
        'The markdown report.',
      ].join('\n'),
      'Aggregates the batch outcome and emails the exceptions report to the firm.',
    ),
  ];

  // Shared Practice Suite tool node (all agents link to it).
  if (practicePreset) {
    nodes.push(
      node({
        id: 'tpl-ias-practice',
        name: 'Practice Suite',
        kind: 'mcp-tool',
        category: 'tool',
        icon: practicePreset.icon,
        x: 1620,
        y: 560,
        ports: [{ key: 'tool', name: 'Tool', role: 'tools' }],
        data: {
          transport: 'stdio',
          command: practicePreset.command ?? 'npx',
          args: [...(practicePreset.args ?? [])],
          envKeys: practicePreset.envSchema.map(field => field.name),
          presetId: practicePreset.id,
        },
        description: practicePreset.description,
      }),
    );
  }

  // Email tool for the summary report (configure creds or delete the node).
  if (emailPreset) {
    nodes.push(
      node({
        id: 'tpl-ias-email',
        name: 'Email',
        kind: 'mcp-tool',
        category: 'tool',
        icon: emailPreset.icon,
        x: 640,
        y: 700,
        ports: [{ key: 'tool', name: 'Tool', role: 'tools' }],
        data: {
          transport: 'stdio',
          command: emailPreset.command ?? 'npx',
          args: [...(emailPreset.args ?? [])],
          envKeys: emailPreset.envSchema.map(field => field.name),
          presetId: emailPreset.id,
        },
        description: emailPreset.description,
      }),
    );
  }

  const connections: WorkflowConnection[] = [
    connect('tpl-ias-trigger', 'tick', 'tpl-ias-jobs', 'task'),
    connect('tpl-ias-jobs', 'result', 'tpl-ias-loop', 'input'),
    connect('tpl-ias-loop', 'each', 'tpl-ias-prep', 'task'),
    connect('tpl-ias-prep', 'result', 'tpl-ias-router', 'input'),
    connect('tpl-ias-router', 'proceed', 'tpl-ias-gate-journal', 'input'),
    // SKIP route is intentionally unconnected: the skip JSON becomes the
    // iteration's terminal result and shows up in the summary.
    connect('tpl-ias-gate-journal', 'approved', 'tpl-ias-journal', 'task'),
    connect('tpl-ias-journal', 'result', 'tpl-ias-wait', 'input'),
    connect('tpl-ias-wait', 'resumed', 'tpl-ias-pack', 'task'),
    connect('tpl-ias-pack', 'result', 'tpl-ias-gate-lodge', 'input'),
    connect('tpl-ias-gate-lodge', 'approved', 'tpl-ias-close', 'task'),
    connect('tpl-ias-loop', 'done', 'tpl-ias-summary', 'task'),
  ];

  if (nodes.some(item => item.id === 'tpl-ias-practice')) {
    for (const agentId of ['tpl-ias-jobs', 'tpl-ias-prep', 'tpl-ias-journal', 'tpl-ias-pack', 'tpl-ias-close']) {
      connections.push(connect(agentId, 'tools', 'tpl-ias-practice', 'tool', 'tool-link'));
    }
  }
  if (nodes.some(item => item.id === 'tpl-ias-email')) {
    connections.push(connect('tpl-ias-summary', 'tools', 'tpl-ias-email', 'tool', 'tool-link'));
  }

  const graph: WorkflowGraph = { nodes, connections };
  return {
    version: 1,
    id: 'tpl-monthly-ias',
    name: 'Monthly IAS (PAYGW)',
    description:
      'Accounting-firm monthly IAS round: reads open IAS jobs from XPM, verifies pay runs and ' +
      'extracts payroll figures per entity, journals the PAYGW liability in Xero, e-signs the IAS ' +
      'summary with the client, and hands staff a lodgement pack for the XPM/ATO steps. ' +
      'Requires the Practice Suite credentials (Settings → Integrations).',
    graph,
    savedAt: new Date().toISOString(),
  };
}

// ── Template: Jira Time-Log Safety Net ───────────────────────────────────────

/**
 * End-of-day Jira safety net: fires on a schedule (~7pm Melbourne, Mon-Fri),
 * checks whether the user already logged time today, and if not, logs a full
 * day against one random eligible ticket and emails a report.
 *
 * Two schedule triggers cover Melbourne's DST switch (cron has no timezone
 * concept): Oct-Mar fires at 08:00 UTC (19:00 AEDT), Apr-Sep at 09:00 UTC
 * (19:00 AEST). Both feed the same agent, so only one fires on any given
 * evening (± a few days' drift right at the actual DST switchover date).
 *
 * The Jira calls are `http-tool` nodes wired to a stored Connection
 * (Settings → Connections: Basic auth, Atlassian account email + API token),
 * not an MCP server - the official remote Jira MCP server is OAuth-only, and
 * an OAuth session never reaches a deployed worker (`mcpOAuth` capability in
 * engine/src/capabilities.ts), so it cannot run on a schedule. A `{{baseUrl}}`
 * token in each tool's url is filled in from the connection at call time
 * (`withConnectionBaseUrl` in engine/src/tools.ts) - the site URL is set once
 * on the connection, not on every node. `Add Worklog` needs both a url path
 * segment (the issue key) AND a JSON body, which is exactly what
 * `HttpToolData.params` (named tokens) exists for; the other two calls still
 * use the single `input` default.
 *
 * There is no reliable "today" without a real clock: a schedule trigger's
 * fired input is always empty, and no prompt gets today's date injected. The
 * `Get Current Time (Melbourne)` tool (timeapi.io, unauthenticated) is the
 * agent's first call for exactly that reason.
 */
function buildJiraSafetyNetWorkflow(): WorkflowSpec {
  connectionCounter = 0;
  const emailPreset = findMcpPreset('email-remote');

  const nodes: WorkflowNode[] = [
    node({
      id: 'tpl-jira-trigger-aedt',
      name: 'Trigger (Oct-Mar, AEDT)',
      kind: 'schedule-trigger',
      category: 'trigger',
      icon: 'ti ti-clock-play',
      x: 80,
      y: 180,
      ports: [{ key: 'tick', name: 'Tick', role: 'message-out' }],
      data: { cron: '0 8 * 1,2,3,10,11,12 1-5' },
      description: '19:00 AEDT (UTC+11) on weekdays, October to March.',
    }),
    node({
      id: 'tpl-jira-trigger-aest',
      name: 'Trigger (Apr-Sep, AEST)',
      kind: 'schedule-trigger',
      category: 'trigger',
      icon: 'ti ti-clock-play',
      x: 80,
      y: 420,
      ports: [{ key: 'tick', name: 'Tick', role: 'message-out' }],
      data: { cron: '0 9 * 4-9 1-5' },
      description: '19:00 AEST (UTC+10) on weekdays, April to September.',
    }),

    agent(
      'tpl-jira-agent',
      'Jira Time-Log Safety Net',
      400,
      300,
      [
        `You are a Jira "safety net" agent that runs once at the end of each business day (~7pm`,
        `Melbourne time, Mon-Fri) via a schedule trigger. Your job is to make sure the user never`,
        `forgets to log time for the day.`,
        ``,
        `Trigger payload / task: {{input}}`,
        ``,
        `# Tools available to you`,
        ``,
        `- **Get Current Time (Melbourne)**: call this FIRST, before anything else. It returns`,
        `  year/month/day/hour/minute/dayOfWeek and dstActive for Australia/Melbourne. Use dstActive`,
        `  to pick the UTC offset: true = +11:00 (AEDT), false = +10:00 (AEST). This is your only`,
        `  source of truth for "today" - never guess the date.`,
        `- **Jira: Search My Issues**: POST to the Jira v3 enhanced search endpoint`,
        `  (/rest/api/3/search/jql). Its single input value is the ENTIRE JSON request body as a`,
        `  STRING, verbatim. Example (note the escaped inner quotes):`,
        `  {"jql":"assignee = currentUser() AND statusCategory != Done","fields":["summary","status"],"maxResults":50}`,
        `- **Jira: Get Issue Worklogs**: GET worklogs for one issue. Its single input value is just`,
        `  the issue key, e.g. PROJ-123.`,
        `- **Jira: Add Worklog**: POST a new worklog entry. It takes two separate arguments:`,
        `  issueKey (e.g. PROJ-123) and body. The body argument MUST be a JSON STRING (not an`,
        `  object) - pass the full worklog payload serialized as text, e.g.`,
        `  {"timeSpent":"1d","started":"2026-08-10T09:00:00.000+1000","comment":"..."}.`,
        `- **Email Report**: sends the final report email. ALWAYS call this as your final step.`,
        ``,
        `The current user is identified by assignee = currentUser() - the connection behind the Jira`,
        `tools already carries the site URL and the user's own credentials.`,
        ``,
        `# Steps (follow exactly, in order)`,
        ``,
        `1. **Get today's date.** Call Get Current Time (Melbourne). Derive today's Melbourne`,
        `   calendar date (YYYY-MM-DD) and the correct offset (+10:00 or +11:00) from the result.`,
        `   You will need both again in step 5.`,
        `2. **Check if time was already logged today.** Call Jira: Search My Issues ONCE with a JQL`,
        `   query that finds issues the current user logged time on today. Use the worklogDate and`,
        `   worklogAuthor JQL functions so a single search replaces N per-issue worklog calls:`,
        `   - JQL: assignee = currentUser() AND worklogDate >= "<TODAY>" AND worklogDate <=`,
        `     "<TODAY>" AND worklogAuthor = currentUser()`,
        `     (replace <TODAY> with today's Melbourne date, e.g. 2026-08-10)`,
        `   - Request fields: ["summary","status"].`,
        `   - If this search returns ANY issues, the user already logged time today. STOP - do not`,
        `     log anything. Skip to step 6 and report which ticket(s) already have today's worklog.`,
        `3. **Fetch the eligible queue.** Call Jira: Search My Issues ONCE more for issues assigned`,
        `   to the current user that are not in a terminal or QA-like status:`,
        `   - JQL: assignee = currentUser() AND statusCategory != Done AND status NOT IN ('QA',`,
        `     'In QA', 'Ready for QA', 'In QA Staging')`,
        `     (Use SINGLE quotes inside JQL string values so the outer JSON string quotes don't need`,
        `     escaping. Jira accepts both.)`,
        `   - Request fields: ["key","summary","status"].`,
        `   - If the search returns no issues, skip to step 6 and report there were no eligible`,
        `     tickets.`,
        `4. **Pick one at random.** From the eligible queue, pick one ticket uniformly at random`,
        `   (not just the first - vary your selection using whatever entropy you have, e.g. shuffle`,
        `   the list mentally and pick an index).`,
        `5. **Log the time.** Call Jira: Add Worklog for the chosen ticket:`,
        `   - issueKey: the chosen ticket's key.`,
        `   - body: a JSON STRING (not an object) with timeSpent "1d" (one full working day, per`,
        `     the site's Jira work-day hours setting - typically 8h, but let Jira interpret "1d"),`,
        `     started set to today's Melbourne date at 09:00 formatted yyyy-MM-ddTHH:mm:ss.SSS plus`,
        `     the offset from step 1 (e.g. 2026-08-07T09:00:00.000+1000), and comment "Auto-logged`,
        `     by safety-net workflow - please review/adjust if needed."`,
        `6. **Report and email.** Compose a short, clear summary stating exactly one of:`,
        `   - "No action: time already logged today on <ticket(s)>."`,
        `   - "No action: no eligible tickets (none open outside QA/Done) to log time against."`,
        `   - "Logged 1 day on <TICKET-KEY> - <summary> (auto-selected at random from N eligible`,
        `     tickets)."`,
        `   - Or a clear error description if a Jira call failed.`,
        ``,
        `   Call Email Report to send that summary to blakelinnell96@gmail.com, stating what ticket`,
        `   was logged (if any) and how much time. This is your FINAL tool call - do not call any`,
        `   tools after Email Report.`,
        ``,
        `Never log time on more than one ticket. Never log time if any ticket already has today's`,
        `worklog. Be conservative: if you cannot determine worklog status confidently, do not log`,
        `time, explain why in your report, and still email it. You have a generous tool-round`,
        `budget but should need only 4-5 rounds: time check, queue fetch, add worklog (if needed),`,
        `email report.`,
      ].join('\n'),
      'Checks whether time was already logged today; if not, logs a full day against one random ' +
        'eligible ticket and emails the outcome.',
      // Raise the tool-result cap so Jira worklog/search payloads (which can
      // carry many entries) aren't truncated mid-response - a truncated
      // worklog tail previously hid an already-logged-today entry and caused
      // a duplicate log. 50000 is plenty for a worklog list and well under
      // the 200000 hard ceiling.
      { toolResultCapChars: 50000, maxToolRounds: 15 },
    ),

    node({
      id: 'tpl-jira-time',
      name: 'Get Current Time (Melbourne)',
      kind: 'http-tool',
      category: 'tool',
      icon: 'ti ti-clock',
      x: 760,
      y: 80,
      ports: [{ key: 'tool', name: 'Tool', role: 'tools' }],
      data: {
        method: 'GET',
        url: 'https://timeapi.io/api/time/current/zone?timeZone=Australia/Melbourne',
      } satisfies HttpToolData,
      description:
        'Unauthenticated public API. Ground truth for "today" - the schedule trigger carries no payload.',
    }),

    node({
      id: 'tpl-jira-search',
      name: 'Jira: Search My Issues',
      kind: 'http-tool',
      category: 'tool',
      icon: 'ti ti-brand-jira',
      x: 760,
      y: 220,
      ports: [{ key: 'tool', name: 'Tool', role: 'tools' }],
      data: {
        method: 'POST',
        url: '{{baseUrl}}/rest/api/3/search/jql',
        headers: { 'Content-Type': 'application/json' },
        bodyTemplate: '{{input}}',
      } satisfies HttpToolData,
      description:
        'Set the Connection below to your Jira Cloud site (Basic auth: account email + API token).',
    }),

    node({
      id: 'tpl-jira-worklogs',
      name: 'Jira: Get Issue Worklogs',
      kind: 'http-tool',
      category: 'tool',
      icon: 'ti ti-brand-jira',
      x: 760,
      y: 360,
      ports: [{ key: 'tool', name: 'Tool', role: 'tools' }],
      data: {
        method: 'GET',
        url: '{{baseUrl}}/rest/api/3/issue/{{input}}/worklog',
      } satisfies HttpToolData,
      description: 'Uses the same Connection as Search My Issues.',
    }),

    node({
      id: 'tpl-jira-add-worklog',
      name: 'Jira: Add Worklog',
      kind: 'http-tool',
      category: 'tool',
      icon: 'ti ti-brand-jira',
      x: 760,
      y: 500,
      ports: [{ key: 'tool', name: 'Tool', role: 'tools' }],
      data: {
        method: 'POST',
        url: '{{baseUrl}}/rest/api/3/issue/{{issueKey}}/worklog',
        headers: { 'Content-Type': 'application/json' },
        bodyTemplate: '{{body}}',
        params: [
          {
            name: 'issueKey',
            description: 'The Jira issue key to log time against, e.g. PROJ-123.',
            required: true,
          },
          {
            name: 'body',
            description:
              'The full JSON worklog body, e.g. {"timeSpent":"1d","started":"2026-08-07T09:00:00.000+1000","comment":"..."}.',
            required: true,
          },
        ],
      } satisfies HttpToolData,
      description:
        'Uses the same Connection as Search My Issues. This is the only tool that writes to Jira.',
    }),
  ];

  if (emailPreset) {
    nodes.push(
      node({
        id: 'tpl-jira-email',
        name: 'Email Report',
        kind: 'mcp-tool',
        category: 'tool',
        icon: emailPreset.icon,
        x: 760,
        y: 640,
        ports: [{ key: 'tool', name: 'Tool', role: 'tools' }],
        data: {
          transport: 'sse',
          url: emailPreset.url,
          authKey: emailPreset.authKey,
          envKeys: emailPreset.envSchema.map(field => field.name),
          presetId: emailPreset.id,
        },
        description: emailPreset.description,
      }),
    );
  }

  const connections: WorkflowConnection[] = [
    connect('tpl-jira-trigger-aedt', 'tick', 'tpl-jira-agent', 'task'),
    connect('tpl-jira-trigger-aest', 'tick', 'tpl-jira-agent', 'task'),
    connect('tpl-jira-agent', 'tools', 'tpl-jira-time', 'tool', 'tool-link'),
    connect('tpl-jira-agent', 'tools', 'tpl-jira-search', 'tool', 'tool-link'),
    connect('tpl-jira-agent', 'tools', 'tpl-jira-worklogs', 'tool', 'tool-link'),
    connect('tpl-jira-agent', 'tools', 'tpl-jira-add-worklog', 'tool', 'tool-link'),
  ];
  if (nodes.some(item => item.id === 'tpl-jira-email')) {
    connections.push(connect('tpl-jira-agent', 'tools', 'tpl-jira-email', 'tool', 'tool-link'));
  }

  const graph: WorkflowGraph = { nodes, connections };
  return {
    version: 1,
    id: 'tpl-jira-safety-net',
    name: 'Jira Time-Log Safety Net',
    description:
      'End-of-day check (~7pm Melbourne, Mon-Fri): if you have not logged time today, logs a full ' +
      'day against one random eligible ticket and emails a report. Needs a Jira Connection (Basic ' +
      'auth: account email + API token, Settings → Connections) referenced on the three Jira tool ' +
      'nodes, and a Resend API key for the Email Report tool (Settings → Integrations).',
    graph,
    savedAt: new Date().toISOString(),
  };
}

/**
 * Registry of workflow templates shown in the Workflows panel.
 * Adding a template = one entry here.
 */
export const WORKFLOW_TEMPLATES: WorkflowTemplate[] = [
  {
    id: 'tpl-monthly-ias',
    label: 'Monthly IAS (PAYGW)',
    description:
      'End-to-end monthly Instalment Activity Statement round for an accounting firm — XPM jobs, ' +
      'payroll figures, Xero journal, client e-signature, lodgement pack.',
    icon: 'ti ti-report-money',
    build: buildIasWorkflow,
  },
  {
    id: 'tpl-jira-safety-net',
    label: 'Jira Time-Log Safety Net',
    description:
      'End-of-day check (~7pm Melbourne, Mon-Fri): if you have not logged time today, logs a full ' +
      'day against one random eligible ticket and emails a report.',
    icon: 'ti ti-brand-jira',
    build: buildJiraSafetyNetWorkflow,
  },
];

/** Finds a template by id. */
export function findWorkflowTemplate(id: string): WorkflowTemplate | undefined {
  return WORKFLOW_TEMPLATES.find(template => template.id === id);
}
