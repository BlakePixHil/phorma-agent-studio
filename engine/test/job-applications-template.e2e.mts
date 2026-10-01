/**
 * E2E: the Weekly Job Applications template (`tpl-weekly-job-applications`)
 * driven end to end through the real engine with mocks and recorded fixtures
 * only - no network, no model, no provider.
 *
 * Run:  TSX_TSCONFIG_PATH=frontend/tsconfig.json npx -y tsx engine/test/job-applications-template.e2e.mts
 *
 * Scenarios (the template's Definition of Done):
 *  1. Five postings in (email, api and manual suitable; one below threshold;
 *     one duplicate across two sources) -> exactly 2 sends, 1 manual,
 *     1 screened out, the duplicate collapsed.
 *  2. An immediate re-run sends 0.
 *  3. 31 days later the same postings are eligible again.
 *  4. A refused send is not written to the ledger and is retried next run; a
 *     retry inside one run does not double-send.
 *  5. dryRun on: 0 outbound sends, 0 `applied:` writes, summary still produced.
 *  6. A resume that changes an employer, or exceeds maxAddedSkills, is blocked.
 *  7. The email carries a PDF attachment and the cover letter as its body.
 *  8. Melbourne targeting: a Melbourne role in any arrangement and a remote role
 *     open to Australia are kept; a hybrid role elsewhere and a remote role
 *     restricted to another country are dropped; Adzuna runs only once its app
 *     id is set, and then carries the connection's key.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CLOUDFLARE_CAPABILITIES,
  decodeBase64,
  resolveWorkflowVariables,
  startRun,
  type DataRequest,
  type DataResponse,
  type ModelRequest,
  type ResolvedConnection,
  type RunEvent,
} from '../src/index.js';
import { MemoryArtifactStore } from '../src/test/fake-host.js';
import { MemoryStateStore } from '../src/test/memory-state-store.js';
import { inspectPdf } from '../src/test/pdf-reader.js';
import { WORKFLOW_TEMPLATES } from '../../frontend/src/app/core/workflow-templates.js';

let failures = 0;
let checks = 0;
function check(label: string, ok: boolean, detail = ''): void {
  checks += 1;
  if (ok) console.log(`  \u2713 ${label}`);
  else {
    failures += 1;
    console.log(`  \u2717 ${label}${detail ? ` - ${detail}` : ''}`);
  }
}

// ── Clock: one value drives Date.now (the engine) and the state store ────────

const DAY = 86_400_000;
let clock = Date.parse('2026-10-05T08:00:00Z');
const realNow = Date.now;
// The clock still TICKS: `RunGate.sleep` waits on a `Date.now()` deadline during retry backoff,
// so a frozen clock would hang the first retried request forever. Tests jump it with `clock +=`.
const wallStart = realNow();
Date.now = () => clock + (realNow() - wallStart);

// ── The template, with test overrides ────────────────────────────────────────

const template = WORKFLOW_TEMPLATES.find(item => item.id === 'tpl-weekly-job-applications');
if (!template) throw new Error('template tpl-weekly-job-applications is not registered');
const base = await template.build();

const PROFILE = String(base.settings?.variables?.find(variable => variable.name === 'profile')?.value ?? '');
const NAME = PROFILE.split('\n')[0]!.replace(/#/g, '').trim();

function spec(overrides: Record<string, unknown>) {
  const copy = structuredClone(base);
  for (const variable of copy.settings?.variables ?? []) {
    if (variable.name in overrides) variable.value = overrides[variable.name] as never;
  }
  for (const node of copy.graph.nodes) {
    if (node.kind === 'notify') (node.data as { connectionId?: string }).connectionId = 'conn-resend';
    if (node.id === 'tpl-wja-fetch-adzuna') (node.data as { connectionId?: string }).connectionId = 'conn-adzuna';
  }
  return copy;
}

const LIVE = {
  dryRun: false,
  companyBoards: ['greenhouse:acme-api|api', 'lever:example-lever', 'ashby:example-ashby'],
  applyApiUrl: 'https://apply.acme.test/v1/applications',
};

// ── Fixtures, re-dated against the clock ─────────────────────────────────────

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'job-sources');
function fixture(name: string): string {
  return readFileSync(join(FIXTURES, `${name}.json`), 'utf8')
    .replace(/"__POSTED_(\d+)D_MS__"/g, (_m, days) => String(clock - Number(days) * DAY))
    .replace(/__POSTED_(\d+)D__/g, (_m, days) => new Date(clock - Number(days) * DAY).toISOString());
}

// ── Fake hosts ───────────────────────────────────────────────────────────────

interface Provider {
  /** Every request that reached a provider. */
  requests: DataRequest[];
  /** Deliveries the provider ACCEPTED, deduplicated by Idempotency-Key. */
  delivered: Map<string, DataRequest>;
  /** Scripted statuses for the next application emails, consumed in order. */
  emailStatuses: number[];
  /** Requests that reached a keyed source (Adzuna). */
  sourceRequests: DataRequest[];
}

function provider(): Provider {
  return { requests: [], delivered: new Map(), emailStatuses: [], sourceRequests: [] };
}

function respond(status: number, body: string): DataResponse {
  return { status, headers: { 'content-type': 'application/json' }, body, byteCount: body.length, durationMs: 1 };
}

function fetcher(p: Provider) {
  return async (request: DataRequest): Promise<DataResponse> => {
    const url = new URL(request.url);
    const route = `${url.host}${url.pathname}`;
    if (route === 'remotive.com/api/remote-jobs') return respond(200, fixture('remotive'));
    if (route === 'remoteok.com/api') return respond(200, fixture('remoteok'));
    if (route === 'boards-api.greenhouse.io/v1/boards/acme-api/jobs') return respond(200, fixture('greenhouse'));
    if (route === 'api.lever.co/v0/postings/example-lever') return respond(200, fixture('lever'));
    if (route === 'api.ashbyhq.com/posting-api/job-board/example-ashby') return respond(200, fixture('ashby'));
    if (route === 'api.lever.co/v0/postings/example-lever-au') return respond(200, fixture('lever-au'));
    if (route === 'api.ashbyhq.com/posting-api/job-board/example-ashby-au') return respond(200, fixture('ashby-au'));
    if (route === 'api.adzuna.com/v1/api/jobs/au/search/1') {
      p.sourceRequests.push(request);
      return respond(200, fixture('adzuna'));
    }
    if (route === 'api.resend.com/emails' || route === 'apply.acme.test/v1/applications') {
      p.requests.push(request);
      const isApplication = request.headers['Idempotency-Key'] !== undefined;
      const status = route === 'api.resend.com/emails' && isApplication ? (p.emailStatuses.shift() ?? 200) : 200;
      if (status >= 200 && status < 300) {
        const key = request.headers['Idempotency-Key'] ?? `summary-${p.requests.length}`;
        if (!p.delivered.has(key)) p.delivered.set(key, request);
      }
      return respond(status, status < 300 ? '{"id":"msg_1"}' : '{"message":"refused"}');
    }
    throw new Error(`Unexpected request to ${request.url}`);
  };
}

const resend: ResolvedConnection = {
  id: 'conn-resend',
  type: 'http',
  config: { emailProvider: 'resend' },
  secrets: { token: 're_test_not_a_real_key_000' },
  auth: { mode: 'bearer', secretKey: 'token' },
  allowWrites: true,
};

const adzuna: ResolvedConnection = {
  id: 'conn-adzuna',
  type: 'http',
  config: {},
  secrets: { appKey: 'adzuna_test_key_0000' },
  auth: { mode: 'query', param: 'app_key', secretKey: 'appKey' },
  allowWrites: false,
};

// ── Fake model, keyed on the agent's prompt ──────────────────────────────────

type TailorMode = 'good' | 'employer' | 'skills';
const tailorModes = new Map<string, TailorMode>();

const FIT: Record<string, object> = {
  'Senior Backend Engineer': {
    score: 85,
    reasons: ['TypeScript and PostgreSQL match'],
    missingSkills: [],
    applyMethod: 'email',
    applyEmail: 'careers@acme-widgets.example',
  },
  'AI Automation Engineer': { score: 90, reasons: ['LangChain'], missingSkills: [], applyMethod: 'manual', applyEmail: '' },
  'Platform Engineer': { score: 80, reasons: ['Kubernetes, AWS'], missingSkills: [], applyMethod: 'manual', applyEmail: '' },
  'Machine Learning Engineer': { score: 40, reasons: ['Research PhD required'], missingSkills: ['PhD'], applyMethod: 'manual', applyEmail: '' },
};

function titleIn(system: string): string {
  return /- Title: (.+)\n/.exec(system)?.[1]?.trim() ?? '';
}

function companyIn(system: string): string {
  return /- Company: (.+)\n/.exec(system)?.[1]?.trim() ?? '';
}

function tailored(mode: TailorMode, company: string): object {
  let resume = PROFILE.replace(
    '- TypeScript, Node.js, Python, SQL, PostgreSQL',
    '- TypeScript, Node.js, Python, SQL, PostgreSQL, LangGraph',
  );
  let addedSkills = [{ skill: 'LangGraph', relatedTo: 'LangChain' }];
  if (mode === 'employer') resume = resume.replace('Example Robotics Pty Ltd', 'Famous Robotics Corp.');
  if (mode === 'skills') {
    const extra = ['LangGraph', 'LlamaIndex', 'Haystack', 'Semantic Kernel'];
    resume = resume.replace('- TypeScript, Node.js, Python, SQL, PostgreSQL', `- TypeScript, Node.js, Python, SQL, PostgreSQL, ${extra.join(', ')}`);
    addedSkills = extra.map(skill => ({ skill, relatedTo: 'LangChain' }));
  }
  return {
    resumeMarkdown: resume,
    addedSkills,
    coverLetter: `Dear ${company} team,\n\nI would like to apply for this role.\n\nBest regards,\n${NAME}`,
    emailSubject: `Application: ${company}`,
  };
}

let summaryCalls = 0;
const model = {
  async *stream(request: ModelRequest) {
    const system = request.system ?? '';
    let reply: object;
    if (system.includes('# Fit screen')) {
      reply = FIT[titleIn(system)] ?? { score: 0, reasons: [], missingSkills: [], applyMethod: 'manual', applyEmail: '' };
    } else if (system.includes('# Tailor')) {
      const company = companyIn(system);
      reply = tailored(tailorModes.get(company) ?? 'good', company);
    } else if (system.includes('# Revise')) {
      // The revision keeps the same defect, so a bad draft stays bad.
      const previous = /"resumeMarkdown"[\s\S]*/.test(system) ? system : '';
      const company = /Dear (.+?) team/.exec(previous)?.[1] ?? '';
      reply = tailored(tailorModes.get(company) ?? 'good', company);
    } else if (system.includes('# Weekly summary')) {
      summaryCalls += 1;
      reply = { subject: 'Weekly applications', markdown: '# Weekly applications\n\nCounts as reported.' };
    } else {
      throw new Error(`Unexpected agent prompt: ${system.slice(0, 80)}`);
    }
    yield { type: 'text' as const, text: `\`\`\`json\n${JSON.stringify(reply)}\n\`\`\`` };
  },
};

// ── One run ──────────────────────────────────────────────────────────────────

interface Outcome {
  events: RunEvent[];
  results: { outcome: string; company: string; title: string; key: string }[];
  error?: string;
}

let runCounter = 0;
async function run(
  overrides: Record<string, unknown>,
  hosts: { state: MemoryStateStore; artifacts: MemoryArtifactStore; provider: Provider },
): Promise<Outcome> {
  runCounter += 1;
  summaryCalls = 0;
  const s = spec(overrides);
  const events: RunEvent[] = [];
  const handle = startRun({
    runId: `wja-run-${runCounter}`,
    graph: s.graph,
    input: '',
    workflowId: s.id,
    variables: resolveWorkflowVariables(s.settings),
    model: model as never,
    defaultModel: { provider: 'ollama', model: 'stub' },
    emit: event => events.push(event),
    requestApproval: async () => true,
    requestInput: async () => '',
    dataFetch: fetcher(hosts.provider),
    state: hosts.state,
    artifacts: hosts.artifacts,
    connections: { resolve: async (id: string) => (id === 'conn-adzuna' ? adzuna : resend) },
    capabilities: CLOUDFLARE_CAPABILITIES,
    maxExecutions: 2000,
  });
  await handle.done;
  const failed = events.find(event => event.type === 'run-failed');
  const loop = events.find(
    (event): event is Extract<RunEvent, { type: 'node-completed' }> =>
      event.type === 'node-completed' && event.nodeId === 'tpl-wja-each-posting',
  );
  const results = loop ? (JSON.parse(loop.output).results as Outcome['results']).filter(Boolean) : [];
  return { events, results, error: failed?.type === 'run-failed' ? failed.error : undefined };
}

function freshHosts() {
  return {
    state: new MemoryStateStore({ now: () => Date.now() }),
    artifacts: new MemoryArtifactStore(),
    provider: provider(),
  };
}

const employerSends = (p: Provider) =>
  [...p.delivered.entries()].filter(([key]) => key.startsWith('apply:'));
const count = (o: Outcome, outcome: string) => o.results.filter(result => result.outcome === outcome).length;
const stateKeys = async (s: MemoryStateStore, prefix: string) =>
  (await s.list(`tpl-weekly-job-applications::${prefix}`, 1000)).map(entry => entry.key);
const appliedWrites = (o: Outcome) =>
  o.events.filter(event => event.type === 'state-written' && event.key.includes('::applied:')).length;

// ── 1 + 7. First live run ────────────────────────────────────────────────────

console.log('\n1. Five postings in: two sends, one manual, one screened, duplicate collapsed');
const hosts = freshHosts();
const first = await run(LIVE, hosts);
check('run completes', first.error === undefined, first.error);
check('four distinct postings considered (duplicate collapsed, stale and onsite dropped)', first.results.length === 4,
  JSON.stringify(first.results.map(result => [result.title, result.outcome])));
check('Acme appears once', first.results.filter(result => result.company === 'Acme Widgets Ltd').length === 1);
check('exactly two employer sends', employerSends(hosts.provider).length === 2, String(employerSends(hosts.provider).length));
check('one by email, one by API', employerSends(hosts.provider).some(([, r]) => r.url.includes('resend'))
  && employerSends(hosts.provider).some(([, r]) => r.url.includes('apply.acme.test')));
check('applied 2, manual 1, screened out 1', count(first, 'applied') === 2 && count(first, 'manual') === 1 && count(first, 'screened-out') === 1);
check('ledger holds 3 applied (incl. manual-pending) and 1 screened',
  (await stateKeys(hosts.state, 'applied:')).length === 3 && (await stateKeys(hosts.state, 'screened:')).length === 1);
const manualEntry = (await hosts.state.list('tpl-weekly-job-applications::applied:', 1000))
  .map(entry => JSON.parse(entry.value))
  .find(value => value.method === 'manual-pending');
check('the manual posting is recorded as manual-pending with its added skills', !!manualEntry && manualEntry.addedSkills?.[0]?.skill === 'LangGraph');
const ttl = (await hosts.state.list('tpl-weekly-job-applications::applied:', 1000)).every(
  entry => entry.expiresAt !== undefined && Math.abs(entry.expiresAt - (Date.now() + 30 * DAY)) < 60_000,
);
check('every ledger entry expires in exactly 30 days', ttl);
check('the summary was produced and emailed once', summaryCalls === 1
  && hosts.provider.requests.filter(r => !r.headers['Idempotency-Key'] && r.url.includes('resend')).length === 1);

console.log('\n7. The application email: PDF attachment, cover letter body');
const email = employerSends(hosts.provider).find(([, r]) => r.url.includes('resend'))?.[1];
const emailBody = email ? JSON.parse(email.body!) : {};
check('sent to the address the posting gives', JSON.stringify(emailBody.to) === '["careers@acme-widgets.example"]');
check('Reply-To is the applicant', emailBody.reply_to === 'alex.placeholder@example.com');
check('body is the cover letter, as plain text', typeof emailBody.text === 'string' && emailBody.text.startsWith('Dear Acme Widgets Ltd team') && emailBody.html === undefined);
check('idempotency header names the posting', email?.headers['Idempotency-Key'] === 'apply:remotive:3100001');
const attachment = emailBody.attachments?.[0];
const pdfBytes = attachment ? decodeBase64(attachment.content) : new Uint8Array();
const pdf = inspectPdf(pdfBytes);
check('one PDF attachment named from the profile and the company', emailBody.attachments?.length === 1
  && attachment.content_type === 'application/pdf' && attachment.filename === `${NAME} - Acme Widgets Ltd - Resume.pdf`, attachment?.filename);
check('starts with %PDF, at least one page, valid xref', pdf.header === '%PDF-1.4' && pdf.pageCount >= 1 && pdf.xrefValid);
check('contains the profile name as text', pdf.text.includes(NAME));
const api = employerSends(hosts.provider).find(([, r]) => r.url.includes('apply.acme.test'))?.[1];
const apiBody = api ? [...decodeBase64(api.body!)].map(b => String.fromCharCode(b)).join('') : '';
check('the API upload is multipart with the resume file', api?.bodyEncoding === 'base64'
  && apiBody.includes('name="resume"; filename=') && apiBody.includes('%PDF-1.4'));

// ── 2. Immediate re-run ──────────────────────────────────────────────────────

console.log('\n2. An immediate re-run sends nothing');
const before = employerSends(hosts.provider).length;
const requestsBefore = hosts.provider.requests.filter(r => r.headers['Idempotency-Key']).length;
const second = await run(LIVE, hosts);
check('run completes', second.error === undefined, second.error);
check('no new employer request at all', hosts.provider.requests.filter(r => r.headers['Idempotency-Key']).length === requestsBefore);
check('every posting skipped by the ledger', count(second, 'skipped') === 4, JSON.stringify(second.results.map(r => r.outcome)));
check('deliveries unchanged', employerSends(hosts.provider).length === before);

// ── 3. 31 days later ─────────────────────────────────────────────────────────

console.log('\n3. Thirty-one days later the same postings are eligible again');
clock += 31 * DAY;
const sendsBefore = hosts.provider.requests.filter(r => r.headers['Idempotency-Key']).length;
const third = await run(LIVE, hosts);
check('run completes', third.error === undefined, third.error);
check('applied 2, manual 1, screened out 1 again', count(third, 'applied') === 2 && count(third, 'manual') === 1 && count(third, 'screened-out') === 1,
  JSON.stringify(third.results.map(r => r.outcome)));
check('two new employer requests', hosts.provider.requests.filter(r => r.headers['Idempotency-Key']).length === sendsBefore + 2);

// ── 4. Refused send, then retries ────────────────────────────────────────────

console.log('\n4. A refused send is not recorded and is retried next run; a retry never double-sends');
const h4 = freshHosts();
h4.provider.emailStatuses = [422];
const refused = await run(LIVE, h4);
check('run completes with the posting reported as an error', refused.error === undefined
  && refused.events.some(event => event.type === 'node-failed' && event.nodeId === 'tpl-wja-send-email'));
check('the refused posting is NOT in the applied ledger', !(await stateKeys(h4.state, 'applied:')).some(key => key.endsWith('remotive:3100001')));
check('nothing was delivered for it', !employerSends(h4.provider).some(([key]) => key === 'apply:remotive:3100001'));
const retried = await run(LIVE, h4);
check('next run sends it', employerSends(h4.provider).some(([key]) => key === 'apply:remotive:3100001') && count(retried, 'applied') === 1);
check('and records it', (await stateKeys(h4.state, 'applied:')).some(key => key.endsWith('remotive:3100001')));

const h4b = freshHosts();
h4b.provider.emailStatuses = [503, 200];
await run(LIVE, h4b);
const attempts = h4b.provider.requests.filter(r => r.headers['Idempotency-Key'] === 'apply:remotive:3100001');
check('a 503 is retried inside the run with the same Idempotency-Key', attempts.length === 2);
check('the provider delivered it once', employerSends(h4b.provider).filter(([key]) => key === 'apply:remotive:3100001').length === 1);
const appliedWritesForA = (await stateKeys(h4b.state, 'applied:')).filter(key => key.endsWith('remotive:3100001')).length;
check('and the ledger holds one entry for it', appliedWritesForA === 1);

// ── 5. Dry run ───────────────────────────────────────────────────────────────

console.log('\n5. Dry run: nothing sent, nothing recorded, summary still produced');
const h5 = freshHosts();
const dry = await run({ ...LIVE, dryRun: true }, h5);
check('run completes', dry.error === undefined, dry.error);
check('0 employer requests', h5.provider.requests.filter(r => r.headers['Idempotency-Key']).length === 0);
check('0 applied: writes', appliedWrites(dry) === 0 && (await stateKeys(h5.state, 'applied:')).length === 0);
check('three dry-run outcomes, each with a rendered document', count(dry, 'dry-run') === 3
  && h5.artifacts.all().length === 3);
check('the summary is produced and emailed with the documents attached', summaryCalls === 1
  && JSON.parse(h5.provider.requests.at(-1)!.body!).attachments?.length === 3);

// ── 6. Honesty block ─────────────────────────────────────────────────────────

console.log('\n6. A changed employer or too many added skills is blocked and never sent');
tailorModes.set('Acme Widgets Ltd', 'employer');
tailorModes.set('example-ashby', 'skills');
const h6 = freshHosts();
const blocked = await run(LIVE, h6);
check('run completes', blocked.error === undefined, blocked.error);
check('two postings blocked', count(blocked, 'blocked') === 2, JSON.stringify(blocked.results.map(r => [r.company, r.outcome])));
check('the blocked email is never sent', !h6.provider.requests.some(r => r.headers['Idempotency-Key'] === 'apply:remotive:3100001'));
check('the blocked manual posting is not recorded', !(await stateKeys(h6.state, 'applied:')).some(key => key.includes('ashby:')));
check('the unaffected API posting still goes out', employerSends(h6.provider).some(([key]) => key.startsWith('apply:greenhouse:')));
const breaches = blocked.events.filter(event => event.type === 'assert-breached').map(event => (event as { assertion: string }).assertion);
check('the employer change and the skill cap are the reasons', breaches.includes('Fixed facts kept') && breaches.includes('Added skills within limit'),
  JSON.stringify([...new Set(breaches)]));
tailorModes.clear();

// ── 8. Melbourne targeting and the optional Adzuna source ────────────────────

console.log('\n8. Melbourne roles and Australia-open remote roles kept; Adzuna only when configured');
check('Adzuna is not called while adzunaAppId is empty', hosts.provider.sourceRequests.length === 0);
const h8 = freshHosts();
const local = await run(
  {
    dryRun: true,
    companyBoards: ['lever:example-lever-au', 'ashby:example-ashby-au'],
    adzunaAppId: 'adzuna-app-id-test',
  },
  h8,
);
check('run completes', local.error === undefined, local.error);
const keys = new Set(local.results.map(result => result.key));
const ashbyKey = (n: string) => `ashby:example-ashby-au:0b9e0000-0000-47bd-98cb-0000000000c${n}`;
check('a hybrid role with Melbourne as a second office is kept',
  keys.has('lever:example-lever-au:a1b2c3d4-0000-4b60-b120-0000000000a1'), JSON.stringify([...keys]));
check('an on-site role with a Melbourne secondary location is kept', keys.has(ashbyKey('4')));
check('a remote role open to Australia is kept', keys.has(ashbyKey('3')));
check('a hybrid Sydney role is dropped, although Ashby marks it isRemote', !keys.has(ashbyKey('1')));
check('a remote role restricted to the US is dropped', !keys.has(ashbyKey('2')));
check('a hybrid Brisbane role is dropped', !keys.has('lever:example-lever-au:a1b2c3d4-0000-4b60-b120-0000000000a2'));
check('the Adzuna Melbourne posting is kept', keys.has('adzuna:4900000001'));
const adzunaUrl = h8.provider.sourceRequests[0] ? new URL(h8.provider.sourceRequests[0].url) : undefined;
check('Adzuna is asked once, for Melbourne, with the app id and the connection key',
  h8.provider.sourceRequests.length === 1
    && adzunaUrl?.searchParams.get('where') === 'melbourne'
    && adzunaUrl?.searchParams.get('app_id') === 'adzuna-app-id-test'
    && adzunaUrl?.searchParams.get('app_key') === 'adzuna_test_key_0000'
    && adzunaUrl?.searchParams.get('max_days_old') === '14',
  adzunaUrl?.search);

Date.now = realNow;
console.log(`\n${checks - failures}/${checks} checks passed`);
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
