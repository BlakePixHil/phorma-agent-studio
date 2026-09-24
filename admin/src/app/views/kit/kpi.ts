import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

import type { DeltaReading } from '../charts/chart-math';
import { AdminSparkline } from '../charts/sparkline';
import { toneVar, type Tone } from '../charts/tones';
import { AdminDelta } from './delta';
import { AdminHint } from './hint';

/**
 * One headline number: label, value, change against the previous period, and an
 * optional sparkline. Keeps the `.admin-stat*` class names the specs read.
 */
@Component({
  selector: 'admin-kpi',
  imports: [AdminDelta, AdminHint, AdminSparkline],
  template: `
    <article class="admin-card admin-kpi admin-stat" [style.--tone]="toneColor()">
      <p class="admin-stat__label">
        <i class="ti {{ icon() }} admin-kpi__icon" aria-hidden="true"></i>
        <span>{{ label() }}</span>
        @if (hint(); as text) {
          <admin-hint [text]="text" />
        }
      </p>
      <div class="admin-kpi__figure">
        <p
          class="admin-stat__value"
          [class.admin-stat__value--unknown]="unknown()"
          [class.admin-stat__value--long]="value().length > 13"
          [attr.title]="value().length > 13 ? value() : null"
        >
          {{ value() }}
        </p>
        <admin-delta
          [reading]="delta()"
          [invert]="invert()"
          [mode]="deltaMode()"
          [hint]="deltaHint()"
        />
      </div>
      @if (sparkValues(); as values) {
        <admin-sparkline class="admin-kpi__spark" [values]="values" [tone]="tone()" />
      }
      <ng-content />
      @if (note(); as text) {
        <p class="admin-stat__note">{{ text }}</p>
      }
    </article>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AdminKpi {
  readonly label = input.required<string>();
  /** Pre-formatted, so a null can be an honest dash rather than a zero. */
  readonly value = input.required<string>();
  readonly icon = input('ti-point');
  readonly tone = input<Tone>('iris');
  readonly note = input<string | null>(null);
  readonly hint = input<string | null>(null);
  readonly delta = input<DeltaReading | null>(null);
  readonly deltaHint = input<string | null>(null);
  readonly deltaMode = input<'percent' | 'points'>('percent');
  /** True when a rise is bad news (errors). */
  readonly invert = input(false);
  readonly spark = input<readonly (number | null)[] | null>(null);
  readonly unknown = input(false);

  readonly toneColor = computed(() => toneVar(this.tone()));
  readonly sparkValues = computed(() => {
    const values = this.spark();
    return values && values.length > 1 ? values : null;
  });
}
