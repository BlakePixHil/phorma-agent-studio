import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { CurrencyPipe, DatePipe, DecimalPipe, NgTemplateOutlet } from '@angular/common';

import { CloudService } from '../../../core/cloud.service';
import { RunControllerService, TraceEntry } from '../../../core/run-controller.service';
import { TerminalOutputService } from '../../../core/terminal-output.service';
import { ButtonModule } from 'primeng/button';
import { Textarea } from 'primeng/textarea';

/**
 * A run of consecutive tool-activity entries, folded into a single collapsible
 * container. A `grouped` run holds > 1 tool entry; anything else (a lone tool
 * call or a non-tool event) is rendered inline as a single entry.
 */
export interface TraceGroup {
  /** Stable key for @for tracking. */
  key: string;
  /** True when this run should render as a collapsible container. */
  grouped: boolean;
  entries: TraceEntry[];
}

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
  imports: [CurrencyPipe, DatePipe, DecimalPipe, NgTemplateOutlet, ButtonModule, Textarea],
  templateUrl: './runs-panel.html',
  styleUrl: './runs-panel.scss',
})
export class RunsPanel {
  protected readonly runController = inject(RunControllerService);
  protected readonly terminal = inject(TerminalOutputService);
  protected readonly cloud = inject(CloudService);

  /** Trace entry ids the user has expanded. */
  protected readonly expanded = signal<ReadonlySet<number>>(new Set());

  /** Group keys the user has collapsed (groups start expanded). */
  protected readonly collapsedGroups = signal<ReadonlySet<string>>(new Set());

  /** Trace entry id whose payload was just copied (drives the green tick). */
  protected readonly copiedId = signal<number | null>(null);
  private copyTimer?: ReturnType<typeof setTimeout>;

  /** Cumulative run usage (tokens + cost when the provider reports it). */
  protected readonly usage = this.runController.runUsage;

  /**
   * The trace, with consecutive tool-activity entries folded into containers.
   * A run of two or more tool entries becomes one collapsible group; single
   * tool entries and every non-tool event render inline.
   */
  protected readonly traceGroups = computed<TraceGroup[]>(() => {
    const groups: TraceGroup[] = [];
    let bucket: TraceEntry[] | null = null;

    for (const entry of this.runController.trace()) {
      if (entry.kind === 'tool-call' || entry.kind === 'tool-result') {
        if (!bucket) {
          bucket = [];
          groups.push({ key: `g${entry.id}`, grouped: true, entries: bucket });
        }
        bucket.push(entry);
      } else {
        bucket = null;
        groups.push({ key: `e${entry.id}`, grouped: false, entries: [entry] });
      }
    }

    return groups;
  });

  /**
   * Logical tool-call count for a group's header. A call and its result are
   * two entries but one step, so we count the calls (this lines up with the
   * "max tool calls" setting). Falls back to entry count if calls are absent.
   */
  protected groupStepCount(group: TraceGroup): number {
    const calls = group.entries.filter(entry => entry.kind === 'tool-call').length;
    return calls || group.entries.length;
  }

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

  protected isGroupCollapsed(key: string): boolean {
    return this.collapsedGroups().has(key);
  }

  protected toggleGroup(key: string): void {
    this.collapsedGroups.update(current => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  /** Copy an entry's payload to the clipboard and flash the green tick. */
  protected async copyDetail(entry: TraceEntry, event: Event): Promise<void> {
    event.stopPropagation();
    if (!entry.detail) return;

    try {
      await navigator.clipboard.writeText(entry.detail);
    } catch {
      // Fallback for insecure contexts where the async clipboard is blocked.
      const textarea = document.createElement('textarea');
      textarea.value = entry.detail;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      try {
        document.execCommand('copy');
      } finally {
        document.body.removeChild(textarea);
      }
    }

    this.copiedId.set(entry.id);
    clearTimeout(this.copyTimer);
    this.copyTimer = setTimeout(() => this.copiedId.set(null), 1500);
  }
}
