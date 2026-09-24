import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

import type { Tone } from './tones';
import { toneVar } from './tones';

/**
 * A bullet meter: `value` as a filled bar against a `target` marker, on a scale
 * that always shows both. Coverage is the use: balance against committed ceiling.
 */
@Component({
  selector: 'admin-meter',
  template: `
    <div class="admin-meter" [style.--tone]="toneColor()">
      <div class="admin-meter__track" role="img" [attr.aria-label]="ariaLabel()">
        <span class="admin-meter__fill" [style.width.%]="fill()"></span>
        @if (target() !== null) {
          <span class="admin-meter__target" [style.left.%]="marker()"></span>
        }
      </div>
      <div class="admin-meter__legend">
        <span><span class="admin-meter__key admin-meter__key--value"></span>{{ valueLabel() }}</span>
        @if (target() !== null) {
          <span><span class="admin-meter__key admin-meter__key--target"></span>{{ targetLabel() }}</span>
        }
      </div>
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AdminMeter {
  readonly value = input.required<number | null>();
  readonly target = input<number | null>(null);
  readonly valueLabel = input('');
  readonly targetLabel = input('');
  readonly tone = input<Tone>('good');

  readonly toneColor = computed(() => toneVar(this.tone()));

  private readonly scale = computed(() => {
    const value = this.value() ?? 0;
    const target = this.target() ?? 0;
    return Math.max(value, target) * 1.12 || 1;
  });

  readonly fill = computed(() => Math.min(100, ((this.value() ?? 0) / this.scale()) * 100));
  readonly marker = computed(() => Math.min(100, ((this.target() ?? 0) / this.scale()) * 100));
  readonly ariaLabel = computed(() => `${this.valueLabel()} against ${this.targetLabel()}`);
}
