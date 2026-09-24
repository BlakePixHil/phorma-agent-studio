import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { TooltipModule } from 'primeng/tooltip';

/**
 * An info icon whose explanation appears on hover or keyboard focus. Replaces the
 * explainer footnotes the views used to carry. The copy is also in the DOM as
 * screen-reader text, so it stays readable to assistive technology and to specs.
 */
@Component({
  selector: 'admin-hint',
  imports: [TooltipModule],
  template: `
    <span
      class="admin-hint"
      tabindex="0"
      [pTooltip]="text()"
      tooltipPosition="top"
      tooltipEvent="both"
      tooltipStyleClass="admin-tip"
      [showDelay]="120"
    >
      <i class="ti {{ icon() }}" aria-hidden="true"></i>
      <span class="admin-sr">{{ text() }}</span>
    </span>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AdminHint {
  readonly text = input.required<string>();
  readonly icon = input('ti-info-circle');
}
