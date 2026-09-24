import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { TooltipModule } from 'primeng/tooltip';

import { longDay, shortDay, whole } from '../format';
import { heatOpacity, weekGrid } from './chart-math';
import { toneVar, type Tone } from './tones';

const WEEKDAYS = ['Mon', '', 'Wed', '', 'Fri', '', ''];

/** A GitHub-style day grid: one column per week, opacity by value. */
@Component({
  selector: 'admin-calendar',
  imports: [TooltipModule],
  template: `
    <div class="admin-cal" [style.--tone]="toneColor()">
      <div class="admin-cal__weekdays" aria-hidden="true">
        @for (name of weekdays; track $index) {
          <span>{{ name }}</span>
        }
      </div>
      <div class="admin-cal__scroll">
        <div class="admin-cal__months" aria-hidden="true">
          @for (week of grid(); track $index) {
            <span class="admin-cal__month">{{ week.month }}</span>
          }
        </div>
        <div class="admin-cal__grid" role="img" [attr.aria-label]="ariaLabel()">
          @for (week of grid(); track $index) {
            <div class="admin-cal__week">
              @for (cell of week.cells; track $index) {
                @if (cell) {
                  <span
                    class="admin-cal__cell"
                    [class.admin-cal__cell--zero]="cell.opacity === 0"
                    [style.--heat]="cell.opacity"
                    [pTooltip]="cell.tip"
                    tooltipPosition="top"
                    tooltipStyleClass="admin-tip"
                  ></span>
                } @else {
                  <span class="admin-cal__cell admin-cal__cell--pad"></span>
                }
              }
            </div>
          }
        </div>
      </div>
      <div class="admin-cal__scale" aria-hidden="true">
        <span>Less</span>
        @for (step of scale; track step) {
          <span class="admin-cal__cell" [style.--heat]="step"></span>
        }
        <span>More</span>
      </div>
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AdminCalendar {
  readonly from = input.required<string>();
  readonly to = input.required<string>();
  readonly values = input.required<ReadonlyMap<string, number>>();
  readonly tone = input<Tone>('iris');
  readonly unit = input('');

  readonly weekdays = WEEKDAYS;
  readonly scale = [0.14, 0.36, 0.58, 0.8, 1];
  readonly toneColor = computed(() => toneVar(this.tone()));

  readonly grid = computed(() => {
    const values = this.values();
    const max = [...values.values()].reduce((peak, v) => Math.max(peak, v), 0);
    let lastMonth = '';
    return weekGrid(this.from(), this.to()).map((week) => {
      const firstDay = week.find((day) => day !== null) ?? '';
      const month = shortDay(firstDay).split(' ')[0];
      const label = month !== lastMonth ? month : '';
      lastMonth = month;
      return {
        month: label,
        cells: week.map((day) => {
          if (day === null) return null;
          const value = values.get(day) ?? null;
          return {
            day,
            opacity: heatOpacity(value, max),
            tip: `${longDay(day)}: ${value === null ? 'no data' : `${whole(value)} ${this.unit()}`.trim()}`,
          };
        }),
      };
    });
  });

  readonly ariaLabel = computed(() => `Daily ${this.unit()} from ${this.from()} to ${this.to()}.`);
}
