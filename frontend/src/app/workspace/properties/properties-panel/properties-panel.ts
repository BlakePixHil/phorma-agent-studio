import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { ButtonModule } from 'primeng/button';

import { PanelExpandService } from '../../../core/panel-expand.service';
import { PropertiesForm } from '../properties-form/properties-form';

/**
 * The Properties panel (right side): a single narrow column of node
 * configuration.
 *
 * The form itself lives in {@link PropertiesForm}, shared with the expanded
 * Properties dialog - this component only supplies the sidebar chrome and the
 * expand affordance.
 */
@Component({
  selector: 'app-properties-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ButtonModule, PropertiesForm],
  templateUrl: './properties-panel.html',
  styleUrl: './properties-panel.scss',
})
export class PropertiesPanel {
  private readonly panelExpand = inject(PanelExpandService);

  /** Opens the expanded properties dialog (multi-column, wide editors). */
  protected expand(): void {
    this.panelExpand.open('properties');
  }
}
