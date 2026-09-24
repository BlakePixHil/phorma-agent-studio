import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { TooltipModule } from 'primeng/tooltip';

import type { DeltaReading } from '../charts/chart-math';

export type DeltaTone = 'good' | 'bad' | 'flat' | 'new';

/** Which way is good: most figures should rise, errors should fall. */
export function deltaTone(reading: DeltaReading, invert = false): DeltaTone {
  if (reading.kind === 'new') return 'new';
  if (reading.kind === 'flat') return 'flat';
  const rising = reading.kind === 'up';
  return rising !== invert ? 'good' : 'bad';
}

/** `+12%`, `-3.4%`, `+2.1 pts`, `0%`, `New`. */
export function deltaText(reading: DeltaReading, mode: 'percent' | 'points' = 'percent'): string {
  if (reading.kind === 'new') return 'New';
  const amount = reading.amount ?? 0;
  const magnitude = Math.abs(amount);
  const digits = magnitude < 10 && magnitude !== 0 ? 1 : 0;
  const sign = amount > 0 ? '+' : amount < 0 ? '-' : '';
  const body = magnitude.toFixed(digits);
  return mode === 'points' ? `${sign}${body} pts` : `${sign}${body}%`;
}

/** A change-versus-previous-period pill. Renders nothing without a reading. */
@Component({
  selector: 'admin-delta',
  imports: [TooltipModule],
  template: `
    @if (reading(); as value) {
      <span
        class="admin-delta admin-delta--{{ tone() }}"
        [attr.data-delta]="tone()"
        [pTooltip]="hint() ?? undefined"
        tooltipPosition="top"
        tooltipStyleClass="admin-tip"
      >
        <i class="ti {{ icon() }}" aria-hidden="true"></i>
        <span>{{ label() }}</span>
      </span>
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AdminDelta {
  readonly reading = input<DeltaReading | null>(null);
  readonly invert = input(false);
  readonly mode = input<'percent' | 'points'>('percent');
  readonly hint = input<string | null>(null);

  readonly tone = computed(() => {
    const value = this.reading();
    return value ? deltaTone(value, this.invert()) : 'flat';
  });

  readonly label = computed(() => {
    const value = this.reading();
    return value ? deltaText(value, this.mode()) : '';
  });

  readonly icon = computed(() => {
    const kind = this.reading()?.kind;
    if (kind === 'up') return 'ti-arrow-up-right';
    if (kind === 'down') return 'ti-arrow-down-right';
    if (kind === 'new') return 'ti-sparkles';
    return 'ti-arrow-right';
  });
}
