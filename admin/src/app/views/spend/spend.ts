import { DecimalPipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, resource } from '@angular/core';

import { BillingApiService } from '../../core/billing-api.service';
import {
  DEGRADED_VENDOR_BALANCE,
  type BillingCostsResponse,
  type BillingRevenueResponse,
} from '../../core/billing-models';
import { DateRangeService } from '../../core/date-range.service';
import { loadedValue, viewStateOf } from '../../core/view-state';
import { unwrapAdminResult } from '../view-data';
import { ViewStateRail } from '../view-state-rail';

/**
 * One figure on the spend view.
 *
 * `value` is a PRE-FORMATTED string rather than a number, which is the whole
 * point: a null from the API means "we could not read this", and the only honest
 * rendering of that is a dash. Passing a number plus a nullable flag would leave
 * every template site free to render `0` for it, which is the one mistake this
 * surface exists to avoid.
 */
export interface SpendCard {
  label: string;
  value: string;
  icon: string;
  note: string;
  /** Drives the muted look for a figure that could not be read. */
  unknown?: boolean;
}

/** Runway thresholds, in days. Below `warn` is worth acting on. */
export const RUNWAY_WARN_DAYS = 14;
export const RUNWAY_CRITICAL_DAYS = 7;

/**
 * Spend: what the OpenRouter account holds, how fast it is draining, what we have
 * promised active tenants, and the margin actually measured against Stripe.
 *
 * ## Two resources, not one
 *
 * The cost half is D1 plus one vendor read; the revenue half is two paginated
 * Stripe walks. They are separate `resource()`s so the balance and runway paint
 * without waiting for Stripe, and so a Stripe outage degrades one card instead of
 * blanking the page - which matters because an OpenRouter funding question is
 * exactly what an operator opens this view to answer during a vendor incident.
 *
 * ## The range applies to revenue only
 *
 * Runway is a property of the account NOW, so the Worker measures burn over its
 * own trailing window and ignores the picker. The captions say so, so a one-day
 * range cannot be misread as having produced the runway figure.
 *
 * ## Nothing here is a billing surface for a customer
 *
 * Every figure is operator-facing and USD. The credits-not-dollars rule governs
 * what the STUDIO shows a paying user; this dashboard is the other side of that
 * abstraction and is where the real dollars are allowed to be.
 */
@Component({
  selector: 'admin-spend',
  imports: [DecimalPipe, ViewStateRail],
  template: `
    <section class="admin-view" aria-labelledby="admin-spend-title">
      <header class="admin-view__header">
        <h1 class="admin-view__title" id="admin-spend-title">
          <i class="ti ti-cash" aria-hidden="true"></i>
          <span>Spend</span>
        </h1>
        <p class="admin-view__range">{{ range().from }} to {{ range().to }}</p>
      </header>

      @if (costs(); as data) {
        <div class="admin-view__body" data-view-state="loaded">
          <section class="admin-view__section" aria-labelledby="admin-spend-vendor">
            <h2 class="admin-view__section-title" id="admin-spend-vendor">
              Model provider account
            </h2>
            <div class="admin-grid">
              @for (card of vendorCards(); track card.label) {
                <article class="admin-card admin-stat" [class.admin-stat--unknown]="card.unknown">
                  <p class="admin-stat__label">
                    <i class="ti {{ card.icon }}" aria-hidden="true"></i>
                    <span>{{ card.label }}</span>
                  </p>
                  <p class="admin-stat__value">{{ card.value }}</p>
                  <p class="admin-stat__note">{{ card.note }}</p>
                </article>
              }
            </div>
            @if (vendorProblem(); as problem) {
              <p class="admin-footnote" role="status">
                <i class="ti ti-alert-triangle" aria-hidden="true"></i>
                <span>{{ problem }}</span>
              </p>
            }
          </section>

          <section class="admin-view__section" aria-labelledby="admin-spend-committed">
            <h2 class="admin-view__section-title" id="admin-spend-committed">
              Committed to active tenants
            </h2>
            <div class="admin-grid">
              @for (card of committedCards(); track card.label) {
                <article class="admin-card admin-stat" [class.admin-stat--unknown]="card.unknown">
                  <p class="admin-stat__label">
                    <i class="ti {{ card.icon }}" aria-hidden="true"></i>
                    <span>{{ card.label }}</span>
                  </p>
                  <p class="admin-stat__value">{{ card.value }}</p>
                  <p class="admin-stat__note">{{ card.note }}</p>
                </article>
              }
            </div>
            @if (data.committed.byTier.length > 0) {
              <table class="admin-table">
                <caption class="admin-table__caption">
                  Committed monthly allowance by tier
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Tier</th>
                    <th scope="col" class="admin-table__number">Tenants</th>
                    <th scope="col" class="admin-table__number">Allowance</th>
                  </tr>
                </thead>
                <tbody>
                  @for (row of data.committed.byTier; track row.tier) {
                    <tr>
                      <th scope="row"><span class="admin-table__label">{{ row.tier }}</span></th>
                      <td class="admin-table__number">{{ row.tenants | number }}</td>
                      <td class="admin-table__number">{{ usd(row.allowanceUsd) }}</td>
                    </tr>
                  }
                </tbody>
              </table>
            }
          </section>

          @if (attentionRows().length > 0 || data.attention.entitledWithoutKey > 0) {
            <section class="admin-view__section" aria-labelledby="admin-spend-attention">
              <h2 class="admin-view__section-title" id="admin-spend-attention">Needs a look</h2>
              @if (data.attention.entitledWithoutKey > 0) {
                <p class="admin-footnote">
                  <i class="ti ti-key-off" aria-hidden="true"></i>
                  <span>
                    {{ data.attention.entitledWithoutKey | number }} active tenant(s) hold no
                    runtime key, so every hosted run of theirs is refused.
                  </span>
                </p>
              }
              @if (attentionRows().length > 0) {
                <table class="admin-table">
                  <caption class="admin-table__caption">
                    Inactive tenants still carrying a runtime key hash
                  </caption>
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
                        <th scope="row">
                          <span class="admin-table__label">{{ row.id }}</span>
                        </th>
                        <td>{{ row.tier }}</td>
                        <td>{{ row.status }}</td>
                      </tr>
                    }
                  </tbody>
                </table>
                <p class="admin-footnote">
                  <i class="ti ti-info-circle" aria-hidden="true"></i>
                  <span>
                    Expected after a cancellation: the key is disabled at the provider but the hash
                    is kept. Spot-check these against the provider dashboard.
                  </span>
                </p>
              }
            </section>
          }

          <section class="admin-view__section" aria-labelledby="admin-spend-revenue">
            <h2 class="admin-view__section-title" id="admin-spend-revenue">
              Revenue and margin for this range
            </h2>
            @if (revenue(); as money) {
              @if (money.configured) {
                <div class="admin-grid">
                  @for (card of revenueCards(); track card.label) {
                    <article
                      class="admin-card admin-stat"
                      [class.admin-stat--unknown]="card.unknown"
                    >
                      <p class="admin-stat__label">
                        <i class="ti {{ card.icon }}" aria-hidden="true"></i>
                        <span>{{ card.label }}</span>
                      </p>
                      <p class="admin-stat__value">{{ card.value }}</p>
                      <p class="admin-stat__note">{{ card.note }}</p>
                    </article>
                  }
                </div>
                @if (revenueCaveat(); as caveat) {
                  <p class="admin-footnote" role="status">
                    <i class="ti ti-alert-triangle" aria-hidden="true"></i>
                    <span>{{ caveat }}</span>
                  </p>
                }
              } @else {
                <p class="admin-footnote">
                  <i class="ti ti-plug-off" aria-hidden="true"></i>
                  <span>This deployment sells no plans, so there is no revenue to report.</span>
                </p>
              }
            } @else {
              <admin-view-state
                [state]="revenueState()"
                emptyMessage="No invoices in this range."
                (retry)="reloadRevenue()"
              />
            }
          </section>

          <p class="admin-footnote">
            <i class="ti ti-lock" aria-hidden="true"></i>
            <span>
              Operator-only. These figures are never shown in the studio, which reports plan
              credits.
            </span>
          </p>
        </div>
      } @else {
        <admin-view-state [state]="costsState()" (retry)="reloadCosts()" />
      }
    </section>
  `,
  styles: `
    /* The ONE rule this view adds: a figure that could not be read must not look
       like a figure that was read as zero. Everything else reuses the shared
       dashboard classes in styles.scss. */
    .admin-stat--unknown .admin-stat__value {
      color: var(--admin-text-muted);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Spend {
  private readonly api = inject(BillingApiService);

  /** The one shared range. Applies to the revenue half only - see the class doc. */
  readonly range = inject(DateRangeService).range;

  private readonly costsData = resource({
    params: () => this.range(),
    loader: ({ params }) => this.api.fetchCosts(params).then(unwrapAdminResult),
  });

  private readonly revenueData = resource({
    params: () => this.range(),
    loader: ({ params }) => this.api.fetchRevenue(params).then(unwrapAdminResult),
  });

  /**
   * Exactly one of loading, loaded, empty or failed, per half.
   *
   * `value` is read through `hasValue()`, never bare: `resource().value()` THROWS
   * while the resource is in its error state, and the literal below evaluates
   * every property eagerly, so a bare read would make this computed throw on any
   * failed request instead of resolving to `failed`. Same guard in every view.
   *
   * Neither half declares an `isEmpty`: a zero balance and a quiet month are real
   * answers this surface must show, not empty states to hide behind. The empty
   * rail would say "no data" for the most important number on the page.
   */
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

  readonly attentionRows = computed(() => this.costs()?.attention.retiredHoldingKey ?? []);

  readonly vendorCards = computed<SpendCard[]>(() => {
    const data = this.costs();
    if (!data) return [];
    const { vendor, burn } = data;
    return [
      {
        label: 'Balance',
        value: this.usd(vendor.balanceUsd),
        icon: 'ti-wallet',
        note: vendor.reachable ? 'Left to draw down' : 'Could not be read',
        unknown: vendor.balanceUsd === null,
      },
      {
        label: 'Runway',
        value: burn.runwayDays === null ? '-' : `${burn.runwayDays} days`,
        icon: 'ti-hourglass',
        note: this.runwayNote(burn.runwayDays),
        unknown: burn.runwayDays === null,
      },
      {
        label: `Burn (${burn.windowDays}d)`,
        value: this.usd(burn.meteredUsd),
        icon: 'ti-flame',
        note: `${this.usd(burn.perDayUsd)} per day, metered`,
      },
      {
        label: 'Purchased',
        value: this.usd(vendor.purchasedUsd),
        icon: 'ti-receipt',
        note: `${this.usd(vendor.spentUsd)} spent, lifetime`,
        unknown: vendor.purchasedUsd === null,
      },
    ];
  });

  readonly committedCards = computed<SpendCard[]>(() => {
    const data = this.costs();
    if (!data) return [];
    const { committed } = data;
    return [
      {
        label: 'Active tenants',
        value: String(committed.activeTenants),
        icon: 'ti-users',
        note: 'Paying and entitled',
      },
      {
        label: 'Committed ceiling',
        value: this.usd(committed.ceilingUsd),
        icon: 'ti-shield-half',
        note: 'Sum of every live key limit',
      },
      {
        label: 'Coverage',
        value:
          committed.coverageRatio === null
            ? '-'
            : `${Math.round(committed.coverageRatio * 100)}%`,
        icon: 'ti-scale',
        note: this.coverageNote(committed.coverageRatio),
        unknown: committed.coverageRatio === null,
      },
      {
        label: 'Unspent top-ups',
        value: this.usd(committed.grantPoolUsd),
        icon: 'ti-gift',
        note: 'Held by active tenants',
      },
    ];
  });

  readonly revenueCards = computed<SpendCard[]>(() => {
    const money = this.revenue();
    if (!money) return [];
    const { invoiced, processing, margin } = money;
    return [
      {
        label: 'Net revenue',
        value: this.usd(invoiced?.netUsd ?? null),
        icon: 'ti-cash-banknote',
        note:
          invoiced === null
            ? 'Could not be read'
            : `${this.usd(invoiced.grossUsd)} gross less ${this.usd(invoiced.taxUsd)} tax`,
        unknown: invoiced === null,
      },
      {
        label: 'Model cost',
        value: this.usd(margin?.vendorCostUsd ?? null),
        icon: 'ti-cpu',
        note: 'Metered spend in this range',
        unknown: margin === null,
      },
      {
        label: 'Processing',
        value: this.usd(processing?.feeUsd ?? null),
        icon: 'ti-credit-card',
        note: processing === null ? 'Could not be read' : `${processing.count} transactions`,
        unknown: processing === null,
      },
      {
        label: 'Margin',
        value: margin?.marginPct === null || margin === null ? '-' : `${margin.marginPct}%`,
        icon: 'ti-trending-up',
        note:
          margin === null
            ? 'Could not be read'
            : margin.marginPct === null
              ? 'No revenue in this range'
              : `${this.usd(margin.marginUsd)} kept`,
        unknown: margin === null || margin.marginPct === null,
      },
    ];
  });

  /** One sentence about a degraded or unconfigured provider read, or null. */
  readonly vendorProblem = computed<string | null>(() => {
    const data = this.costs();
    if (!data) return null;
    if (!data.vendor.configured) {
      return 'This deployment manages no provider keys, so there is no balance to report.';
    }
    if (data.degraded.includes(DEGRADED_VENDOR_BALANCE)) {
      return 'The provider balance could not be read, so the runway is unknown. The figures below are unaffected.';
    }
    return null;
  });

  /** One sentence about a degraded or truncated revenue read, or null. */
  readonly revenueCaveat = computed<string | null>(() => {
    const money = this.revenue();
    if (!money) return null;
    if (money.degraded.length > 0) {
      return 'Part of this range could not be read, so the margin below is incomplete.';
    }
    if (money.invoiced?.truncated || money.processing?.truncated) {
      return 'This range has more records than one read returns, so these totals are a floor.';
    }
    const other = (money.invoiced?.otherCurrencyCount ?? 0) + (money.processing?.otherCurrencyCount ?? 0);
    if (other > 0) {
      return `${other} record(s) in another currency are excluded from these totals.`;
    }
    return null;
  });

  reloadCosts(): void {
    this.costsData.reload();
  }

  reloadRevenue(): void {
    this.revenueData.reload();
  }

  /**
   * A USD figure, or a dash for a null.
   *
   * A method rather than a pipe because the null case is the reason it exists:
   * `DecimalPipe` renders a null as an empty string, which reads as a rendering
   * bug next to three real numbers, and any numeric default would state a figure
   * nobody measured.
   */
  usd(value: number | null): string {
    if (value === null || !Number.isFinite(value)) return '-';
    // Sub-cent figures are real here: one agent turn can cost $0.0004, and a burn
    // rate rounded to cents would report genuine spend as zero.
    const fractionDigits = value !== 0 && Math.abs(value) < 0.01 ? 4 : 2;
    return `$${value.toFixed(fractionDigits)}`;
  }

  private runwayNote(days: number | null): string {
    if (days === null) return 'Needs a balance and recent spend';
    if (days <= RUNWAY_CRITICAL_DAYS) return 'Top up now';
    if (days <= RUNWAY_WARN_DAYS) return 'Top up soon';
    return 'At the current burn rate';
  }

  private coverageNote(ratio: number | null): string {
    if (ratio === null) return 'Needs a provider balance';
    return ratio < 1
      ? 'Below 1: a full-spend month would run dry'
      : 'Balance covers every committed allowance';
  }
}
