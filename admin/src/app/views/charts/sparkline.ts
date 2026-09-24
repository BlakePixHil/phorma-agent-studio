import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

import { seriesPaths } from './chart-math';
import { chartId, toneVar, type Tone } from './tones';

const W = 120;
const H = 36;

/** A tiny trend line with a soft gradient fill. Decorative: the figure beside it carries the number. */
@Component({
  selector: 'admin-sparkline',
  template: `
    <svg
      class="admin-spark"
      [attr.viewBox]="viewBox"
      preserveAspectRatio="none"
      aria-hidden="true"
      [style.--tone]="toneColor()"
    >
      <defs>
        <linearGradient [attr.id]="gradientId" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" class="admin-spark__stop-top" />
          <stop offset="1" class="admin-spark__stop-bottom" />
        </linearGradient>
      </defs>
      <path class="admin-spark__area" [attr.d]="paths().area" [attr.fill]="fill" />
      <path class="admin-spark__line" [attr.d]="paths().line" />
    </svg>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AdminSparkline {
  readonly values = input.required<readonly (number | null)[]>();
  readonly tone = input<Tone>('iris');

  readonly viewBox = `0 0 ${W} ${H}`;
  readonly gradientId = chartId('spark');
  readonly fill = `url(#${this.gradientId})`;
  readonly toneColor = computed(() => toneVar(this.tone()));

  readonly paths = computed(() => {
    // Decorative, so a folded day is bridged rather than drawn as a gap.
    const values = this.values().filter((value): value is number => value !== null);
    const max = values.reduce<number>((peak, value) => Math.max(peak, value ?? 0), 0);
    const n = values.length;
    const xOf = (i: number) => (n <= 1 ? W / 2 : (i / (n - 1)) * W);
    // 3px of headroom top and bottom so the stroke is never clipped.
    const yOf = (value: number) => H - 3 - (max > 0 ? (value / max) * (H - 6) : 0);
    return seriesPaths(values, xOf, yOf, H);
  });
}
