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

import { compact, longDay, shortDay, whole } from '../format';
import { niceTicks, seriesPaths } from './chart-math';
import { chartId, toneVar, type Tone } from './tones';

/** One plotted series. `previous` is the prior period, aligned index for index. */
export interface AreaSeries {
  readonly key: string;
  readonly label: string;
  readonly tone: Tone;
  readonly values: readonly (number | null)[];
  readonly previous?: readonly (number | null)[];
}

const M = { top: 14, right: 14, bottom: 26, left: 40 };

/**
 * The time-series chart: smooth monotone lines over gradient fills, a crosshair
 * tooltip, legend chips that toggle series, and an optional dashed ghost of the
 * previous period. Width is measured, not scaled, so text stays crisp.
 */
@Component({
  selector: 'admin-area-chart',
  template: `
    <div class="admin-area" [class.admin-area--compact]="compact()">
      @if (legend()) {
        <div class="admin-legend" role="group" aria-label="Series">
          @for (entry of legendEntries(); track entry.key) {
            <button
              type="button"
              class="admin-legend__chip"
              [class.admin-legend__chip--off]="entry.hidden"
              [style.--tone]="entry.color"
              [attr.aria-pressed]="!entry.hidden"
              (click)="toggle(entry.key)"
            >
              <span class="admin-legend__swatch" aria-hidden="true"></span>
              <span class="admin-legend__label">{{ entry.label }}</span>
              <span class="admin-legend__total">{{ entry.total }}</span>
            </button>
          }
        </div>
      }

      <div
        #frame
        class="admin-area__frame"
        [style.height.px]="height()"
        (pointermove)="onMove($event)"
        (pointerleave)="hoverIndex.set(null)"
      >
        <svg
          class="admin-area__svg"
          [attr.viewBox]="'0 0 ' + width() + ' ' + height()"
          [attr.width]="width()"
          [attr.height]="height()"
          role="img"
          [attr.aria-label]="ariaLabel()"
        >
          <defs>
            @for (line of lines(); track line.key) {
              <linearGradient [attr.id]="line.gradientId" x1="0" y1="0" x2="0" y2="1">
                <!-- A style, not a presentation attribute: attributes do not resolve var(). -->
                <stop offset="0" [style.stop-color]="line.color" style="stop-opacity: 0.34" />
                <stop offset="1" [style.stop-color]="line.color" style="stop-opacity: 0" />
              </linearGradient>
            }
          </defs>

          @for (tick of yTicks(); track tick.value) {
            <line class="admin-axis__grid" [attr.x1]="left" [attr.x2]="width() - right" [attr.y1]="tick.y" [attr.y2]="tick.y" />
            @if (!compact()) {
              <text class="admin-axis__label" [attr.x]="left - 8" [attr.y]="tick.y" text-anchor="end" dominant-baseline="middle">
                {{ tick.label }}
              </text>
            }
          }
          @for (tick of xTicks(); track tick.index) {
            <text class="admin-axis__label" [attr.x]="tick.x" [attr.y]="height() - 6" [attr.text-anchor]="tick.anchor">
              {{ tick.label }}
            </text>
          }

          @for (line of lines(); track line.key) {
            @if (line.ghost) {
              <path class="admin-area__ghost" [attr.d]="line.ghost" [style.stroke]="line.color" />
            }
            <path class="admin-area__fill" [attr.d]="line.area" [attr.fill]="'url(#' + line.gradientId + ')'" />
            <path
              class="admin-area__line admin-draw"
              pathLength="1"
              [attr.d]="line.line"
              [style.stroke]="line.color"
              [style.color]="line.color"
            />
          }

          @if (hover(); as h) {
            <line class="admin-area__cross" [attr.x1]="h.x" [attr.x2]="h.x" [attr.y1]="top" [attr.y2]="height() - bottom" />
            @for (dot of h.dots; track dot.key) {
              <circle class="admin-area__dot" [attr.cx]="h.x" [attr.cy]="dot.y" r="4" [style.fill]="dot.color" />
            }
          }
        </svg>

        @if (hover(); as h) {
          <div
            class="admin-tooltip admin-area__tooltip"
            [class.admin-area__tooltip--flip]="h.flip"
            [style.left.px]="h.x"
            [style.top.px]="top"
          >
            <p class="admin-tooltip__title">{{ h.title }}</p>
            @for (row of h.rows; track row.key) {
              <p class="admin-tooltip__row">
                <span class="admin-tooltip__swatch" [style.background]="row.color"></span>
                <span class="admin-tooltip__name">{{ row.label }}</span>
                <span class="admin-tooltip__value">{{ row.value }}</span>
                @if (row.previous !== null) {
                  <span class="admin-tooltip__prev">was {{ row.previous }}</span>
                }
              </p>
            }
          </div>
        }
      </div>
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AdminAreaChart {
  /** Metric_Day labels, one per point. */
  readonly labels = input.required<readonly string[]>();
  readonly series = input.required<readonly AreaSeries[]>();
  readonly height = input(260);
  readonly legend = input(true);
  readonly compact = input(false);
  /** Draws each series' `previous` as a dashed ghost line. */
  readonly showPrevious = input(false);
  readonly format = input<(value: number) => string>(whole);

  readonly left = M.left;
  readonly right = M.right;
  readonly top = M.top;
  readonly bottom = M.bottom;

  private readonly frame = viewChild.required<ElementRef<HTMLDivElement>>('frame');
  readonly width = signal(640);
  readonly hidden = signal<ReadonlySet<string>>(new Set());
  readonly hoverIndex = signal<number | null>(null);
  private readonly gradientPrefix = chartId('area');

  constructor() {
    const destroyRef = inject(DestroyRef);
    afterNextRender(() => {
      const element = this.frame().nativeElement;
      const measure = () => {
        const next = Math.max(160, Math.round(element.clientWidth));
        if (next !== this.width()) this.width.set(next);
      };
      measure();
      if (typeof ResizeObserver === 'undefined') return;
      const observer = new ResizeObserver(measure);
      observer.observe(element);
      destroyRef.onDestroy(() => observer.disconnect());
    });
  }

  readonly visible = computed(() => this.series().filter((s) => !this.hidden().has(s.key)));

  private readonly max = computed(() => {
    let peak = 0;
    for (const s of this.visible()) {
      for (const v of s.values) peak = Math.max(peak, v ?? 0);
      if (this.showPrevious()) for (const v of s.previous ?? []) peak = Math.max(peak, v ?? 0);
    }
    return peak;
  });

  private readonly ticks = computed(() => niceTicks(this.max() * 1.08, this.compact() ? 2 : 4));
  private readonly top_ = computed(() => this.ticks()[this.ticks().length - 1] || 1);

  private readonly plotW = computed(() => this.width() - M.left - M.right);
  private readonly plotH = computed(() => this.height() - M.top - M.bottom);

  xOf(index: number): number {
    const n = this.labels().length;
    return M.left + (n <= 1 ? this.plotW() / 2 : (index / (n - 1)) * this.plotW());
  }

  yOf(value: number): number {
    return M.top + this.plotH() - (value / this.top_()) * this.plotH();
  }

  readonly yTicks = computed(() =>
    this.ticks().map((value) => ({ value, y: this.yOf(value), label: compact(value) })),
  );

  readonly xTicks = computed(() => {
    const labels = this.labels();
    const n = labels.length;
    if (n === 0) return [];
    const slots = Math.max(2, Math.min(n, Math.floor(this.plotW() / 84)));
    const step = Math.max(1, Math.round((n - 1) / (slots - 1)));
    const indexes = new Set<number>();
    for (let i = 0; i < n; i += step) indexes.add(i);
    indexes.add(n - 1);
    // Drop an interior tick that would crowd the pinned last one.
    const sorted = [...indexes].sort((a, b) => a - b);
    if (sorted.length > 2 && n - 1 - sorted[sorted.length - 2] < step * 0.6) sorted.splice(sorted.length - 2, 1);
    return sorted.map((index) => ({
      index,
      x: this.xOf(index),
      label: shortDay(labels[index]),
      anchor: n === 1 ? 'middle' : index === 0 ? 'start' : index === n - 1 ? 'end' : 'middle',
    }));
  });

  readonly lines = computed(() => {
    const baseline = M.top + this.plotH();
    const xOf = (i: number) => this.xOf(i);
    const yOf = (v: number) => this.yOf(v);
    return this.visible().map((s) => {
      const { line, area } = seriesPaths(s.values, xOf, yOf, baseline);
      const ghost =
        this.showPrevious() && s.previous ? seriesPaths(s.previous, xOf, yOf, baseline).line : null;
      return {
        key: s.key,
        color: `rgb(${toneVar(s.tone)})`,
        gradientId: `${this.gradientPrefix}-${s.key}`,
        line,
        area,
        ghost,
      };
    });
  });

  readonly legendEntries = computed(() =>
    this.series().map((s) => ({
      key: s.key,
      label: s.label,
      color: `rgb(${toneVar(s.tone)})`,
      hidden: this.hidden().has(s.key),
      total: compact(s.values.reduce<number>((sum, v) => sum + (v ?? 0), 0)),
    })),
  );

  readonly hover = computed(() => {
    const index = this.hoverIndex();
    const labels = this.labels();
    if (index === null || index < 0 || index >= labels.length) return null;
    const x = this.xOf(index);
    const fmt = this.format();
    const visible = this.visible();
    return {
      x,
      flip: x > this.width() * 0.62,
      title: longDay(labels[index]),
      dots: visible
        .filter((s) => s.values[index] !== null && s.values[index] !== undefined)
        .map((s) => ({ key: s.key, y: this.yOf(s.values[index] ?? 0), color: `rgb(${toneVar(s.tone)})` })),
      rows: visible.map((s) => {
        const value = s.values[index];
        const previous = this.showPrevious() ? s.previous?.[index] : undefined;
        return {
          key: s.key,
          label: s.label,
          color: `rgb(${toneVar(s.tone)})`,
          value: value === null || value === undefined ? '-' : fmt(value),
          previous: previous === null || previous === undefined ? null : fmt(previous),
        };
      }),
    };
  });

  readonly ariaLabel = computed(() => {
    const labels = this.labels();
    if (labels.length === 0) return 'Empty chart';
    const parts = this.series().map(
      (s) => `${s.label} ${whole(s.values.reduce<number>((sum, v) => sum + (v ?? 0), 0))}`,
    );
    return `Per-day chart from ${labels[0]} to ${labels[labels.length - 1]}. Totals: ${parts.join(', ')}.`;
  });

  toggle(key: string): void {
    const next = new Set(this.hidden());
    if (next.has(key)) next.delete(key);
    else if (next.size < this.series().length - 1) next.add(key);
    this.hidden.set(next);
  }

  onMove(event: PointerEvent): void {
    const n = this.labels().length;
    if (n === 0) return;
    const rect = this.frame().nativeElement.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const ratio = (x - M.left) / Math.max(1, this.plotW());
    const index = Math.round(Math.min(1, Math.max(0, ratio)) * (n - 1));
    if (index !== this.hoverIndex()) this.hoverIndex.set(index);
  }
}
