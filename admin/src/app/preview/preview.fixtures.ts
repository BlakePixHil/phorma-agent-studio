import {
  HttpBackend,
  HttpErrorResponse,
  HttpResponse,
  type HttpEvent,
  type HttpRequest,
} from '@angular/common/http';
import { Injectable, type EnvironmentProviders, type Provider } from '@angular/core';
import { ClerkService } from 'ngx-clerk';
import { BehaviorSubject, Observable, delay, of, throwError } from 'rxjs';

import { SESSION_TOKEN_RESOLVER } from '../core/admin-api';
import type { DateRange, GroupRow, TrendDay } from '../core/models';

/**
 * The dev-only fixture preview: a signed-in session and a backend that answers
 * every admin route with deterministic, range-aware fixture data, so the
 * dashboard can be pixel-checked with no Clerk sign-in and no Worker. Swapped in
 * by the `preview` configuration only; see `preview.ts`.
 *
 * `?preview=empty`, `?preview=fail` and `?preview=degraded` on the URL exercise
 * the other states.
 */

const DAY = 86_400_000;

function days(range: DateRange): string[] {
  const out: string[] = [];
  for (let at = Date.parse(`${range.from}T00:00:00Z`); at <= Date.parse(`${range.to}T00:00:00Z`); at += DAY) {
    out.push(new Date(at).toISOString().slice(0, 10));
  }
  return out;
}

/** Deterministic 0..1 noise per string key. */
function noise(key: string): number {
  let h = 2166136261;
  for (const c of key) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return ((h >>> 0) % 10_000) / 10_000;
}

/** Growth over calendar time, so a previous period reads lower. */
function growth(day: string): number {
  return 1 + (Date.parse(`${day}T00:00:00Z`) - Date.parse('2026-01-01T00:00:00Z')) / (DAY * 240);
}

function trendDays(range: DateRange): TrendDay[] {
  return days(range).map((day) => {
    const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
    const weekend = weekday === 0 || weekday === 6 ? 0.55 : 1;
    const base = 38 * growth(day) * weekend * (0.8 + noise(day) * 0.45);
    const installs = Math.round(base);
    const sessions = Math.round(base * (2.6 + noise(`s${day}`)));
    const runs = Math.round(base * (5.2 + noise(`r${day}`) * 3));
    return { label: day, installs, sessions, runs };
  });
}

function scale(range: DateRange): number {
  const trend = trendDays(range);
  return trend.reduce((s, d) => s + d.installs, 0) / Math.max(1, trend.length);
}

function summary(range: DateRange) {
  const trend = trendDays(range);
  const installs = Math.round(scale(range) * 4.1);
  const sessions = trend.reduce((s, d) => s + d.sessions, 0);
  const runs = trend.reduce((s, d) => s + d.runs, 0);
  const failRate = 0.07 + noise(range.from) * 0.05;
  return {
    range,
    activeInstalls: { d1: 41, d7: 118, d30: 212 },
    totals: {
      installs,
      sessions,
      runs,
      runsCompleted: Math.round(runs * (1 - failRate)),
      runErrors: Math.round(runs * failRate * 0.6),
    },
  };
}

const COUNTRIES: [string, number][] = [
  ['US', 64], ['DE', 29], ['GB', 24], ['IN', 21], ['AU', 17], ['CA', 14], ['FR', 12], ['BR', 10],
  ['JP', 9], ['NL', 8], ['SE', 7], ['ES', 6], ['PL', 6], ['SG', 5], ['NZ', 5],
];
const REGIONS: [string, number][] = [
  ['north-america', 78], ['europe', 92], ['asia', 35], ['oceania', 22], ['south-america', 10], ['unknown', 4],
];

function geography(range: DateRange) {
  const f = scale(range) / 40;
  const row = ([label, n]: [string, number]): GroupRow => {
    const installs = Math.round(n * f);
    return { label, installs, runs: Math.round(installs * (18 + noise(label) * 30)) };
  };
  return {
    range,
    countries: [...COUNTRIES.map(row), { label: 'other', installs: Math.round(13 * f), runs: Math.round(190 * f) }],
    regions: REGIONS.map(row),
  };
}

function environment(range: DateRange) {
  const f = scale(range) / 40;
  const rows = (pairs: [string, number][]): GroupRow[] =>
    pairs.map(([label, n]) => ({ label, installs: Math.max(1, Math.round(n * f)) }));
  return {
    range,
    appVersion: rows([
      ['1.0.0-beta.5', 96], ['1.0.0-beta.4', 58], ['1.0.0-beta.3', 27], ['0.2.0-beta.18', 14], ['0.2.0-beta.12', 6], ['other', 7],
    ]),
    platform: rows([['windows', 118], ['macos', 71], ['linux', 17], ['other', 2]]),
    runtimeMode: rows([['desktop', 171], ['browser', 37]]),
    locale: rows([
      ['en-US', 102], ['en-GB', 28], ['de-DE', 22], ['en-AU', 14], ['fr-FR', 11], ['ja-JP', 8], ['pt-BR', 7], ['es-ES', 6], ['nl-NL', 5], ['other', 9],
    ]),
  };
}

const COUNTERS: [string, number, number][] = [
  ['session.started', 2400, 208], ['run.started', 5200, 171], ['run.completed', 4810, 168], ['run.error', 240, 61],
  ['node.created:agent', 1320, 154], ['node.created:http-tool', 610, 97], ['node.created:router', 402, 76],
  ['node.created:manual-trigger', 380, 140], ['node.created:schedule-trigger', 212, 58], ['node.created:mcp-tool', 196, 44],
  ['node.created:web-search-tool', 188, 63], ['node.created:transform', 150, 39], ['node.created:approval-gate', 72, 21],
  ['node.created:for-each', 64, 19], ['node.created:sql-query', 41, 12],
  ['panel.opened:workflows', 2100, 201], ['panel.opened:runs', 1650, 176], ['panel.opened:agents', 980, 150],
  ['panel.opened:prompt', 760, 131], ['panel.opened:connections', 420, 88], ['panel.opened:usage', 310, 74],
  ['panel.opened:evals', 190, 37], ['panel.opened:portal', 88, 22],
  ['assistant.invoked:ask', 890, 122], ['assistant.invoked:agent', 540, 81], ['assistant.invoked:plan', 260, 49],
  ['deploy.started:phorma', 310, 66], ['deploy.started:cloudflare', 92, 18], ['deploy.started:aws', 21, 6],
  ['error:model-call', 96, 41], ['error:tool-call', 71, 33], ['error:network', 38, 20], ['error:mcp', 22, 11],
  ['error:validation', 18, 9], ['error:deploy', 7, 5],
];

function features(range: DateRange) {
  const f = scale(range) / 40;
  return {
    range,
    counters: COUNTERS.map(([label, total, installs]) => ({
      label,
      total: Math.round(total * f * (label.startsWith('run.') ? 1 : 0.9 + noise(label + range.from) * 0.2)),
      installs: Math.round(installs * Math.min(1.1, f)),
    })),
  };
}

function trend(range: DateRange) {
  const all = trendDays(range);
  // Two quiet days fold into `other` below the reporting floor.
  const folded = all.filter((_, i) => i === 3 || i === 11);
  const kept = all.filter((_, i) => i !== 3 && i !== 11);
  const other = folded.reduce(
    (acc, d) => ({ label: 'other', installs: acc.installs + 2, sessions: acc.sessions + 5, runs: acc.runs + 9 }),
    { label: 'other', installs: 0, sessions: 0, runs: 0 },
  );
  return { range, days: folded.length > 0 ? [...kept, other] : kept, foldedDays: folded.length };
}

function costs(mode: string) {
  const today = new Date();
  const daily = Array.from({ length: 31 }, (_, i) => {
    const day = new Date(today.getTime() - (30 - i) * DAY).toISOString().slice(0, 10);
    return { day, usd: Number((1.4 + noise(day) * 2.6 * (0.7 + i / 45)).toFixed(4)) };
  });
  const metered = daily.reduce((s, d) => s + d.usd, 0);
  const degraded = mode === 'degraded';
  const balance = degraded ? null : 86.42;
  const perDay = Number((metered / 30).toFixed(4));
  return {
    vendor: {
      configured: true,
      reachable: !degraded,
      purchasedUsd: degraded ? null : 400,
      spentUsd: degraded ? null : 313.58,
      balanceUsd: balance,
    },
    burn: {
      windowDays: 30,
      meteredUsd: Number(metered.toFixed(4)),
      perDayUsd: perDay,
      runwayDays: balance === null ? null : Math.round(balance / perDay),
      daily,
    },
    committed: {
      activeTenants: 9,
      allowanceUsd: 101.2,
      grantPoolUsd: 6.5,
      ceilingUsd: 107.7,
      coverageRatio: balance === null ? null : Number((balance / 107.7).toFixed(4)),
      byTier: [
        { tier: 'team', tenants: 1, allowanceUsd: 44 },
        { tier: 'pro', tenants: 3, allowanceUsd: 37.8 },
        { tier: 'starter', tenants: 5, allowanceUsd: 20 },
      ],
    },
    attention: {
      entitledWithoutKey: degraded ? 1 : 0,
      retiredHoldingKey: [
        { id: 'org_3G7aQpLk2m', tier: 'pro', status: 'canceled' },
        { id: 'user_3F1xVb8sTq', tier: 'starter', status: 'past_due' },
      ],
    },
    degraded: degraded ? ['openrouter-balance'] : [],
    generatedAt: today.toISOString(),
  };
}

function revenue(range: DateRange) {
  const f = scale(range) / 40;
  const gross = Number((412 * f).toFixed(2));
  const tax = Number((gross * 0.0909).toFixed(2));
  const net = Number((gross - tax).toFixed(2));
  const vendor = Number((74 * f).toFixed(2));
  const fee = Number((gross * 0.034 + 3.6).toFixed(2));
  const margin = Number((net - vendor - fee).toFixed(2));
  return {
    range,
    configured: true,
    invoiced: { count: Math.round(22 * f), grossUsd: gross, taxUsd: tax, netUsd: net, otherCurrencyCount: 0, truncated: false },
    processing: { count: Math.round(22 * f), feeUsd: fee, otherCurrencyCount: 0, truncated: false },
    margin: {
      netUsd: net,
      vendorCostUsd: vendor,
      processingFeeUsd: fee,
      marginUsd: margin,
      marginPct: Number(((margin / net) * 100).toFixed(1)),
    },
    degraded: [],
    generatedAt: new Date().toISOString(),
  };
}

const ORGS = {
  organisations: [
    { id: 'org_3G7aQpLk2mAcme', name: 'Acme Accounting', slug: 'acme', tier: 'pro', status: 'active', members: 4 },
    { id: 'org_3G9bNorthwind', name: 'Northwind Legal', slug: 'northwind', tier: 'team', status: 'active', members: 11 },
    { id: 'org_3H1cHalfMade', name: null, slug: null, tier: 'none', status: 'unprovisioned', members: 0 },
    { id: 'org_3H4dGlobex', name: 'Globex Research', slug: 'globex', tier: 'starter', status: 'past_due', members: 2 },
  ],
  levels: ['operator', 'editor', 'builder', 'admin'],
  tiers: ['none', 'starter', 'pro', 'team'],
  degraded: [],
};

const MEMBERS = (orgId: string) => ({
  orgId,
  members: [
    { userId: 'user_3F1xVb8sTqAlice', level: 'admin', invitedBy: null, createdAt: '2026-08-01T00:00:00Z', updatedAt: '2026-08-01T00:00:00Z' },
    { userId: 'user_3F2yWc9tUrBob', level: 'builder', invitedBy: null, createdAt: '2026-08-03T00:00:00Z', updatedAt: '2026-08-03T00:00:00Z' },
    { userId: 'user_3F3zXd0uVsCarol', level: 'operator', invitedBy: null, createdAt: '2026-08-09T00:00:00Z', updatedAt: '2026-08-09T00:00:00Z' },
  ],
  levels: ORGS.levels,
});

const AUDIT = {
  entries: Array.from({ length: 7 }, (_, i) => ({
    id: 100 - i,
    actingUserId: i % 3 === 0 ? 'user_3F1xVb8sTqAlice' : 'user_3E9opsBlake',
    ownerId: ['org_3G7aQpLk2mAcme', 'org_3G9bNorthwind', 'user_3F2yWc9tUrBob'][i % 3],
    method: 'GET',
    path: i % 2 === 0 ? '/api/deployments' : '/api/deployments/wf-msil6paq/runs',
    at: new Date(Date.now() - i * 5.5 * 3_600_000).toISOString(),
  })),
  owner: null,
  limit: 100,
  truncated: true,
  generatedAt: new Date().toISOString(),
};

const DEPLOYMENTS = {
  month: new Date().toISOString().slice(0, 7),
  deployments: [
    { workflowId: 'wf-msil6paq', workflowName: 'Invoice chaser', updatedAt: '2026-09-20T09:12:00Z', cronArmed: true, portalSlug: null, creditsSpent: 1840, runsThisMonth: 212 },
    { workflowId: 'wf-k2p9zzqa', workflowName: 'Contract triage', updatedAt: '2026-09-18T14:40:00Z', cronArmed: false, portalSlug: 'triage', creditsSpent: 620, runsThisMonth: 48 },
    { workflowId: 'wf-quiet001', workflowName: 'Quiet workflow', updatedAt: '2026-08-02T08:00:00Z', cronArmed: false, portalSlug: null, creditsSpent: null, runsThisMonth: null },
  ],
};

@Injectable()
class FixtureBackend implements HttpBackend {
  handle(request: HttpRequest<unknown>): Observable<HttpEvent<unknown>> {
    const mode = new URLSearchParams(location.search).get('preview') ?? '';
    const url = new URL(request.urlWithParams);
    const route = url.pathname.split('/').filter(Boolean).pop() ?? '';
    const range: DateRange = {
      from: url.searchParams.get('from') ?? '',
      to: url.searchParams.get('to') ?? '',
    };
    const wait = 250 + Math.round(noise(request.urlWithParams) * 400);

    if (mode === 'fail') {
      return throwError(
        () => new HttpErrorResponse({ status: 500, error: { error: 'Telemetry store unavailable.' }, url: request.url }),
      ).pipe(delay(wait));
    }
    const empty = mode === 'empty';
    let body: unknown;
    if (url.pathname.includes('/telemetry/')) {
      const handlers: Record<string, () => unknown> = {
        summary: () => (empty ? { ...summary(range), activeInstalls: { d1: 0, d7: 0, d30: 0 }, totals: { installs: 0, sessions: 0, runs: 0, runsCompleted: 0, runErrors: 0 } } : summary(range)),
        geography: () => (empty ? { range, countries: [], regions: [] } : geography(range)),
        environment: () => (empty ? { range, appVersion: [], platform: [], runtimeMode: [], locale: [] } : environment(range)),
        features: () => (empty ? { range, counters: [] } : features(range)),
        trend: () => (empty ? { range, days: [], foldedDays: 0 } : trend(range)),
      };
      body = handlers[route]?.();
    } else if (url.pathname.includes('/billing/')) {
      body = route === 'costs' ? costs(mode) : revenue(range);
    } else if (url.pathname.includes('/organisations/')) {
      body = route === 'members' ? MEMBERS(url.searchParams.get('orgId') ?? '') : ORGS;
    } else if (url.pathname.endsWith('/impersonation')) {
      body = empty ? { ...AUDIT, entries: [], truncated: false } : AUDIT;
    } else if (url.pathname.endsWith('/deployments')) {
      body = DEPLOYMENTS;
    }
    if (body === undefined) {
      return throwError(() => new HttpErrorResponse({ status: 404, error: { error: 'Not found.' }, url: request.url }));
    }
    return of(new HttpResponse({ status: 200, body, url: request.url })).pipe(delay(wait));
  }
}

function fakeClerk(): ClerkService {
  const noop = () => undefined;
  const instance = { signOut: () => Promise.resolve(), mountUserButton: noop, unmountUserButton: noop, mountSignIn: noop, unmountSignIn: noop };
  return {
    __init: noop,
    clerk$: new BehaviorSubject(instance),
    session$: new BehaviorSubject({ id: 'sess_preview' }),
  } as unknown as ClerkService;
}

export const PREVIEW_PROVIDERS: (Provider | EnvironmentProviders)[] = [
  { provide: HttpBackend, useClass: FixtureBackend },
  { provide: ClerkService, useFactory: fakeClerk },
  { provide: SESSION_TOKEN_RESOLVER, useValue: () => Promise.resolve('sess_preview') },
];
