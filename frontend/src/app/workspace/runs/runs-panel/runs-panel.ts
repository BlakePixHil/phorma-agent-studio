import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { CurrencyPipe, DatePipe, DecimalPipe } from '@angular/common';

import { CloudService } from '../../../core/cloud.service';
import { RunControllerService } from '../../../core/run-controller.service';
import { TerminalOutputService } from '../../../core/terminal-output.service';
import { ButtonModule } from 'primeng/button';

/**
 * The Runs panel (right side): task input, run controls, pending approvals,
 * and the trace timeline — every RunEvent as a scannable, expandable entry.
 *
 * When the cloud monitor is connected, Run/Stop target the DEPLOYED instance
 * and its events animate the canvas through the same pipeline.
 */
@Component({
  selector: 'app-runs-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CurrencyPipe, DatePipe, DecimalPipe, ButtonModule],
  templateUrl: './runs-panel.html',
  styleUrl: './runs-panel.scss',
})
export class RunsPanel {
  protected readonly runController = inject(RunControllerService);
  protected readonly terminal = inject(TerminalOutputService);
  protected readonly cloud = inject(CloudService);

  /** Trace entry ids the user has expanded. */
  protected readonly expanded = signal<ReadonlySet<number>>(new Set());

  /** Cumulative run usage (tokens + cost when the provider reports it). */
  protected readonly usage = this.runController.runUsage;

  protected onInput(event: Event): void {
    this.runController.runInput.set((event.target as HTMLTextAreaElement | null)?.value ?? '');
  }

  /** Run — local engine, or the deployed instance while cloud-connected. */
  protected run(): void {
    if (this.cloud.connected()) {
      this.cloud.triggerRemote(this.runController.runInput().trim());
      return;
    }
    this.runController.start();
  }

  protected stop(): void {
    if (this.cloud.connected()) {
      this.cloud.stopRemote();
      return;
    }
    this.runController.stop();
  }

  protected toggleExpanded(id: number): void {
    this.expanded.update(current => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
}
