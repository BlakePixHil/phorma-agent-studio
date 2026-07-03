import { Directive, input, TemplateRef, inject } from '@angular/core';

/**
 * Structural marker directive applied to an `<ng-template>` inside `<app-sidebar>`.
 * Associates a block of content with a specific panel tab id.
 *
 * Usage:
 *   <ng-template sidePanelPane tabId="components">…content…</ng-template>
 */
@Directive({
  selector: '[sidePanelPane]',
  standalone: true,
})
export class SidePanelPane {
  /** Must match a `PanelTab.id` registered in `PanelRegistryService`. */
  readonly tabId = input.required<string>();

  readonly templateRef = inject(TemplateRef);
}
