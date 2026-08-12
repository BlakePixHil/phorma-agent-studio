/**
 * Connectors compiled into the app (P1-14).
 *
 * These are DERIVED at read time and never persisted, the same way
 * `prompt-library.model.ts` derives its built-in prompts from the node catalog:
 * a fix to a built-in bundle reaches every existing install through an app
 * update, with no migration and no stale copy in IndexedDB.
 *
 * Keep this file free of Angular imports - it is plain data, validated by the
 * same `validateConnectorBundle` a stranger's file goes through. A built-in that
 * fails validation is dropped with a console warning rather than shipped, and
 * `connectors-builtin.spec.ts` fails the build before that can happen.
 *
 * Adding a built-in connector is one entry here. Nothing else changes: the
 * Connectors panel section, the palette Data section and the assistant actions
 * all read the registry.
 */

import type { ConnectorBundle } from '@phorma/engine';

/**
 * A generic REST connector: bearer auth, cursor pagination, a mapping table and
 * a transform that uses it. Deliberately vendor-neutral - it is the "start here"
 * bundle for an API nobody has packaged yet, and it exercises every part of the
 * format (config fields, a secret, pagination, a table, two step kinds).
 */
const REST_API: ConnectorBundle = {
  format: 1,
  id: 'cx-rest-api',
  name: 'REST API (generic)',
  description:
    'A starting point for any bearer-authenticated JSON API: a paginated list step, ' +
    'a single-record fetch, and a transform wired to an editable mapping table.',
  version: '1.0.0',
  author: 'Phorma',
  icon: 'ti ti-api',
  connection: {
    type: 'http',
    configFields: [
      {
        name: 'baseUrl',
        label: 'API base URL',
        description: 'Everything before the path, for example https://api.example.com/v1',
        placeholder: 'https://api.example.com/v1',
        required: true,
      },
    ],
    secretFields: [
      {
        name: 'apiToken',
        label: 'API token',
        description: 'Sent as an Authorization: Bearer header. Stored in your OS keychain.',
      },
    ],
    auth: { mode: 'bearer', secretKey: 'apiToken' },
  },
  steps: [
    {
      id: 'list-records',
      label: 'List records (paginated)',
      description:
        'Cursor pagination over a collection endpoint. Set the path, the items path and the ' +
        'cursor field to match your API.',
      icon: 'ti ti-list-details',
      keywords: ['list', 'collection', 'page', 'cursor', 'rest'],
      kind: 'http-request',
      data: {
        method: 'GET',
        url: '/records',
        responseMode: 'json',
        bodyMode: 'none',
        resultKey: 'records',
        pagination: {
          mode: 'cursor',
          cursorPath: 'next_cursor',
          cursorParam: 'cursor',
          itemsPath: 'data',
          maxPages: 20,
        },
        retry: { maxAttempts: 3, backoffMs: 1000, idempotent: true, honorRetryAfter: true },
        fixtures: 'off',
      },
    },
    {
      id: 'get-record',
      label: 'Get one record',
      description: 'Fetches a single record by id from the incoming payload.',
      icon: 'ti ti-file-search',
      keywords: ['get', 'fetch', 'record', 'rest'],
      kind: 'http-request',
      data: {
        // Templates resolve a DOTTED PATH into the incoming payload: `{{id}}` is
        // the payload's `id`. (`{{input}}` alone is the whole payload; there is
        // no `input.` prefix form - `{{input.id}}` would look for a field called
        // `input`.)
        method: 'GET',
        url: '/records/{{id}}',
        responseMode: 'json',
        bodyMode: 'none',
        resultKey: 'record',
        pagination: { mode: 'none' },
        retry: { maxAttempts: 3, backoffMs: 1000, idempotent: true, honorRetryAfter: true },
        fixtures: 'off',
      },
    },
    {
      id: 'map-record',
      label: 'Map record to your fields',
      description:
        'Renames and casts the API response into your own vocabulary, translating the status ' +
        'field through the bundled mapping table.',
      icon: 'ti ti-transform',
      keywords: ['map', 'rename', 'cast', 'lookup'],
      kind: 'transform',
      tables: ['statusMap'],
      // Expression grammar: `item` is the record being mapped, `$` is the whole
      // payload, and a bare `name` is shorthand for `$.name`. There is no
      // `input` keyword, so `input.id` would silently read `$.input.id`.
      data: {
        mode: 'record',
        passthrough: false,
        fields: [
          { target: 'id', expression: 'item.id', cast: 'string', required: true },
          { target: 'amount', expression: 'item.amount', cast: 'number', default: 0 },
          { target: 'status', expression: "lookup('statusMap', item.status)", cast: 'string' },
          { target: 'occurredAt', expression: 'item.created_at', cast: 'date-iso' },
        ],
      },
    },
  ],
  tables: [
    {
      name: 'statusMap',
      description: 'Vendor status vocabulary mapped to yours. Edit to match your API.',
      entries: {
        active: 'Active',
        pending: 'Pending',
        paid: 'Settled',
        cancelled: 'Cancelled',
        failed: 'Failed',
      },
    },
  ],
};

/**
 * A read-only SQL reporting connector. Present because a SQL bundle proves a
 * different half of the format: no auth secret in the connection descriptor
 * (the password is a declared secret field, applied by the driver rather than by
 * an auth mode), and SQL guard rails travelling with the connection.
 */
const SQL_REPORTING: ConnectorBundle = {
  format: 1,
  id: 'cx-sql-reporting',
  name: 'SQL reporting database',
  description:
    'Read-only reporting queries against Postgres or MySQL, with row and timeout guard rails ' +
    'set on the connection.',
  version: '1.0.0',
  author: 'Phorma',
  icon: 'ti ti-database-search',
  connection: {
    type: 'sql',
    configFields: [
      { name: 'driver', label: 'Driver', placeholder: 'postgres', required: true, default: 'postgres' },
      { name: 'host', label: 'Host', placeholder: 'db.internal.example', required: true },
      { name: 'port', label: 'Port', placeholder: '5432', default: '5432' },
      { name: 'database', label: 'Database', placeholder: 'reporting', required: true },
      { name: 'user', label: 'User', placeholder: 'reporting_ro', required: true },
    ],
    secretFields: [
      {
        name: 'password',
        label: 'Password',
        description: 'Stored in your OS keychain. Use a read-only database role.',
      },
    ],
    auth: { mode: 'none' },
    limits: { statementTimeoutMs: 30_000, maxRows: 10_000 },
  },
  steps: [
    {
      id: 'period-totals',
      label: 'Totals for a period',
      description:
        'Parameterised aggregate over a period. Named parameters only - the payload never ' +
        'reaches the SQL text.',
      icon: 'ti ti-sum',
      keywords: ['sql', 'total', 'period', 'report'],
      kind: 'sql-query',
      data: {
        statement:
          'select account, sum(amount) as total\n' +
          '  from ledger\n' +
          ' where period = :period\n' +
          ' group by account\n' +
          ' order by account',
        // `period` is shorthand for `$.period`: the payload's `period` field.
        params: [{ name: 'period', expression: 'period' }],
        maxRows: 10_000,
        resultKey: 'rows',
        fixtures: 'off',
      },
    },
    {
      id: 'roll-up',
      label: 'Roll up by account',
      description: 'Groups the returned rows and sums them, ready for a report or a sync.',
      icon: 'ti ti-chart-bar',
      keywords: ['group', 'sum', 'roll up'],
      kind: 'aggregate',
      data: {
        op: 'group',
        itemsPath: 'rows',
        group: {
          by: ['account'],
          metrics: [
            { name: 'total', fn: 'sum', path: 'total' },
            { name: 'entries', fn: 'count' },
          ],
        },
        resultKey: 'summary',
      },
    },
  ],
};

/** Every connector shipped with the app. Adding one is a single entry. */
export const BUILTIN_CONNECTOR_BUNDLES: readonly ConnectorBundle[] = [REST_API, SQL_REPORTING];
