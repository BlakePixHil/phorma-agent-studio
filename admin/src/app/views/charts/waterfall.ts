import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

export interface WaterfallStep {
  readonly key: string;
  readonly label: string;
  /** Positive adds, negative subtracts. Ignored for a `total` step. */
  readonly value: number;
  /** A running total bar (gross, net, margin) rather than a change. */
  readonly total?: boolean;
  readonly display: string;
}

interface PaintedStep extends WaterfallStep {
  readonly left: number;
  readonly width: number;
  readonly kind: 'total' | 'loss' | 'gain' | 'result-good' | 'result-bad';
}

/**
 * Horizontal waterfall: each row is a bar positioned on one shared scale, so a
 * deduction visibly eats into the bar above it and the last row is what is left.
 */
@Component({
  selector: 'admin-waterfall',
  template: `
    <ol class="admin-fall" role="list">
      @for (step of steps(); track step.key; let i = $index) {
        <li class="admin-fall__row" [attr.data-step]="step.key" [style.--i]="i">
          <span class="admin-fall__label">{{ step.label }}</span>
          <span class="admin-fall__track">
            <span
              class="admin-fall__bar admin-fall__bar--{{ step.kind }}"
              [style.left.%]="step.left"
              [style.width.%]="step.width"
            ></span>
          </span>
          <span class="admin-fall__value admin-fall__value--{{ step.kind }}">{{ step.display }}</span>
        </li>
      }
    </ol>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AdminWaterfall {
  readonly data = input.required<readonly WaterfallStep[]>();

  readonly steps = computed<PaintedStep[]>(() => {
    const data = this.data();
    // One scale across every running level, so bars are comparable row to row.
    let level = 0;
    const levels: { from: number; to: number }[] = [];
    for (const step of data) {
      if (step.total) {
        level = step.value;
        levels.push({ from: 0, to: level });
      } else {
        const next = level + step.value;
        levels.push({ from: level, to: next });
        level = next;
      }
    }
    const lo = Math.min(0, ...levels.map((l) => Math.min(l.from, l.to)));
    const hi = Math.max(0, ...levels.map((l) => Math.max(l.from, l.to)));
    const span = hi - lo || 1;
    const last = data.length - 1;
    return data.map((step, index) => {
      const { from, to } = levels[index];
      const start = Math.min(from, to);
      const end = Math.max(from, to);
      let kind: PaintedStep['kind'];
      if (step.total) kind = index === last ? (to >= 0 ? 'result-good' : 'result-bad') : 'total';
      else kind = step.value < 0 ? 'loss' : 'gain';
      return {
        ...step,
        kind,
        left: ((start - lo) / span) * 100,
        width: Math.max(end > start ? 0.8 : 0, ((end - start) / span) * 100),
      };
    });
  });
}
