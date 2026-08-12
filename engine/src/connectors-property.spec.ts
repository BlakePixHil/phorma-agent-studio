import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  CONNECTOR_FORMAT_VERSION,
  buildConnectorConnection,
  connectorSecretKeyNames,
  connectorStepNodeData,
  isConnectorBundle,
  parseConnectorBundle,
  secretPositionsOf,
  serializeConnectorBundle,
  validateConnectorBundle,
  type ConnectorBundle,
  type ConnectorStep,
} from './connectors.js';
import { authSecretKeyNames } from './connections.js';
import { jsonArb } from './test/generators.js';

/**
 * Property 12: Connector bundles are safe to install (P1-14, plan
 * `docs/connector-packaging-plan.md`) - claims 55, 56, 57 and 58:
 *
 *  55. **No packaged secret.** ∀ bundle `b`: if `b` is valid then
 *      `secretPositionsOf(b)` is empty; and ∀ valid `b`, ∀ string position `p`
 *      in `b`: replacing `p` with a recognisable credential makes `b` invalid
 *      and reports a leak AT `p`. This is the load-bearing invariant - a
 *      connector is shared by definition, so a key that survives validation is
 *      a key published to everyone who installs it.
 *  56. **Totality and determinism.** ∀ JSON value `v`:
 *      `validateConnectorBundle(v)`, `parseConnectorBundle(v)` and
 *      `secretPositionsOf(v)` return rather than throw, and repeated calls
 *      return identical findings in identical order.
 *  57. **Round-trip stability.** ∀ valid `b`:
 *      `parseConnectorBundle(serializeConnectorBundle(b))` yields a bundle
 *      structurally equal to `b`, and serialization is a fixed point.
 *  58. **Installation grants no trust.** ∀ valid `b`, ∀ seed: the connection
 *      built from `b` never sets `allowWrites`, declares exactly the secret
 *      names `b` names, carries only declared config keys, and no step node data
 *      shares structure with the bundle.
 *
 * Bundles are generated from a small PLAN model (connection family plus a step
 * list) rather than from raw arbitrary JSON, because an arbitrary document is
 * essentially never a valid bundle and the interesting claims are all about
 * VALID ones. Claim 56 is the one that takes arbitrary JSON, since totality is
 * exactly a statement about garbage input.
 *
 * **Validates: the plan's decision 5 (install never installs trust) and the
 * secret-free bundle invariant documented in `engine/src/connectors.ts`.**
 */

// ─────────────────────────────────────────────────────────────────────────────
// Generators
// ─────────────────────────────────────────────────────────────────────────────

/** Credential shapes the scanner must recognise wherever they appear. */
const CREDENTIALS: readonly string[] = [
  'sk-ABCDEFGHIJKLMNOPQRSTUVWX',
  'sk_live_ABCDEFGHIJKLMNOP',
  'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345',
  'glpat-ABCDEFGHIJKLMNOPQRST',
  'xoxb-1234567890-ABCDEFGH',
  'AKIAIOSFODNN7EXAMPLE',
  'AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZ0123456',
  're_ABCDEFGHIJKLMNOPQR',
  'npm_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
  'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.dBjftJeZ4CVPmB92K27uhbUJU1p1r',
  '-----BEGIN RSA PRIVATE KEY-----',
];

const slugArb = fc.constantFrom('list-items', 'fetch-page', 'map-record', 'roll-up', 'read-ledger');
const labelArb = fc.constantFrom('List items', 'Fetch page', 'Map record', 'Roll up', 'Read ledger');

/** Non-secret, non-opaque config values - a url, a short id, a database name. */
const configValueArb = fc.constantFrom(
  'https://api.example.test',
  'https://eu.api.example.test/v2',
  'tenant-1',
  'reporting',
  '5432',
);

/** An `http-request` step whose url is statically determinable. */
const httpStepArb: fc.Arbitrary<ConnectorStep> = fc.record(
  {
    id: slugArb,
    label: labelArb,
    kind: fc.constant('http-request' as const),
    data: fc.record(
      {
        method: fc.constantFrom('GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'),
        url: fc.constantFrom('/v1/items', '/v1/items/{{input.id}}', 'https://api.example.test/v1/items'),
        responseMode: fc.constantFrom('json', 'text'),
        headers: fc.option(
          fc.array(
            fc.record({ key: fc.constantFrom('Accept', 'Content-Type'), value: fc.constantFrom('application/json') }),
            { maxLength: 2 },
          ),
          { nil: undefined },
        ),
      },
      { requiredKeys: ['method', 'url'] },
    ),
  },
  { requiredKeys: ['id', 'label', 'kind', 'data'] },
);

const sqlStepArb: fc.Arbitrary<ConnectorStep> = fc.record({
  id: slugArb,
  label: labelArb,
  kind: fc.constant('sql-query' as const),
  data: fc.record({
    statement: fc.constantFrom('select 1', 'select id, amount from ledger where period = :period'),
    resultKey: fc.constantFrom('rows', 'ledger'),
  }),
});

/** A `transform` step, optionally pulling the bundle's one mapping table. */
const transformStepArb = (tableName: string | undefined): fc.Arbitrary<ConnectorStep> =>
  fc.record(
    {
      id: slugArb,
      label: labelArb,
      kind: fc.constant('transform' as const),
      data: fc.record({
        mode: fc.constantFrom('record', 'array'),
        fields: fc.array(
          fc.record({ target: fc.constantFrom('code', 'amount', 'ref'), expression: fc.constantFrom('input.id', '1') }),
          { maxLength: 2 },
        ),
      }),
      tables: tableName === undefined ? fc.constant(undefined) : fc.constantFrom(undefined, [tableName]),
    },
    { requiredKeys: ['id', 'label', 'kind', 'data'] },
  );

/**
 * `fc.constant` hands out the SAME object instance on every draw, so any test
 * that mutates a generated value would corrupt the generator itself. Building
 * the data through `.map` mints a fresh object per draw instead. (Finding one
 * production bug this way was enough: see the shared-subtree case in
 * `connectors.spec.ts`.)
 */
const aggregateStepArb: fc.Arbitrary<ConnectorStep> = fc
  .record({ id: slugArb, label: labelArb, by: fc.constantFrom('code', 'account') })
  .map(({ id, label, by }) => ({
    id,
    label,
    kind: 'aggregate' as const,
    data: { op: 'group', group: { by: [by], metrics: [] } },
  }));

/**
 * A valid bundle. The connection family decides which step kinds may appear,
 * mirroring the validator's rule that an `http-request` step needs an
 * http-family connection and a `sql-query` step needs a sql one.
 */
const bundleArb: fc.Arbitrary<ConnectorBundle> = fc
  .record({
    family: fc.constantFrom('http', 'sql'),
    secretName: fc.constantFrom('apiToken', 'clientSecret', 'password'),
    withTable: fc.boolean(),
    withDescription: fc.boolean(),
    withNeedsWrites: fc.boolean(),
    configCount: fc.integer({ min: 0, max: 2 }),
    configValues: fc.array(configValueArb, { minLength: 2, maxLength: 2 }),
    ioSteps: fc.integer({ min: 1, max: 2 }),
    extraSteps: fc.array(fc.constantFrom('transform', 'aggregate'), { maxLength: 2 }),
    stepSeed: fc.array(fc.nat(), { minLength: 4, maxLength: 4 }),
  })
  .chain((plan) => {
    const tableName = plan.withTable ? 'accountCodes' : undefined;
    const ioArb = plan.family === 'http' ? httpStepArb : sqlStepArb;
    const extraArbs = plan.extraSteps.map((kind) =>
      kind === 'transform' ? transformStepArb(tableName) : aggregateStepArb,
    );

    return fc
      .tuple(fc.array(ioArb, { minLength: plan.ioSteps, maxLength: plan.ioSteps }), ...extraArbs)
      .map(([ioSteps, ...extras]) => {
        // Step ids are drawn from a small domain, so uniqueness is imposed here
        // rather than by rejection sampling.
        const steps = [...ioSteps, ...extras].map((step, index) => ({ ...step, id: `${step.id}-${index}` }));

        const configFields = [
          { name: 'baseUrl', label: 'Base URL', required: true, default: plan.configValues[0]! },
          { name: 'tenantId', label: 'Tenant id' },
        ].slice(0, plan.configCount);

        const bundle: ConnectorBundle = {
          format: CONNECTOR_FORMAT_VERSION,
          id: 'cx-generated',
          name: 'Generated connector',
          version: '1.0.0',
          connection: {
            type: plan.family === 'http' ? 'http' : 'sql',
            configFields,
            secretFields: [{ name: plan.secretName, label: 'Credential' }],
            auth: plan.family === 'http' ? { mode: 'bearer', secretKey: plan.secretName } : { mode: 'none' },
          },
          steps,
        };
        if (plan.withDescription) bundle.description = 'A generated connector for property tests.';
        if (plan.withNeedsWrites) bundle.connection.needsWrites = true;
        if (tableName) {
          bundle.tables = [{ name: tableName, entries: { subscription: '4000', usage: 4010, credit: true } }];
        }
        // A sql connection with a `bearer` auth would point at a declared secret
        // that the `none` mode does not use; keep the declaration consistent.
        if (plan.family === 'sql') bundle.connection.secretFields = [{ name: plan.secretName, label: 'Password' }];
        return bundle;
      });
  });

// ─────────────────────────────────────────────────────────────────────────────
// Path enumeration, mirroring `secretPositionsOf`'s path construction
// ─────────────────────────────────────────────────────────────────────────────

/** Every string-valued position in a JSON document, as `path` plus a setter. */
function stringPositions(root: unknown): { path: string; set: (value: string) => void }[] {
  const positions: { path: string; set: (value: string) => void }[] = [];

  const walk = (node: unknown, path: string): void => {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach((entry, index) => {
        const childPath = `${path}[${index}]`;
        if (typeof entry === 'string') {
          positions.push({ path: childPath, set: (value) => void (node[index] = value) });
          return;
        }
        walk(entry, childPath);
      });
      return;
    }
    const record = node as Record<string, unknown>;
    for (const [property, entry] of Object.entries(record)) {
      const childPath = path.length === 0 ? property : `${path}.${property}`;
      if (typeof entry === 'string') {
        positions.push({ path: childPath, set: (value) => void (record[property] = value) });
        continue;
      }
      walk(entry, childPath);
    }
  };

  walk(root, '');
  return positions;
}

// ─────────────────────────────────────────────────────────────────────────────
// Claim 55: no packaged secret
// ─────────────────────────────────────────────────────────────────────────────

describe('Property 12, claim 55: a valid bundle carries no secret value', () => {
  it('generates valid bundles (generator sanity, so the claims below are not vacuous)', () => {
    fc.assert(
      fc.property(bundleArb, (bundle) => {
        const findings = validateConnectorBundle(bundle);
        expect(findings).toEqual([]);
      }),
      { numRuns: 300 },
    );
  });

  it('a valid bundle has no secret position', () => {
    fc.assert(
      fc.property(bundleArb, (bundle) => {
        fc.pre(isConnectorBundle(bundle));
        expect(secretPositionsOf(bundle)).toEqual([]);
      }),
      { numRuns: 300 },
    );
  });

  it('a credential injected at ANY string position is caught, at that position', () => {
    fc.assert(
      fc.property(bundleArb, fc.nat(), fc.constantFrom(...CREDENTIALS), (generated, pick, credential) => {
        // Clone before mutating: a property test must never write through to a
        // value the generator may reuse.
        const bundle = JSON.parse(JSON.stringify(generated)) as ConnectorBundle;
        const positions = stringPositions(bundle);
        expect(positions.length).toBeGreaterThan(0);
        const target = positions[pick % positions.length]!;
        target.set(credential);

        const leaks = secretPositionsOf(bundle);
        expect(leaks.map((leak) => leak.path)).toContain(target.path);
        expect(isConnectorBundle(bundle)).toBe(false);
        // The finding a user reads must name the position, not just the file.
        const reported = validateConnectorBundle(bundle).filter((finding) => finding.path === target.path);
        expect(reported.some((finding) => finding.severity === 'error')).toBe(true);
      }),
      { numRuns: 400 },
    );
  });

  it('a credential appended as an undeclared extra property is caught too', () => {
    fc.assert(
      fc.property(
        bundleArb,
        fc.constantFrom('token', 'clientSecret', 'apiKey', 'password'),
        fc.constantFrom(...CREDENTIALS),
        (generated, property, credential) => {
          const bundle = JSON.parse(JSON.stringify(generated)) as ConnectorBundle;
          const step = bundle.steps[0]!;
          (step.data as Record<string, unknown>)[property] = credential;
          expect(isConnectorBundle(bundle)).toBe(false);
          expect(secretPositionsOf(bundle).map((leak) => leak.path)).toContain(`steps[0].data.${property}`);
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Claim 56: totality and determinism
// ─────────────────────────────────────────────────────────────────────────────

describe('Property 12, claim 56: validation is total and deterministic', () => {
  it('never throws for an arbitrary JSON value, and repeats itself exactly', () => {
    fc.assert(
      fc.property(jsonArb({ maxDepth: 4 }), (value) => {
        const first = validateConnectorBundle(value);
        const second = validateConnectorBundle(value);
        expect(second).toEqual(first);
        expect(secretPositionsOf(value)).toEqual(secretPositionsOf(value));
        expect(() => parseConnectorBundle(value)).not.toThrow();
        expect(() => parseConnectorBundle(JSON.stringify(value))).not.toThrow();
      }),
      { numRuns: 500 },
    );
  });

  it('reports an error for every value that is not an installable bundle', () => {
    fc.assert(
      fc.property(jsonArb({ maxDepth: 3 }), (value) => {
        fc.pre(!isConnectorBundle(value));
        expect(validateConnectorBundle(value).some((finding) => finding.severity === 'error')).toBe(true);
      }),
      { numRuns: 300 },
    );
  });

  it('leaves the input untouched (validation is pure)', () => {
    fc.assert(
      fc.property(bundleArb, (bundle) => {
        const before = JSON.stringify(bundle);
        validateConnectorBundle(bundle);
        secretPositionsOf(bundle);
        expect(JSON.stringify(bundle)).toBe(before);
      }),
      { numRuns: 200 },
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Claim 57: round-trip stability
// ─────────────────────────────────────────────────────────────────────────────

describe('Property 12, claim 57: serialize and parse round-trip', () => {
  it('parses back to a structurally equal bundle, and serialization is a fixed point', () => {
    fc.assert(
      fc.property(bundleArb, (bundle) => {
        const text = serializeConnectorBundle(bundle);
        const result = parseConnectorBundle(text);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.bundle).toEqual(bundle);
        expect(serializeConnectorBundle(result.bundle)).toBe(text);
      }),
      { numRuns: 300 },
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Claim 58: installation grants no trust
// ─────────────────────────────────────────────────────────────────────────────

describe('Property 12, claim 58: installation grants no trust', () => {
  const seedArb = fc.record({
    id: fc.constantFrom('conn-a', 'conn-generated-1'),
    name: fc.option(fc.constantFrom('My connection'), { nil: undefined }),
    nowIso: fc.constant('2026-08-12T00:00:00.000Z'),
    config: fc.option(fc.dictionary(fc.constantFrom('baseUrl', 'tenantId', 'unexpected'), configValueArb), {
      nil: undefined,
    }),
  });

  it('never sets allowWrites, and declares exactly the named secrets', () => {
    fc.assert(
      fc.property(bundleArb, seedArb, (bundle, seed) => {
        const connection = buildConnectorConnection(bundle, seed);
        expect(connection.allowWrites).toBeUndefined();
        expect(connection.secretKeys).toEqual(connectorSecretKeyNames(bundle.connection));
        // Every secret the auth descriptor points at is declared, so no run-time
        // lookup can resolve to nothing.
        for (const name of authSecretKeyNames(connection.auth)) {
          expect(connection.secretKeys).toContain(name);
        }
      }),
      { numRuns: 300 },
    );
  });

  it('carries only config keys the template declares', () => {
    fc.assert(
      fc.property(bundleArb, seedArb, (bundle, seed) => {
        const declared = bundle.connection.configFields.map((field) => field.name);
        for (const key of Object.keys(buildConnectorConnection(bundle, seed).config)) {
          expect(declared).toContain(key);
        }
      }),
      { numRuns: 300 },
    );
  });

  it('produces step node data that shares no structure with the bundle', () => {
    fc.assert(
      fc.property(bundleArb, (bundle) => {
        const before = JSON.stringify(bundle);
        for (const step of bundle.steps) {
          const data = connectorStepNodeData(bundle, step, 'conn-a') as Record<string, unknown>;
          // Mutating the derived data must not reach the bundle.
          data['__probe'] = 'mutated';
          if (Array.isArray(data['fields'])) (data['fields'] as unknown[]).push('mutated');
          const lookups = data['lookups'] as Record<string, Record<string, unknown>> | undefined;
          if (lookups) for (const table of Object.values(lookups)) table['__probe'] = 'mutated';
        }
        expect(JSON.stringify(bundle)).toBe(before);
      }),
      { numRuns: 200 },
    );
  });

  it('binds a connection id on I/O steps only', () => {
    fc.assert(
      fc.property(bundleArb, (bundle) => {
        for (const step of bundle.steps) {
          const data = connectorStepNodeData(bundle, step, 'conn-a') as Record<string, unknown>;
          const bound = step.kind === 'http-request' || step.kind === 'sql-query';
          expect('connectionId' in data).toBe(bound);
        }
      }),
      { numRuns: 200 },
    );
  });
});
