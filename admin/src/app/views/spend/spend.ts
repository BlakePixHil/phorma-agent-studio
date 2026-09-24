import { ChangeDetectionStrategy, Component, computed, inject, resource, signal } from '@angular/core';

import { BillingApiService } from '../../core/billing-api.service';
import {
  DEGRADED_METERED_COST,
  DEGRADED_VENDOR_BALANCE,
  type BillingCostsResponse,
  type BillingRevenueResponse,
} from '../../core/billing-models';
import { DateRangeService, shiftMetricDay, todayUtc } from '../../core/date-range.service';
import { loadedValue, viewStateOf } from '../../core/view-state';
import { deltaOf, type DeltaReading } from '../charts/chart-math';
import { AdminColumnChart, type Column } from '../charts/column-chart';
import { AdminMeter } from '../charts/meter';
import { AdminRing } from '../charts/ring';
import { AdminStackBar, type StackPart } from '../charts/stack-bar';
import { categorical, hashTone, type Tone } from '../charts/tones';
import { AdminWaterfall, type WaterfallStep } from '../charts/waterfall';
import { formatRange, longDay, whole } from '../format';
import { AdminDelta } from '../kit/delta';
import { AdminHint } from '../kit/hint';
import { enriched, enrichment } from '../secondary';
import { unwrapAdminResult } from '../view-data';
import { ViewStateRail } from '../view-state-rail';

/** Runway thresholds, in days. Below `warn` is worth acting on. */
export const RUNWAY_WARN_DAYS = 14;
export const RUNWAY_CRITICAL_DAYS = 7;

/** The ring is full at this many days, so a healthy runway reads as nearly full. */
const RUNWAY_RING_DAYS = 90;

export type Health = 'good' | 'warn' | 'bad' | 'unknown';

/** One status chip at the top of the page. */
export interface SpendStatus {
  readonly key: string;
  readonly tone: 'good' | 'warn' | 'bad' | 'muted';
  readonly icon: string;
  readonly text: string;
  readonly hint: string | null;
}

/** Runway health: critical at or below 7 days, warning at or below 14. */
export function runwayHealth(days: number | null): Health {
  if (days === null) return 'unknown';
  if (days <= RUNWAY_CRITICAL_DAYS) return 'bad';
  if (days <= RUNWAY_WARN_DAYS) return 'warn';
  return 'good';
}

/** Coverage health: below 1 means a full-spend month would run the account dry. */
export function coverageHealth(ratio: number | null): Health {
  if (ratio === null) return 'unknown';
  if (ratio < 1) return 'bad';
  if (ratio < 1.25) return 'warn';
  return 'good';
}

/**
 * A USD figure, or a dash for a null. Sub-cent figures keep four digits: one
 * agent turn can cost $0.0004, and cents would report real spend as zero.
 */
export function usd(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '-';
  const fractionDigits = value !== 0 && Math.abs(value) < 0.01 ? 4 : 2;
  const sign = value < 0 ? '-' : '';
  return `${sign}$${Math.abs(value).toLocaleString('en', {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  })}`;
}

const HEALTH_TONE: Readonly<Record<Health, Tone>> = {
  good: 'good',
  warn: 'warn',
  bad: 'bad',
  unknown: 'muted',
};

/**
 * Spend: what the OpenRouter account holds, how fast it drains, what active
 * tenants have been promised, and the margin measured against Stripe.
 *
 * Costs and revenue are two resources so a Stripe outage degrades one card and
 * never blanks the balance. The range applies to revenue only; runway is a
 * property of the account now. A null figure renders as a dash, never a zero.
 */
@Component({
  selector: 'admin-spend',
  imports: [
    AdminColumnChart,
    AdminDelta,
    AdminHint,
    AdminMeter,
    AdminRing,
    AdminStackBar,
    AdminWaterfall,
    ViewStateRail,
  ],
  template: `
    <section class="admin-view" aria-labelledby="admin-spend-title">
      <header class="admin-view__header">
        <h1 class="admin-view__title" id="admin-spend-title">
          <i class="ti ti-cash" aria-hidden="true"></i>
          <span>Spend</span>
        </h1>
        <p class="admin-view__range">{{ rangeLabel() }}</p>
        <admin-hint [text]="operatorHint" icon="ti-lock" />
      </header>

      @if (costs(); as data) {
        <div class="admin-view__body" data-view-state="loaded">
          <div class="admin-status" role="status">
            @for (item of statuses(); track item.key) {
              <span class="admin-chip admin-chip--{{ item.tone }}" [attr.data-status]="item.key" [class.admin-chip--pulse]="item.tone === 'bad'">
                <i class="ti {{ item.icon }}" aria-hidden="true"></i>
                <span>{{ item.text }}</span>
                @if (item.hint) {
                  <admin-hint [text]="item.hint" />
                }
              </span>
            }
          </div>

          <!-- Provider account -->
          <article class="admin-card admin-card--hero" aria-labelledby="admin-spend-vendor">
            <div class="admin-card__head">
              <h2 class="admin-card__title" id="admin-spend-vendor">
                <i class="ti ti-wallet" aria-hidden="true"></i>
                <span>Model provider account</span>
              </h2>
              <p class="admin-card__subtitle">Account-wide, measured now</p>
            </div>

            <div class="admin-spend__provider">
              <div class="admin-figure" data-figure="balance">
                <span class="admin-figure__label">Balance</span>
                <span class="admin-figure__value admin-figure__value--hero" [class.admin-figure__value--unknown]="data.vendor.balanceUsd === null">
                  {{ usd(data.vendor.balanceUsd) }}
                </span>
                <span class="admin-figure__note">{{ lifetimeNote() }}</span>
              </div>

              <div class="admin-ring-pair" data-figure="runway">
                <admin-ring
                  [value]="runwayRing()"
                  [tone]="runwayTone()"
                  [label]="runwayLabel()"
                  caption="runway"
                />
                <div class="admin-ring-pair__text">
                  <span class="admin-ring-pair__title">{{ runwayTitle() }}</span>
                  <span class="admin-ring-pair__note">{{ runwayNote() }}</span>
                </div>
              </div>

              <div class="admin-figures admin-spend__burn-figures">
                <div class="admin-figure" data-figure="burn">
                  <span class="admin-figure__label">Burn ({{ data.burn.windowDays }}d)</span>
                  <span class="admin-figure__value">{{ usd(data.burn.meteredUsd) }}</span>
                  <span class="admin-figure__note">{{ usd(data.burn.perDayUsd) }} a day, metered</span>
                </div>
                <div class="admin-figure" data-figure="purchased">
                  <span class="admin-figure__label">Purchased</span>
                  <span class="admin-figure__value" [class.admin-figure__value--unknown]="data.vendor.purchasedUsd === null">
                    {{ usd(data.vendor.purchasedUsd) }}
                  </span>
                  <span class="admin-figure__note">lifetime</span>
                </div>
              </div>
            </div>

            @if (burnColumns(); as columns) {
              <div class="admin-spend__chart" data-burn-chart>
                <p class="admin-figure__label">Daily burn, last {{ data.burn.windowDays }} days</p>
                <admin-column-chart
                  [data]="columns"
                  tone="amber"
                  [height]="170"
                  [reference]="data.burn.perDayUsd"
                  referenceLabel="avg {{ usd(data.burn.perDayUsd) }}"
                  [format]="usdAxis"
                />
              </div>
            }
          </article>

          <div class="admin-split admin-split--even admin-split--stretch">
            <!-- Commitments -->
            <article class="admin-card" aria-labelledby="admin-spend-committed">
              <div class="admin-card__head">
                <h2 class="admin-card__title" id="admin-spend-committed">
                  <i class="ti ti-shield-half" aria-hidden="true"></i>
                  <span>Committed to active tenants</span>
                </h2>
                <admin-hint [text]="ceilingHint" />
              </div>

              <div class="admin-figures">
                <div class="admin-figure" data-figure="coverage">
                  <span class="admin-figure__label">Coverage</span>
                  <span class="admin-figure__value admin-spend__tone--{{ coverageTone() }}" [class.admin-figure__value--unknown]="data.committed.coverageRatio === null">
                    {{ coverageLabel() }}
                  </span>
                  <span class="admin-figure__note">{{ coverageNote() }}</span>
                </div>
                <div class="admin-figure" data-figure="ceiling">
                  <span class="admin-figure__label">Ceiling</span>
                  <span class="admin-figure__value">{{ usd(data.committed.ceilingUsd) }}</span>
                  <span class="admin-figure__note">every live key limit</span>
                </div>
                <div class="admin-figure" data-figure="tenants">
                  <span class="admin-figure__label">Active tenants</span>
                  <span class="admin-figure__value">{{ whole(data.committed.activeTenants) }}</span>
                  <span class="admin-figure__note">{{ usd(data.committed.grantPoolUsd) }} unspent top-ups</span>
                </div>
              </div>

              <admin-meter
                [value]="data.vendor.balanceUsd"
                [target]="data.committed.ceilingUsd"
                [valueLabel]="'Balance ' + usd(data.vendor.balanceUsd)"
                [targetLabel]="'Ceiling ' + usd(data.committed.ceilingUsd)"
                [tone]="coverageTone()"
              />

              @if (tierParts().length > 0) {
                <hr class="admin-divider" />
                <p class="admin-figure__label">Monthly allowance by tier</p>
                <admin-stack-bar [data]="tierParts()" />
              }
            </article>

            <!-- Revenue -->
            <article class="admin-card" aria-labelledby="admin-spend-revenue">
              <div class="admin-card__head">
                <h2 class="admin-card__title" id="admin-spend-revenue">
                  <i class="ti ti-chart-bar" aria-hidden="true"></i>
                  <span>Revenue and margin</span>
                </h2>
                <p class="admin-card__subtitle">{{ rangeLabel() }}</p>
              </div>

              @if (revenue(); as money) {
                @if (money.configured) {
                  <div class="admin-figures">
                    <div class="admin-figure" data-figure="net">
                      <span class="admin-figure__label">Net revenue</span>
                      <span class="admin-figure__value" [class.admin-figure__value--unknown]="money.invoiced === null">
                        {{ usd(money.invoiced?.netUsd) }}
                      </span>
                      <admin-delta [reading]="netDelta()" [hint]="deltaHint()" />
                    </div>
                    <div class="admin-figure" data-figure="margin">
                      <span class="admin-figure__label">Margin</span>
                      <span class="admin-figure__value admin-spend__tone--{{ marginTone() }}" [class.admin-figure__value--unknown]="marginPct() === null">
                        {{ marginLabel() }}
                      </span>
                      <admin-delta [reading]="marginDelta()" mode="points" [hint]="deltaHint()" />
                    </div>
                    <div class="admin-figure" data-figure="invoices">
                      <span class="admin-figure__label">Invoices</span>
                      <span class="admin-figure__value">{{ money.invoiced ? whole(money.invoiced.count) : '-' }}</span>
                      <span class="admin-figure__note">{{ money.processing ? whole(money.processing.count) + ' transactions' : '' }}</span>
                    </div>
                  </div>

                  @if (waterfall().length > 0) {
                    <admin-waterfall [data]="waterfall()" />
                  }

                  @if (revenueCaveat(); as caveat) {
                    <span class="admin-chip admin-chip--warn" role="status" data-revenue-caveat>
                      <i class="ti ti-alert-triangle" aria-hidden="true"></i>
                      <span>{{ caveat }}</span>
                    </span>
                  }
                } @else {
                  <p class="admin-empty-inline">
                    <i class="ti ti-plug-off" aria-hidden="true"></i>
                    <span>This deployment sells no plans, so there is no revenue to report.</span>
                  </p>
                }
              } @else {
                <admin-view-state
                  [state]="revenueState()"
                  [inline]="true"
                  emptyMessage="No invoices in this range."
                  (retry)="reloadRevenue()"
                />
              }
            </article>
          </div>

          @if (attentionRows().length > 0) {
            <article class="admin-card" aria-labelledby="admin-spend-attention">
              <div class="admin-card__head">
                <h2 class="admin-card__title" id="admin-spend-attention">
                  <i class="ti ti-key" aria-hidden="true"></i>
                  <span>Inactive tenants still holding a key hash</span>
                </h2>
                <admin-hint [text]="retiredHint" />
                <div class="admin-card__aside">
                  <button type="button" class="admin-link-button" (click)="showAttention.set(!showAttention())">
                    {{ showAttention() ? 'Hide' : 'Show ' + attentionRows().length }}
                  </button>
                </div>
              </div>
              @if (showAttention()) {
                <table class="admin-table">
                  <caption class="admin-table__caption">Inactive tenants still carrying a runtime key hash</caption>
                  <thead>
                    <tr>
                      <th scope="col">Tenant</th>
                      <th scope="col">Tier</th>
                      <th scope="col">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (row of attentionRows(); track row.id) {
                      <tr>
                        <th scope="row"><span class="admin-id">{{ row.id }}</span></th>
                        <td><span class="admin-badge" [style.--tone]="tierTone(row.tier)">{{ row.tier }}</span></td>
                        <td>{{ row.status }}</td>
                      </tr>
                    }
                  </tbody>
                </table>
              }
            </article>
          }
        </div>
      } @else {
        <admin-view-state [state]="costsState()" (retry)="reloadCosts()" />
      }
    </section>
  `,
  styles: `
    /* Layout specific to this page; the visual language is all in styles.scss. */
    .admin-spend__provider {
      display: grid;
      grid-template-columns: minmax(12rem, 1.1fr) minmax(14rem, 1fr) minmax(14rem, 1.2fr);
      gap: 1.429rem;
      align-items: center;
    }

    @media (max-width: 1100px) {
      .admin-spend__provider {
        grid-template-columns: minmax(0, 1fr);
      }
    }

    .admin-spend__chart {
      display: flex;
      flex-direction: column;
      gap: 0.429rem;
      padding-top: 0.571rem;
      border-top: 1px solid var(--admin-border);
    }

    .admin-spend__tone--good {
      color: rgb(var(--admin-tone-good));
    }

    .admin-spend__tone--warn {
      color: rgb(var(--admin-tone-warn));
    }

    .admin-spend__tone--bad {
      color: rgb(var(--admin-tone-bad));
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Spend {
  private readonly api = inject(BillingApiService);
  private readonly dates = inject(DateRangeService);

  /** The range applies to revenue only; runway is a property of the account now. */
  readonly range = this.dates.range;
  readonly rangeLabel = computed(() => formatRange(this.range()));
  readonly deltaHint = computed(() => `Against ${formatRange(this.dates.previousRange())}`);
  readonly showAttention = signal(false);

  readonly usd = usd;
  readonly whole = whole;
  readonly usdAxis = (value: number) => (value === 0 ? '$0' : value >= 1 ? `$${Math.round(value)}` : usd(value));

  readonly operatorHint =
    'Operator-only. These figures are never shown in the studio, which reports plan credits. Balance, runway and commitments are account-wide and ignore the date picker; revenue follows it.';
  readonly ceilingHint =
    'What active tenants may spend this month: tier allowances plus unspent top-ups, which is also the sum of their provider key limits. Coverage is the balance over that ceiling.';
  readonly retiredHint =
    'Expected after a cancellation: the key is disabled at the provider but the hash is kept. Spot-check these against the provider dashboard.';

  private readonly costsData = resource({
    params: () => this.range(),
    loader: ({ params }) => this.api.fetchCosts(params).then(unwrapAdminResult),
  });

  private readonly revenueData = resource({
    params: () => this.range(),
    loader: ({ params }) => this.api.fetchRevenue(params).then(unwrapAdminResult),
  });

  private readonly previousRevenueData = enrichment(
    () => this.dates.previousRange(),
    (range) => this.api.fetchRevenue(range),
  );

  /** No `isEmpty` on either half: a zero balance is an answer, not an empty state. */
  readonly costsState = computed(() =>
    viewStateOf<BillingCostsResponse>({
      loading: this.costsData.isLoading(),
      error: this.costsData.error(),
      value: this.costsData.hasValue() ? this.costsData.value() : undefined,
    }),
  );

  readonly revenueState = computed(() =>
    viewStateOf<BillingRevenueResponse>({
      loading: this.revenueData.isLoading(),
      error: this.revenueData.error(),
      value: this.revenueData.hasValue() ? this.revenueData.value() : undefined,
    }),
  );

  readonly costs = computed(() => loadedValue(this.costsState()));
  readonly revenue = computed(() => loadedValue(this.revenueState()));
  private readonly previousRevenue = computed(() => enriched(this.previousRevenueData));

  readonly attentionRows = computed(() => this.costs()?.attention.retiredHoldingKey ?? []);

  // --- Runway ---------------------------------------------------------------

  readonly runwayHealth = computed(() => runwayHealth(this.costs()?.burn.runwayDays ?? null));
  readonly runwayTone = computed(() => HEALTH_TONE[this.runwayHealth()]);
  readonly runwayRing = computed(() => {
    const days = this.costs()?.burn.runwayDays ?? null;
    return days === null ? null : Math.min(100, (days / RUNWAY_RING_DAYS) * 100);
  });
  readonly runwayLabel = computed(() => {
    const days = this.costs()?.burn.runwayDays ?? null;
    return days === null ? '-' : `${whole(days)}d`;
  });
  readonly runwayTitle = computed(() => {
    const days = this.costs()?.burn.runwayDays ?? null;
    if (days === null) return 'Runway unknown';
    return `Runs dry ${longDay(shiftMetricDay(todayUtc(), days))}`;
  });
  readonly runwayNote = computed(() => {
    const data = this.costs();
    if (!data || data.burn.runwayDays === null) return 'Needs a balance and recent spend';
    const health = this.runwayHealth();
    if (health === 'bad') return 'Top up now';
    if (health === 'warn') return 'Top up soon';
    return `At ${usd(data.burn.perDayUsd)} a day`;
  });

  readonly lifetimeNote = computed(() => {
    const vendor = this.costs()?.vendor;
    if (!vendor) return '';
    if (!vendor.configured) return 'No provider keys managed here';
    if (!vendor.reachable) return 'Could not be read';
    return `${usd(vendor.spentUsd)} spent of ${usd(vendor.purchasedUsd)} purchased`;
  });

  /** The daily burn series, or null when the Worker does not send one (or it is empty). */
  readonly burnColumns = computed<Column[] | null>(() => {
    const daily = this.costs()?.burn.daily;
    if (!daily || daily.length === 0) return null;
    return daily.map((day) => ({ label: day.day, value: day.usd }));
  });

  // --- Coverage -------------------------------------------------------------

  readonly coverageTone = computed(() => HEALTH_TONE[coverageHealth(this.costs()?.committed.coverageRatio ?? null)]);
  readonly coverageLabel = computed(() => {
    const ratio = this.costs()?.committed.coverageRatio ?? null;
    return ratio === null ? '-' : `${Math.round(ratio * 100)}%`;
  });
  readonly coverageNote = computed(() => {
    const ratio = this.costs()?.committed.coverageRatio ?? null;
    if (ratio === null) return 'Needs a provider balance';
    return ratio < 1 ? 'A full-spend month would run dry' : 'Balance covers every allowance';
  });

  readonly tierParts = computed<StackPart[]>(() =>
    (this.costs()?.committed.byTier ?? []).map((row, index) => ({
      key: row.tier,
      label: `${row.tier} (${whole(row.tenants)})`,
      value: row.allowanceUsd,
      tone: categorical(index),
      caption: usd(row.allowanceUsd),
    })),
  );

  tierTone(tier: string): string {
    return `var(--admin-tone-${hashTone(tier)})`;
  }

  // --- Revenue --------------------------------------------------------------

  readonly marginPct = computed(() => this.revenue()?.margin?.marginPct ?? null);
  readonly marginLabel = computed(() => {
    const pct = this.marginPct();
    return pct === null ? '-' : `${pct}%`;
  });
  readonly marginTone = computed(() => {
    const pct = this.marginPct();
    if (pct === null) return 'muted';
    return pct < 0 ? 'bad' : pct < 20 ? 'warn' : 'good';
  });

  readonly netDelta = computed<DeltaReading | null>(() =>
    deltaOf(this.revenue()?.invoiced?.netUsd ?? null, this.previousRevenue()?.invoiced?.netUsd ?? null),
  );
  readonly marginDelta = computed<DeltaReading | null>(() =>
    deltaOf(this.marginPct(), this.previousRevenue()?.margin?.marginPct ?? null, 'points'),
  );

  /** Gross, less tax, net, less model cost and processing, margin. */
  readonly waterfall = computed<WaterfallStep[]>(() => {
    const money = this.revenue();
    const invoiced = money?.invoiced;
    const margin = money?.margin;
    if (!invoiced || !margin) return [];
    return [
      { key: 'gross', label: 'Gross', value: invoiced.grossUsd, total: true, display: usd(invoiced.grossUsd) },
      { key: 'tax', label: 'Tax', value: -invoiced.taxUsd, display: usd(-invoiced.taxUsd) },
      { key: 'net', label: 'Net', value: invoiced.netUsd, total: true, display: usd(invoiced.netUsd) },
      { key: 'model', label: 'Model cost', value: -margin.vendorCostUsd, display: usd(-margin.vendorCostUsd) },
      { key: 'processing', label: 'Processing', value: -margin.processingFeeUsd, display: usd(-margin.processingFeeUsd) },
      { key: 'margin', label: 'Kept', value: margin.marginUsd, total: true, display: usd(margin.marginUsd) },
    ];
  });

  /** One sentence about a degraded or truncated revenue read, or null. */
  readonly revenueCaveat = computed<string | null>(() => {
    const money = this.revenue();
    if (!money) return null;
    if (money.degraded.length > 0) return 'Part of this range could not be read, so the margin is incomplete.';
    if (money.invoiced?.truncated || money.processing?.truncated) {
      return 'More records than one read returns, so these totals are a floor.';
    }
    const other = (money.invoiced?.otherCurrencyCount ?? 0) + (money.processing?.otherCurrencyCount ?? 0);
    return other > 0 ? `${other} record(s) in another currency are excluded.` : null;
  });

  // --- Status strip ---------------------------------------------------------

  readonly statuses = computed<SpendStatus[]>(() => {
    const data = this.costs();
    if (!data) return [];
    const items: SpendStatus[] = [];
    if (!data.vendor.configured) {
      items.push({
        key: 'vendor-unconfigured',
        tone: 'muted',
        icon: 'ti-plug-off',
        text: 'No provider keys managed here',
        hint: 'This deployment manages no provider keys, so there is no balance to report.',
      });
    } else if (data.degraded.includes(DEGRADED_VENDOR_BALANCE)) {
      items.push({
        key: 'vendor-unreachable',
        tone: 'warn',
        icon: 'ti-cloud-off',
        text: 'Provider balance unreadable',
        hint: 'The provider balance could not be read, so the runway is unknown. The other figures are unaffected.',
      });
    }
    if (data.degraded.includes(DEGRADED_METERED_COST)) {
      items.push({
        key: 'metered-degraded',
        tone: 'warn',
        icon: 'ti-database-off',
        text: 'Usage ledger unreadable',
        hint: 'The metered burn could not be read, so burn and runway show as zero or unknown.',
      });
    }
    const health = runwayHealth(data.burn.runwayDays);
    if (health === 'bad' || health === 'warn') {
      items.push({
        key: 'runway',
        tone: health,
        icon: 'ti-hourglass-low',
        text: `${whole(data.burn.runwayDays ?? 0)} days of runway`,
        hint: health === 'bad' ? 'Top up the provider account now.' : 'Top up the provider account soon.',
      });
    }
    if (coverageHealth(data.committed.coverageRatio) === 'bad') {
      items.push({
        key: 'coverage',
        tone: 'bad',
        icon: 'ti-scale',
        text: 'Balance below committed ceiling',
        hint: 'If every active tenant spent their full allowance this month, the account would run dry.',
      });
    }
    if (data.attention.entitledWithoutKey > 0) {
      items.push({
        key: 'no-key',
        tone: 'bad',
        icon: 'ti-key-off',
        text: `${whole(data.attention.entitledWithoutKey)} active tenant(s) hold no runtime key`,
        hint: 'Every hosted run of theirs is refused until a key is provisioned.',
      });
    }
    if (data.attention.retiredHoldingKey.length > 0) {
      items.push({
        key: 'retired-key',
        tone: 'warn',
        icon: 'ti-key',
        text: `${whole(data.attention.retiredHoldingKey.length)} inactive tenant(s) still hold a key hash`,
        hint: this.retiredHint,
      });
    }
    if (items.every((item) => item.tone !== 'bad' && item.tone !== 'warn')) {
      items.unshift({ key: 'healthy', tone: 'good', icon: 'ti-circle-check', text: 'All clear', hint: null });
    }
    return items;
  });

  reloadCosts(): void {
    this.costsData.reload();
  }

  reloadRevenue(): void {
    this.revenueData.reload();
  }
}
