import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { ButtonModule } from 'primeng/button';

import { VIEW_FAILURE_FALLBACK, type ViewState } from '../core/view-state';

/**
 * The loading, empty and failed chrome for EVERY view, in one component.
 *
 * The five views differ only in their loaded markup, so the other three states
 * live here rather than being written out five times - there is no way for the
 * error copy, the retry control or the empty wording to drift between views, and
 * a change to any of them is a single edit (Requirements 10.11, 10.12, 10.13).
 *
 * The rail renders NOTHING in the `loaded` state. A view pairs it with its own
 * loaded branch:
 *
 * ```html
 * @if (loaded(); as data) { ...loaded markup... }
 * @else { <admin-view-state [state]="state()" (retry)="reload()" /> }
 * ```
 *
 * which is what makes "exactly one of the four states" structural: the loaded
 * markup and the rail are the two arms of one `@if`, and inside the rail the
 * three remaining states are arms of one `@switch`.
 *
 * Every rendered state carries a `data-view-state` attribute naming itself, so
 * counting `[data-view-state]` in the DOM is a direct test of that exclusivity.
 */
@Component({
  selector: 'admin-view-state',
  imports: [ButtonModule],
  template: `
    @switch (state().kind) {
      @case ('loading') {
        <div class="admin-view-state" data-view-state="loading" role="status">
          <i class="ti ti-loader-2 admin-view-state__spinner" aria-hidden="true"></i>
          <p class="admin-view-state__message">Loading telemetry.</p>
        </div>
      }
      @case ('empty') {
        <div class="admin-view-state" data-view-state="empty">
          <i class="ti ti-database-off admin-view-state__icon" aria-hidden="true"></i>
          <p class="admin-view-state__message">{{ emptyMessage() }}</p>
        </div>
      }
      @case ('failed') {
        <div class="admin-view-state" data-view-state="failed" role="alert">
          <i class="ti ti-alert-triangle admin-view-state__icon" aria-hidden="true"></i>
          <p class="admin-view-state__message">{{ failureReason() }}</p>
          <button
            pButton
            type="button"
            size="small"
            class="phorma-btn-content"
            (click)="retry.emit()"
          >
            <i class="ti ti-refresh" aria-hidden="true"></i>
            <span>Retry</span>
          </button>
        </div>
      }
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ViewStateRail {
  /**
   * The view's single state. `unknown` as the payload type on purpose: the rail
   * never reads the loaded value, so it does not need to know its shape.
   */
  readonly state = input.required<ViewState<unknown>>();

  /**
   * What the empty state says. Defaulted, and overridden by the trend view,
   * which has something more useful to say when every day in range fell below
   * the reporting threshold (10.13).
   */
  readonly emptyMessage = input('No telemetry for this range.');

  /** Re-run the view's own request. The failed state's only action (10.12). */
  readonly retry = output<void>();

  /** The failure copy, with the static fallback for a state that carries none. */
  readonly failureReason = computed(() => {
    const state = this.state();
    return state.kind === 'failed' ? state.reason : VIEW_FAILURE_FALLBACK;
  });
}
