import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/**
 * A generic reusable card component for panel list items across the app.
 * Used in Connections, Skills, Workflows, Evals - anywhere a clickable row
 * with icon + meta + hover-revealed actions appears.
 *
 * Usage:
 * ```html
 * <app-panel-card (click)="doSomething()" [active]="isSelected">
 *   <i card-icon class="ti ti-plug-connected" aria-hidden="true"></i>
 *   <ng-container card-meta>
 *     <span class="phorma-card__title">Title</span>
 *     <span class="phorma-card__sub">Subtitle</span>
 *   </ng-container>
 *   <ng-container card-actions>
 *     <span role="button" class="phorma-card__action-btn">...</span>
 *   </ng-container>
 * </app-panel-card>
 * ```
 */
@Component({
  selector: 'app-panel-card',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ng-content select="[card-icon]"></ng-content>
    <span class="phorma-card__meta">
      <ng-content select="[card-meta]"></ng-content>
    </span>
    <span class="phorma-card__actions">
      <ng-content select="[card-actions]"></ng-content>
    </span>
  `,
  styleUrl: './panel-card.scss',
  host: {
    'class': 'phorma-card',
    '[class.phorma-card--active]': 'active()',
    '[class.phorma-card--compact]': 'compact()',
    'role': 'button',
    'tabindex': '0',
  },
})
export class PanelCard {
  /** Highlight the card as selected/active. */
  active = input(false);
  /** Compact mode: less padding, smaller text. Useful for dense lists. */
  compact = input(false);
}
