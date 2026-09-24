import { ChangeDetectionStrategy, Component, computed, input, signal } from '@angular/core';

import { compact, percent } from '../format';
import { arcPath, donutArcs, shareOf } from './chart-math';
import { categorical, toneVar, type Tone } from './tones';

export interface Slice {
  readonly key: string;
  readonly label: string;
  readonly value: number;
  readonly tone?: Tone;
  readonly icon?: string;
}

const SIZE = 160;
const OUTER = 76;
const INNER = 54;

/** A donut with a centre readout that follows the hovered slice, and a legend. */
@Component({
  selector: 'admin-donut',
  template: `
    <div class="admin-donut" [class.admin-donut--side]="legendSide()">
      <div class="admin-donut__chart">
        <svg
          class="admin-donut__svg"
          [attr.viewBox]="'0 0 ' + size + ' ' + size"
          role="img"
          [attr.aria-label]="ariaLabel()"
        >
          <circle class="admin-donut__track" [attr.cx]="size / 2" [attr.cy]="size / 2" [attr.r]="(outer + inner) / 2" [attr.stroke-width]="outer - inner" />
          @for (slice of slices(); track slice.key) {
            <path
              class="admin-donut__slice"
              [class.admin-donut__slice--dim]="active() !== null && active() !== slice.key"
              [attr.d]="slice.path"
              [style.fill]="slice.color"
              (pointerenter)="active.set(slice.key)"
              (pointerleave)="active.set(null)"
            />
          }
        </svg>
        <div class="admin-donut__center" aria-hidden="true">
          <span class="admin-donut__value">{{ center().value }}</span>
          <span class="admin-donut__caption">{{ center().caption }}</span>
        </div>
      </div>
      <ul class="admin-donut__legend">
        @for (slice of slices(); track slice.key) {
          <li
            class="admin-donut__item"
            [class.admin-donut__item--active]="active() === slice.key"
            [style.--tone]="slice.color"
            (pointerenter)="active.set(slice.key)"
            (pointerleave)="active.set(null)"
          >
            <span class="admin-donut__swatch" aria-hidden="true"></span>
            @if (slice.icon) {
              <i class="ti {{ slice.icon }} admin-donut__icon" aria-hidden="true"></i>
            }
            <span class="admin-donut__label">{{ slice.label }}</span>
            <span class="admin-donut__share">{{ slice.shareText }}</span>
          </li>
        }
      </ul>
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AdminDonut {
  readonly data = input.required<readonly Slice[]>();
  /** Centre caption when nothing is hovered. */
  readonly caption = input('total');
  readonly legendSide = input(true);

  readonly size = SIZE;
  readonly outer = OUTER;
  readonly inner = INNER;
  readonly active = signal<string | null>(null);

  private readonly total = computed(() => this.data().reduce((sum, s) => sum + Math.max(0, s.value), 0));

  readonly slices = computed(() => {
    const data = this.data();
    const arcs = donutArcs(data.map((s) => s.value));
    const total = this.total();
    return data.map((slice, index) => ({
      ...slice,
      color: `rgb(${toneVar(slice.tone ?? categorical(index))})`,
      path: arcPath(SIZE / 2, SIZE / 2, OUTER, INNER, arcs[index]),
      shareText: percent(shareOf(slice.value, total)),
    }));
  });

  readonly center = computed(() => {
    const key = this.active();
    const slice = key === null ? null : this.slices().find((s) => s.key === key);
    if (slice) return { value: slice.shareText, caption: slice.label };
    return { value: compact(this.total()), caption: this.caption() };
  });

  readonly ariaLabel = computed(
    () => `Share: ${this.slices().map((s) => `${s.label} ${s.shareText}`).join(', ')}.`,
  );
}
