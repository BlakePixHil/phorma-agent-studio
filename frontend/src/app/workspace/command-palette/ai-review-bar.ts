import { ChangeDetectionStrategy, Component, inject } from '@angular/core';

import { AiEditSessionService } from '../../core/ai-edit-session.service';

/**
 * Canvas-anchored review bar shown after an AI build finishes: "AI edited
 * the canvas — Revert / Keep". Persists after the command palette closes so
 * the user can inspect the result first. Backed by the pending transaction
 * in {@link AiEditSessionService}; Ctrl+Z remains available independently.
 */
@Component({
  selector: 'app-ai-review-bar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './ai-review-bar.html',
  styleUrl: './ai-review-bar.scss',
})
export class AiReviewBar {
  protected readonly session = inject(AiEditSessionService);
}
