import {
  ChangeDetectionStrategy,
  Component,
  input,
  viewChild,
} from '@angular/core';
import { Popover, PopoverModule } from 'primeng/popover';

/**
 * A small (i) info icon that, on hover or focus, opens a frosted-glass popover
 * with rich HTML help text. Used in the Settings dialog to explain what each
 * property is for and where to configure it.
 *
 * Built on PrimeNG's `p-popover` so the panel is appended to the document
 * body (never clipped by the settings dialog's scroll container or overlapped
 * by the side nav) and positioning is handled by the library. Hover open is
 * emulated with a small leave delay so moving the mouse from the icon to the
 * panel doesn't dismiss it.
 */
@Component({
  selector: 'app-info-popover',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [PopoverModule],
  template: `
    <button
      type="button"
      class="phorma-info-popover__trigger"
      [attr.aria-label]="label() + ' - more information'"
      (mouseenter)="show($event)"
      (mouseleave)="scheduleHide()"
      (focus)="show($event)"
      (blur)="scheduleHide()"
      (click)="$event.stopPropagation()"
    >
      <i class="ti {{ icon() }}" aria-hidden="true"></i>
    </button>

    <p-popover #pop styleClass="phorma-info-popover" [dismissable]="false" [showTransitionOptions]="'0.12s ease-out'">
      <div (mouseleave)="scheduleHide()" (mouseenter)="cancelHide()">
        @if (heading()) {
          <div class="phorma-info-popover__heading">{{ heading() }}</div>
        }
        <div class="phorma-info-popover__body">
          <ng-content />
        </div>
      </div>
    </p-popover>
  `,
  styles: [
    `
      :host {
        display: inline-flex;
        font-family: inherit;
      }

      .phorma-info-popover__trigger {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        padding: 0;
        border: none;
        background: transparent;
        color: var(--p-text-muted-color);
        cursor: help;
        font-size: 0.85rem;
        line-height: 1;
        transition: color 0.15s ease;

        &:hover,
        &:focus-visible {
          color: var(--p-primary-color);
          outline: none;
        }

        i {
          font-size: inherit;
        }
      }
    `,
  ],
})
export class InfoPopover {
  private readonly popover = viewChild.required<Popover>('pop');

  /** Accessible label for the trigger button. */
  readonly label = input.required<string>();
  /** Optional bold heading shown at the top of the popover. */
  readonly heading = input<string>('');

  /**
   * Trigger glyph, as a Tabler icon name. Defaults to the (i) every settings row
   * uses; `ti-help-circle` suits "why does this exist" copy better than "what is
   * this field". Anything else would be a third affordance for one behaviour, so
   * keep it to those two.
   */
  readonly icon = input<string>('ti-info-circle');

  private hideTimer: ReturnType<typeof setTimeout> | null = null;

  protected show(event: Event): void {
    this.cancelHide();
    this.popover().show(event);
  }

  protected scheduleHide(): void {
    this.cancelHide();
    this.hideTimer = setTimeout(() => this.popover().hide(), 120);
  }

  protected cancelHide(): void {
    if (this.hideTimer) {
      clearTimeout(this.hideTimer);
      this.hideTimer = null;
    }
  }
}
