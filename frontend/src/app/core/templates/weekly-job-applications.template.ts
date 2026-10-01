/**
 * Template: Weekly Job Applications, Melbourne and remote (`tpl-weekly-job-applications`).
 *
 * Every Monday at 08:00 Melbourne time (compiled to UTC) on a deployed worker,
 * or on a manual Run: pulls roles based in `vars.homeLocations` (any work
 * arrangement) plus remote roles open to Australia from public job feeds, drops
 * what the 30-day ledger already holds, screens fit against the user's profile,
 * writes a tailored resume and cover letter within a strict honesty rule,
 * renders the resume to PDF, applies (email, or an API endpoint the user
 * configured), and emails a summary with the ledger.
 *
 * Built only from generic primitives: workflow variables, expression routers,
 * agent `resultKey`, `render-document`, notify email attachments, multipart
 * http-request, `state-list` and the shared idempotency claim. This file is the
 * ONLY place that knows its domain, and it is loaded on demand (see
 * `WORKFLOW_TEMPLATES`).
 *
 * Sources (verified live 2026-10-01; each permits automated reads with
 * attribution, and the summary credits every posting's source):
 * - Remotive and RemoteOK: public remote-job feeds, no key.
 * - Greenhouse / Lever / Ashby public boards listed in `vars.companyBoards`. The
 *   defaults are companies with Melbourne (or ANZ-remote) roles open at the time
 *   of writing, so a run returns local postings with no configuration.
 * - Adzuna's Australian search API, OPTIONAL: it runs only once
 *   `vars.adzunaAppId` is set and an Adzuna connection (query auth, `app_key`)
 *   is selected on its step. Adzuna returns a description snippet, not the full
 *   posting, so its fit screen sees less than the other sources'.
 * SEEK is deliberately absent: it has no public job-search API (its developer
 * platform serves hirers and ATS partners only) and its terms forbid scraping.
 * None of these sources offers a candidate-facing apply API without the
 * employer's own key, so the API branch runs only for a board the user marks
 * `|api` AND an `applyApiUrl` the user sets; by default it is wired and unused.
 *
 * Honesty rule (enforced deterministically before anything is sent): every
 * heading line of the profile (name, contact line, roles, education,
 * certifications) is reproduced verbatim and no new heading appears; every
 * figure in the resume exists in the profile; added skills are capped, sit in
 * the Skills section only, are declared, and each names related experience
 * already on the profile. One revision round, then the posting is blocked.
 */

import type {
  AgentNodeData,
  AssertNodeData,
  ForEachNodeData,
  HttpRequestNodeData,
  NotifyNodeData,
  RenderDocumentNodeData,
  RouterNodeData,
  StateGetNodeData,
  StateListNodeData,
  StateSetNodeData,
  TransformField,
  TransformNodeData,
  WorkflowConnection,
  WorkflowNode,
  WorkflowSpec,
  WorkflowVariable,
} from '../workflow.model';
import { buildScheduleCron } from '../schedule-cron';
import { agent, connect, node, resetTemplateConnections } from '../workflow-templates';

export const WEEKLY_APPLICATIONS_TEMPLATE_ID = 'tpl-weekly-job-applications';

/** 30 days: the ledger window for both `applied:` and `screened:`. */
export const LEDGER_TTL_SEC = 2_592_000;

/** The schedule's zone. Pinned rather than read from the machine the template is opened on. */
export const SCHEDULE_TIME_ZONE = 'Australia/Melbourne';

const P = 'tpl-wja';

// ── Sample content (obviously fake: replace before use) ─────────────────────

const SAMPLE_PROFILE = [
  '# Alex Placeholder',
  '#### alex.placeholder@example.com | 0491 570 156 | Melbourne VIC | github.com/alex-placeholder',
  '',
  '## Summary',
  'Software engineer focused on backend services and AI-assisted automation. Builds reliable',
  'TypeScript and Python systems, ships small and often, and writes things down. Australian',
  'citizen with full working rights.',
  '',
  '## Experience',
  '### Senior Software Engineer | Example Robotics Pty Ltd | 2021 - Present',
  '- Led the move of order processing to an event-driven pipeline, cutting p95 latency by 40%.',
  '- Built an LLM triage assistant with LangChain that resolves 30% of internal tickets unaided.',
  '- Mentored 4 engineers; introduced code review checklists and on-call runbooks.',
  '- Owned the PostgreSQL schema for 12 services and its zero-downtime migrations.',
  '',
  '### Software Engineer | Sample Data Co. | 2018 - 2021',
  '- Wrote Python ETL jobs moving 2 TB a day into the warehouse with Airflow.',
  '- Shipped a React and Node.js admin console used by 150 support staff.',
  '- Automated release checks in GitHub Actions, saving about 6 hours a week.',
  '',
  '## Skills',
  '- TypeScript, Node.js, Python, SQL, PostgreSQL',
  '- LangChain, OpenAI API, prompt engineering, Airflow',
  '- React, Docker, Kubernetes, AWS, GitHub Actions',
  '',
  '## Education',
  '### B.Sc. Computer Science | Example State University | 2014 - 2018',
  '',
  '## Certifications',
  '### Example Cloud Practitioner | 2022',
].join('\n');

const SAMPLE_RESUME_TEMPLATE = [
  '# Full name, exactly as in the profile',
  '#### Contact line, exactly as in the profile',
  '',
  '## Summary',
  'Two or three sentences written for this role, using only facts from the profile.',
  '',
  '## Experience',
  '### Role line, exactly as in the profile (one per role, every role kept)',
  '- The most relevant bullets for this role, rephrased to echo the posting, facts unchanged',
  '',
  '## Skills',
  '- Comma-separated skills, most relevant first',
  '',
  '## Education',
  '### Exactly as in the profile',
  '',
  '## Certifications',
  '### Exactly as in the profile',
].join('\n');

function variable(
  name: string,
  type: WorkflowVariable['type'],
  value: WorkflowVariable['value'],
  description: string,
): WorkflowVariable {
  return { name, type, value, description };
}

const VARIABLES: WorkflowVariable[] = [
  variable(
    'profile',
    'markdown',
    SAMPLE_PROFILE,
    'SAMPLE - replace with your own master profile. Lines starting with # are fixed facts: your ' +
      'name, a #### contact line, ### role lines (Title | Employer | Dates), education and ' +
      'certifications. Tailoring reproduces them verbatim and never adds a figure that is not here.',
  ),
  variable(
    'resumeTemplate',
    'markdown',
    SAMPLE_RESUME_TEMPLATE,
    'Single-column layout the tailored resume follows. Keep its section headings identical to the profile.',
  ),
  variable('remotiveCategory', 'text', 'software-dev', 'Remotive category slug to fetch.'),
  variable(
    'companyBoards',
    'list',
    [
      'ashby:xero',
      'greenhouse:easygo',
      'greenhouse:block',
      'greenhouse:cultureamp',
      'lever:mable',
      'ashby:sitemate',
      'lever:deputy',
      'greenhouse:buildkite',
      'greenhouse:octopusdeploy',
      'ashby:dovetail',
    ],
    'Company job boards, one per line: provider:board (greenhouse, lever or ashby; the board is the ' +
      'name in the company careers url, such as jobs.ashbyhq.com/xero). The defaults are companies ' +
      'hiring in Melbourne or ANZ-remote. A board must answer in under 4 MB: a global company ' +
      'listing hundreds of roles with full descriptions (Airwallex, about 8.5 MB) fails to read ' +
      'and is reported as a source error. Append |api only when that company accepts applications ' +
      'at applyApiUrl without employer credentials.',
  ),
  variable(
    'homeLocations',
    'list',
    ['melbourne'],
    'Where you live. A role whose location names one of these is eligible whether it is remote, ' +
      'hybrid or on-site. The first entry is also the Adzuna search location. Empty: remote roles only.',
  ),
  variable(
    'remoteRegions',
    'list',
    [
      'australia',
      'au:',
      'anz',
      'apac',
      'asia pacific',
      'oceania',
      'worldwide',
      'anywhere',
      'global',
      'sydney',
      'brisbane',
      'perth',
      'adelaide',
      'canberra',
      'hobart',
    ],
    'A REMOTE role must name one of these regions (or no region at all) to be eligible, so remote ' +
      'roles restricted to another country are dropped. Empty accepts every region.',
  ),
  variable(
    'adzunaAppId',
    'text',
    '',
    'Optional extra source: your Adzuna app id (free at developer.adzuna.com). Adzuna is searched only ' +
      'while this is set; select an Adzuna connection holding the app key on the "Adzuna" step.',
  ),
  variable(
    'includeKeywords',
    'list',
    [
      'engineer',
      'developer',
      'automation',
      'machine learning',
      'backend',
      'full stack',
      'platform',
      'scientist',
      'architect',
      'devops',
    ],
    'A posting title must contain at least one of these (matched inside words, so avoid very short ' +
      'ones such as "ai", which also matches "maintenance"). Empty accepts every title.',
  ),
  variable(
    'excludeKeywords',
    'list',
    ['unpaid', 'internship', 'commission only', 'clearance required'],
    'A posting whose title or description contains any of these is skipped.',
  ),
  variable(
    'excludeTitleKeywords',
    'list',
    ['manager', 'director', 'head of'],
    'A posting whose TITLE contains any of these is skipped. Title only, because a description ' +
      'routinely mentions the manager a role reports to.',
  ),
  variable('excludedCompanies', 'list', [], 'Companies never to apply to, one per line.'),
  variable(
    'maxPostingAgeDays',
    'number',
    14,
    'Only postings published within this many days. Twice the weekly cadence, so a posting a feed ' +
      'lists late is still caught; the 30-day ledger stops it being handled twice.',
  ),
  variable('maxApplicationsPerRun', 'number', 20, 'Most postings screened in one run.'),
  variable('minFitScore', 'number', 70, 'Fit score (0-100) a posting needs before tailoring.'),
  variable('maxAddedSkills', 'number', 3, 'Most skills the tailored resume may add that the profile does not list.'),
  variable(
    'dryRun',
    'boolean',
    true,
    'While true, documents are generated and the summary is sent to you, but NOTHING is sent to an ' +
      'employer and nothing is written to the applied ledger.',
  ),
  variable('applicantEmail', 'text', 'alex.placeholder@example.com', 'Your address: Reply-To on every application.'),
  variable(
    'senderEmail',
    'text',
    'Alex Placeholder <apply@example.com>',
    'From address: must be on a domain verified in your Resend account.',
  ),
  variable('notifyEmail', 'text', 'alex.placeholder@example.com', 'Where the weekly summary goes.'),
  variable(
    'applyApiUrl',
    'text',
    'https://apply.example.com/v1/applications',
    'Candidate-facing application endpoint used for boards marked |api. Unused by default.',
  ),
];

// ── Node helpers ────────────────────────────────────────────────────────────

const RETRY = { maxAttempts: 3, backoffMs: 2000, idempotent: true, honorRetryAfter: true };

function field(target: string, expression: string): TransformField {
  return { target, expression };
}

function transform(
  id: string,
  name: string,
  x: number,
  y: number,
  fields: TransformField[],
  extra: Partial<TransformNodeData> = {},
  description?: string,
): WorkflowNode {
  return node({
    id,
    name,
    kind: 'transform',
    category: 'flow',
    icon: 'ti ti-transform',
    x,
    y,
    ports: [
      { key: 'in', name: 'In', role: 'message-in' },
      { key: 'out', name: 'Out', role: 'message-out' },
    ],
    data: { mode: 'record', fields, ...extra } satisfies TransformNodeData,
    description,
  });
}

function router(
  id: string,
  name: string,
  x: number,
  y: number,
  expression: string,
  routes: string[],
  description?: string,
): WorkflowNode {
  return node({
    id,
    name,
    kind: 'router',
    category: 'flow',
    icon: 'ti ti-arrows-split',
    x,
    y,
    ports: [
      { key: 'in', name: 'In', role: 'message-in' },
      ...routes.map(route => ({ key: routeKey(route), name: route, role: 'message-out' as const })),
    ],
    data: { mode: 'expression', expression } satisfies RouterNodeData,
    description,
  });
}

function routeKey(route: string): string {
  return `r-${route.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
}

function stateNode(
  id: string,
  name: string,
  kind: 'state-get' | 'state-set' | 'state-list',
  x: number,
  y: number,
  data: StateGetNodeData | StateSetNodeData | StateListNodeData,
  description?: string,
): WorkflowNode {
  return node({
    id,
    name,
    kind,
    category: 'flow',
    icon: kind === 'state-get' ? 'ti ti-bookmark' : kind === 'state-set' ? 'ti ti-bookmark-plus' : 'ti ti-list-details',
    x,
    y,
    ports: [
      { key: 'in', name: 'In', role: 'message-in' },
      { key: 'out', name: 'Out', role: 'message-out' },
    ],
    data,
    description,
  });
}

function forEach(id: string, name: string, x: number, y: number, data: ForEachNodeData, description: string): WorkflowNode {
  return node({
    id,
    name,
    kind: 'for-each',
    category: 'flow',
    icon: 'ti ti-repeat',
    x,
    y,
    ports: [
      { key: 'in', name: 'In', role: 'message-in' },
      { key: 'each', name: 'Each item', role: 'message-out' },
      { key: 'done', name: 'Done', role: 'message-out' },
    ],
    data,
    description,
  });
}

function fetchStep(id: string, name: string, x: number, y: number, url: string, query: { key: string; value: string }[]): WorkflowNode {
  return node({
    id,
    name,
    kind: 'http-request',
    category: 'flow',
    icon: 'ti ti-api',
    x,
    y,
    ports: [
      { key: 'in', name: 'In', role: 'message-in' },
      { key: 'response', name: 'Response', role: 'message-out' },
      { key: 'err', name: 'On error', role: 'message-out' },
    ],
    data: {
      method: 'GET',
      url,
      query,
      headers: [
        { key: 'Accept', value: 'application/json' },
        { key: 'User-Agent', value: 'PhormaAgentStudio/1.0 (weekly job search; personal use)' },
      ],
      bodyMode: 'none',
      responseMode: 'json',
      resultKey: 'response',
      pagination: { mode: 'none' },
      retry: RETRY,
      timeoutSec: 30,
      fixtures: 'off',
    } satisfies HttpRequestNodeData,
  });
}

function assertNode(id: string, name: string, x: number, y: number, assertions: AssertNodeData['assertions'], description: string): WorkflowNode {
  return node({
    id,
    name,
    kind: 'assert',
    category: 'flow',
    icon: 'ti ti-shield-check',
    x,
    y,
    ports: [
      { key: 'in', name: 'In', role: 'message-in' },
      { key: 'pass', name: 'Passed', role: 'message-out' },
      { key: 'fail', name: 'Failed', role: 'message-out' },
    ],
    data: { assertions, onBreach: 'route', failedPortId: `${id}-fail` } satisfies AssertNodeData,
    description,
  });
}

// ── Expressions ─────────────────────────────────────────────────────────────

/** Normalised posting fields shared by every source. */
function postingFields(
  source: string,
  map: {
    key: string;
    company: string;
    title: string;
    url: string;
    location: string;
    remote: string;
    postedAt: string;
    description: string;
    applyApi: string;
  },
): TransformField[] {
  return [
    field('key', map.key),
    field('source', `'${source}'`),
    field('company', `trim(coalesce(${map.company}, ''))`),
    field('title', `trim(coalesce(${map.title}, ''))`),
    field('url', map.url),
    field('location', `coalesce(${map.location}, '')`),
    field('remote', map.remote),
    field('postedAt', `formatDate(${map.postedAt}, 'iso')`),
    field('description', `substr(${map.description}, 0, 12000)`),
    field('applyEmail', 'null'),
    field('applyApi', map.applyApi),
  ];
}

/** `source:id`, or a hash of the url when a record carries no stable id. */
const keyOf = (prefix: string, id: string): string =>
  `isNull(${id}) ? concat('url:', hash(lower(coalesce(item.url, '')))) : concat(${prefix}, toString(${id}))`;

/** A role based in one of the user's home locations, whatever its work arrangement. */
const LOCAL =
  '(len(vars.homeLocations) > 0 && containsAny(lower(item.location), map(vars.homeLocations, "lower(trim(item))")))';

/** A remote role open to the user: no region named, or one of the allowed regions. */
const REMOTE_OPEN =
  '(item.remote == true && (isEmpty(trim(item.location)) || lower(trim(item.location)) == "remote" || ' +
  'len(vars.remoteRegions) == 0 || containsAny(lower(item.location), map(vars.remoteRegions, "lower(trim(item))"))))';

/** Local or open-remote, recent, on-topic, not excluded. */
const PREFILTER = [
  `(${LOCAL} || ${REMOTE_OPEN})`,
  '!isNull(parseDate(item.postedAt))',
  'dateDiffDays(now(), item.postedAt) <= vars.maxPostingAgeDays',
  '(len(vars.includeKeywords) == 0 || containsAny(lower(item.title), map(vars.includeKeywords, "lower(item)")))',
  '!containsAny(lower(concat(item.title, " ", item.description)), map(vars.excludeKeywords, "lower(item)"))',
  '!containsAny(lower(item.title), map(vars.excludeTitleKeywords, "lower(trim(item))"))',
  '!(lower(item.company) in map(vars.excludedCompanies, "lower(trim(item))"))',
].join(' && ');

/**
 * Ranking before the per-run cap: local roles first, then remote roles naming
 * an allowed region, then remote roles naming none (often country-restricted
 * in their text); newest first within each band.
 */
const RANK =
  `(${LOCAL} ? 0 : ((isEmpty(trim(item.location)) || lower(trim(item.location)) == "remote") ? 2 : 1)) ` +
  '* 100000000000000 - parseDate(item.postedAt)';

/**
 * Employer identity for the cross-source duplicate check: one listing on two
 * feeds often differs only by a legal suffix ("Acme Inc" / "Acme").
 */
const COMPANY_KEY =
  'replace(replace(replace(replace(replace(replace(lower(trim(item.company)), ".", ""), ",", ""), ' +
  '" pty ltd", ""), " ltd", ""), " inc", ""), " llc", "")';

/** One source's normalised postings cut down to the eligible ones (runs once per source). */
const ELIGIBLE = `filter(coalesce($.postings, []), '!isEmpty(item.title) && !isEmpty(item.url) && ${PREFILTER}')`;

/** Every source's eligible postings, deduplicated, ranked and capped. */
const POSTINGS =
  "map(slice(sort(distinctBy(distinctBy(" +
  "flatten(map(filter($.results, '!isNull(item)'), 'coalesce(item.postings, [])')), " +
  `'item.key'), 'concat(${COMPANY_KEY}, "|", lower(trim(item.title)))'), ` +
  `'${RANK}'), 0, vars.maxApplicationsPerRun), '{"posting": item}')`;

const RESUME = "coalesce($.tailored.resumeMarkdown, '')";
const SKILLS_SECTION = `coalesce(first(split(coalesce(first(slice(split(${RESUME}, '## Skills'), 1, 2)), ''), '\\n## ')), '')`;

/** Derived facts the fidelity guard compares (pure functions of profile and reply). */
const FACT_FIELDS: TransformField[] = [
  field('facts.profileHeadings', "filter(map(split(vars.profile, '\\n'), 'trim(item)'), 'startsWith(item, \"#\")')"),
  field('facts.resumeHeadings', `filter(map(split(${RESUME}, '\\n'), 'trim(item)'), 'startsWith(item, "#")')`),
  field('facts.profileNumbers', 'extractNumbers(vars.profile)'),
  field('facts.resumeNumbers', `extractNumbers(${RESUME})`),
  field('facts.letterNumbers', "extractNumbers(coalesce($.tailored.coverLetter, ''))"),
  field('facts.postingNumbers', "extractNumbers(concat($.posting.title, ' ', $.posting.description))"),
  field('facts.skillsSection', SKILLS_SECTION),
  field('facts.outsideSkills', `replace(${RESUME}, ${SKILLS_SECTION}, '')`),
  field(
    'facts.resumeSkills',
    `filter(map(split(replace(replace(${SKILLS_SECTION}, '\\n', ','), '- ', ''), ','), 'trim(replace(item, "**", ""))'), '!isEmpty(item)')`,
  ),
  field('facts.addedNames', "map(coalesce($.tailored.addedSkills, []), 'trim(coalesce(item.skill, \"\"))')"),
  field(
    'documentName',
    "concat(trim(replace(first(split(trim(vars.profile), '\\n')), '#', '')), ' - ', $.posting.company, ' - Resume')",
  ),
];

const FIDELITY: AssertNodeData['assertions'] = [
  {
    name: 'Reply complete',
    expression: '!isEmpty($.tailored.resumeMarkdown) && !isEmpty($.tailored.coverLetter) && !isEmpty($.tailored.emailSubject)',
    message: 'The reply must carry resumeMarkdown, coverLetter and emailSubject.',
  },
  {
    name: 'Fixed facts kept',
    expression: "countIf($.facts.profileHeadings, '!(item in $.facts.resumeHeadings)') == 0",
    message: 'Every heading line of the profile (name, contact, roles, education, certifications) must appear unchanged.',
  },
  {
    name: 'No invented headings',
    expression: "countIf($.facts.resumeHeadings, '!(item in $.facts.profileHeadings)') == 0",
    message: 'The resume may not add or alter a heading line (employer, title, dates, degree, certificate).',
  },
  {
    name: 'No new figures in the resume',
    expression: "countIf($.facts.resumeNumbers, '!(item in $.facts.profileNumbers)') == 0",
    message: 'Every number in the resume must already be in the profile.',
  },
  {
    name: 'Cover letter figures are real',
    expression:
      "countIf($.facts.letterNumbers, '!(item in $.facts.profileNumbers) && !(item in $.facts.postingNumbers)') == 0",
    message: 'Every number in the cover letter must come from the profile or the posting.',
  },
  {
    name: 'Added skills within limit',
    expression: 'len(coalesce($.tailored.addedSkills, [])) <= vars.maxAddedSkills',
    message: 'Too many skills that are not on the profile.',
  },
  {
    name: 'Added skills only under Skills',
    expression:
      "countIf($.facts.addedNames, 'isEmpty(item) || contains(lower($.facts.outsideSkills), lower(item)) || !contains(lower($.facts.skillsSection), lower(item))') == 0",
    message: 'An added skill must appear in the Skills section and nowhere else.',
  },
  {
    name: 'Added skills are anchored',
    expression:
      "countIf(coalesce($.tailored.addedSkills, []), 'isEmpty(item.relatedTo) || !contains(lower(vars.profile), lower(item.relatedTo))') == 0",
    message: 'Each added skill must name related experience that is already on the profile.',
  },
  {
    name: 'Every new skill is declared',
    expression:
      "countIf($.facts.resumeSkills, '!contains(lower(vars.profile), lower(item)) && !(lower(item) in map($.facts.addedNames, \"lower(item)\"))') == 0",
    message: 'A skill not on the profile must be listed in addedSkills.',
  },
];

/** Outcome record fields read from the current payload, or from a breach report's `input`. */
function outcomeFields(outcome: string, base: string, extra: TransformField[] = []): TransformField[] {
  return [
    field('outcome', `'${outcome}'`),
    field('key', `${base}.posting.key`),
    field('source', `${base}.posting.source`),
    field('company', `${base}.posting.company`),
    field('title', `${base}.posting.title`),
    field('url', `${base}.posting.url`),
    ...extra,
  ];
}

const FROM_BREACH = 'parseJson($.input)';

const RECORD_VALUE = (method: string) =>
  `{"company": $.posting.company, "title": $.posting.title, "url": $.posting.url, "method": ${method}, ` +
  `"appliedAt": formatDate(now(), 'iso'), "addedSkills": coalesce($.tailored.addedSkills, []), "score": $.fitScore}`;

// ── Prompts (markdown) ──────────────────────────────────────────────────────

const FIT_PROMPT = [
  '# Fit screen',
  '',
  'You decide whether ONE job posting is worth applying to for the candidate below. Judge the',
  'must-have requirements against what the profile actually shows. Do not reward keyword overlap',
  'alone, and do not penalise missing nice-to-haves heavily.',
  '',
  '## Candidate profile',
  '{{vars.profile}}',
  '',
  '## Posting',
  '- Company: {{posting.company}}',
  '- Title: {{posting.title}}',
  '- Location: {{posting.location}}',
  '- Link: {{posting.url}}',
  '',
  '{{posting.description}}',
  '',
  '## Where the candidate can work',
  'The candidate lives in {{vars.homeLocations.0}}, Australia. A role based there is fine in any work',
  'arrangement. A remote role must be open to someone working from Australia; one that needs',
  'relocation, a work visa for another country, or mostly overnight hours is a poor fit.',
  '',
  '## Reply',
  'Reply with ONE JSON object and nothing else:',
  '',
  '```json',
  '{"score": 0, "reasons": ["..."], "missingSkills": ["..."], "applyMethod": "api | email | manual", "applyEmail": ""}',
  '```',
  '',
  '- `score`: 0-100, how well the profile meets the role\'s must-haves.',
  '- `reasons`: two to four short reasons for the score.',
  '- `missingSkills`: must-haves the profile does not show.',
  '- `applyMethod`: "email" ONLY when the posting text explicitly asks for applications by email,',
  '  and then copy that exact address into `applyEmail`. Otherwise "manual" with `applyEmail` "".',
  '  Never invent or guess an address; the workflow checks it against the posting text.',
].join('\n');

const TAILOR_RULES = [
  '## Honesty rules (checked automatically; a violation is never sent)',
  '- Copy EVERY line of the profile that starts with `#` exactly, character for character: the name,',
  '  the `####` contact line, every `###` role line (title, employer, dates), education and',
  '  certifications. Keep every role. Add no other heading lines; use the section headings shown.',
  '- Never add a number, date, percentage or metric that is not already in the profile.',
  '- You MAY reorder sections and bullets, choose which bullets to show, rephrase a bullet to mirror',
  '  the posting\'s wording without changing its facts, rewrite the Summary, and reorder skills.',
  '- You MAY add at most {{vars.maxAddedSkills}} skills the profile does not list, ONLY inside the',
  '  Skills section, and only where the profile already shows closely related experience (for',
  '  example a sibling framework of one the profile lists). List each one in `addedSkills` with the',
  '  related experience in `relatedTo`, quoted from the profile.',
  '- Skills section lines are `- skill, skill, skill`.',
  '- Write in Australian English (organise, optimise, colour, centre).',
].join('\n');

const TAILOR_PROMPT = [
  '# Tailor',
  '',
  'Write a resume and a cover letter for ONE posting, using ONLY facts from the profile.',
  '',
  '## Profile (the only source of facts)',
  '{{vars.profile}}',
  '',
  '## Layout to follow',
  '{{vars.resumeTemplate}}',
  '',
  '## Posting',
  '- Company: {{posting.company}}',
  '- Title: {{posting.title}}',
  '',
  '{{posting.description}}',
  '',
  TAILOR_RULES,
  '',
  '## Cover letter',
  'Plain prose for an email body: a greeting, three short paragraphs specific to this posting and',
  'this company, and a sign-off with the name from the profile. No markdown, no placeholders.',
  '',
  '## Reply',
  'Reply with ONE JSON object and nothing else:',
  '',
  '```json',
  '{"resumeMarkdown": "...", "addedSkills": [{"skill": "...", "relatedTo": "..."}], "coverLetter": "...", "emailSubject": "..."}',
  '```',
].join('\n');

const REVISE_PROMPT = [
  '# Revise',
  '',
  'An automatic check rejected the tailored resume or cover letter below. Fix EVERY listed issue',
  'and change nothing else that was correct.',
  '',
  '## Failed checks',
  '{{issues}}',
  '',
  '## Profile (the only source of facts)',
  '{{vars.profile}}',
  '',
  '## Previous reply',
  '{{tailored}}',
  '',
  TAILOR_RULES,
  '',
  '## Reply',
  'Reply with ONE JSON object and nothing else, in the same shape as the previous reply:',
  '`{"resumeMarkdown", "addedSkills": [{"skill", "relatedTo"}], "coverLetter", "emailSubject"}`.',
].join('\n');

const SUMMARY_PROMPT = [
  '# Weekly summary',
  '',
  'Write the weekly report of this run for the candidate. Use the counts EXACTLY as given; do not',
  'recount. Dry run: {{vars.dryRun}} (when true, say clearly that nothing was sent to employers).',
  '',
  '## Counts',
  '{{stats}}',
  '',
  '## This run, one record per posting',
  '{{results}}',
  '',
  '## Postings that failed with an error',
  '{{exceptions}}',
  '',
  '## Sources (postings fetched, and sources that could not be read)',
  '{{sources}}',
  '',
  '## The applied ledger (entries expire 30 days after they were written)',
  '{{ledger}}',
  '',
  '## Write markdown with these sections',
  '1. **Counts by outcome** - one line per outcome.',
  '2. **Applications this run** - a table: company, title, method, score, added skills (name each',
  '   added skill so the candidate can prepare for it in an interview).',
  '3. **Apply manually** - every `manual` (or, in a dry run, `dry-run`) posting with its link.',
  '4. **Failures** - blocked, failed and errored postings with the reason.',
  '5. **Ledger** - every entry with company, title, method and expiry date.',
  'Credit the source of each posting (Remotive, Remote OK, the company board, or "Jobs by Adzuna"',
  'linked to https://www.adzuna.com.au) with its link.',
  '',
  '## Reply',
  'Reply with ONE JSON object and nothing else:',
  '`{"subject": "...", "markdown": "..."}`',
].join('\n');

// ── The workflow ────────────────────────────────────────────────────────────

export function buildWeeklyJobApplicationsWorkflow(): WorkflowSpec {
  resetTemplateConnections();
  const timezone = SCHEDULE_TIME_ZONE;
  const nodes: WorkflowNode[] = [];
  const edges: WorkflowConnection[] = [];
  const add = (...items: WorkflowNode[]) => nodes.push(...items);
  const wire = (from: string, fromPort: string, to: string, toPort = 'in') =>
    edges.push(connect(from, fromPort, to, toPort));

  // Triggers.
  add(
    node({
      id: `${P}-schedule`,
      name: 'Every Monday 08:00',
      kind: 'schedule-trigger',
      category: 'trigger',
      icon: 'ti ti-clock-play',
      x: 0,
      y: 120,
      ports: [{ key: 'tick', name: 'Tick', role: 'message-out' }],
      data: {
        timezone,
        cron: buildScheduleCron({ frequency: 'weekly', hour: 8, minute: 0, weekdays: [1], dayOfMonth: 1 }, timezone),
      },
      description:
        'Fires on a deployed worker only. 08:00 Melbourne time, compiled to UTC: after a daylight ' +
        'saving change it runs an hour off until the schedule step is edited again.',
    }),
    node({
      id: `${P}-manual`,
      name: 'Run now',
      kind: 'manual-trigger',
      category: 'trigger',
      icon: 'ti ti-player-play',
      x: 0,
      y: 340,
      ports: [{ key: 'start', name: 'Start', role: 'message-out' }],
      data: {},
    }),
  );

  // Sources.
  add(
    transform(
      `${P}-sources`,
      'Build source list',
      280,
      230,
      [
        field(
          'sources',
          "flatten([[{\"provider\": \"remotive\", \"slug\": vars.remotiveCategory, \"applyApi\": false}, " +
            "{\"provider\": \"remoteok\", \"slug\": \"\", \"applyApi\": false}], " +
            "isEmpty(trim(coalesce(vars.adzunaAppId, ''))) ? [] : [{\"provider\": \"adzuna\", " +
            "\"slug\": coalesce(first(vars.homeLocations), 'melbourne'), " +
            "\"what\": join(vars.includeKeywords, ' '), \"applyApi\": false}], " +
            "map(vars.companyBoards, '{\"provider\": lower(trim(first(split(item, \":\")))), " +
            "\"slug\": trim(first(split(coalesce(first(slice(split(item, \":\"), 1, 2)), \"\"), \"|\"))), " +
            "\"applyApi\": contains(item, \"|api\")}')])",
        ),
      ],
      {},
      'Remotive and RemoteOK, Adzuna once adzunaAppId is set, and every company board listed in the ' +
        'companyBoards variable.',
    ),
    forEach(
      `${P}-each-source`,
      'Each source',
      560,
      230,
      { itemsPath: 'sources', concurrency: 2, continueOnError: true },
      'Fetches every source; a source that fails is reported in the summary and the rest continue.',
    ),
    router(`${P}-provider`, 'By provider', 840, 230, '$.provider', [
      'Remotive',
      'RemoteOK',
      'Greenhouse',
      'Lever',
      'Ashby',
      'Adzuna',
    ]),
    fetchStep(`${P}-fetch-remotive`, 'Remotive', 1120, -60, 'https://remotive.com/api/remote-jobs', [
      { key: 'category', value: '{{slug}}' },
    ]),
    fetchStep(`${P}-fetch-remoteok`, 'RemoteOK', 1120, 90, 'https://remoteok.com/api', []),
    fetchStep(`${P}-fetch-greenhouse`, 'Greenhouse board', 1120, 240, 'https://boards-api.greenhouse.io/v1/boards/{{slug}}/jobs', [
      { key: 'content', value: 'true' },
    ]),
    fetchStep(`${P}-fetch-lever`, 'Lever board', 1120, 390, 'https://api.lever.co/v0/postings/{{slug}}', [
      { key: 'mode', value: 'json' },
    ]),
    fetchStep(`${P}-fetch-ashby`, 'Ashby board', 1120, 540, 'https://api.ashbyhq.com/posting-api/job-board/{{slug}}', []),
    {
      ...fetchStep(`${P}-fetch-adzuna`, 'Adzuna', 1120, 690, 'https://api.adzuna.com/v1/api/jobs/au/search/1', [
        { key: 'app_id', value: '{{vars.adzunaAppId}}' },
        { key: 'where', value: '{{slug}}' },
        { key: 'distance', value: '50' },
        { key: 'what_or', value: '{{what}}' },
        { key: 'max_days_old', value: '{{vars.maxPostingAgeDays}}' },
        { key: 'sort_by', value: 'date' },
        { key: 'results_per_page', value: '50' },
      ]),
      description:
        'Optional. Runs only while the adzunaAppId variable is set. Select a connection here: type ' +
        'http, auth "query parameter" named app_key, holding your Adzuna app key.',
    },
    transform(
      `${P}-norm-remotive`,
      'Normalise Remotive',
      1400,
      -60,
      postingFields('Remotive', {
        key: keyOf("'remotive:'", 'item.id'),
        company: 'item.company_name',
        title: 'item.title',
        url: 'item.url',
        location: 'item.candidate_required_location',
        remote: 'true',
        postedAt: 'item.publication_date',
        description: "htmlToText(coalesce(item.description, ''))",
        applyApi: 'false',
      }),
      { mode: 'array', itemsPath: 'response.jobs', resultKey: 'postings' },
    ),
    transform(
      `${P}-norm-remoteok`,
      'Normalise RemoteOK',
      1400,
      90,
      postingFields('Remote OK', {
        key: keyOf("'remoteok:'", 'item.id'),
        company: 'item.company',
        title: 'item.position',
        url: 'coalesce(item.url, item.apply_url)',
        location: 'item.location',
        remote: 'true',
        postedAt: 'item.date',
        description: "htmlToText(coalesce(item.description, ''))",
        applyApi: 'false',
      }),
      { mode: 'array', itemsPath: 'response', resultKey: 'postings' },
    ),
    transform(
      `${P}-norm-greenhouse`,
      'Normalise Greenhouse',
      1400,
      240,
      postingFields('Greenhouse', {
        key: keyOf("concat('greenhouse:', $.slug, ':')", 'item.id'),
        company: 'coalesce(item.company_name, $.slug)',
        title: 'item.title',
        url: 'item.absolute_url',
        location: 'item.location.name',
        remote: "contains(lower(coalesce(item.location.name, '')), 'remote')",
        postedAt: 'coalesce(item.first_published, item.updated_at)',
        // Greenhouse escapes its HTML, so it decodes twice.
        description: "htmlToText(htmlToText(coalesce(item.content, '')))",
        applyApi: '$.applyApi',
      }),
      { mode: 'array', itemsPath: 'response.jobs', resultKey: 'postings' },
    ),
    transform(
      `${P}-norm-lever`,
      'Normalise Lever',
      1400,
      390,
      postingFields('Lever', {
        key: keyOf("concat('lever:', $.slug, ':')", 'item.id'),
        company: '$.slug',
        title: 'item.text',
        url: 'item.hostedUrl',
        // Every office the role is open to, so a Melbourne second office still matches.
        location:
          "len(coalesce(item.categories.allLocations, [])) > 0 ? join(item.categories.allLocations, ' / ') : item.categories.location",
        remote:
          "lower(coalesce(item.workplaceType, '')) == 'remote' || contains(lower(coalesce(item.categories.location, '')), 'remote')",
        postedAt: 'item.createdAt',
        description:
          "concat(coalesce(item.descriptionPlain, ''), '\\n\\n', join(map(coalesce(item.lists, []), " +
          "'concat(coalesce(item.text, \"\"), \": \", htmlToText(coalesce(item.content, \"\")))'), '\\n\\n'), " +
          "'\\n\\n', coalesce(item.additionalPlain, ''))",
        applyApi: '$.applyApi',
      }),
      { mode: 'array', itemsPath: 'response', resultKey: 'postings' },
    ),
    transform(
      `${P}-norm-ashby`,
      'Normalise Ashby',
      1400,
      540,
      postingFields('Ashby', {
        key: keyOf("concat('ashby:', $.slug, ':')", 'item.id'),
        company: '$.slug',
        title: 'item.title',
        url: 'item.jobUrl',
        location:
          "concat(coalesce(item.location, ''), len(coalesce(item.secondaryLocations, [])) > 0 ? " +
          "concat(' / ', join(map(item.secondaryLocations, 'coalesce(item.location, \"\")'), ' / ')) : '')",
        // Ashby sets isRemote on hybrid roles too, so the workplace type decides when present.
        remote:
          "isEmpty(coalesce(item.workplaceType, '')) ? item.isRemote == true : lower(item.workplaceType) == 'remote'",
        postedAt: 'item.publishedAt',
        description: "coalesce(item.descriptionPlain, htmlToText(coalesce(item.descriptionHtml, '')))",
        applyApi: '$.applyApi',
      }),
      { mode: 'array', itemsPath: 'response.jobs', resultKey: 'postings' },
    ),
    transform(
      `${P}-norm-adzuna`,
      'Normalise Adzuna',
      1400,
      690,
      postingFields('Adzuna', {
        key: keyOf("'adzuna:'", 'item.id'),
        company: 'item.company.display_name',
        title: 'item.title',
        url: 'item.redirect_url',
        // The endpoint is Australia-only, so the country is a fact rather than a guess.
        location: "concat(coalesce(item.location.display_name, ''), ', Australia')",
        remote:
          "containsAny(lower(concat(coalesce(item.title, ''), ' ', coalesce(item.description, ''))), " +
          "['remote', 'work from home', 'wfh'])",
        postedAt: 'item.created',
        description: "htmlToText(coalesce(item.description, ''))",
        applyApi: 'false',
      }),
      { mode: 'array', itemsPath: 'response.results', resultKey: 'postings' },
    ),
  );
  wire(`${P}-schedule`, 'tick', `${P}-sources`);
  wire(`${P}-manual`, 'start', `${P}-sources`);
  wire(`${P}-sources`, 'out', `${P}-each-source`);
  wire(`${P}-each-source`, 'each', `${P}-provider`);
  // Every normaliser feeds one filter, so a source's loop result is its eligible
  // postings only: the merge, the trace and the run journal never carry the
  // thousand-odd full descriptions a run fetches.
  add(
    transform(
      `${P}-keep-eligible`,
      'Keep eligible postings',
      1680,
      240,
      [field('postings', ELIGIBLE), field('fetched', 'len(coalesce($.postings, []))')],
      { mode: 'record' },
      'Keeps postings in a home location or remote and open to an allowed region, recent, on-topic ' +
        'and not excluded. No model involved.',
    ),
  );
  for (const [route, fetch, norm] of [
    ['Remotive', 'remotive', 'remotive'],
    ['RemoteOK', 'remoteok', 'remoteok'],
    ['Greenhouse', 'greenhouse', 'greenhouse'],
    ['Lever', 'lever', 'lever'],
    ['Ashby', 'ashby', 'ashby'],
    ['Adzuna', 'adzuna', 'adzuna'],
  ] as const) {
    wire(`${P}-provider`, routeKey(route), `${P}-fetch-${fetch}`);
    wire(`${P}-fetch-${fetch}`, 'response', `${P}-norm-${norm}`);
    wire(`${P}-norm-${norm}`, 'out', `${P}-keep-eligible`);
  }

  // Merge, dedupe, pre-filter, then one loop per posting.
  add(
    transform(
      `${P}-merge`,
      'Merge, dedupe and pre-filter',
      560,
      760,
      [
        field('postings', POSTINGS),
        field('fetched', "sum(filter($.results, '!isNull(item)'), 'coalesce(item.fetched, 0)')"),
        field(
          'sourceErrors',
          "map($.exceptions, '{\"source\": coalesce(item.item.provider, \"\"), \"board\": coalesce(item.item.slug, \"\"), \"error\": item.error}')",
        ),
      ],
      {},
      'Deduplicates by key and by company plus title across sources, then ranks Melbourne roles ' +
        'first, newest first, capped at maxApplicationsPerRun. No model involved.',
    ),
    forEach(
      `${P}-each-posting`,
      'Each posting',
      1120,
      760,
      { itemsPath: 'postings', concurrency: 1, continueOnError: true },
      'One posting at a time; a failure is reported and the loop continues.',
    ),
    // The posting loop's Done payload is `{results, exceptions}` only, so the
    // source report travels to the summary through a short-lived state entry.
    stateNode(`${P}-remember-sources`, 'Remember source report', 'state-set', 840, 760, {
      key: 'run-report:sources',
      valueExpression: "{\"fetched\": $.fetched, \"errors\": $.sourceErrors}",
      ttlSec: 86_400,
      semantics: 'value',
    }),
  );
  wire(`${P}-each-source`, 'done', `${P}-merge`);
  wire(`${P}-merge`, 'out', `${P}-remember-sources`);
  wire(`${P}-remember-sources`, 'out', `${P}-each-posting`);

  // Everything from here to the summary is the per-posting loop body, laid out
  // one column right of the loop node.
  const bodyStart = nodes.length;

  // Ledger check.
  add(
    stateNode(`${P}-applied`, 'Applied?', 'state-get', 1120, 760, { key: 'applied:{{posting.key}}', resultKey: 'applied' }),
    stateNode(`${P}-screened`, 'Screened?', 'state-get', 1400, 760, { key: 'screened:{{posting.key}}', resultKey: 'screened' }),
    router(`${P}-ledger-check`, 'In the ledger?', 1680, 760, "isNull($.applied) && isNull($.screened) ? 'new' : 'seen'", ['New', 'Seen']),
    transform(
      `${P}-skip`,
      'Skipped (in ledger)',
      1960,
      620,
      outcomeFields('skipped', '$', [
        field('reason', "isNull($.applied) ? 'Screened out within the last 30 days' : 'Already in the applied ledger'"),
      ]),
    ),
  );
  wire(`${P}-each-posting`, 'each', `${P}-applied`);
  wire(`${P}-applied`, 'out', `${P}-screened`);
  wire(`${P}-screened`, 'out', `${P}-ledger-check`);
  wire(`${P}-ledger-check`, routeKey('Seen'), `${P}-skip`);

  // Fit screen.
  add(
    agent(`${P}-fit`, 'Fit screen', 1960, 860, FIT_PROMPT, 'Scores the posting against the profile. Strict JSON.', {
      resultKey: 'fit',
      temperature: 0.1,
      maxTokens: 800,
    } satisfies Partial<AgentNodeData>),
    transform(
      `${P}-fit-facts`,
      'Fit facts',
      2240,
      860,
      [
        field('fitScore', 'toNumber($.fit.score)'),
        field('applyEmail', "trim(coalesce($.fit.applyEmail, ''))"),
        field(
          'method',
          "$.posting.applyApi == true && !isEmpty(vars.applyApiUrl) ? 'api' : " +
            "(!isEmpty(trim(coalesce($.fit.applyEmail, ''))) && contains(lower(concat($.posting.description, ' ', $.posting.url)), " +
            "lower(trim(coalesce($.fit.applyEmail, '')))) ? 'email' : 'manual')",
        ),
      ],
      { passthrough: true },
      'Decides the apply method from data: an email address counts only when it appears in the posting itself.',
    ),
    router(
      `${P}-fit-gate`,
      'Fit gate',
      2520,
      860,
      "isNull($.fitScore) ? 'unreadable' : ($.fitScore >= vars.minFitScore ? 'fit' : 'screened')",
      ['Fit', 'Screened', 'Unreadable'],
    ),
    stateNode(`${P}-record-screened`, 'Record screened (30 days)', 'state-set', 2800, 1010, {
      key: 'screened:{{posting.key}}',
      valueExpression:
        "{\"company\": $.posting.company, \"title\": $.posting.title, \"url\": $.posting.url, \"score\": $.fitScore, " +
        "\"reasons\": coalesce($.fit.reasons, []), \"screenedAt\": formatDate(now(), 'iso')}",
      ttlSec: LEDGER_TTL_SEC,
      semantics: 'value',
    }),
    transform(`${P}-screened-out`, 'Screened out', 3080, 1010, outcomeFields('screened-out', '$', [field('score', '$.fitScore')])),
    transform(
      `${P}-unreadable`,
      'Fit check unreadable',
      2800,
      1160,
      outcomeFields('failed', '$', [field('reason', "'The fit check did not return a score'")]),
    ),
  );
  wire(`${P}-ledger-check`, routeKey('New'), `${P}-fit`, 'task');
  wire(`${P}-fit`, 'result', `${P}-fit-facts`);
  wire(`${P}-fit-facts`, 'out', `${P}-fit-gate`);
  wire(`${P}-fit-gate`, routeKey('Screened'), `${P}-record-screened`);
  wire(`${P}-record-screened`, 'out', `${P}-screened-out`);
  wire(`${P}-fit-gate`, routeKey('Unreadable'), `${P}-unreadable`);

  // Tailor, guard, one revision, guard again.
  add(
    agent(`${P}-tailor`, 'Tailor resume and letter', 2800, 760, TAILOR_PROMPT, 'Writes within the honesty rules. Strict JSON.', {
      resultKey: 'tailored',
      temperature: 0.3,
      maxTokens: 6000,
    }),
    transform(`${P}-facts`, 'Fidelity facts', 3080, 760, FACT_FIELDS, { passthrough: true }),
    assertNode(`${P}-fidelity`, 'Honesty check', 3360, 760, FIDELITY, 'Blocks any change to fixed facts, invented figures or unbounded added skills.'),
    transform(`${P}-revision-brief`, 'Revision brief', 3360, 560, [
      field('posting', `${FROM_BREACH}.posting`),
      field('fit', `${FROM_BREACH}.fit`),
      field('fitScore', `${FROM_BREACH}.fitScore`),
      field('method', `${FROM_BREACH}.method`),
      field('applyEmail', `${FROM_BREACH}.applyEmail`),
      field('tailored', `${FROM_BREACH}.tailored`),
      field('issues', '$.breaches'),
    ]),
    agent(`${P}-revise`, 'Revise once', 3640, 560, REVISE_PROMPT, 'One chance to fix the failed checks. Strict JSON.', {
      resultKey: 'tailored',
      temperature: 0.2,
      maxTokens: 6000,
    }),
    transform(`${P}-facts-2`, 'Fidelity facts (revised)', 3920, 560, FACT_FIELDS, { passthrough: true }),
    assertNode(`${P}-fidelity-2`, 'Honesty re-check', 4200, 560, FIDELITY, 'A second failure blocks the posting: nothing is sent.'),
    transform(
      `${P}-blocked`,
      'Blocked (honesty)',
      4480,
      420,
      outcomeFields('blocked', FROM_BREACH, [
        field('reason', "concat('Failed checks: ', join($.breaches, ', '))"),
      ]),
    ),
  );
  wire(`${P}-fit-gate`, routeKey('Fit'), `${P}-tailor`, 'task');
  wire(`${P}-tailor`, 'result', `${P}-facts`);
  wire(`${P}-facts`, 'out', `${P}-fidelity`);
  wire(`${P}-fidelity`, 'fail', `${P}-revision-brief`);
  wire(`${P}-revision-brief`, 'out', `${P}-revise`, 'task');
  wire(`${P}-revise`, 'result', `${P}-facts-2`);
  wire(`${P}-facts-2`, 'out', `${P}-fidelity-2`);
  wire(`${P}-fidelity-2`, 'fail', `${P}-blocked`);

  // Render and send.
  add(
    node({
      id: `${P}-render`,
      name: 'Render resume PDF',
      kind: 'render-document',
      category: 'flow',
      icon: 'ti ti-file-type-pdf',
      x: 4480,
      y: 760,
      ports: [
        { key: 'in', name: 'In', role: 'message-in' },
        { key: 'rendered', name: 'Rendered', role: 'message-out' },
        { key: 'err', name: 'On error', role: 'message-out' },
      ],
      data: {
        markdown: '{{tailored.resumeMarkdown}}',
        fileName: '{{documentName}}',
        title: '{{documentName}}',
        format: 'pdf',
        resultKey: 'resumePdf',
      } satisfies RenderDocumentNodeData,
    }),
    router(`${P}-send-route`, 'Apply by', 4760, 760, "vars.dryRun ? 'dry run' : $.method", ['Email', 'API', 'Manual', 'Dry run']),
    node({
      id: `${P}-send-email`,
      name: 'Email application',
      kind: 'notify',
      category: 'flow',
      icon: 'ti ti-mail-forward',
      x: 5040,
      y: 600,
      ports: [
        { key: 'in', name: 'In', role: 'message-in' },
        { key: 'sent', name: 'Sent', role: 'message-out' },
        { key: 'err', name: 'On error', role: 'message-out' },
      ],
      data: {
        channel: 'email',
        to: '{{applyEmail}}',
        from: '{{vars.senderEmail}}',
        replyTo: '{{vars.applicantEmail}}',
        subject: '{{tailored.emailSubject}}',
        body: '{{tailored.coverLetter}}',
        bodyFormat: 'text',
        attachments: ['resumePdf'],
        attachmentLimit: 'fail',
        idempotencyKey: 'apply:{{posting.key}}',
        retry: RETRY,
      } satisfies NotifyNodeData,
      description: 'Select your Resend connection here. Never sends twice for one posting.',
    }),
    node({
      id: `${P}-send-api`,
      name: 'Submit by API',
      kind: 'http-request',
      category: 'flow',
      icon: 'ti ti-api',
      x: 5040,
      y: 760,
      ports: [
        { key: 'in', name: 'In', role: 'message-in' },
        { key: 'response', name: 'Response', role: 'message-out' },
        { key: 'err', name: 'On error', role: 'message-out' },
      ],
      data: {
        method: 'POST',
        url: '{{vars.applyApiUrl}}',
        bodyMode: 'multipart',
        multipart: {
          fields: [
            { name: 'postingId', value: '{{posting.key}}' },
            { name: 'postingUrl', value: '{{posting.url}}' },
            { name: 'email', value: '{{vars.applicantEmail}}' },
            { name: 'coverLetter', value: '{{tailored.coverLetter}}' },
          ],
          files: [{ name: 'resume', artifact: 'resumePdf' }],
        },
        idempotencyKey: 'apply:{{posting.key}}',
        responseMode: 'text',
        resultKey: 'submission',
        pagination: { mode: 'none' },
        retry: RETRY,
        timeoutSec: 60,
        fixtures: 'off',
      } satisfies HttpRequestNodeData,
      description: 'Only for boards marked |api in companyBoards. No default source offers a candidate API.',
    }),
    stateNode(`${P}-record-applied`, 'Record applied (30 days)', 'state-set', 5320, 680, {
      key: 'applied:{{posting.key}}',
      valueExpression: RECORD_VALUE('$.method'),
      ttlSec: LEDGER_TTL_SEC,
      semantics: 'value',
    }),
    transform(
      `${P}-applied-out`,
      'Applied',
      5600,
      680,
      outcomeFields('applied', '$', [
        field('method', '$.method'),
        field('score', '$.fitScore'),
        field('addedSkills', 'coalesce($.tailored.addedSkills, [])'),
        field('document', '$.resumePdf'),
      ]),
    ),
    stateNode(`${P}-record-manual`, 'Record manual (30 days)', 'state-set', 5040, 920, {
      key: 'applied:{{posting.key}}',
      valueExpression: RECORD_VALUE("'manual-pending'"),
      ttlSec: LEDGER_TTL_SEC,
      semantics: 'value',
    }),
    transform(
      `${P}-manual-out`,
      'Apply manually',
      5320,
      920,
      outcomeFields('manual', '$', [
        field('method', "'manual-pending'"),
        field('score', '$.fitScore'),
        field('addedSkills', 'coalesce($.tailored.addedSkills, [])'),
        field('coverLetter', '$.tailored.coverLetter'),
        field('document', '$.resumePdf'),
      ]),
    ),
    transform(
      `${P}-dry-out`,
      'Dry run (nothing sent)',
      5040,
      1080,
      outcomeFields('dry-run', '$', [
        field('plannedMethod', '$.method'),
        field('applyEmail', '$.applyEmail'),
        field('score', '$.fitScore'),
        field('addedSkills', 'coalesce($.tailored.addedSkills, [])'),
        field('emailSubject', '$.tailored.emailSubject'),
        field('coverLetter', '$.tailored.coverLetter'),
        field('document', '$.resumePdf'),
      ]),
    ),
  );
  wire(`${P}-fidelity`, 'pass', `${P}-render`);
  wire(`${P}-fidelity-2`, 'pass', `${P}-render`);
  wire(`${P}-render`, 'rendered', `${P}-send-route`);
  wire(`${P}-send-route`, routeKey('Email'), `${P}-send-email`);
  wire(`${P}-send-route`, routeKey('API'), `${P}-send-api`);
  wire(`${P}-send-route`, routeKey('Manual'), `${P}-record-manual`);
  wire(`${P}-send-route`, routeKey('Dry run'), `${P}-dry-out`);
  wire(`${P}-send-email`, 'sent', `${P}-record-applied`);
  wire(`${P}-send-api`, 'response', `${P}-record-applied`);
  wire(`${P}-record-applied`, 'out', `${P}-applied-out`);
  wire(`${P}-record-manual`, 'out', `${P}-manual-out`);
  for (const bodyNode of nodes.slice(bodyStart)) bodyNode.position.x += 280;

  // Summary.
  add(
    stateNode(`${P}-ledger`, 'Read the ledger', 'state-list', 1120, 1340, {
      prefix: 'applied:',
      limit: 1000,
      resultKey: 'ledger',
    }),
    stateNode(`${P}-recall-sources`, 'Recall source report', 'state-get', 1400, 1340, {
      key: 'run-report:sources',
      resultKey: 'sources',
    }),
    transform(
      `${P}-summary-facts`,
      'Summary counts',
      1680,
      1340,
      [
        field(
          'stats',
          "{\"considered\": len($.results), " +
            "\"applied\": countIf($.results, 'item.outcome == \"applied\"'), " +
            "\"manual\": countIf($.results, 'item.outcome == \"manual\"'), " +
            "\"dryRun\": countIf($.results, 'item.outcome == \"dry-run\"'), " +
            "\"screenedOut\": countIf($.results, 'item.outcome == \"screened-out\"'), " +
            "\"skipped\": countIf($.results, 'item.outcome == \"skipped\"'), " +
            "\"blocked\": countIf($.results, 'item.outcome == \"blocked\"'), " +
            "\"failed\": countIf($.results, 'item.outcome == \"failed\"') + len($.exceptions)}",
        ),
        field('documents', "filter(map($.results, 'item.document'), '!isNull(item)')"),
      ],
      { passthrough: true },
    ),
    agent(`${P}-summary`, 'Write the weekly summary', 1960, 1340, SUMMARY_PROMPT, 'Markdown report. Strict JSON.', {
      resultKey: 'summary',
      temperature: 0.2,
      maxTokens: 4000,
    }),
    node({
      id: `${P}-send-summary`,
      name: 'Email the summary',
      kind: 'notify',
      category: 'flow',
      icon: 'ti ti-mail',
      x: 2240,
      y: 1340,
      ports: [
        { key: 'in', name: 'In', role: 'message-in' },
        { key: 'sent', name: 'Sent', role: 'message-out' },
        { key: 'err', name: 'On error', role: 'message-out' },
      ],
      data: {
        channel: 'email',
        to: '{{vars.notifyEmail}}',
        from: '{{vars.senderEmail}}',
        subject: '{{summary.subject}}',
        body: '{{summary.markdown}}',
        bodyFormat: 'markdown',
        attachments: ['documents'],
        attachmentLimit: 'truncate',
        retry: RETRY,
        errorPortId: `${P}-send-summary-err`,
      } satisfies NotifyNodeData,
      description: 'Select your Resend connection here. In a dry run this is the only email sent.',
    }),
    transform(`${P}-summary-unsent`, 'Summary (not emailed)', 2520, 1460, [
      field('summary', `${FROM_BREACH}.summary`),
      field('deliveryError', '$.error'),
    ]),
  );
  wire(`${P}-each-posting`, 'done', `${P}-ledger`);
  wire(`${P}-ledger`, 'out', `${P}-recall-sources`);
  wire(`${P}-recall-sources`, 'out', `${P}-summary-facts`);
  wire(`${P}-summary-facts`, 'out', `${P}-summary`, 'task');
  wire(`${P}-summary`, 'result', `${P}-send-summary`);
  wire(`${P}-send-summary`, 'err', `${P}-summary-unsent`);

  return {
    version: 1,
    id: WEEKLY_APPLICATIONS_TEMPLATE_ID,
    name: 'Weekly Job Applications (Melbourne and remote)',
    description:
      'Applies to suitable Melbourne and Australia-open remote roles every Monday and emails you a ' +
      'summary. Starts in dry run. To run it now: set your model, replace the sample profile, Run. ' +
      'To send: create a Resend connection (HTTP, bearer token, config emailProvider = resend) with a ' +
      'sender on a verified domain, select it on "Email application" and "Email the summary", set ' +
      'dryRun to false. Optional: Adzuna (adzunaAppId plus an Adzuna connection on its step). The ' +
      'weekly schedule fires only on a deployed worker.',
    graph: { nodes, connections: edges },
    settings: { variables: VARIABLES, timeoutMinutes: 120 },
    savedAt: new Date().toISOString(),
  };
}
