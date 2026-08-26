import { DecimalPipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  input,
  signal,
  viewChild,
} from '@angular/core';

import type { GroupRow } from '../../core/models';
import { metricOf } from '../view-data';
import { WORLD_SHAPES, WORLD_VIEWBOX, type WorldShape } from './world-map.data';

/** Floor opacity for any country with at least one install, so it never reads as "no data". */
const MIN_INK = 0.15;
const MAX_INK = 1;

/** One country shape plus the metrics and shading this range gives it. */
export interface PaintedShape extends WorldShape {
  readonly installs: number;
  readonly runs: number;
  readonly share: number;
  readonly opacity: number;
}

/**
 * Shades every mapped country by its installs relative to the busiest one, on a
 * square-root curve so one dominant country does not wash every other one out
 * to near-zero opacity, the way a linear scale would.
 *
 * `share` is installs over the total across ALL rows the caller passes,
 * including the k-anonymity `other` fold - an honest denominator even though
 * `other` itself never paints (it is not a real country code).
 */
export function paintShapes(
  rows: readonly GroupRow[],
  shapes: readonly WorldShape[] = WORLD_SHAPES,
): PaintedShape[] {
  const byCode = new Map(rows.map((row) => [row.label, row]));
  const total = rows.reduce((sum, row) => sum + row.installs, 0);
  const max = shapes.reduce((peak, shape) => {
    const row = byCode.get(shape.code);
    return row ? Math.max(peak, row.installs) : peak;
  }, 0);

  return shapes.map((shape) => {
    const row = byCode.get(shape.code);
    const installs = row?.installs ?? 0;
    const runs = row ? metricOf(row, 'runs') : 0;
    const share = total > 0 ? (installs / total) * 100 : 0;
    const opacity =
      installs > 0 && max > 0 ? MIN_INK + (MAX_INK - MIN_INK) * Math.sqrt(installs / max) : 0;
    return { ...shape, installs, runs, share, opacity };
  });
}

/** Installs that landed on no shape: the k-anonymity `other` fold, `XX`, or any code with no geometry. */
export function unmappedInstalls(
  rows: readonly GroupRow[],
  shapes: readonly WorldShape[] = WORLD_SHAPES,
): number {
  const codes = new Set(shapes.map((shape) => shape.code));
  return rows.reduce((sum, row) => (codes.has(row.label) ? sum : sum + row.installs), 0);
}

/** Names the busiest countries, for the map's one accessible label (paths are not individually focusable). */
function summarize(painted: readonly PaintedShape[]): string {
  const top = [...painted]
    .filter((shape) => shape.installs > 0)
    .sort((a, b) => b.installs - a.installs)
    .slice(0, 3);
  if (top.length === 0) {
    return 'World map of installs by country. No installs reported a location in this range.';
  }
  const parts = top.map((shape) => `${shape.name} ${Math.round(shape.share)}%`);
  return `World map of installs by country. Highest share: ${parts.join(', ')}.`;
}

/**
 * The GA-style choropleth: one flat ink colour per country, opacity carrying
 * the signal, painted from build-time-generated Natural Earth geometry
 * (`world-map.data.ts`) so the app takes on no runtime mapping dependency.
 *
 * Countries with no installs keep the neutral `--admin-map-base` fill rather
 * than ink at a near-zero opacity, so the whole landmass reads as "no data"
 * instead of as a washed-out version of the ink scale. The ink colour itself is
 * a CSS custom property, so the fill flips between the light and dark themes
 * for free instead of being recomputed here.
 *
 * The countries table below this component is the accessible equivalent of
 * what it shows (Requirement-style parity with `GroupTable`): the map's own
 * `aria-label` only names the top few countries, and its paths are not
 * individually focusable.
 */
@Component({
  selector: 'admin-world-map',
  imports: [DecimalPipe],
  template: `
    <div
      #mapContainer
      class="admin-map"
      (pointermove)="onMove($event)"
      (pointerleave)="clearHover()"
    >
      <svg
        class="admin-map__svg"
        [attr.viewBox]="viewBox"
        role="img"
        [attr.aria-label]="mapSummary()"
      >
        @for (shape of painted(); track shape.code) {
          <path
            [attr.d]="shape.d"
            class="admin-map__country"
            [style.fill]="fillFor(shape)"
            (pointerenter)="hover(shape)"
          />
        }
      </svg>

      @if (hovered(); as shape) {
        <div
          class="admin-map__tooltip"
          [class.admin-map__tooltip--flip]="flip()"
          [style.left.px]="pointer().x"
          [style.top.px]="pointer().y"
        >
          <p class="admin-map__tooltip-name">{{ shape.name }}</p>
          <p class="admin-map__tooltip-row">{{ shape.installs | number }} installs</p>
          <p class="admin-map__tooltip-row">{{ shape.runs | number }} runs</p>
          <p class="admin-map__tooltip-row">{{ shape.share | number: '1.0-1' }}% of range</p>
        </div>
      }
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WorldMap {
  readonly rows = input.required<readonly GroupRow[]>();

  readonly viewBox = WORLD_VIEWBOX;
  readonly painted = computed(() => paintShapes(this.rows()));
  readonly mapSummary = computed(() => summarize(this.painted()));

  private readonly mapContainer = viewChild.required<ElementRef<HTMLDivElement>>('mapContainer');
  private readonly containerWidth = signal(0);

  readonly hovered = signal<PaintedShape | null>(null);
  readonly pointer = signal({ x: 0, y: 0 });
  /** Flips the tooltip to the left of the cursor once it is past 70% of the map's width. */
  readonly flip = computed(() => this.pointer().x > this.containerWidth() * 0.7);

  fillFor(shape: PaintedShape): string {
    return shape.opacity > 0
      ? `rgb(var(--admin-map-ink) / ${shape.opacity})`
      : 'var(--admin-map-base)';
  }

  hover(shape: PaintedShape): void {
    this.hovered.set(shape);
  }

  clearHover(): void {
    this.hovered.set(null);
  }

  onMove(event: PointerEvent): void {
    const rect = this.mapContainer().nativeElement.getBoundingClientRect();
    this.containerWidth.set(rect.width);
    this.pointer.set({ x: event.clientX - rect.left, y: event.clientY - rect.top });
  }
}
