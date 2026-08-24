import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { ClerkService, ClerkUserButtonComponent } from 'ngx-clerk';

import { NotAuthorized } from './auth/not-authorized';
import { SignedOut } from './auth/signed-out';
import {
  DateRangeService,
  MAX_RANGE_DAYS,
  RANGE_PRESET_DAYS,
  type RangePresetDays,
} from './core/date-range.service';
import { TELEMETRY_ROUTES, type DateRange, type TelemetryRoute } from './core/models';
import { TelemetryApiService } from './core/telemetry-api.service';

/** One header nav entry. `route` is both the URL path and the Admin_API route. */
export interface ViewNavItem {
  route: TelemetryRoute;
  label: string;
  icon: string;
}

/**
 * The view nav, in the order `TELEMETRY_ROUTES` lists the aggregate routes.
 * Labels and icons live here; the set of entries does not, so a sixth aggregate
 * route cannot be silently missing from the nav.
 */
const NAV_LABELS: Record<TelemetryRoute, { label: string; icon: string }> = {
  summary: { label: 'Overview', icon: 'ti-gauge' },
  geography: { label: 'Geography', icon: 'ti-world' },
  environment: { label: 'Environment', icon: 'ti-device-desktop' },
  features: { label: 'Features', icon: 'ti-sparkles' },
  trend: { label: 'Trend', icon: 'ti-chart-line' },
};

export const VIEW_NAV: readonly ViewNavItem[] = TELEMETRY_ROUTES.map((route) => ({
  route,
  ...NAV_LABELS[route],
}));

/**
 * The copy the header shows when a typed range is one the Admin_API would
 * reject. The bound is read from the service rather than restated, so the two
 * cannot disagree.
 */
export const RANGE_REJECTED_MESSAGE = `Pick a start on or before the end, within ${MAX_RANGE_DAYS} days.`;

/**
 * The dashboard shell: one auth switch, one header, one date-range control, and
 * the outlet the five views render into.
 *
 * The auth switch is a GATE, not a visibility toggle. `router-outlet` lives
 * inside the signed-in branch only, so while there is no Clerk session no view
 * component is constructed and no view `resource()` can fire - which is how
 * Requirement 10.3's "issue no Admin_API request" holds structurally rather than
 * by every view remembering to check. A 403 from any route flips
 * `TelemetryApiService.forbidden` and swaps the same outlet out for the
 * not-authorized surface (10.4).
 *
 * The range control writes the single `DateRangeService` range signal and
 * nothing else. Every view keys its `resource()` on that signal, so one write
 * refetches every bound view with no fan-out list to maintain (10.10).
 */
@Component({
  selector: 'admin-root',
  imports: [
    RouterOutlet,
    RouterLink,
    RouterLinkActive,
    ButtonModule,
    InputTextModule,
    ClerkUserButtonComponent,
    SignedOut,
    NotAuthorized,
  ],
  templateUrl: './app.html',
  styleUrl: './app.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class App {
  private readonly dateRange = inject(DateRangeService);
  private readonly api = inject(TelemetryApiService);

  /** The nav entries and the presets, for the template. */
  readonly nav = VIEW_NAV;
  readonly presets = RANGE_PRESET_DAYS;
  readonly rangeRejectedMessage = RANGE_REJECTED_MESSAGE;

  /**
   * Whether a Clerk session exists.
   *
   * Clerk not having loaded yet reads as "no session", the same reading
   * `TelemetryApiService` takes: it is the honest one, and it keeps 10.3 true
   * during startup instead of briefly rendering a dashboard that cannot fetch.
   */
  readonly signedIn = signal(false);

  /** True once any Admin_API call has been answered 403 (10.4). */
  readonly forbidden = this.api.forbidden;

  /** The selected range, for the header summary. */
  readonly from = this.dateRange.from;
  readonly to = this.dateRange.to;
  readonly days = this.dateRange.days;
  readonly activePreset = this.dateRange.activePreset;

  /**
   * What the two date inputs currently hold. Separate from the shared range so a
   * half-typed date does not refetch every view; each resets to the shared value
   * whenever the range changes, which is what makes the preset buttons update the
   * inputs.
   *
   * Each input tracks its OWN end, so moving only the end date leaves a start the
   * visitor typed alone (`adoptRangeChange`).
   *
   * Plain signals synced at the write, not `linkedSignal`s over the range: a
   * linked signal is LAZY, so it only notices a source change when something
   * reads it. Nothing reads these between two writes except the markup, and the
   * commit path reads the drafts to build the range it commits - so a range that
   * moved away and back between reads collapsed into "unchanged" and the input
   * kept a superseded day, which then committed as one end of the next typed
   * range. Syncing eagerly at the write removes the read-timing dependency
   * altogether.
   */
  readonly draftFrom = signal(this.dateRange.from());
  readonly draftTo = signal(this.dateRange.to());

  /** True while the drafted range is one the Admin_API would answer 400 for. */
  readonly rangeRejected = signal(false);

  constructor() {
    inject(ClerkService)
      .session$.pipe(takeUntilDestroyed())
      .subscribe((session) => this.signedIn.set(session !== null && session !== undefined));
  }

  onFromInput(event: Event): void {
    this.draftFrom.set(readInputValue(event));
    this.commitDraft();
  }

  onToInput(event: Event): void {
    this.draftTo.set(readInputValue(event));
    this.commitDraft();
  }

  /**
   * Selects a trailing window. A preset is always a valid range, so this clears
   * the rejected hint - but it clears it from what the service ANSWERED rather
   * than from that assumption, so a preset the Admin_API would refuse would show
   * the hint instead of failing silently.
   */
  selectPreset(days: RangePresetDays): void {
    const before = this.dateRange.range();
    const accepted = this.dateRange.applyPreset(days);
    this.adoptRangeChange(before);
    this.rangeRejected.set(!accepted);
  }

  /**
   * Writes the drafted range to the shared signal, or records the rejection and
   * leaves the shared signal alone. `setRange` is the one validity gate; this
   * method does not re-implement it.
   */
  private commitDraft(): void {
    const before = this.dateRange.range();
    const accepted = this.dateRange.setRange({ from: this.draftFrom(), to: this.draftTo() });
    this.adoptRangeChange(before);
    this.rangeRejected.set(!accepted);
  }

  /**
   * Pulls each input up to the shared range for the end that actually moved.
   * Called after every write, so a preset always shows in both inputs while a
   * rejected or no-op write leaves a half-typed day where the visitor left it.
   */
  private adoptRangeChange(before: DateRange): void {
    const selected = this.dateRange.range();
    if (selected.from !== before.from) this.draftFrom.set(selected.from);
    if (selected.to !== before.to) this.draftTo.set(selected.to);
  }
}

function readInputValue(event: Event): string {
  const target = event.target;
  return target instanceof HTMLInputElement ? target.value : '';
}
