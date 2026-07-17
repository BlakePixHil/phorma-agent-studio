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
    data: { prompt } satisfies AgentNodeData,
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
        '2. If an email tool is attached, send the report to the practice manager with subject',
        '   "Monthly IAS run — summary".',
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
];

/** Finds a template by id. */
export function findWorkflowTemplate(id: string): WorkflowTemplate | undefined {
  return WORKFLOW_TEMPLATES.find(template => template.id === id);
}
