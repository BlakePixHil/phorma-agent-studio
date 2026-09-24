import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  input,
  signal,
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';

import type { ChatStep } from '../../../core/assistant-chat.model';

/** Finished steps shorter than this show no duration. */
const MIN_SHOWN_DURATION_MS = 50;

/**
 * The list of things the assistant did in one turn - one row per studio
 * action or tool call.
 *
 * - **Live** (`live`): every row visible, status updating in place (spinner,
 *   check, red alert), with a ticking duration on the running row.
 * - **Finished**: collapsed behind a one-line summary ("Performed 6 steps ·
 *   4.2s"), because an Agent-mode turn can take dozens of actions and the
 *   answer is what the user came for. Expanding shows the same rows.
 *
 * Any row that carries arguments, a result or an error is itself a disclosure
 * onto that detail. Expansion state is component-local view state: the panel
 * and the expanded dialog are separate instances and should not fight over it.
 */
@Component({
  selector: 'app-chat-steps',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgTemplateOutlet],
  templateUrl: './chat-steps.html',
  styleUrl: './chat-steps.scss',
})
export class ChatSteps {
  readonly steps = input.required<readonly ChatStep[]>();
  /** True while the turn is in flight: rows are shown uncollapsed. */
  readonly live = input(false);

  /** Whether the finished list is expanded. */
  protected readonly expanded = signal(false);
  /** Step ids whose detail is open. */
  private readonly openRows = signal<ReadonlySet<string>>(new Set());
  /** Clock for the running row's duration. */
  private readonly now = signal(Date.now());

  protected readonly failedCount = computed(
    () => this.steps().filter(step => step.status === 'failed').length,
  );

  protected readonly running = computed(() => this.steps().some(step => step.status === 'running'));

  /** "Performed 6 steps" (or "Took 1 step"). */
  protected readonly summary = computed(() => {
    const count = this.steps().length;
    return `Performed ${count} ${count === 1 ? 'step' : 'steps'}`;
  });

  /** Wall time from the first step's start to the last step's end. */
  protected readonly totalDuration = computed(() => {
    const steps = this.steps();
    if (steps.length === 0) return '';
    const start = Math.min(...steps.map(step => step.startedAt));
    const end = Math.max(...steps.map(step => step.endedAt ?? step.startedAt));
    return end > start ? formatDuration(end - start) : '';
  });

  constructor() {
    effect(onCleanup => {
      if (!this.live() || !this.running()) return;
      const timer = setInterval(() => this.now.set(Date.now()), 250);
      onCleanup(() => clearInterval(timer));
    });
  }

  protected toggle(): void {
    this.expanded.update(open => !open);
  }

  protected hasDetail(step: ChatStep): boolean {
    return !!(step.args || step.result || step.error);
  }

  protected isOpen(step: ChatStep): boolean {
    return this.openRows().has(step.id);
  }

  protected toggleRow(step: ChatStep): void {
    this.openRows.update(open => {
      const next = new Set(open);
      if (!next.delete(step.id)) next.add(step.id);
      return next;
    });
  }

  /** Duration label for one row; ticks while the step runs. */
  protected duration(step: ChatStep): string {
    if (step.status === 'running') {
      return this.live() ? formatDuration(Math.max(0, this.now() - step.startedAt)) : '';
    }
    if (step.endedAt === undefined) return '';
    const ms = step.endedAt - step.startedAt;
    // A local read finishes in a few ms; "0ms" reads as a broken timer, and a
    // duration only says something once it is long enough to notice.
    return ms < MIN_SHOWN_DURATION_MS ? '' : formatDuration(ms);
  }

  protected statusLabel(step: ChatStep): string {
    return step.status === 'running' ? 'Running' : step.status === 'failed' ? 'Failed' : 'Done';
  }
}

/** "120ms", "1.4s", "12s", "2m 05s". */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms / 10) * 10}ms`;
  const seconds = ms / 1000;
  if (seconds < 10) return `${seconds.toFixed(1)}s`;
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds - minutes * 60);
  return `${minutes}m ${String(rest).padStart(2, '0')}s`;
}
