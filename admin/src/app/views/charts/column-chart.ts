import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  computed,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';

import { longDay, shortDay } from '../format';
import { niceTicks } from './chart-math';
import { toneVar, type Tone } from './tones';

export interface Column {
  readonly label: string;
  readonly value: number;
}

const M = { top: 12, right: 10, bottom: 24, left: 44 };

/** Daily columns with an optional dashed reference line (for example the average). */
@Component({
  selector: 'admin-column-chart',
  template: `
    <div
      #frame
      class="admin-columns-chart"
      [style.height.px]="height()"
      [style.--tone]="toneColor()"
      (pointerleave)="hoverIndex.set(null)"
    >
      <svg
        [attr.viewBox]="'0 0 ' + width() + ' ' + height()"
        [attr.width]="width()"
        [attr.height]="height()"
        role="img"
        [attr.aria-label]="ariaLabel()"
      >
        @for (tick of yTicks(); track tick.value) {
          <line class="admin-axis__grid" [attr.x1]="left" [attr.x2]="width() - right" [attr.y1]="tick.y" [attr.y2]="tick.y" />
          <text class="admin-axis__label" [attr.x]="left - 8" [attr.y]="tick.y" text-anchor="end" dominant-baseline="middle">
            {{ tick.label }}
          </text>
        }
        @for (bar of bars(); track bar.index) {
          <rect
            class="admin-columns-chart__bar"
            [class.admin-columns-chart__bar--active]="hoverIndex() === bar.index"
            [attr.x]="bar.x"
            [attr.y]="bar.y"
            [attr.width]="bar.w"
            [attr.height]="bar.h"
            rx="2"
            [style.--i]="bar.index"
            (pointerenter)="hoverIndex.set(bar.index)"
          />
        }
        @if (referenceY(); as y) {
          <line class="admin-columns-chart__ref" [attr.x1]="left" [attr.x2]="width() - right" [attr.y1]="y" [attr.y2]="y" />
          <text class="admin-columns-chart__ref-label" [attr.x]="width() - right" [attr.y]="y - 5" text-anchor="end">
            {{ referenceLabel() }}
          </text>
        }
        @for (tick of xTicks(); track tick.index) {
          <text class="admin-axis__label" [attr.x]="tick.x" [attr.y]="height() - 6" [attr.text-anchor]="tick.anchor">
            {{ tick.label }}
          </text>
        }
      </svg>
      @if (hover(); as h) {
        <div class="admin-tooltip admin-area__tooltip" [class.admin-area__tooltip--flip]="h.flip" [style.left.px]="h.x" [style.top.px]="top">
          <p class="admin-tooltip__title">{{ h.title }}</p>
          <p class="admin-tooltip__row">
            <span class="admin-tooltip__swatch" [style.background]="'rgb(' + toneColor() + ')'"></span>
            <span class="admin-tooltip__value">{{ h.value }}</span>
          </p>
        </div>
      }
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AdminColumnChart {
  readonly data = input.required<readonly Column[]>();
  readonly tone = input<Tone>('amber');
  readonly height = input(180);
  readonly reference = input<number | null>(null);
  readonly referenceLabel = input('');
  readonly format = input.required<(value: number) => string>();

  readonly left = M.left;
  readonly right = M.right;
  readonly top = M.top;
  readonly toneColor = computed(() => toneVar(this.tone()));
  readonly width = signal(560);
  readonly hoverIndex = signal<number | null>(null);
  private readonly frame = viewChild.required<ElementRef<HTMLDivElement>>('frame');

  constructor() {
    const destroyRef = inject(DestroyRef);
    afterNextRender(() => {
      const element = this.frame().nativeElement;
      const measure = () => this.width.set(Math.max(160, Math.round(element.clientWidth)));
      measure();
      if (typeof ResizeObserver === 'undefined') return;
      const observer = new ResizeObserver(measure);
      observer.observe(element);
      destroyRef.onDestroy(() => observer.disconnect());
    });
  }

  private readonly ticks = computed(() => {
    const peak = this.data().reduce((max, c) => Math.max(max, c.value), this.reference() ?? 0);
    return niceTicks(peak * 1.1, 3, false);
  });
  private readonly topValue = computed(() => this.ticks()[this.ticks().length - 1] || 1);
  private readonly plotW = computed(() => this.width() - M.left - M.right);
  private readonly plotH = computed(() => this.height() - M.top - M.bottom);

  private yOf(value: number): number {
    return M.top + this.plotH() - (value / this.topValue()) * this.plotH();
  }

  readonly yTicks = computed(() =>
    this.ticks().map((value) => ({ value, y: this.yOf(value), label: this.format()(value) })),
  );

  readonly bars = computed(() => {
    const data = this.data();
    const slot = this.plotW() / Math.max(1, data.length);
    const w = Math.max(2, slot * 0.68);
    return data.map((column, index) => {
      const y = this.yOf(Math.max(0, column.value));
      return {
        index,
        x: M.left + slot * index + (slot - w) / 2,
        y,
        w,
        h: Math.max(column.value > 0 ? 1.5 : 0, M.top + this.plotH() - y),
      };
    });
  });

  readonly xTicks = computed(() => {
    const data = this.data();
    const n = data.length;
    if (n === 0) return [];
    const slot = this.plotW() / n;
    const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(this.plotW() / 80))));
    const ticks = [];
    for (let i = 0; i < n; i += every) ticks.push(i);
    if (ticks[ticks.length - 1] !== n - 1 && n - 1 - ticks[ticks.length - 1] > every / 2) ticks.push(n - 1);
    return ticks.map((index) => ({
      index,
      x: M.left + slot * index + slot / 2,
      label: shortDay(data[index].label),
      anchor: index === 0 ? 'start' : index === n - 1 ? 'end' : 'middle',
    }));
  });

  readonly referenceY = computed(() => {
    const value = this.reference();
    return value === null || !(value > 0) ? null : this.yOf(value);
  });

  readonly hover = computed(() => {
    const index = this.hoverIndex();
    const data = this.data();
    if (index === null || !data[index]) return null;
    const bar = this.bars()[index];
    const x = bar.x + bar.w / 2;
    return {
      x,
      flip: x > this.width() * 0.62,
      title: longDay(data[index].label),
      value: this.format()(data[index].value),
    };
  });

  readonly ariaLabel = computed(() => {
    const data = this.data();
    if (data.length === 0) return 'Empty chart';
    return `Daily values from ${data[0].label} to ${data[data.length - 1].label}.`;
  });
}
