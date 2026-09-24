import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

import { toneVar, type Tone } from './tones';

const R = 42;
const CIRCUMFERENCE = 2 * Math.PI * R;

/** A progress ring for a 0-100 reading. A null reads as a dashed, unknown ring. */
@Component({
  selector: 'admin-ring',
  template: `
    <div class="admin-ring" [class.admin-ring--small]="small()" [style.--tone]="toneColor()">
      <svg class="admin-ring__svg" viewBox="0 0 100 100" role="img" [attr.aria-label]="ariaLabel()">
        <circle class="admin-ring__track" [class.admin-ring__track--unknown]="value() === null" cx="50" cy="50" [attr.r]="r" />
        @if (value() !== null) {
          <circle
            class="admin-ring__arc admin-draw-ring"
            cx="50"
            cy="50"
            [attr.r]="r"
            [attr.stroke-dasharray]="circumference"
            [attr.stroke-dashoffset]="offset()"
            [style.--ring-offset]="offset()"
            [style.--ring-full]="circumference"
          />
        }
      </svg>
      <div class="admin-ring__center">
        <span class="admin-ring__value">{{ display() }}</span>
        @if (caption()) {
          <span class="admin-ring__caption">{{ caption() }}</span>
        }
      </div>
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AdminRing {
  /** 0-100, clamped for drawing. Null when it cannot be computed. */
  readonly value = input.required<number | null>();
  readonly tone = input<Tone>('iris');
  readonly caption = input('');
  /** Overrides the centre text, for a figure that is not itself a percentage. */
  readonly label = input<string | null>(null);
  readonly small = input(false);

  readonly r = R;
  readonly circumference = CIRCUMFERENCE;
  readonly toneColor = computed(() => toneVar(this.tone()));

  readonly offset = computed(() => {
    const value = this.value();
    const clamped = value === null ? 0 : Math.min(100, Math.max(0, value));
    return CIRCUMFERENCE * (1 - clamped / 100);
  });

  readonly display = computed(() => {
    const label = this.label();
    if (label !== null) return label;
    const value = this.value();
    if (value === null) return '-';
    return `${Math.round(value)}%`;
  });

  readonly ariaLabel = computed(() => `${this.caption() || 'Reading'}: ${this.display()}`);
}
