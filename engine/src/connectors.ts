/**
 * Connector bundles (P1-14) - the shareable integration package.
 *
 * A connector is ONE JSON file that turns "here is how you talk to system X"
 * into something a user installs in seconds. It declares a connection template,
 * a set of pre-configured data steps, optional mapping tables and optional
 * starter workflows. Every part materialises into an entity that already exists
 * (`Connection`, a plain data node, `TransformNodeData.lookups`, `WorkflowSpec`),
 * so packaging adds no runtime surface: the engine, the worker and the desktop
 * shell need no changes to run a workflow built from a connector.
 *
 * This module is pure declaration plus parse, validate and derive. It performs
 * no I/O, mints no ids and reads no clock - callers pass both in. Installation
 * (writing the connection, storing the bundle) is a STUDIO concern; see
 * `frontend/src/app/core/connectors.service.ts`.
 *
 * The load-bearing invariant, enforced by {@link validateConnectorBundle} and
 * pinned by a property test: **a valid bundle carries no secret value in any
 * position.** A bundle names the secrets it needs and nothing more. Rejection is
 * outright rather than sanitising, because silently stripping a leaked key
 * teaches authors that shipping one is fine.
 *
 * Plan: `docs/connector-packaging-plan.md`.
 */

import {
  authSecretKeyNames,
  type Connection,
  type ConnectionAuth,
  type ConnectionType,
  type SqlLimits,
} from './connections.js';
import type { EmbeddedWorkflow, WorkflowNodeKind } from './types.js';

/** Bundle format this build reads and writes. Unknown versions are refused. */
export const CONNECTOR_FORMAT_VERSION = 1;

/** Every `ConnectorBundle.id`, mirroring `CONNECTION_ID_PATTERN`. */
export const CONNECTOR_ID_PATTERN = /^cx-[A-Za-z0-9_-]{1,64}$/;

/** Step ids are bundle-scoped, so they only need to be slug-shaped. */
export const CONNECTOR_STEP_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** Mapping table names, addressable from expressions as `lookup('name', key)`. */
export const CONNECTOR_TABLE_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

/** `<kebab-name>.connector.json`. */
export const CONNECTOR_FILE_EXTENSION = 'connector.json';

/** Read-only id prefix for the connectors compiled into the app. */
export const BUILTIN_CONNECTOR_PREFIX = 'builtin:';

/** Bundle-wide size guards, so one file cannot wedge the install dialog. */
export const CONNECTOR_MAX_STEPS = 64;
export const CONNECTOR_MAX_TABLES = 32;
export const CONNECTOR_MAX_TABLE_ENTRIES = 5000;
export const CONNECTOR_MAX_WORKFLOWS = 8;
export const CONNECTOR_MAX_SOURCE_BYTES = 2 * 1024 * 1024;

/**
 * Node kinds a bundle may package. Deliberately a SUBSET of `DATA_NODE_KINDS`:
 * `assert` and the two `state-*` kinds are workflow policy rather than
 * integration knowledge, and `notify` belongs to the operator's own alerting
 * setup, not to the vendor whose API is being packaged.
 */
export const CONNECTOR_PACKAGEABLE_KINDS = [
  'http-request',
  'sql-query',
  'transform',
  'aggregate',
] as const satisfies readonly WorkflowNodeKind[];

/** One of {@link CONNECTOR_PACKAGEABLE_KINDS}. */
export type ConnectorStepKind = (typeof CONNECTOR_PACKAGEABLE_KINDS)[number];

/** Connection types an `http-request` step can draw its auth from. */
const HTTP_CONNECTION_TYPES: readonly ConnectionType[] = ['http', 'oauth2', 'aws-sigv4'];

// ─────────────────────────────────────────────────────────────────────────────
// The bundle
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One non-secret connection field the installer must fill in, such as a base
 * url, a tenant id or a database name. Materialises into `Connection.config`.
 */
export interface ConnectorConfigField {
  /** Key written into `Connection.config`. */
  name: string;
  /** Operator-facing label. */
  label: string;
  description?: string;
  placeholder?: string;
  /** Absent means optional. An install with a required field empty is blocked. */
  required?: boolean;
  /**
   * Pre-filled value, for genuinely public defaults such as an API base url.
   * A default under a secret-shaped field name is a validation error - this is
   * the field most likely to be abused as a smuggling channel for a key.
   */
  default?: string;
}

/**
 * One secret the connector needs, declared by NAME only. Shaped after
 * `McpEnvField`, the app's existing declared-credential schema, minus its
 * `secret` discriminator: every field here is a secret by definition.
 */
export interface ConnectorSecretField {
  /** Becomes an entry of `Connection.secretKeys`. Never carries a value. */
  name: string;
  label: string;
  description?: string;
  /** Where the installer goes to obtain this credential. */
  docsUrl?: string;
}

/**
 * The connection the bundle installs. Everything except the secret VALUES: the
 * shape, the auth mode and the field vocabulary, which is the part that takes a
 * vendor-docs reading session to get right.
 */
export interface ConnectorConnectionTemplate {
  type: ConnectionType;
  /** Non-secret config the installer fills in. May be empty. */
  configFields: ConnectorConfigField[];
  /** Secret NAMES the connection declares. May be empty (unauthenticated API). */
  secretFields: ConnectorSecretField[];
  /** Auth descriptor. Every secret key it points at must be declared above. */
  auth: ConnectionAuth;
  /**
   * True when the packaged steps write to the target system. Surfaced at install
   * time as a warning; it NEVER sets `Connection.allowWrites`. Writes stay
   * opt-in on the connection, chosen by the person whose credential it is.
   */
  needsWrites?: boolean;
  /** SQL guard rails suggested by the connector author. */
  limits?: SqlLimits;
}

/**
 * One pre-configured step. Instantiating it produces an ordinary data node: the
 * connector is not its owner, nothing references the bundle afterwards, and
 * uninstalling the connector cannot break a workflow built from it.
 */
export interface ConnectorStep {
  /** Bundle-scoped id. Part of the palette drag payload. */
  id: string;
  label: string;
  description?: string;
  /** Tabler icon class (`ti ti-*`). Falls back to the node kind's own icon. */
  icon?: string;
  /** Extra palette search terms. */
  keywords?: string[];
  kind: ConnectorStepKind;
  /**
   * Node data for `kind`, structurally matching the corresponding
   * `*NodeData` interface with `connectionId` ABSENT - it is bound at
   * instantiation by {@link connectorStepNodeData}. Typed as `object` because
   * interfaces without an index signature are not assignable to
   * `Record<string, unknown>` across a package boundary.
   */
  data: object;
  /**
   * Mapping tables from {@link ConnectorBundle.tables} to inject as this step's
   * `lookups`. `transform` steps only; every name must exist in the bundle.
   */
  tables?: string[];
}

/**
 * A named mapping table: the account-code crosswalk, the status vocabulary, the
 * currency rounding rules. Shared by every step of the bundle rather than
 * duplicated inline per node.
 */
export interface ConnectorTable {
  /** Addressable from expressions as `lookup('name', key)`. */
  name: string;
  description?: string;
  entries: Record<string, string | number | boolean>;
}

/**
 * A starter workflow shipped with the bundle. Same shape as an embedded
 * sub-workflow, so it materialises straight through `WorkflowService.importSpec`.
 */
export type ConnectorWorkflow = EmbeddedWorkflow;

/** The file. One connector, one JSON document. */
export interface ConnectorBundle {
  /** {@link CONNECTOR_FORMAT_VERSION}. */
  format: number;
  /** `cx-` prefixed, stable across versions of the same connector. */
  id: string;
  name: string;
  description?: string;
  /** Author-chosen version string, shown verbatim. Not parsed for ordering. */
  version: string;
  author?: string;
  /** Tabler icon class (`ti ti-*`). */
  icon?: string;
  /**
   * Refuse to install below this app version. Compared on the numeric core
   * only - see {@link satisfiesMinAppVersion}.
   */
  minAppVersion?: string;
  connection: ConnectorConnectionTemplate;
  steps: ConnectorStep[];
  tables?: ConnectorTable[];
  workflows?: ConnectorWorkflow[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Findings, parse
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One problem found in a bundle. `error` blocks installation; `warning` never
 * does, it just has to be shown in the install preview.
 */
export interface ConnectorFinding {
  severity: 'error' | 'warning';
  /** Dotted path into the bundle, e.g. `steps[1].data.headers[0].value`. */
  path: string;
  message: string;
}

/** Outcome of {@link parseConnectorBundle}. Warnings ride along on success. */
export type ConnectorParseResult =
  | { ok: true; bundle: ConnectorBundle; findings: ConnectorFinding[] }
  | { ok: false; findings: ConnectorFinding[] };

/**
 * Parses and validates connector source text.
 *
 * Total: any input, including non-strings and malformed JSON, yields findings
 * rather than an exception. `ok: true` guarantees every finding is a warning.
 */
export function parseConnectorBundle(text: unknown): ConnectorParseResult {
  if (typeof text !== 'string' || text.trim().length === 0) {
    return { ok: false, findings: [error('', 'The connector file is empty.')] };
  }
  if (text.length > CONNECTOR_MAX_SOURCE_BYTES) {
    return {
      ok: false,
      findings: [
        error(
          '',
          `The connector file is ${Math.round(text.length / 1024)}kB, over the ` +
            `${CONNECTOR_MAX_SOURCE_BYTES / 1024}kB limit.`,
        ),
      ],
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    return { ok: false, findings: [error('', `The connector file is not valid JSON: ${detail}`)] };
  }

  const findings = validateConnectorBundle(parsed);
  if (findings.some((finding) => finding.severity === 'error')) return { ok: false, findings };
  return { ok: true, bundle: parsed as ConnectorBundle, findings };
}

/** Serializes a bundle for export. Stable key order, trailing newline. */
export function serializeConnectorBundle(bundle: ConnectorBundle): string {
  return `${JSON.stringify(bundle, null, 2)}\n`;
}

/** Suggested file name for an exported bundle (kebab-cased). */
export function connectorFileName(bundle: Pick<ConnectorBundle, 'name'>): string {
  const kebab = String(bundle.name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${kebab || 'connector'}.${CONNECTOR_FILE_EXTENSION}`;
}

/**
 * True when `appVersion` is at or above `bundle.minAppVersion`.
 *
 * Compares the numeric core (`major.minor.patch`) ONLY and ignores any
 * prerelease suffix, so `0.2.0-beta.8` satisfies a `minAppVersion` of `0.2.0`.
 * Strict SemVer says otherwise, but every build of this app during a beta chain
 * carries a prerelease suffix, and refusing every connector for the length of a
 * beta would be a bug dressed as correctness. Missing or unparseable versions
 * are permissive: a bundle should not become uninstallable because of a typo in
 * an advisory field.
 */
export function satisfiesMinAppVersion(
  bundle: Pick<ConnectorBundle, 'minAppVersion'>,
  appVersion: string,
): boolean {
  const required = versionCore(bundle.minAppVersion);
  const actual = versionCore(appVersion);
  if (!required || !actual) return true;
  for (let index = 0; index < 3; index += 1) {
    const a = actual[index] ?? 0;
    const r = required[index] ?? 0;
    if (a !== r) return a > r;
  }
  return true;
}

/** `[major, minor, patch]`, or `undefined` when the value is not a version. */
function versionCore(value: unknown): [number, number, number] | undefined {
  if (typeof value !== 'string') return undefined;
  const match = /^\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(value);
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)];
}

// ─────────────────────────────────────────────────────────────────────────────
// Validation
// ─────────────────────────────────────────────────────────────────────────────

/** Every `ConnectionType`, listed so an unknown value is a finding, not a cast. */
const ALL_CONNECTION_TYPES: readonly ConnectionType[] = [
  'http',
  'oauth2',
  'sql',
  'aws-sigv4',
  'smtp',
];

/** Every `ConnectionAuth['mode']`, for the same reason. */
const ALL_AUTH_MODES: readonly ConnectionAuth['mode'][] = [
  'none',
  'bearer',
  'basic',
  'basic-token',
  'header',
  'query',
  'oauth2-client-credentials',
  'oauth2-refresh',
  'aws-sigv4',
];

const HTTP_METHODS: readonly string[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'];

/** Config and secret field names: identifier-ish, no path or template syntax. */
const FIELD_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;

/**
 * Validates a parsed bundle. Total: never throws for any input, because this
 * runs against a file a stranger authored.
 *
 * Returns `[]` when the bundle is installable with nothing to warn about.
 * Ordering is fixed: bundle identity, then the connection template, then steps
 * in declaration order, then tables, then workflows, then the secret scan over
 * the whole document.
 */
export function validateConnectorBundle(value: unknown): ConnectorFinding[] {
  const findings: ConnectorFinding[] = [];
  const bundle = readRecord(value);

  if (!bundle) {
    findings.push(error('', 'A connector must be a JSON object.'));
    return findings;
  }

  const connection = readRecord(bundle['connection']);
  validateIdentity(bundle, findings);
  validateConnection(connection, findings);
  const tableNames = validateTables(bundle['tables'], findings);
  validateSteps(bundle['steps'], connection, tableNames, findings);
  validateWorkflows(bundle['workflows'], findings);

  for (const leak of secretPositionsOf(value)) {
    findings.push(
      error(
        leak.path,
        `${leak.reason} A connector declares the secrets it needs by name and ` +
          `never carries their values.`,
      ),
    );
  }

  return findings;
}

/** True when the bundle is installable as-is. Warnings do not block. */
export function isConnectorBundle(value: unknown): value is ConnectorBundle {
  return !validateConnectorBundle(value).some((finding) => finding.severity === 'error');
}

/** Only the blocking findings, for a caller that shows errors and warnings apart. */
export function connectorErrors(findings: readonly ConnectorFinding[]): ConnectorFinding[] {
  return findings.filter((finding) => finding.severity === 'error');
}

function validateIdentity(bundle: Readonly<Record<string, unknown>>, out: ConnectorFinding[]): void {
  const format = bundle['format'];
  if (typeof format !== 'number' || !Number.isInteger(format)) {
    out.push(error('format', 'A connector must declare an integer `format` version.'));
  } else if (format > CONNECTOR_FORMAT_VERSION) {
    out.push(
      error(
        'format',
        `This connector uses format ${format}, which this version of the studio ` +
          `does not read (it reads format ${CONNECTOR_FORMAT_VERSION}). Update the studio.`,
      ),
    );
  } else if (format < CONNECTOR_FORMAT_VERSION) {
    out.push(
      error(
        'format',
        `Connector format ${format} is no longer supported (this studio reads ` +
          `format ${CONNECTOR_FORMAT_VERSION}).`,
      ),
    );
  }

  if (typeof bundle['id'] !== 'string' || !CONNECTOR_ID_PATTERN.test(bundle['id'])) {
    out.push(
      error('id', `A connector id must match ${CONNECTOR_ID_PATTERN.source} (for example cx-xero).`),
    );
  }
  requireText(bundle['name'], 'name', 100, 'A connector needs a name', out);
  requireText(bundle['version'], 'version', 32, 'A connector needs a version', out);
  optionalText(bundle['description'], 'description', 500, out);
  optionalText(bundle['author'], 'author', 100, out);
  optionalText(bundle['icon'], 'icon', 64, out);

  if (bundle['minAppVersion'] !== undefined && !versionCore(bundle['minAppVersion'])) {
    out.push(
      warning(
        'minAppVersion',
        '`minAppVersion` is not a version number, so it is ignored.',
      ),
    );
  }
}

/**
 * Validates the connection template and returns the secret NAMES it declares,
 * which the auth cross-check below and the studio installer both need.
 */
function validateConnection(
  template: Readonly<Record<string, unknown>> | undefined,
  out: ConnectorFinding[],
): string[] {
  if (!template) {
    out.push(error('connection', 'A connector must declare a `connection` template.'));
    return [];
  }

  if (!ALL_CONNECTION_TYPES.includes(template['type'] as ConnectionType)) {
    out.push(
      error(
        'connection.type',
        `Connection type must be one of ${ALL_CONNECTION_TYPES.join(', ')}.`,
      ),
    );
  }

  const configNames = new Set<string>();
  for (const [index, raw] of readArray(template['configFields']).entries()) {
    const path = `connection.configFields[${index}]`;
    const field = readRecord(raw);
    if (!field) {
      out.push(error(path, 'A config field must be an object.'));
      continue;
    }
    const name = field['name'];
    if (typeof name !== 'string' || !FIELD_NAME_PATTERN.test(name)) {
      out.push(error(`${path}.name`, `A config field name must match ${FIELD_NAME_PATTERN.source}.`));
    } else if (configNames.has(name)) {
      out.push(error(`${path}.name`, `Duplicate config field "${name}".`));
    } else {
      configNames.add(name);
    }
    requireText(field['label'], `${path}.label`, 100, 'A config field needs a label', out);
    if (field['default'] !== undefined && typeof field['default'] !== 'string') {
      out.push(error(`${path}.default`, 'A config field default must be a string.'));
    }
    // The one field an author could abuse to smuggle a credential into
    // non-secret config. The generic scan below catches key-shaped VALUES; this
    // catches a secret-shaped FIELD NAME being given any default at all.
    if (looksLikeSecretName(name) && field['default'] !== undefined) {
      out.push(
        error(
          `${path}.default`,
          `"${name}" looks like a credential, so it belongs in \`secretFields\` ` +
            `with no value rather than in \`configFields\` with a default.`,
        ),
      );
    }
  }

  const secretNames: string[] = [];
  for (const [index, raw] of readArray(template['secretFields']).entries()) {
    const path = `connection.secretFields[${index}]`;
    const field = readRecord(raw);
    if (!field) {
      out.push(error(path, 'A secret field must be an object.'));
      continue;
    }
    const name = field['name'];
    if (typeof name !== 'string' || !FIELD_NAME_PATTERN.test(name)) {
      out.push(error(`${path}.name`, `A secret field name must match ${FIELD_NAME_PATTERN.source}.`));
    } else if (secretNames.includes(name)) {
      out.push(error(`${path}.name`, `Duplicate secret field "${name}".`));
    } else {
      secretNames.push(name);
    }
    if (typeof name === 'string' && configNames.has(name)) {
      out.push(
        error(
          `${path}.name`,
          `"${name}" is declared as both a config field and a secret field.`,
        ),
      );
    }
    requireText(field['label'], `${path}.label`, 100, 'A secret field needs a label', out);
    optionalText(field['docsUrl'], `${path}.docsUrl`, 500, out);
  }

  validateAuth(template['auth'], secretNames, out);

  if (template['needsWrites'] !== undefined && typeof template['needsWrites'] !== 'boolean') {
    out.push(error('connection.needsWrites', '`needsWrites` must be true or false.'));
  }

  return secretNames;
}

/**
 * The auth descriptor must name a known mode, and every secret key it points at
 * must be declared. `connections.ts` spells out why: a pointer to an undeclared
 * name resolves to nothing at run time and the operator has no way to see why.
 */
function validateAuth(value: unknown, secretNames: readonly string[], out: ConnectorFinding[]): void {
  const auth = readRecord(value);
  if (!auth) {
    out.push(error('connection.auth', 'A connector must declare an `auth` mode (use {"mode":"none"}).'));
    return;
  }
  if (!ALL_AUTH_MODES.includes(auth['mode'] as ConnectionAuth['mode'])) {
    out.push(error('connection.auth.mode', `Auth mode must be one of ${ALL_AUTH_MODES.join(', ')}.`));
    return;
  }

  for (const name of authSecretKeyNames(auth as ConnectionAuth)) {
    if (secretNames.includes(name)) continue;
    out.push(
      error(
        'connection.auth',
        `Auth mode "${String(auth['mode'])}" points at secret "${name}", which the ` +
          `connector does not declare in \`secretFields\`.`,
      ),
    );
  }
}

/** Validates mapping tables and returns the declared names, for step checks. */
function validateTables(value: unknown, out: ConnectorFinding[]): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    out.push(error('tables', '`tables` must be an array.'));
    return [];
  }
  if (value.length > CONNECTOR_MAX_TABLES) {
    out.push(error('tables', `A connector may declare at most ${CONNECTOR_MAX_TABLES} tables.`));
  }

  const names: string[] = [];
  for (const [index, raw] of value.slice(0, CONNECTOR_MAX_TABLES).entries()) {
    const path = `tables[${index}]`;
    const table = readRecord(raw);
    if (!table) {
      out.push(error(path, 'A mapping table must be an object.'));
      continue;
    }
    const name = table['name'];
    if (typeof name !== 'string' || !CONNECTOR_TABLE_NAME_PATTERN.test(name)) {
      out.push(
        error(`${path}.name`, `A table name must match ${CONNECTOR_TABLE_NAME_PATTERN.source}.`),
      );
    } else if (names.includes(name)) {
      out.push(error(`${path}.name`, `Duplicate mapping table "${name}".`));
    } else {
      names.push(name);
    }

    const entries = readRecord(table['entries']);
    if (!entries) {
      out.push(error(`${path}.entries`, 'A mapping table needs an `entries` object.'));
      continue;
    }
    const keys = Object.keys(entries);
    if (keys.length > CONNECTOR_MAX_TABLE_ENTRIES) {
      out.push(
        error(
          `${path}.entries`,
          `Table "${String(name)}" has ${keys.length} entries, over the ` +
            `${CONNECTOR_MAX_TABLE_ENTRIES} limit.`,
        ),
      );
    }
    for (const key of keys) {
      const entry = entries[key];
      const kind = typeof entry;
      if (kind === 'string' || kind === 'number' || kind === 'boolean') continue;
      out.push(
        error(
          `${path}.entries.${key}`,
          'Mapping table values must be a string, number or boolean.',
        ),
      );
    }
  }
  return names;
}

function validateSteps(
  value: unknown,
  template: Readonly<Record<string, unknown>> | undefined,
  tableNames: readonly string[],
  out: ConnectorFinding[],
): void {
  if (!Array.isArray(value)) {
    out.push(error('steps', 'A connector must declare a `steps` array.'));
    return;
  }
  if (value.length === 0) {
    out.push(
      error('steps', 'A connector with no steps installs nothing beyond a connection.'),
    );
    return;
  }
  if (value.length > CONNECTOR_MAX_STEPS) {
    out.push(error('steps', `A connector may declare at most ${CONNECTOR_MAX_STEPS} steps.`));
  }

  const connectionType = template?.['type'];
  const ids = new Set<string>();

  for (const [index, raw] of value.slice(0, CONNECTOR_MAX_STEPS).entries()) {
    const path = `steps[${index}]`;
    const step = readRecord(raw);
    if (!step) {
      out.push(error(path, 'A step must be an object.'));
      continue;
    }

    const id = step['id'];
    if (typeof id !== 'string' || !CONNECTOR_STEP_ID_PATTERN.test(id)) {
      out.push(error(`${path}.id`, `A step id must match ${CONNECTOR_STEP_ID_PATTERN.source}.`));
    } else if (ids.has(id)) {
      out.push(error(`${path}.id`, `Duplicate step id "${id}".`));
    } else {
      ids.add(id);
    }
    requireText(step['label'], `${path}.label`, 100, 'A step needs a label', out);
    optionalText(step['description'], `${path}.description`, 300, out);
    optionalText(step['icon'], `${path}.icon`, 64, out);

    const kind = step['kind'];
    if (!(CONNECTOR_PACKAGEABLE_KINDS as readonly string[]).includes(kind as string)) {
      out.push(
        error(
          `${path}.kind`,
          `A connector step must be one of ${CONNECTOR_PACKAGEABLE_KINDS.join(', ')}` +
            `${typeof kind === 'string' ? ` (got "${kind}")` : ''}.`,
        ),
      );
      continue;
    }

    const data = readRecord(step['data']);
    if (!data) {
      out.push(error(`${path}.data`, 'A step needs a `data` object.'));
      continue;
    }
    if (data['connectionId'] !== undefined) {
      out.push(
        error(
          `${path}.data.connectionId`,
          'A step must not name a connection id. The installer binds its own ' +
            'connection, which is what makes the bundle portable.',
        ),
      );
    }

    validateStepTables(step['tables'], kind as ConnectorStepKind, tableNames, path, out);

    switch (kind) {
      case 'http-request':
        if (!HTTP_CONNECTION_TYPES.includes(connectionType as ConnectionType)) {
          out.push(
            error(
              `${path}.kind`,
              `An http-request step needs a connection of type ` +
                `${HTTP_CONNECTION_TYPES.join(', ')}, but this connector declares ` +
                `"${String(connectionType)}".`,
            ),
          );
        }
        validateHttpStep(data, path, out);
        break;
      case 'sql-query':
        if (connectionType !== 'sql') {
          out.push(
            error(
              `${path}.kind`,
              'A sql-query step needs a connection of type sql, but this connector ' +
                `declares "${String(connectionType)}".`,
            ),
          );
        }
        if (typeof data['statement'] !== 'string' || data['statement'].trim().length === 0) {
          out.push(error(`${path}.data.statement`, 'A sql-query step needs a statement.'));
        }
        break;
      default:
        break;
    }
  }
}

/** `tables` names bundle tables and only makes sense on a `transform` step. */
function validateStepTables(
  value: unknown,
  kind: ConnectorStepKind,
  tableNames: readonly string[],
  path: string,
  out: ConnectorFinding[],
): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    out.push(error(`${path}.tables`, '`tables` must be an array of mapping table names.'));
    return;
  }
  if (kind !== 'transform') {
    out.push(
      error(
        `${path}.tables`,
        `Mapping tables become a transform step's lookups, so they have no effect ` +
          `on a ${kind} step.`,
      ),
    );
    return;
  }
  for (const [index, name] of value.entries()) {
    if (typeof name === 'string' && tableNames.includes(name)) continue;
    out.push(
      error(
        `${path}.tables[${index}]`,
        `Step references mapping table "${String(name)}", which the connector does not declare.`,
      ),
    );
  }
}

/**
 * Http step rules. The important one is the auth-header check: `headers` and
 * `query` are documented as non-secret, with auth coming from the connection, so
 * a literal credential in an auth-bearing header is both a leak and a design
 * error. A pure `{{template}}` is allowed - that reads run-time payload data,
 * not a packaged secret.
 */
function validateHttpStep(
  data: Readonly<Record<string, unknown>>,
  path: string,
  out: ConnectorFinding[],
): void {
  const method = data['method'];
  if (method !== undefined && !HTTP_METHODS.includes(String(method))) {
    out.push(error(`${path}.data.method`, `Method must be one of ${HTTP_METHODS.join(', ')}.`));
  }
  if (typeof data['url'] !== 'string') {
    out.push(error(`${path}.data.url`, 'An http-request step needs a url (a path or absolute url).'));
  }

  for (const group of ['headers', 'query'] as const) {
    const rows = data[group];
    if (rows === undefined) continue;
    if (!Array.isArray(rows)) {
      out.push(error(`${path}.data.${group}`, `\`${group}\` must be an array of {key, value}.`));
      continue;
    }
    for (const [index, raw] of rows.entries()) {
      const row = readRecord(raw);
      const key = row?.['key'];
      const value = row?.['value'];
      if (typeof key !== 'string' || key.trim().length === 0) {
        out.push(error(`${path}.data.${group}[${index}].key`, `Each ${group} entry needs a key.`));
        continue;
      }
      const authBearing =
        group === 'headers'
          ? AUTH_HEADER_NAMES.has(key.trim().toLowerCase()) || looksLikeSecretName(key)
          : looksLikeSecretName(key);
      if (!authBearing) continue;
      if (typeof value === 'string' && isPureTemplate(value)) continue;
      out.push(
        error(
          `${path}.data.${group}[${index}].value`,
          `"${key}" carries authentication, which comes from the connection. ` +
            `Remove it from ${group} and use the connector's auth mode instead.`,
        ),
      );
    }
  }
}

function validateWorkflows(value: unknown, out: ConnectorFinding[]): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    out.push(error('workflows', '`workflows` must be an array.'));
    return;
  }
  if (value.length > CONNECTOR_MAX_WORKFLOWS) {
    out.push(
      error('workflows', `A connector may ship at most ${CONNECTOR_MAX_WORKFLOWS} workflows.`),
    );
  }
  for (const [index, raw] of value.slice(0, CONNECTOR_MAX_WORKFLOWS).entries()) {
    const path = `workflows[${index}]`;
    const workflow = readRecord(raw);
    if (!workflow) {
      out.push(error(path, 'A shipped workflow must be an object.'));
      continue;
    }
    requireText(workflow['id'], `${path}.id`, 100, 'A shipped workflow needs an id', out);
    requireText(workflow['name'], `${path}.name`, 100, 'A shipped workflow needs a name', out);
    if (!Array.isArray(readRecord(workflow['graph'])?.['nodes'])) {
      out.push(error(`${path}.graph`, 'A shipped workflow needs a graph with a `nodes` array.'));
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Secret scanning - the load-bearing invariant
// ─────────────────────────────────────────────────────────────────────────────

/** One position in a bundle that appears to carry a credential value. */
export interface ConnectorSecretLeak {
  /** Dotted path into the bundle. */
  path: string;
  /** Single sentence naming what was recognised. */
  reason: string;
}

/**
 * Known credential shapes. Provider prefixes are recognised ANYWHERE in the
 * bundle, including prose fields: a real key pasted into a description is still
 * a leaked key, and a connector file is shared by definition.
 */
const CREDENTIAL_PATTERNS: readonly { label: string; pattern: RegExp }[] = [
  { label: 'an OpenAI or Anthropic style key', pattern: /\bsk-[A-Za-z0-9_-]{16,}/ },
  { label: 'a Stripe key', pattern: /\b[prs]k_(?:live|test)_[A-Za-z0-9]{10,}/ },
  { label: 'a GitHub token', pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}/ },
  { label: 'a GitLab token', pattern: /\bglpat-[A-Za-z0-9_-]{16,}/ },
  { label: 'a Slack token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
  { label: 'an AWS access key id', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { label: 'a Google API key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { label: 'a Resend API key', pattern: /\bre_[A-Za-z0-9]{16,}/ },
  { label: 'an npm token', pattern: /\bnpm_[A-Za-z0-9]{30,}/ },
  { label: 'a Shopify access token', pattern: /\bshp[a-z]{2}_[A-Za-z0-9]{20,}/ },
  { label: 'a SendGrid key', pattern: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/ },
  {
    label: 'a JSON Web Token',
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
  },
  { label: 'a PEM private key', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
];

/**
 * The label of the first known credential shape found in `value`, or
 * undefined. Shared with workflow-variable validation so one list decides
 * what "looks like a key" everywhere a spec is checked.
 */
export function credentialShapeOf(value: string): string | undefined {
  return CREDENTIAL_PATTERNS.find(({ pattern }) => pattern.test(value))?.label;
}

/**
 * Words that make a property name a credential name, matched as substrings of
 * the name with separators removed. `auth` is absent on purpose: it is a
 * substring of `author`, which is a legitimate bundle field.
 */
const SECRET_NAME_WORDS: readonly string[] = [
  'secret',
  'token',
  'password',
  'passwd',
  'pwd',
  'passphrase',
  'apikey',
  'credential',
  'privatekey',
  'accesskey',
  'bearer',
  'authorization',
];

/**
 * Positions that hold a secret NAME by contract rather than a value. The generic
 * rule below is skipped here: `auth.clientIdSecretKey` legitimately holds
 * something like `XeroClientSecretKey`, which is long, camel-cased and opaque -
 * exactly the shape the rule looks for. Provider-prefix matching still applies,
 * since no field name looks like `sk-...`.
 */
const NAME_POSITION_PATTERNS: readonly RegExp[] = [
  /^connection\.auth\./,
  /^connection\.secretFields\[\d+\]\.name$/,
  /^connection\.configFields\[\d+\]\.name$/,
];

/** Request headers whose value is authentication by definition. */
const AUTH_HEADER_NAMES: ReadonlySet<string> = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'api-key',
  'apikey',
  'x-auth-token',
  'x-access-token',
  'x-amz-security-token',
  'private-token',
  'x-functions-key',
]);

/** Depth cap on the walk, mirroring the redaction module's structural limit. */
const MAX_SCAN_DEPTH = 32;

/**
 * True when a property name reads as a credential. Separators are stripped
 * before matching, so `clientSecret`, `client_secret`, `CLIENT-SECRET` and
 * `X-API-Key` all reduce to something the word list catches.
 *
 * Substring matching is deliberate. It costs the odd false positive
 * (`tokenizer`), but each one surfaces as a clear message asking the author to
 * move or rename a field, whereas a false negative ships a live credential to
 * everyone who installs the connector.
 */
export function looksLikeSecretName(name: unknown): boolean {
  if (typeof name !== 'string' || name.length === 0) return false;
  const squashed = name.toLowerCase().replace(/[^a-z0-9]+/g, '');
  return SECRET_NAME_WORDS.some((word) => squashed.includes(word));
}

/**
 * Every string in `value` that appears to be a credential, with the path that
 * holds it. Two rules, both deliberately conservative about prose:
 *
 * 1. A known provider key shape, recognised in ANY string position.
 * 2. An opaque, key-shaped value sitting under a credential-shaped property
 *    name. This is the generic catch for a vendor whose key format nobody has
 *    listed yet.
 *
 * Pure and total - it walks arbitrary JSON, never throws, and never mutates.
 */
export function secretPositionsOf(value: unknown): ConnectorSecretLeak[] {
  const leaks: ConnectorSecretLeak[] = [];
  const ancestors = new Set<object>();

  const walk = (node: unknown, path: string, key: string | undefined, depth: number): void => {
    if (depth > MAX_SCAN_DEPTH) return;

    if (typeof node === 'string') {
      const matched = CREDENTIAL_PATTERNS.find((candidate) => candidate.pattern.test(node));
      if (matched) {
        leaks.push({ path, reason: `This value looks like ${matched.label}.` });
        return;
      }
      if (looksLikeSecretName(key) && !isNamePosition(path) && isOpaqueSecretValue(node)) {
        leaks.push({
          path,
          reason: `"${key}" holds what looks like a credential value.`,
        });
      }
      return;
    }

    if (node === null || typeof node !== 'object') return;
    // ANCESTORS only. Bundles are JSON, so a true cycle can only come from a
    // caller passing a live object graph, and this must never hang the install
    // dialog - but a subtree that merely APPEARS twice is not a cycle. Two steps
    // sharing one object is normal for the connectors compiled into the app, and
    // a global visited-set silently skipped the second occurrence, so a
    // credential sitting in it went unreported.
    if (ancestors.has(node)) return;
    ancestors.add(node);

    if (Array.isArray(node)) {
      node.forEach((entry, index) => walk(entry, `${path}[${index}]`, key, depth + 1));
    } else {
      for (const [property, entry] of Object.entries(node)) {
        const childPath = path.length === 0 ? property : `${path}.${property}`;
        walk(entry, childPath, property, depth + 1);
      }
    }
    ancestors.delete(node);
  };

  walk(value, '', undefined, 0);
  return leaks;
}

/** True for a bundle path that holds a secret NAME by contract. */
function isNamePosition(path: string): boolean {
  return NAME_POSITION_PATTERNS.some((pattern) => pattern.test(path));
}

/**
 * True for a value that reads as an opaque credential rather than as
 * configuration: long enough to be one, no whitespace, key-ish character set,
 * mixing letters with digits or separators, and not a template or a url.
 */
function isOpaqueSecretValue(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length < 16 || trimmed.length > 4096) return false;
  if (isPureTemplate(trimmed)) return false;
  if (/\s/.test(trimmed)) return false;
  if (trimmed.includes('://')) return false;
  if (!/^[A-Za-z0-9+/=_.:-]+$/.test(trimmed)) return false;
  // Configuration values that happen to be long are usually one alphabet:
  // a hostname, a path, an id. Credentials mix cases or classes.
  const hasDigit = /\d/.test(trimmed);
  const hasLetter = /[A-Za-z]/.test(trimmed);
  const mixedCase = /[a-z]/.test(trimmed) && /[A-Z]/.test(trimmed);
  return hasLetter && (hasDigit || mixedCase);
}

/** True when a string is nothing but `{{template}}` references and separators. */
function isPureTemplate(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed.includes('{{')) return false;
  return trimmed.replace(/\{\{[^{}]*\}\}/g, '').trim().length === 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Derivations - what the installer materialises
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every secret NAME the connection needs: the declared fields plus anything the
 * auth descriptor points at, deduplicated in declaration order. This is exactly
 * `Connection.secretKeys`, so the two can never drift.
 */
export function connectorSecretKeyNames(template: ConnectorConnectionTemplate): string[] {
  const declared = readArray(template?.secretFields)
    .map((field) => readRecord(field)?.['name'])
    .filter((name): name is string => typeof name === 'string' && name.length > 0);
  return [...new Set([...declared, ...authSecretKeyNames(template?.auth)])];
}

/** Pre-filled non-secret config, keyed by field name. */
export function connectorConfigDefaults(
  template: ConnectorConnectionTemplate,
): Record<string, string> {
  const config: Record<string, string> = {};
  for (const field of readArray(template?.configFields)) {
    const record = readRecord(field);
    const name = record?.['name'];
    const value = record?.['default'];
    if (typeof name === 'string' && typeof value === 'string') config[name] = value;
  }
  return config;
}

/**
 * Required config field names with no value yet. The installer blocks on this
 * rather than creating a connection that cannot resolve a base url.
 */
export function missingConnectorConfig(
  template: ConnectorConnectionTemplate,
  config: Readonly<Record<string, string>> | undefined,
): string[] {
  const missing: string[] = [];
  for (const field of readArray(template?.configFields)) {
    const record = readRecord(field);
    const name = record?.['name'];
    if (typeof name !== 'string' || record?.['required'] !== true) continue;
    if ((config?.[name] ?? '').trim().length === 0) missing.push(name);
  }
  return missing;
}

/**
 * The `lookups` record for a transform step: the named bundle tables, in the
 * order the step lists them. Unknown names are skipped - validation has already
 * reported them as errors, and this must stay total for a preview of a bundle
 * that has not been installed.
 */
export function connectorTableLookups(
  bundle: Pick<ConnectorBundle, 'tables'>,
  names: readonly string[] | undefined,
): Record<string, Record<string, string | number | boolean>> {
  const lookups: Record<string, Record<string, string | number | boolean>> = {};
  if (!names || names.length === 0) return lookups;
  const tables = readArray(bundle?.tables);
  for (const name of names) {
    const table = tables.map(readRecord).find((entry) => entry?.['name'] === name);
    const entries = readRecord(table?.['entries']);
    if (entries) lookups[name] = cloneJson(entries) as Record<string, string | number | boolean>;
  }
  return lookups;
}

/**
 * Node data for one step, ready to drop on the canvas: the packaged data with
 * the installer's `connectionId` bound and any mapping tables inlined as
 * `lookups`.
 *
 * Returns a fresh object every call - the bundle is a template and a dropped
 * node must never share structure with it. From this point the node is an
 * ORDINARY data node: fully editable, and unaffected by uninstalling the
 * connector.
 */
export function connectorStepNodeData(
  bundle: Pick<ConnectorBundle, 'tables'>,
  step: ConnectorStep,
  connectionId?: string,
): object {
  const data = (cloneJson(step?.data) ?? {}) as Record<string, unknown>;

  if (step?.kind === 'http-request' || step?.kind === 'sql-query') {
    if (typeof connectionId === 'string' && connectionId.length > 0) {
      data['connectionId'] = connectionId;
    } else {
      delete data['connectionId'];
    }
  }

  if (step?.kind === 'transform') {
    const lookups = connectorTableLookups(bundle, step.tables);
    if (Object.keys(lookups).length > 0) {
      data['lookups'] = { ...(readRecord(data['lookups']) ?? {}), ...lookups };
    }
  }

  return data;
}

/** What the installer supplies that a bundle cannot: an id, a clock, the config. */
export interface ConnectorConnectionSeed {
  /** Minted by the caller, matching `CONNECTION_ID_PATTERN`. */
  id: string;
  /** Operator-chosen label. Defaults to the connector name. */
  name?: string;
  /** Values collected for the declared config fields. */
  config?: Readonly<Record<string, string>>;
  /** ISO-8601 UTC timestamp for `createdAt` and `updatedAt`. */
  nowIso: string;
}

/**
 * Builds the `Connection` an install creates. Metadata only: secret VALUES are
 * written separately, straight to the host store.
 *
 * Two things are deliberately absent. `allowWrites` is never set, however loudly
 * the bundle declares `needsWrites` - writes are opt-in on the connection,
 * chosen by whoever owns the credential. And config keys the template does not
 * declare are dropped, so a caller cannot widen a connection's non-secret
 * surface by accident.
 */
export function buildConnectorConnection(
  bundle: ConnectorBundle,
  seed: ConnectorConnectionSeed,
): Connection {
  const template = bundle.connection;
  const declared = readArray(template?.configFields)
    .map((field) => readRecord(field)?.['name'])
    .filter((name): name is string => typeof name === 'string');

  const config: Record<string, string> = {};
  const supplied = { ...connectorConfigDefaults(template), ...(seed.config ?? {}) };
  for (const name of declared) {
    const value = supplied[name];
    if (typeof value === 'string' && value.length > 0) config[name] = value;
  }

  const connection: Connection = {
    id: seed.id,
    name: (seed.name ?? bundle.name ?? 'Connector').trim().slice(0, 100) || 'Connector',
    type: template.type,
    config,
    secretKeys: connectorSecretKeyNames(template),
    auth: cloneJson(template.auth) as ConnectionAuth,
    createdAt: seed.nowIso,
    updatedAt: seed.nowIso,
  };
  if (template.type === 'sql' && readRecord(template.limits)) {
    connection.limits = cloneJson(template.limits) as SqlLimits;
  }
  return connection;
}

/**
 * A throwaway spec containing one node per step, so the install preview can run
 * the EXISTING capability walk (`inspectAgainstCapabilities`) instead of
 * reimplementing egress collection and host checks for bundles.
 *
 * The graph is nodes-only: connector steps carry no topology, and every rule the
 * preview cares about (node kind, SQL driver, connection resolution, expression
 * compilation, declared egress) is per-node.
 */
export function connectorPreviewSpec(
  bundle: ConnectorBundle,
  connectionId?: string,
): { graph: { nodes: import('./types.js').WorkflowNode[]; connections: [] } } {
  const nodes = readArray(bundle?.steps).map((raw, index) => {
    const step = (readRecord(raw) ?? {}) as unknown as ConnectorStep;
    const id = `cx-preview-${index}`;
    return {
      id,
      name: typeof step.label === 'string' && step.label.length > 0 ? step.label : `Step ${index + 1}`,
      kind: String(step.kind ?? ''),
      category: 'flow',
      icon: typeof step.icon === 'string' ? step.icon : '',
      position: { x: 0, y: 0 },
      ports: [
        { id: `${id}-in`, name: 'In', role: 'message-in' as const },
        { id: `${id}-out`, name: 'Out', role: 'message-out' as const },
      ],
      data: connectorStepNodeData(bundle, step, connectionId),
    };
  });
  return { graph: { nodes, connections: [] } };
}

// ─────────────────────────────────────────────────────────────────────────────
// Packaging - turning a working workflow back into a shareable bundle
// ─────────────────────────────────────────────────────────────────────────────

/** One node being packaged as a step. */
export interface ConnectorPackageStep {
  /** Node name, which becomes the step label and seeds its id. */
  label: string;
  kind: string;
  /** Node data, copied and stripped. */
  data: object;
  description?: string;
  icon?: string;
  keywords?: string[];
}

/** Everything {@link packageConnectorBundle} needs from the studio. */
export interface ConnectorPackageSource {
  /** `cx-` prefixed bundle id, minted by the caller. */
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  icon?: string;
  minAppVersion?: string;
  /**
   * The connection the packaged steps use. Only its SHAPE is carried: type, auth
   * mode, config field names and secret key names.
   */
  connection: Pick<Connection, 'type' | 'auth' | 'config' | 'secretKeys' | 'allowWrites' | 'limits'>;
  steps: ConnectorPackageStep[];
}

/** A packaged bundle plus whatever validation says about it. */
export interface ConnectorPackageResult {
  bundle: ConnectorBundle;
  /** Findings for the produced bundle. An error means it must not be shared. */
  findings: ConnectorFinding[];
}

/**
 * Builds a shareable bundle from nodes that already work (P1-14 packaging).
 *
 * What it deliberately does NOT carry:
 *
 * - Secret values. There are none to carry: a `Connection` holds names only.
 * - Config VALUES. The author's own base url, host, database and tenant id are
 *   identifying, and a bundle is shared by definition, so config fields travel
 *   as names and labels for the installer to fill. Anything a recipient must set
 *   is marked required.
 * - `connectionId` and `errorPortId`. Both name entities in the author's own
 *   install - a connection they own and a port id belonging to one specific node
 *   - so they cannot mean anything to anyone else.
 *
 * Mapping tables are LIFTED: a transform's inline `lookups` become bundle-level
 * `tables` referenced by name, which is the whole point of packaging one (the
 * account-code crosswalk stops being copy-pasted per node).
 *
 * The result is validated before it is returned, so packaging a node with a
 * hardcoded API key in a header FAILS rather than publishing the key.
 */
export function packageConnectorBundle(source: ConnectorPackageSource): ConnectorPackageResult {
  const template = buildTemplateFromConnection(source.connection, source.steps);
  const tables: ConnectorTable[] = [];
  const usedIds = new Set<string>();

  const steps: ConnectorStep[] = readArray(source.steps).map((raw, index) => {
    const input = (readRecord(raw) ?? {}) as unknown as ConnectorPackageStep;
    const label = typeof input.label === 'string' && input.label.trim().length > 0
      ? input.label.trim()
      : `Step ${index + 1}`;
    const data = (cloneJson(input.data) ?? {}) as Record<string, unknown>;

    // Instance-specific references cannot survive the trip to another install.
    delete data['connectionId'];
    delete data['errorPortId'];

    const step: ConnectorStep = {
      id: uniqueStepId(label, index, usedIds),
      label: label.slice(0, 100),
      kind: input.kind as ConnectorStepKind,
      data,
    };
    if (typeof input.description === 'string' && input.description.trim().length > 0) {
      step.description = input.description.trim().slice(0, 300);
    }
    if (typeof input.icon === 'string' && input.icon.length > 0) step.icon = input.icon;
    if (Array.isArray(input.keywords) && input.keywords.length > 0) {
      step.keywords = input.keywords.filter((word): word is string => typeof word === 'string');
    }

    if (input.kind === 'transform') liftLookups(step, data, tables);
    return step;
  });

  const bundle: ConnectorBundle = {
    format: CONNECTOR_FORMAT_VERSION,
    id: source.id,
    name: source.name,
    version: source.version,
    connection: template,
    steps,
  };
  if (source.description) bundle.description = source.description;
  if (source.author) bundle.author = source.author;
  if (source.icon) bundle.icon = source.icon;
  if (source.minAppVersion) bundle.minAppVersion = source.minAppVersion;
  if (tables.length > 0) bundle.tables = tables;

  return { bundle, findings: validateConnectorBundle(bundle) };
}

/**
 * Moves a transform's inline `lookups` into bundle-level tables, referencing
 * them by name. A name already taken by a DIFFERENT table is suffixed, so two
 * nodes with divergent copies of `statusMap` both survive instead of one
 * silently overwriting the other.
 */
function liftLookups(step: ConnectorStep, data: Record<string, unknown>, tables: ConnectorTable[]): void {
  const lookups = readRecord(data['lookups']);
  if (!lookups) return;
  const names: string[] = [];

  for (const [rawName, rawEntries] of Object.entries(lookups)) {
    const entries = readRecord(rawEntries);
    if (!entries) continue;
    const scalarEntries: Record<string, string | number | boolean> = {};
    for (const [key, value] of Object.entries(entries)) {
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        scalarEntries[key] = value;
      }
    }

    const base = CONNECTOR_TABLE_NAME_PATTERN.test(rawName) ? rawName : `table${tables.length + 1}`;
    const serialised = JSON.stringify(scalarEntries);
    const identical = tables.find(
      (table) => table.name === base && JSON.stringify(table.entries) === serialised,
    );
    if (identical) {
      names.push(identical.name);
      continue;
    }

    let name = base;
    let suffix = 2;
    while (tables.some((table) => table.name === name)) {
      name = `${base}-${suffix}`;
      suffix += 1;
    }
    tables.push({ name, entries: scalarEntries });
    names.push(name);
  }

  delete data['lookups'];
  if (names.length > 0) step.tables = names;
}

/**
 * Derives the connection TEMPLATE from a live connection: its shape, never its
 * values. `needsWrites` is inferred rather than trusted, so a recipient is
 * warned whenever the packaged steps can modify their system - whether or not
 * the author happened to have `allowWrites` on.
 */
function buildTemplateFromConnection(
  connection: ConnectorPackageSource['connection'],
  steps: readonly ConnectorPackageStep[],
): ConnectorConnectionTemplate {
  const config = readRecord(connection?.config) ?? {};
  const configFields: ConnectorConfigField[] = Object.keys(config)
    .filter((name) => FIELD_NAME_PATTERN.test(name))
    .map((name) => ({
      name,
      label: humaniseFieldName(name),
      // Required when the author needed a value for it. No default: the value
      // is theirs, and identifies their install.
      ...(String(config[name] ?? '').trim().length > 0 ? { required: true } : {}),
    }));

  const secretFields: ConnectorSecretField[] = [
    ...new Set([
      ...readArray(connection?.secretKeys).filter((key): key is string => typeof key === 'string'),
      ...authSecretKeyNames(connection?.auth),
    ]),
  ]
    .filter((name) => FIELD_NAME_PATTERN.test(name))
    .map((name) => ({ name, label: humaniseFieldName(name) }));

  const writesData = readArray(steps).some((raw) => {
    const step = readRecord(raw);
    if (step?.['kind'] !== 'http-request') return false;
    const method = String(readRecord(step['data'])?.['method'] ?? 'GET').toUpperCase();
    return method !== 'GET' && method !== 'HEAD';
  });

  const template: ConnectorConnectionTemplate = {
    type: connection.type,
    configFields,
    secretFields,
    auth: (cloneJson(connection.auth) ?? { mode: 'none' }) as ConnectionAuth,
  };
  if (writesData || connection.allowWrites === true) template.needsWrites = true;
  if (connection.type === 'sql' && readRecord(connection.limits)) {
    template.limits = cloneJson(connection.limits) as SqlLimits;
  }
  return template;
}

/** `List invoices` -> `list-invoices`, deduplicated within one bundle. */
function uniqueStepId(label: string, index: number, used: Set<string>): string {
  const base =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || `step-${index + 1}`;
  let id = CONNECTOR_STEP_ID_PATTERN.test(base) ? base : `step-${index + 1}`;
  let suffix = 2;
  while (used.has(id)) {
    id = `${base}-${suffix}`;
    suffix += 1;
  }
  used.add(id);
  return id;
}

/** `baseUrl` -> `Base url`, for a label a human has to read. */
function humaniseFieldName(name: string): string {
  // Sentence case, matching the label style of the built-in connectors
  // ("Tenant id", not "Tenant Id").
  const spaced = name
    .replace(/[_.-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim()
    .toLowerCase();
  return spaced.length > 0 ? `${spaced[0]!.toUpperCase()}${spaced.slice(1)}` : name;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function error(path: string, message: string): ConnectorFinding {
  return { severity: 'error', path, message };
}

function warning(path: string, message: string): ConnectorFinding {
  return { severity: 'warning', path, message };
}

/** A readable plain object, or `undefined` for anything else (never throws). */
function readRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

/** The value as an array, or `[]` - so a malformed field never breaks the walk. */
function readArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function requireText(
  value: unknown,
  path: string,
  maxLength: number,
  what: string,
  out: ConnectorFinding[],
): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    out.push(error(path, `${what}.`));
    return;
  }
  if (value.length > maxLength) {
    out.push(error(path, `${what} of at most ${maxLength} characters.`));
  }
}

function optionalText(
  value: unknown,
  path: string,
  maxLength: number,
  out: ConnectorFinding[],
): void {
  if (value === undefined) return;
  if (typeof value !== 'string') {
    out.push(error(path, 'This field must be a string.'));
    return;
  }
  if (value.length > maxLength) {
    out.push(error(path, `This field must be at most ${maxLength} characters.`));
  }
}

/**
 * Deep copy through JSON. A bundle is JSON by definition, so this is exact for
 * every value it can hold, and it keeps the module free of any assumption about
 * `structuredClone` being present on the host.
 */
function cloneJson(value: unknown): unknown {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return undefined;
  }
}
