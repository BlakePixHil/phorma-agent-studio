import { describe, expect, it } from 'vitest';
import {
  BROWSER_CAPABILITIES,
  TAURI_DESKTOP_CAPABILITIES,
  inspectAgainstCapabilities,
} from './capabilities.js';
import {
  CONNECTOR_FORMAT_VERSION,
  CONNECTOR_MAX_SOURCE_BYTES,
  buildConnectorConnection,
  connectorConfigDefaults,
  connectorErrors,
  connectorFileName,
  connectorPreviewSpec,
  connectorSecretKeyNames,
  connectorStepNodeData,
  connectorTableLookups,
  isConnectorBundle,
  looksLikeSecretName,
  missingConnectorConfig,
  packageConnectorBundle,
  parseConnectorBundle,
  satisfiesMinAppVersion,
  secretPositionsOf,
  serializeConnectorBundle,
  validateConnectorBundle,
  type ConnectorBundle,
} from './connectors.js';

/**
 * Connector bundle format, validation and derivations (P1-14).
 *
 * Plan: `docs/connector-packaging-plan.md`. Two things in here are load-bearing
 * rather than merely correct, and both are about installing a file a stranger
 * wrote:
 *
 * - A valid bundle carries no secret VALUE anywhere. The sibling property spec
 *   pins the general claim; these cases pin the specific shapes.
 * - An install never grants trust. `needsWrites` never becomes
 *   `Connection.allowWrites`, and config keys the template does not declare are
 *   dropped rather than passed through.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

/** A minimal installable bundle. Every test starts from a mutation of this. */
function validBundle(): ConnectorBundle {
  return {
    format: CONNECTOR_FORMAT_VERSION,
    id: 'cx-acme',
    name: 'Acme Billing',
    description: 'Reads invoices out of the Acme billing API.',
    version: '1.0.0',
    author: 'Phorma',
    icon: 'ti ti-receipt',
    connection: {
      type: 'http',
      configFields: [
        {
          name: 'baseUrl',
          label: 'API base URL',
          required: true,
          default: 'https://api.acme.example',
        },
        { name: 'tenantId', label: 'Tenant id' },
      ],
      secretFields: [{ name: 'apiToken', label: 'API token', docsUrl: 'https://acme.example/keys' }],
      auth: { mode: 'bearer', secretKey: 'apiToken' },
    },
    steps: [
      {
        id: 'list-invoices',
        label: 'List invoices',
        description: 'Cursor-paginated invoice fetch.',
        kind: 'http-request',
        data: {
          method: 'GET',
          url: '/v1/invoices',
          responseMode: 'json',
          pagination: { mode: 'cursor', cursorPath: 'next', cursorParam: 'cursor', itemsPath: 'data', maxPages: 20 },
        },
      },
      {
        id: 'map-invoice',
        label: 'Map invoice to ledger',
        kind: 'transform',
        tables: ['accountCodes'],
        data: {
          mode: 'record',
          fields: [{ target: 'account', expression: "lookup('accountCodes', input.type)" }],
        },
      },
    ],
    tables: [
      {
        name: 'accountCodes',
        description: 'Acme invoice type to ledger account.',
        entries: { subscription: '4000', usage: '4010', credit: '4900' },
      },
    ],
  };
}

/** Errors only, as `path: message`, for terse assertions. */
function errorPaths(value: unknown): string[] {
  return connectorErrors(validateConnectorBundle(value)).map((finding) => finding.path);
}

// ─────────────────────────────────────────────────────────────────────────────
// Parse
// ─────────────────────────────────────────────────────────────────────────────

describe('parseConnectorBundle', () => {
  it('accepts a well-formed bundle and reports no findings', () => {
    const result = parseConnectorBundle(serializeConnectorBundle(validBundle()));
    expect(result.ok).toBe(true);
    expect(result.findings).toEqual([]);
  });

  it('is total: no input shape throws', () => {
    for (const input of [undefined, null, 42, {}, [], '   ', '{"format":', 'null', '[]', '"text"']) {
      expect(() => parseConnectorBundle(input)).not.toThrow();
      expect(parseConnectorBundle(input).ok).toBe(false);
    }
  });

  it('names JSON syntax errors rather than reporting a generic failure', () => {
    const result = parseConnectorBundle('{"format": 1,}');
    expect(result.ok).toBe(false);
    expect(result.findings[0]?.message).toContain('not valid JSON');
  });

  it('refuses a file over the source size limit', () => {
    const result = parseConnectorBundle('a'.repeat(CONNECTOR_MAX_SOURCE_BYTES + 1));
    expect(result.ok).toBe(false);
    expect(result.findings[0]?.message).toContain('limit');
  });

  it('tells the user to update the studio for a newer format, not that the file is broken', () => {
    const result = parseConnectorBundle(
      JSON.stringify({ ...validBundle(), format: CONNECTOR_FORMAT_VERSION + 1 }),
    );
    expect(result.ok).toBe(false);
    expect(result.findings.some((f) => f.message.includes('Update the studio'))).toBe(true);
  });

  it('round-trips through serialize and parse', () => {
    const bundle = validBundle();
    const result = parseConnectorBundle(serializeConnectorBundle(bundle));
    expect(result.ok && result.bundle).toEqual(bundle);
  });
});

describe('connectorFileName', () => {
  it('kebab-cases the name and appends the connector extension', () => {
    expect(connectorFileName({ name: 'Acme Billing' })).toBe('acme-billing.connector.json');
  });

  it('falls back to a usable name for an unusable one', () => {
    expect(connectorFileName({ name: '  ***  ' })).toBe('connector.connector.json');
  });
});

describe('satisfiesMinAppVersion', () => {
  it('ignores a prerelease suffix, so a beta build can install a 0.2.0 connector', () => {
    expect(satisfiesMinAppVersion({ minAppVersion: '0.2.0' }, '0.2.0-beta.8')).toBe(true);
  });

  it('refuses a bundle that needs a newer app', () => {
    expect(satisfiesMinAppVersion({ minAppVersion: '0.3.0' }, '0.2.0-beta.8')).toBe(false);
  });

  it('is permissive for an absent or unparseable minimum', () => {
    expect(satisfiesMinAppVersion({}, '0.2.0')).toBe(true);
    expect(satisfiesMinAppVersion({ minAppVersion: 'next' }, '0.2.0')).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Identity and connection template
// ─────────────────────────────────────────────────────────────────────────────

describe('validateConnectorBundle: identity', () => {
  it('accepts the fixture', () => {
    expect(validateConnectorBundle(validBundle())).toEqual([]);
    expect(isConnectorBundle(validBundle())).toBe(true);
  });

  it('requires a cx- prefixed id', () => {
    expect(errorPaths({ ...validBundle(), id: 'acme' })).toContain('id');
    expect(errorPaths({ ...validBundle(), id: 'conn-acme' })).toContain('id');
  });

  it('requires a name and a version', () => {
    expect(errorPaths({ ...validBundle(), name: '  ' })).toContain('name');
    expect(errorPaths({ ...validBundle(), version: undefined })).toContain('version');
  });

  it('warns about an unparseable minAppVersion without blocking the install', () => {
    const findings = validateConnectorBundle({ ...validBundle(), minAppVersion: 'whenever' });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe('warning');
    expect(isConnectorBundle({ ...validBundle(), minAppVersion: 'whenever' })).toBe(true);
  });
});

describe('validateConnectorBundle: connection template', () => {
  it('requires a connection template with a known type', () => {
    expect(errorPaths({ ...validBundle(), connection: undefined })).toContain('connection');
    const bundle = validBundle();
    bundle.connection.type = 'ftp' as never;
    expect(errorPaths(bundle)).toContain('connection.type');
  });

  it('rejects duplicate field names, and a name declared as both config and secret', () => {
    const duplicate = validBundle();
    duplicate.connection.secretFields = [
      { name: 'apiToken', label: 'A' },
      { name: 'apiToken', label: 'B' },
    ];
    expect(errorPaths(duplicate)).toContain('connection.secretFields[1].name');

    const overlap = validBundle();
    overlap.connection.configFields.push({ name: 'apiToken', label: 'Token' });
    expect(errorPaths(overlap)).toContain('connection.secretFields[0].name');
  });

  it('rejects an auth mode pointing at an undeclared secret', () => {
    const bundle = validBundle();
    bundle.connection.auth = { mode: 'bearer', secretKey: 'notDeclared' };
    const findings = connectorErrors(validateConnectorBundle(bundle));
    expect(findings.some((f) => f.path === 'connection.auth')).toBe(true);
    expect(findings[0]?.message).toContain('secretFields');
  });

  it('rejects a secret-shaped config field carrying a default', () => {
    const bundle = validBundle();
    bundle.connection.configFields.push({
      name: 'clientSecret',
      label: 'Client secret',
      default: 'someValue',
    });
    expect(errorPaths(bundle)).toContain('connection.configFields[2].default');
  });

  it('accepts a bundle with no secrets at all (an unauthenticated API)', () => {
    const bundle = validBundle();
    bundle.connection.secretFields = [];
    bundle.connection.auth = { mode: 'none' };
    expect(validateConnectorBundle(bundle)).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Steps
// ─────────────────────────────────────────────────────────────────────────────

describe('validateConnectorBundle: steps', () => {
  it('requires at least one step', () => {
    expect(errorPaths({ ...validBundle(), steps: [] })).toContain('steps');
    expect(errorPaths({ ...validBundle(), steps: undefined })).toContain('steps');
  });

  it('rejects duplicate step ids', () => {
    const bundle = validBundle();
    bundle.steps[1] = { ...bundle.steps[1]!, id: 'list-invoices' };
    expect(errorPaths(bundle)).toContain('steps[1].id');
  });

  it('restricts packageable kinds to the four integration kinds', () => {
    for (const kind of ['agent', 'assert', 'state-set', 'notify', 'router']) {
      const bundle = validBundle();
      bundle.steps = [{ id: 's', label: 'S', kind: kind as never, data: {} }];
      expect(errorPaths(bundle)).toContain('steps[0].kind');
    }
  });

  it('rejects a step that names a connection id, since the installer binds its own', () => {
    const bundle = validBundle();
    bundle.steps[0] = { ...bundle.steps[0]!, data: { method: 'GET', url: '/x', connectionId: 'conn-someone-elses' } };
    expect(errorPaths(bundle)).toContain('steps[0].data.connectionId');
  });

  it('requires the connection type to match what the step needs', () => {
    const http = validBundle();
    http.connection.type = 'smtp';
    expect(errorPaths(http)).toContain('steps[0].kind');

    const sql = validBundle();
    sql.steps = [{ id: 'q', label: 'Q', kind: 'sql-query', data: { statement: 'select 1' } }];
    expect(errorPaths(sql)).toContain('steps[0].kind');

    sql.connection.type = 'sql';
    sql.connection.auth = { mode: 'none' };
    sql.connection.secretFields = [];
    expect(connectorErrors(validateConnectorBundle(sql))).toEqual([]);
  });

  it('requires a sql-query step to carry a statement', () => {
    const bundle = validBundle();
    bundle.connection = { type: 'sql', configFields: [], secretFields: [], auth: { mode: 'none' } };
    bundle.steps = [{ id: 'q', label: 'Q', kind: 'sql-query', data: { statement: '  ' } }];
    expect(errorPaths(bundle)).toContain('steps[0].data.statement');
  });

  it('requires an http-request step to carry a url', () => {
    const bundle = validBundle();
    bundle.steps[0] = { ...bundle.steps[0]!, data: { method: 'GET' } };
    expect(errorPaths(bundle)).toContain('steps[0].data.url');
  });

  it('rejects an unknown HTTP method', () => {
    const bundle = validBundle();
    bundle.steps[0] = { ...bundle.steps[0]!, data: { method: 'FETCH', url: '/x' } };
    expect(errorPaths(bundle)).toContain('steps[0].data.method');
  });

  it('rejects a literal credential in an auth-bearing header, and allows a template', () => {
    const literal = validBundle();
    literal.steps[0] = {
      ...literal.steps[0]!,
      data: { method: 'GET', url: '/x', headers: [{ key: 'Authorization', value: 'Bearer hunter2hunter2' }] },
    };
    expect(errorPaths(literal)).toContain('steps[0].data.headers[0].value');

    const templated = validBundle();
    templated.steps[0] = {
      ...templated.steps[0]!,
      data: { method: 'GET', url: '/x', headers: [{ key: 'X-Api-Key', value: '{{input.key}}' }] },
    };
    expect(connectorErrors(validateConnectorBundle(templated))).toEqual([]);
  });

  it('allows a non-auth header with a literal value', () => {
    const bundle = validBundle();
    bundle.steps[0] = {
      ...bundle.steps[0]!,
      data: { method: 'GET', url: '/x', headers: [{ key: 'Accept', value: 'application/json' }] },
    };
    expect(validateConnectorBundle(bundle)).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tables and workflows
// ─────────────────────────────────────────────────────────────────────────────

describe('validateConnectorBundle: tables and workflows', () => {
  it('rejects a step referencing an undeclared table', () => {
    const bundle = validBundle();
    bundle.steps[1] = { ...bundle.steps[1]!, tables: ['nope'] };
    expect(errorPaths(bundle)).toContain('steps[1].tables[0]');
  });

  it('rejects mapping tables on a kind that has no lookups', () => {
    const bundle = validBundle();
    bundle.steps[0] = { ...bundle.steps[0]!, tables: ['accountCodes'] };
    expect(errorPaths(bundle)).toContain('steps[0].tables');
  });

  it('rejects non-scalar mapping table values', () => {
    const bundle = validBundle();
    bundle.tables = [{ name: 'accountCodes', entries: { a: { nested: true } as never } }];
    expect(errorPaths(bundle)).toContain('tables[0].entries.a');
  });

  it('rejects a duplicate table name', () => {
    const bundle = validBundle();
    bundle.tables = [
      { name: 'accountCodes', entries: { a: '1' } },
      { name: 'accountCodes', entries: { b: '2' } },
    ];
    expect(errorPaths(bundle)).toContain('tables[1].name');
  });

  it('requires a shipped workflow to have an id, a name and a graph', () => {
    const bundle = validBundle();
    bundle.workflows = [{ id: '', name: '', graph: {} as never }];
    const paths = errorPaths(bundle);
    expect(paths).toContain('workflows[0].id');
    expect(paths).toContain('workflows[0].name');
    expect(paths).toContain('workflows[0].graph');
  });

  it('accepts a shipped workflow with a readable graph', () => {
    const bundle = validBundle();
    bundle.workflows = [{ id: 'wf-acme-sync', name: 'Acme sync', graph: { nodes: [], connections: [] } }];
    expect(validateConnectorBundle(bundle)).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Secret scanning
// ─────────────────────────────────────────────────────────────────────────────

describe('looksLikeSecretName', () => {
  it('matches credential words across separator and case styles', () => {
    for (const name of ['clientSecret', 'client_secret', 'CLIENT-SECRET', 'X-Api-Key', 'refreshToken', 'passphrase']) {
      expect(looksLikeSecretName(name)).toBe(true);
    }
  });

  it('does not treat `author` as a credential', () => {
    // `auth` is deliberately absent from the word list for exactly this reason.
    expect(looksLikeSecretName('author')).toBe(false);
    expect(looksLikeSecretName('baseUrl')).toBe(false);
    expect(looksLikeSecretName(undefined)).toBe(false);
  });
});

describe('secretPositionsOf', () => {
  const leaks: ReadonlyArray<readonly [string, string]> = [
    ['an OpenAI style key', 'sk-ABCDEFGHIJKLMNOPQRSTUVWX'],
    ['a Stripe key', 'sk_live_ABCDEFGHIJKLMNOP'],
    ['a GitHub token', 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345'],
    ['a GitLab token', 'glpat-ABCDEFGHIJKLMNOPQRST'],
    ['a Slack token', 'xoxb-1234567890-ABCDEFGH'],
    ['an AWS access key id', 'AKIAIOSFODNN7EXAMPLE'],
    ['a Google API key', 'AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZ0123456'],
    ['a Resend key', 're_ABCDEFGHIJKLMNOPQR'],
    ['a JWT', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r'],
    ['a PEM private key', '-----BEGIN RSA PRIVATE KEY-----'],
  ];

  for (const [label, value] of leaks) {
    it(`recognises ${label} anywhere in the document, including prose`, () => {
      const bundle = { ...validBundle(), description: `Paste ${value} here` };
      expect(secretPositionsOf(bundle).map((leak) => leak.path)).toContain('description');
      expect(isConnectorBundle(bundle)).toBe(false);
    });
  }

  it('catches an unlisted vendor key by name plus opaque value', () => {
    const bundle = validBundle();
    bundle.steps[1] = { ...bundle.steps[1]!, data: { mode: 'record', fields: [], apiKeyValue: 'A1b2C3d4E5f6G7h8' } };
    expect(secretPositionsOf(bundle).map((leak) => leak.path)).toContain('steps[1].data.apiKeyValue');
    expect(isConnectorBundle(bundle)).toBe(false);
  });

  it('leaves positions that hold a secret NAME by contract alone', () => {
    const bundle = validBundle();
    bundle.connection.secretFields = [{ name: 'XeroClientSecretKeyName', label: 'Client secret' }];
    bundle.connection.auth = {
      mode: 'oauth2-client-credentials',
      tokenUrl: 'https://identity.xero.com/connect/token',
      clientIdSecretKey: 'XeroClientIdSecretKeyName',
      clientSecretKey: 'XeroClientSecretKeyName',
    };
    bundle.connection.secretFields.push({ name: 'XeroClientIdSecretKeyName', label: 'Client id' });
    expect(secretPositionsOf(bundle)).toEqual([]);
  });

  it('does not flag templates, urls or prose under credential-shaped names', () => {
    const bundle = validBundle();
    bundle.steps[1] = {
      ...bundle.steps[1]!,
      data: {
        mode: 'record',
        fields: [],
        tokenTemplate: '{{input.token}}',
        tokenUrl: 'https://identity.acme.example/connect/token',
        tokenHint: 'ask the finance team for a token',
      },
    };
    expect(secretPositionsOf(bundle)).toEqual([]);
  });

  it('scans a subtree that appears twice, at both paths', () => {
    // Regression: a global visited-set treated the SECOND occurrence of a shared
    // object as a cycle and skipped it, so a credential in it went unreported.
    // Compile-time bundles (the built-in connectors) share structure routinely.
    const shared = { mode: 'record', fields: [], secretToken: 'A1b2C3d4E5f6G7h8' };
    const bundle = validBundle();
    bundle.steps = [
      { id: 'a', label: 'A', kind: 'transform', data: shared },
      { id: 'b', label: 'B', kind: 'transform', data: shared },
    ];
    expect(secretPositionsOf(bundle).map((leak) => leak.path)).toEqual([
      'steps[0].data.secretToken',
      'steps[1].data.secretToken',
    ]);
  });

  it('is total and terminates on a cyclic object graph', () => {
    const cyclic: Record<string, unknown> = { name: 'x' };
    cyclic['self'] = cyclic;
    expect(() => secretPositionsOf(cyclic)).not.toThrow();
    expect(() => secretPositionsOf(undefined)).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Derivations
// ─────────────────────────────────────────────────────────────────────────────

describe('connectorSecretKeyNames', () => {
  it('unions declared fields with everything the auth mode points at, without duplicates', () => {
    const template = validBundle().connection;
    template.secretFields = [{ name: 'clientId', label: 'Client id' }];
    template.auth = {
      mode: 'oauth2-refresh',
      tokenUrl: 'https://acme.example/token',
      clientIdSecretKey: 'clientId',
      clientSecretKey: 'clientSecret',
      refreshTokenSecretKey: 'refreshToken',
    };
    expect(connectorSecretKeyNames(template)).toEqual(['clientId', 'clientSecret', 'refreshToken']);
  });
});

describe('connectorConfigDefaults / missingConnectorConfig', () => {
  it('pre-fills declared defaults', () => {
    expect(connectorConfigDefaults(validBundle().connection)).toEqual({
      baseUrl: 'https://api.acme.example',
    });
  });

  it('reports only required fields that are still empty', () => {
    const template = validBundle().connection;
    expect(missingConnectorConfig(template, { baseUrl: 'https://x.example' })).toEqual([]);
    expect(missingConnectorConfig(template, { baseUrl: '   ' })).toEqual(['baseUrl']);
    expect(missingConnectorConfig(template, undefined)).toEqual(['baseUrl']);
  });
});

describe('connectorTableLookups', () => {
  it('returns the named tables in the order the step lists them', () => {
    const bundle = validBundle();
    bundle.tables!.push({ name: 'statuses', entries: { open: 'OPEN' } });
    expect(Object.keys(connectorTableLookups(bundle, ['statuses', 'accountCodes']))).toEqual([
      'statuses',
      'accountCodes',
    ]);
  });

  it('skips unknown names instead of throwing, so a preview still renders', () => {
    expect(connectorTableLookups(validBundle(), ['nope'])).toEqual({});
    expect(connectorTableLookups(validBundle(), undefined)).toEqual({});
  });

  it('copies entries, so an installed node never shares structure with the bundle', () => {
    const bundle = validBundle();
    const lookups = connectorTableLookups(bundle, ['accountCodes']);
    lookups['accountCodes']!['subscription'] = 'mutated';
    expect(bundle.tables![0]!.entries['subscription']).toBe('4000');
  });
});

describe('connectorStepNodeData', () => {
  it('binds the installer connection id on an I/O step', () => {
    const bundle = validBundle();
    const data = connectorStepNodeData(bundle, bundle.steps[0]!, 'conn-mine') as Record<string, unknown>;
    expect(data['connectionId']).toBe('conn-mine');
    expect(data['url']).toBe('/v1/invoices');
  });

  it('leaves an unbound step without a connection id rather than an empty one', () => {
    const bundle = validBundle();
    const data = connectorStepNodeData(bundle, bundle.steps[0]!) as Record<string, unknown>;
    expect('connectionId' in data).toBe(false);
  });

  it('inlines mapping tables as lookups on a transform step, and binds no connection', () => {
    const bundle = validBundle();
    const data = connectorStepNodeData(bundle, bundle.steps[1]!, 'conn-mine') as Record<string, unknown>;
    expect(data['lookups']).toEqual({ accountCodes: { subscription: '4000', usage: '4010', credit: '4900' } });
    expect('connectionId' in data).toBe(false);
  });

  it('returns a fresh object every call', () => {
    const bundle = validBundle();
    const first = connectorStepNodeData(bundle, bundle.steps[0]!, 'conn-a') as Record<string, unknown>;
    first['url'] = 'mutated';
    const second = connectorStepNodeData(bundle, bundle.steps[0]!, 'conn-a') as Record<string, unknown>;
    expect(second['url']).toBe('/v1/invoices');
    expect((bundle.steps[0]!.data as Record<string, unknown>)['url']).toBe('/v1/invoices');
  });
});

describe('buildConnectorConnection', () => {
  const seed = { id: 'conn-acme', nowIso: '2026-08-12T00:00:00.000Z' };

  it('builds connection metadata with the declared secret key names', () => {
    const connection = buildConnectorConnection(validBundle(), seed);
    expect(connection).toMatchObject({
      id: 'conn-acme',
      name: 'Acme Billing',
      type: 'http',
      secretKeys: ['apiToken'],
      auth: { mode: 'bearer', secretKey: 'apiToken' },
      createdAt: seed.nowIso,
      updatedAt: seed.nowIso,
    });
  });

  it('NEVER sets allowWrites, however loudly the bundle asks', () => {
    const bundle = validBundle();
    bundle.connection.needsWrites = true;
    expect(buildConnectorConnection(bundle, seed).allowWrites).toBeUndefined();
  });

  it('keeps only declared config keys, defaults included, seed winning', () => {
    const connection = buildConnectorConnection(validBundle(), {
      ...seed,
      config: { tenantId: 'acme-1', baseUrl: 'https://eu.acme.example', sneaky: 'nope' },
    });
    expect(connection.config).toEqual({ baseUrl: 'https://eu.acme.example', tenantId: 'acme-1' });
  });

  it('carries SQL limits only for a sql connection', () => {
    const http = validBundle();
    http.connection.limits = { maxRows: 10 };
    expect(buildConnectorConnection(http, seed).limits).toBeUndefined();

    const sql = validBundle();
    sql.connection = {
      type: 'sql',
      configFields: [],
      secretFields: [],
      auth: { mode: 'none' },
      limits: { maxRows: 500 },
    };
    expect(buildConnectorConnection(sql, seed).limits).toEqual({ maxRows: 500 });
  });

  it('uses an operator-chosen name over the connector name', () => {
    expect(buildConnectorConnection(validBundle(), { ...seed, name: 'Acme (sandbox)' }).name).toBe(
      'Acme (sandbox)',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Preview through the existing capability walk
// ─────────────────────────────────────────────────────────────────────────────

describe('connectorPreviewSpec', () => {
  it('collects the declared egress host from the bound connection', () => {
    const bundle = validBundle();
    const connection = buildConnectorConnection(bundle, {
      id: 'conn-acme',
      nowIso: '2026-08-12T00:00:00.000Z',
      config: { baseUrl: 'https://api.acme.example', tenantId: 't' },
    });
    const report = inspectAgainstCapabilities(
      connectorPreviewSpec(bundle, connection.id),
      TAURI_DESKTOP_CAPABILITIES,
      [{ ...connection, secretsPresent: connection.secretKeys.length }],
    );
    expect(report.egressHosts).toEqual(['api.acme.example']);
    expect(report.findings.filter((f) => f.severity === 'error')).toEqual([]);
  });

  it('surfaces a host that cannot run a packaged step', () => {
    const bundle = validBundle();
    bundle.connection = { type: 'sql', configFields: [], secretFields: [], auth: { mode: 'none' } };
    bundle.steps = [
      { id: 'q', label: 'Read ledger', kind: 'sql-query', data: { statement: 'select 1', driver: 'postgres' } },
    ];
    const report = inspectAgainstCapabilities(connectorPreviewSpec(bundle), BROWSER_CAPABILITIES, []);
    expect(report.findings.some((f) => f.severity === 'error' && f.message.includes('sql-query'))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Packaging
// ─────────────────────────────────────────────────────────────────────────────

describe('packageConnectorBundle', () => {
  const connection = {
    type: 'http' as const,
    auth: { mode: 'bearer' as const, secretKey: 'apiToken' },
    config: { baseUrl: 'https://acme-tenant-42.api.example', tenantId: 'acme-42' },
    secretKeys: ['apiToken'],
  };

  function source(overrides: Partial<Parameters<typeof packageConnectorBundle>[0]> = {}) {
    return {
      id: 'cx-my-acme',
      name: 'My Acme integration',
      version: '1.0.0',
      connection,
      steps: [
        {
          label: 'List invoices',
          kind: 'http-request',
          data: {
            method: 'GET',
            url: '/v1/invoices',
            connectionId: 'conn-mine',
            errorPortId: 'node-abc-p2-x9',
            responseMode: 'json',
          },
        },
      ],
      ...overrides,
    };
  }

  it('produces an installable bundle', () => {
    const { bundle, findings } = packageConnectorBundle(source());
    expect(findings).toEqual([]);
    expect(isConnectorBundle(bundle)).toBe(true);
    expect(bundle.steps[0]?.id).toBe('list-invoices');
    expect(bundle.steps[0]?.label).toBe('List invoices');
  });

  it('strips the author own connection id and port ids', () => {
    const data = packageConnectorBundle(source()).bundle.steps[0]?.data as Record<string, unknown>;
    expect('connectionId' in data).toBe(false);
    expect('errorPortId' in data).toBe(false);
    expect(data['url']).toBe('/v1/invoices');
  });

  it('carries config field NAMES but never the author values', () => {
    const template = packageConnectorBundle(source()).bundle.connection;
    expect(template.configFields).toEqual([
      { name: 'baseUrl', label: 'Base url', required: true },
      { name: 'tenantId', label: 'Tenant id', required: true },
    ]);
    // The author's own tenant url must not travel with a shared file.
    expect(JSON.stringify(template)).not.toContain('acme-tenant-42');
  });

  it('carries secret NAMES only, unioned with the auth descriptor', () => {
    const template = packageConnectorBundle(
      source({
        connection: {
          ...connection,
          secretKeys: [],
          auth: { mode: 'basic', userSecretKey: 'user', passwordSecretKey: 'password' },
        },
      }),
    ).bundle.connection;
    expect(template.secretFields).toEqual([
      { name: 'user', label: 'User' },
      { name: 'password', label: 'Password' },
    ]);
  });

  it('infers needsWrites from a mutating method, not from the author flag alone', () => {
    const readOnly = packageConnectorBundle(source()).bundle.connection;
    expect(readOnly.needsWrites).toBeUndefined();

    const writing = packageConnectorBundle(
      source({
        steps: [{ label: 'Push invoice', kind: 'http-request', data: { method: 'POST', url: '/v1/invoices' } }],
      }),
    ).bundle.connection;
    expect(writing.needsWrites).toBe(true);
  });

  it('lifts a transform lookups table to bundle level and references it by name', () => {
    const { bundle, findings } = packageConnectorBundle(
      source({
        steps: [
          {
            label: 'Map invoice',
            kind: 'transform',
            data: {
              mode: 'record',
              fields: [{ target: 'code', expression: "lookup('accountCodes', input.type)" }],
              lookups: { accountCodes: { subscription: '4000' } },
            },
          },
        ],
      }),
    );
    expect(findings).toEqual([]);
    expect(bundle.tables).toEqual([{ name: 'accountCodes', entries: { subscription: '4000' } }]);
    expect(bundle.steps[0]?.tables).toEqual(['accountCodes']);
    expect('lookups' in (bundle.steps[0]?.data as Record<string, unknown>)).toBe(false);
  });

  it('shares one table between two steps that carry identical copies', () => {
    const transform = (label: string) => ({
      label,
      kind: 'transform',
      data: { mode: 'record', fields: [], lookups: { statusMap: { open: 'Open' } } },
    });
    const { bundle } = packageConnectorBundle(source({ steps: [transform('A'), transform('B')] }));
    expect(bundle.tables).toHaveLength(1);
    expect(bundle.steps[0]?.tables).toEqual(['statusMap']);
    expect(bundle.steps[1]?.tables).toEqual(['statusMap']);
  });

  it('keeps both copies when two steps disagree about the same table name', () => {
    const { bundle } = packageConnectorBundle(
      source({
        steps: [
          { label: 'A', kind: 'transform', data: { mode: 'record', fields: [], lookups: { m: { a: '1' } } } },
          { label: 'B', kind: 'transform', data: { mode: 'record', fields: [], lookups: { m: { a: '2' } } } },
        ],
      }),
    );
    expect(bundle.tables?.map(table => table.name)).toEqual(['m', 'm-2']);
    expect(bundle.steps[1]?.tables).toEqual(['m-2']);
  });

  it('deduplicates step ids derived from identical node names', () => {
    const { bundle } = packageConnectorBundle(
      source({
        steps: [
          { label: 'Fetch', kind: 'http-request', data: { method: 'GET', url: '/a' } },
          { label: 'Fetch', kind: 'http-request', data: { method: 'GET', url: '/b' } },
        ],
      }),
    );
    expect(bundle.steps.map(step => step.id)).toEqual(['fetch', 'fetch-2']);
  });

  it('REFUSES to package a hardcoded credential rather than publishing it', () => {
    const { bundle, findings } = packageConnectorBundle(
      source({
        steps: [
          {
            label: 'List invoices',
            kind: 'http-request',
            data: {
              method: 'GET',
              url: '/v1/invoices',
              headers: [{ key: 'Authorization', value: 'Bearer sk-ABCDEFGHIJKLMNOPQRSTUVWX' }],
            },
          },
        ],
      }),
    );
    expect(isConnectorBundle(bundle)).toBe(false);
    expect(findings.some(finding => finding.severity === 'error')).toBe(true);
    expect(findings.some(finding => finding.path.includes('headers[0].value'))).toBe(true);
  });

  it('names a non-slug node label safely', () => {
    const { bundle } = packageConnectorBundle(
      source({ steps: [{ label: '📈 Totals!', kind: 'transform', data: { mode: 'record', fields: [] } }] }),
    );
    expect(bundle.steps[0]?.id).toMatch(/^[a-z0-9][a-z0-9_-]*$/);
    expect(isConnectorBundle(bundle)).toBe(true);
  });
});
