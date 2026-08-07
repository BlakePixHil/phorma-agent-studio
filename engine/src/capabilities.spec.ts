import { describe, expect, it } from 'vitest';
import {
  ALL_NODE_KINDS,
  BROWSER_CAPABILITIES,
  CLOUDFLARE_CAPABILITIES,
  HOST_CAPABILITIES,
  TAURI_DESKTOP_CAPABILITIES,
} from './capabilities.js';
import type { HostCapabilities } from './data-host.js';
import { DATA_NODE_KINDS } from './types.js';

/**
 * Host capability declarations (Requirements 17.1, 17.2, 17.3).
 *
 * These records are the single source of truth for what each host can run, so
 * the shape of every record and the deliberate omissions (browser SQL, worker
 * MSSQL) are worth pinning: a silent widening here is a run that fails at 3am.
 */

const FEATURE_FLAGS = [
  'cron',
  'durableState',
  'fixtures',
  'privateNetworkEgress',
  'stdioMcp',
  'mcpOAuth',
] as const;

const RECORDS: ReadonlyArray<readonly [string, HostCapabilities]> = [
  ['desktop', TAURI_DESKTOP_CAPABILITIES],
  ['browser', BROWSER_CAPABILITIES],
  ['worker', CLOUDFLARE_CAPABILITIES],
];

describe('host capability records', () => {
  it('declares exactly one record per host with distinct ids', () => {
    expect(Object.keys(HOST_CAPABILITIES).sort()).toEqual([
      'browser',
      'cloudflare-worker',
      'tauri-desktop',
    ]);
    expect(new Set(RECORDS.map(([, record]) => record.id)).size).toBe(3);
  });

  it.each(RECORDS)('%s declares an id, a label and all six feature flags', (_name, record) => {
    expect(record.id.length).toBeGreaterThan(0);
    expect(record.label.length).toBeGreaterThan(0);
    expect(Object.keys(record.features).sort()).toEqual([...FEATURE_FLAGS].sort());
    for (const flag of FEATURE_FLAGS) {
      expect(typeof record.features[flag]).toBe('boolean');
    }
  });

  it.each(RECORDS)('%s declares only known node kinds', (_name, record) => {
    for (const kind of record.nodeKinds) {
      expect(ALL_NODE_KINDS as readonly string[]).toContain(kind);
    }
  });

  it('gives the desktop host every node kind, every driver and every connection type', () => {
    expect([...TAURI_DESKTOP_CAPABILITIES.nodeKinds]).toEqual([...ALL_NODE_KINDS]);
    expect([...TAURI_DESKTOP_CAPABILITIES.sqlDrivers].sort()).toEqual([
      'mssql',
      'mysql',
      'postgres',
      'sqlite',
    ]);
    expect([...TAURI_DESKTOP_CAPABILITIES.connectionTypes].sort()).toEqual([
      'aws-sigv4',
      'http',
      'oauth2',
      'smtp',
      'sql',
    ]);
  });

  it('excludes only sql-query from the browser host and gives it no credentials', () => {
    expect(BROWSER_CAPABILITIES.nodeKinds).not.toContain('sql-query');
    expect([...BROWSER_CAPABILITIES.nodeKinds]).toEqual(
      ALL_NODE_KINDS.filter((kind) => kind !== 'sql-query'),
    );
    expect(BROWSER_CAPABILITIES.sqlDrivers).toEqual([]);
    expect(BROWSER_CAPABILITIES.connectionTypes).toEqual([]);
    // Every other data node still runs in preview.
    for (const kind of DATA_NODE_KINDS.filter((k) => k !== 'sql-query')) {
      expect(BROWSER_CAPABILITIES.nodeKinds).toContain(kind);
    }
  });

  it('declares exactly postgres and mysql for the worker, and mssql for the desktop only', () => {
    expect([...CLOUDFLARE_CAPABILITIES.sqlDrivers]).toEqual(['postgres', 'mysql']);
    expect([...CLOUDFLARE_CAPABILITIES.nodeKinds]).toEqual([...ALL_NODE_KINDS]);
    const withMssql = RECORDS.filter(([, record]) => record.sqlDrivers.includes('mssql'));
    expect(withMssql.map(([name]) => name)).toEqual(['desktop']);
  });

  it('makes cron a worker-only feature', () => {
    expect(CLOUDFLARE_CAPABILITIES.features.cron).toBe(true);
    expect(TAURI_DESKTOP_CAPABILITIES.features.cron).toBe(false);
    expect(BROWSER_CAPABILITIES.features.cron).toBe(false);
  });

  it('makes mcpOAuth false only on the worker - an OAuth session never leaves the device that signed in', () => {
    expect(TAURI_DESKTOP_CAPABILITIES.features.mcpOAuth).toBe(true);
    expect(BROWSER_CAPABILITIES.features.mcpOAuth).toBe(true);
    expect(CLOUDFLARE_CAPABILITIES.features.mcpOAuth).toBe(false);
  });
});
