import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked } from '@angular/core';

import { DecisionTransportService } from '../../../core/decision-transport.service';
import { RunControllerService } from '../../../core/run-controller.service';
import type { TriageVerdict } from '../../../core/studio-assist';

type TriageState = 'idle' | 'loading' | 'done' | 'failed';

/**
 * "Why did this fail?" for a failed run: System One classifies the error into
 * an actionable category with a remedy, and estimates whether a plain retry
 * would work. One explicit click, one small metered call. Deferred by the Runs
 * panel and rendered only for a failed run with a decision backend.
 */
@Component({
  selector: 'app-run-triage',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './run-triage.html',
  styleUrl: './run-triage.scss',
})
export class RunTriage {
  private readonly runController = inject(RunControllerService);
  private readonly decisions = inject(DecisionTransportService);

  protected readonly state = signal<TriageState>('idle');
  protected readonly verdict = signal<TriageVerdict | null>(null);

  /** The last error entry of the trace: what failed and why. */
  private readonly failure = computed(() => {
    const trace = this.runController.trace();
    const errors = trace.filter(entry => entry.tone === 'error');
    const last = errors[errors.length - 1];
    if (!last) return null;
    // The FIRST error is the step that broke; later ones (the enclosing
    // trigger, "Run failed") only echo it upward.
    const first = errors[0]!;
    return {
      error: last.detail?.trim() || first.detail?.trim() || last.label,
      failedStep: first.label.replace(/ failed$/, ''),
      recentTrace: trace.slice(-12).map(entry => entry.label),
    };
  });

  constructor() {
    // A new run (or a reset) invalidates the verdict.
    effect(() => {
      this.failure();
      untracked(() => {
        this.state.set('idle');
        this.verdict.set(null);
      });
    });
  }

  protected percent(value: number): string {
    return `${Math.round(value * 100)}%`;
  }

  protected async triage(): Promise<void> {
    const failure = this.failure();
    const client = this.decisions.create();
    if (!failure || !client) return;
    this.state.set('loading');
    try {
      const { triageFailure } = await import('../../../core/studio-assist');
      const verdict = await triageFailure(client, this.decisions.defaultModel(), failure);
      if (this.failure() !== failure) return;
      this.verdict.set(verdict);
      this.state.set(verdict ? 'done' : 'failed');
    } catch {
      this.state.set('failed');
    }
  }
}
