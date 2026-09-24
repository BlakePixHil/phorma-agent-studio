import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/**
 * The raw numbers behind a chart, one click away. A native `<details>`, so the
 * tables stay in the DOM (accessible, and asserted by the specs) while the page
 * leads with the picture.
 */
@Component({
  selector: 'admin-data',
  template: `
    <details class="admin-data">
      <summary class="admin-data__toggle">
        <i class="ti ti-table" aria-hidden="true"></i>
        <span>{{ label() }}</span>
        <i class="ti ti-chevron-down admin-data__chevron" aria-hidden="true"></i>
      </summary>
      <div class="admin-data__body">
        <ng-content />
      </div>
    </details>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AdminData {
  readonly label = input('View data');
}
