import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { TooltipModule } from 'primeng/tooltip';

import { percent } from '../format';
import { shareOf } from './chart-math';
import { categorical, toneVar, type Tone } from './tones';

export interface StackPart {
  readonly key: string;
  readonly label: string;
  readonly value: number;
  readonly tone?: Tone;
  /** Caption shown in the legend instead of the share. */
  readonly caption?: string;
}

/** One 100% bar split into parts, with a legend underneath. */
@Component({
  selector: 'admin-stack-bar',
  imports: [TooltipModule],
  template: `
    <div class="admin-stack" [class.admin-stack--tall]="tall()">
      <div class="admin-stack__bar" role="img" [attr.aria-label]="ariaLabel()">
        @for (part of parts(); track part.key) {
          @if (part.share > 0) {
            <span
              class="admin-stack__part"
              [style.flex-grow]="part.share"
              [style.background]="part.color"
              [pTooltip]="part.label + ': ' + part.shareText"
              tooltipPosition="top"
              tooltipStyleClass="admin-tip"
            ></span>
          }
        }
      </div>
      @if (legend()) {
        <ul class="admin-stack__legend">
          @for (part of parts(); track part.key) {
            <li class="admin-stack__item" [style.--tone]="part.color">
              <span class="admin-stack__swatch" aria-hidden="true"></span>
              <span class="admin-stack__label">{{ part.label }}</span>
              <span class="admin-stack__share">{{ part.caption ?? part.shareText }}</span>
            </li>
          }
        </ul>
      }
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AdminStackBar {
  readonly data = input.required<readonly StackPart[]>();
  readonly legend = input(true);
  readonly tall = input(false);

  readonly parts = computed(() => {
    const data = this.data();
    const total = data.reduce((sum, part) => sum + Math.max(0, part.value), 0);
    return data.map((part, index) => {
      const share = shareOf(Math.max(0, part.value), total);
      return {
        ...part,
        share,
        shareText: percent(share),
        color: `rgb(${toneVar(part.tone ?? categorical(index))})`,
      };
    });
  });

  readonly ariaLabel = computed(() => this.parts().map((p) => `${p.label} ${p.shareText}`).join(', '));
}
