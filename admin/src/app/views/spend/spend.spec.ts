import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import Aura from '@primeuix/themes/aura';
import { providePrimeNG } from 'primeng/config';

import type { BillingCostsResponse, BillingRevenueResponse } from '../../core/billing-models';
import { DateRangeService } from '../../core/date-range.service';
import type { DateRange } from '../../core/models';
import { SESSION_TOKEN_RESOLVER } from '../../core/telemetry-api.service';
import { coverageHealth, runwayHealth, Spend, usd } from './spend';

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function text(element: Element | null): string {
  return (element?.textContent ?? '').replace(/\s+/g, ' ').trim();
}

function costs(overrides: Partial<BillingCostsResponse> = {}): BillingCostsResponse {
  return {
    vendor: { configured: true, reachable: true, purchasedUsd: 250, spentUsd: 100, balanceUsd: 150 },
    burn: {
      windowDays: 30,
      meteredUsd: 30,
      perDayUsd: 1,
      runwayDays: 150,
      daily: Array.from({ length: 30 }, (_, i) => ({
        day: `2026-09-${String(i + 1).padStart(2, '0')}`,
        usd: i % 3,
      })),
    },
    committed: {
      activeTenants: 3,
      allowanceUsd: 52,
      grantPoolUsd: 1.5,
      ceilingUsd: 53.5,
      coverageRatio: 2.8,
      byTier: [
        { tier: 'team', tenants: 1, allowanceUsd: 44 },
        { tier: 'starter', tenants: 2, allowanceUsd: 8 },
      ],
    },
    attention: { entitledWithoutKey: 0, retiredHoldingKey: [] },
    degraded: [],
    generatedAt: '2026-09-24T00:00:00.000Z',
    ...overrides,
  };
}

function revenue(range: DateRange, overrides: Partial<BillingRevenueResponse> = {}): BillingRevenueResponse {
  return {
    range,
    configured: true,
    invoiced: { count: 4, grossUsd: 110, taxUsd: 10, netUsd: 100, otherCurrencyCount: 0, truncated: false },
    processing: { count: 4, feeUsd: 3.2, otherCurrencyCount: 0, truncated: false },
    margin: { netUsd: 100, vendorCostUsd: 30, processingFeeUsd: 3.2, marginUsd: 66.8, marginPct: 66.8 },
    degraded: [],
    generatedAt: '2026-09-24T00:00:00.000Z',
    ...overrides,
  };
}

interface Mounted {
  fixture: ComponentFixture<Spend>;
  host: HTMLElement;
  http: HttpTestingController;
  range: DateRange;
  previous: DateRange;
}

function mount(): Mounted {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      providePrimeNG({ theme: { preset: Aura } }),
      { provide: SESSION_TOKEN_RESOLVER, useValue: () => Promise.resolve('sess_token') },
    ],
  });
  const http = TestBed.inject(HttpTestingController);
  const dates = TestBed.inject(DateRangeService);
  const fixture = TestBed.createComponent(Spend);
  fixture.detectChanges();
  return { fixture, host: fixture.nativeElement, http, range: dates.range(), previous: dates.previousRange() };
}

async function flushAll(mounted: Mounted, answers: { costs?: object | 'fail'; revenue?: object | 'fail'; previous?: object | 'fail' }) {
  await settle();
  for (const request of mounted.http.match(() => true)) {
    const url = request.request.url;
    const from = request.request.params.get('from');
    const key = url.endsWith('/costs') ? 'costs' : from === mounted.previous.from ? 'previous' : 'revenue';
    const body = answers[key];
    if (body === undefined) continue;
    if (body === 'fail') request.flush({ error: 'Billing aggregate unavailable.' }, { status: 500, statusText: 'Error' });
    else request.flush(body);
  }
  for (let round = 0; round < 3; round += 1) {
    mounted.fixture.detectChanges();
    await settle();
  }
  mounted.fixture.detectChanges();
}

function figure(host: HTMLElement, key: string): string {
  return text(host.querySelector(`[data-figure="${key}"] .admin-figure__value`));
}

describe('Spend view', () => {
  it('renders exactly one state per half, and a revenue failure never blanks the balance', async () => {
    const mounted = mount();
    expect(mounted.host.querySelectorAll('[data-view-state]').length).toBe(1);
    await flushAll(mounted, { costs: costs(), revenue: 'fail', previous: 'fail' });

    const states = Array.from(mounted.host.querySelectorAll('[data-view-state]')).map((el) =>
      el.getAttribute('data-view-state'),
    );
    expect(states).toEqual(['loaded', 'failed']);
    expect(figure(mounted.host, 'balance')).toBe('$150.00');
    mounted.http.verify();
  });

  it('renders an unreadable balance as a dash, never as zero, and says why', async () => {
    const mounted = mount();
    await flushAll(mounted, {
      costs: costs({
        vendor: { configured: true, reachable: false, purchasedUsd: null, spentUsd: null, balanceUsd: null },
        burn: { windowDays: 30, meteredUsd: 30, perDayUsd: 1, runwayDays: null },
        committed: { ...costs().committed, coverageRatio: null },
        degraded: ['openrouter-balance'],
      }),
      revenue: revenue(mounted.range),
      previous: 'fail',
    });

    expect(figure(mounted.host, 'balance')).toBe('-');
    expect(figure(mounted.host, 'purchased')).toBe('-');
    expect(figure(mounted.host, 'coverage')).toBe('-');
    expect(mounted.host.querySelector('[data-status="vendor-unreachable"]')).not.toBeNull();
    // No daily series from an older Worker: the chart is simply absent.
    expect(mounted.host.querySelector('[data-burn-chart]')).toBeNull();
    mounted.http.verify();
  });

  it('draws the daily burn when the Worker sends it, and walks the margin waterfall', async () => {
    const mounted = mount();
    await flushAll(mounted, { costs: costs(), revenue: revenue(mounted.range), previous: revenue(mounted.previous, {
      invoiced: { count: 2, grossUsd: 55, taxUsd: 5, netUsd: 50, otherCurrencyCount: 0, truncated: false },
    }) });

    expect(mounted.host.querySelectorAll('[data-burn-chart] rect').length).toBe(30);
    const steps = Array.from(mounted.host.querySelectorAll('[data-step]')).map((el) => ({
      step: el.getAttribute('data-step'),
      value: text(el.querySelector('.admin-fall__value')),
    }));
    expect(steps).toEqual([
      { step: 'gross', value: '$110.00' },
      { step: 'tax', value: '-$10.00' },
      { step: 'net', value: '$100.00' },
      { step: 'model', value: '-$30.00' },
      { step: 'processing', value: '-$3.20' },
      { step: 'margin', value: '$66.80' },
    ]);
    // Net doubled against the previous period.
    expect(text(mounted.host.querySelector('[data-figure="net"] [data-delta]'))).toBe('+100%');
    expect(mounted.host.querySelector('[data-status="healthy"]')).not.toBeNull();
    mounted.http.verify();
  });

  it('raises a pulsing alert for tenants holding no runtime key', async () => {
    const mounted = mount();
    await flushAll(mounted, {
      costs: costs({ attention: { entitledWithoutKey: 2, retiredHoldingKey: [{ id: 't_gone', tier: 'pro', status: 'canceled' }] } }),
      revenue: revenue(mounted.range),
      previous: 'fail',
    });
    const alert = mounted.host.querySelector('[data-status="no-key"]');
    expect(text(alert)).toContain('2 active tenant(s) hold no runtime key');
    expect(alert?.classList.contains('admin-chip--bad')).toBe(true);
    expect(mounted.host.querySelector('[data-status="retired-key"]')).not.toBeNull();
    expect(mounted.host.querySelector('[data-status="healthy"]')).toBeNull();
    mounted.http.verify();
  });
});

describe('Spend thresholds and formatting', () => {
  it('grades runway and coverage at the documented thresholds', () => {
    expect(runwayHealth(null)).toBe('unknown');
    expect(runwayHealth(7)).toBe('bad');
    expect(runwayHealth(8)).toBe('warn');
    expect(runwayHealth(14)).toBe('warn');
    expect(runwayHealth(15)).toBe('good');
    expect(coverageHealth(null)).toBe('unknown');
    expect(coverageHealth(0.99)).toBe('bad');
    expect(coverageHealth(1)).toBe('warn');
    expect(coverageHealth(1.25)).toBe('good');
  });

  it('keeps sub-cent spend visible and renders a null as a dash', () => {
    expect(usd(null)).toBe('-');
    expect(usd(undefined)).toBe('-');
    expect(usd(0)).toBe('$0.00');
    expect(usd(0.0004)).toBe('$0.0004');
    expect(usd(-3.2)).toBe('-$3.20');
    expect(usd(1234.5)).toBe('$1,234.50');
  });
});
