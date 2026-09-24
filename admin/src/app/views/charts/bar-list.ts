import { ChangeDetectionStrategy, Component, computed, input, signal } from '@angular/core';
import { TooltipModule } from 'primeng/tooltip';

import { compact, percent } from '../format';
import { shareOf } from './chart-math';
import { toneVar, type Tone } from './tones';

export interface BarItem {
  readonly key: string;
  readonly label: string;
  readonly value: number;
  readonly icon?: string;
  /** Right-hand caption; defaults to the compact value. */
  readonly caption?: string;
  /** Muted row, for the k-anonymity `other` fold. */
  readonly muted?: boolean;
  readonly hint?: string;
  readonly badge?: string;
  /** Overrides the list tone for this row, to match a companion chart. */
  readonly tone?: Tone;
}

/**
 * A ranked list of horizontal bars. Bars scale against the largest row; the
 * caption can be a share of `total` instead of the raw value.
 */
@Component({
  selector: 'admin-bar-list',
  imports: [TooltipModule],
  template: `
    <ol class="admin-bars" [style.--tone]="toneColor()">
      @for (item of shown(); track item.key; let i = $index) {
        <li
          class="admin-bars__item"
          [class.admin-bars__item--muted]="item.muted"
          [style.--i]="i"
          [style.--tone]="item.toneColor ?? null"
          [pTooltip]="item.hint"
          tooltipPosition="top"
          tooltipStyleClass="admin-tip"
        >
          <div class="admin-bars__row">
            <span class="admin-bars__name">
              @if (item.icon) {
                <i class="ti {{ item.icon }}" aria-hidden="true"></i>
              }
              <span class="admin-bars__label">{{ item.label }}</span>
              @if (item.badge) {
                <span class="admin-chip admin-chip--good admin-chip--xs">{{ item.badge }}</span>
              }
            </span>
            <span class="admin-bars__value">{{ item.caption }}</span>
          </div>
          <div class="admin-bars__track">
            <div class="admin-bars__fill" [style.width.%]="item.width"></div>
          </div>
        </li>
      }
    </ol>
    @if (hiddenCount() > 0) {
      <button type="button" class="admin-link-button" (click)="expanded.set(!expanded())">
        {{ expanded() ? 'Show fewer' : 'Show ' + hiddenCount() + ' more' }}
      </button>
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AdminBarList {
  readonly items = input.required<readonly BarItem[]>();
  readonly tone = input<Tone>('iris');
  readonly limit = input(8);
  /** When set, captions read as a share of this total. */
  readonly total = input<number | null>(null);

  readonly expanded = signal(false);
  readonly toneColor = computed(() => toneVar(this.tone()));

  private readonly all = computed(() => {
    const items = this.items();
    const max = items.reduce((peak, item) => Math.max(peak, item.value), 0);
    const total = this.total();
    return items.map((item) => ({
      ...item,
      width: max > 0 ? Math.max(1.5, (item.value / max) * 100) : 0,
      caption:
        item.caption ?? (total !== null ? percent(shareOf(item.value, total)) : compact(item.value)),
      hint: item.hint ?? undefined,
      toneColor: item.tone ? toneVar(item.tone) : null,
    }));
  });

  readonly shown = computed(() => (this.expanded() ? this.all() : this.all().slice(0, this.limit())));
  readonly hiddenCount = computed(() => Math.max(0, this.all().length - this.limit()));
}
