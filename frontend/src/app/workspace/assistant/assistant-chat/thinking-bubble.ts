import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterRenderEffect,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
  viewChild,
} from '@angular/core';

/** One chunk of streamed reasoning, rendered as its own fading span. */
interface ThoughtSegment {
  id: number;
  text: string;
}

/** Segments kept in the DOM while streaming. Older ones are merged into one. */
const LIVE_SEGMENTS = 40;

/**
 * The live "thinking" bubble for an in-flight assistant turn.
 *
 * A fixed-height window onto the model's streamed reasoning: newest text at
 * the bottom, auto-scrolled, older text fading out under a top mask - a
 * glimpse of what the model is working on, not a transcript. The full text is
 * shown later, collapsed, on the finished turn.
 *
 * Deltas are coalesced per animation frame and each frame's text is appended
 * as ONE span with a short fade-in, so the text visibly streams in without
 * re-rendering (or re-parsing markdown for) everything already shown. Plain
 * text on purpose: half-streamed markdown is noise at this size, and the
 * finished turn renders it properly.
 */
@Component({
  selector: 'app-thinking-bubble',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="phorma-thought" role="status" aria-live="off" [attr.aria-label]="'Thinking'">
      <div class="phorma-thought__head">
        <i class="ti ti-brain phorma-thought__icon" aria-hidden="true"></i>
        <span class="phorma-thought__label">{{ label() }}</span>
        <span class="phorma-thought__time">{{ elapsedLabel() }}</span>
      </div>
      @if (segments().length > 0) {
        <div #window class="phorma-thought__window selectable">
          <p class="phorma-thought__text">
            @for (segment of segments(); track segment.id) {
              <span class="phorma-thought__seg">{{ segment.text }}</span>
            }
          </p>
        </div>
      }
    </div>
  `,
  styleUrl: './thinking-bubble.scss',
})
export class ThinkingBubble {
  /** Cumulative reasoning text streamed so far. */
  readonly text = input.required<string>();
  /** When thinking started (epoch ms), for the elapsed clock. */
  readonly startedAt = input<number | null>(null);
  /** When thinking stopped, or null while it continues. */
  readonly endedAt = input<number | null>(null);

  protected readonly segments = signal<ThoughtSegment[]>([]);
  private readonly now = signal(Date.now());
  private readonly windowRef = viewChild<ElementRef<HTMLElement>>('window');

  /** Characters already turned into segments. */
  private consumed = 0;
  private nextId = 0;
  private frame: number | null = null;

  protected readonly label = computed(() => (this.endedAt() === null ? 'Thinking' : 'Thought'));

  protected readonly elapsedLabel = computed(() => {
    const started = this.startedAt();
    if (started === null) return '';
    const seconds = Math.max(0, Math.round(((this.endedAt() ?? this.now()) - started) / 1000));
    return `${seconds}s`;
  });

  constructor() {
    // Coalesce deltas into one segment per animation frame.
    effect(() => {
      const text = this.text();
      untracked(() => {
        if (text.length < this.consumed) {
          // A new turn reused the component: start over.
          this.consumed = 0;
          this.segments.set([]);
        }
        if (text.length > this.consumed && this.frame === null) {
          this.frame = requestAnimationFrame(() => this.flush());
        }
      });
    });

    // The elapsed clock ticks only while thinking.
    effect(onCleanup => {
      if (this.startedAt() === null || this.endedAt() !== null) return;
      const timer = setInterval(() => this.now.set(Date.now()), 500);
      onCleanup(() => clearInterval(timer));
    });

    // Keep the newest thought in view after each render.
    afterRenderEffect(() => {
      this.segments();
      const el = this.windowRef()?.nativeElement;
      if (el) el.scrollTop = el.scrollHeight;
    });

    // Stop a pending frame if the bubble is destroyed mid-stream.
    inject(DestroyRef).onDestroy(() => {
      if (this.frame !== null) cancelAnimationFrame(this.frame);
    });
  }

  private flush(): void {
    this.frame = null;
    const text = this.text();
    const delta = text.slice(this.consumed);
    if (!delta) return;
    this.consumed = text.length;
    this.segments.update(list => {
      const next = [...list, { id: this.nextId++, text: delta }];
      if (next.length <= LIVE_SEGMENTS) return next;
      // Merge the oldest into one settled span so the DOM stays small; they
      // have long finished fading in and sit under the top mask anyway.
      const overflow = next.length - LIVE_SEGMENTS + 1;
      const merged = next.slice(0, overflow).map(segment => segment.text).join('');
      return [{ id: next[0].id, text: merged }, ...next.slice(overflow)];
    });
  }
}
