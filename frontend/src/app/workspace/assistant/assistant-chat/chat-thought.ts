import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { DomSanitizer, type SafeHtml } from '@angular/platform-browser';

import { renderMarkdown } from '../../../shared/markdown/render-markdown';
import { formatDuration } from './chat-steps';

/**
 * The model's reasoning once it has finished thinking: a collapsed
 * "Thought for 8s" disclosure that opens onto the full text, rendered as
 * sanitized markdown through the shared rail. The live counterpart is
 * {@link ThinkingBubble}.
 */
@Component({
  selector: 'app-chat-thought',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="phorma-thought-done">
      <!-- No aria-controls: panel and dialog both render this. -->
      <button
        type="button"
        class="phorma-thought-done__head"
        [attr.aria-expanded]="open()"
        (click)="open.set(!open())"
      >
        <i
          class="ti phorma-thought-done__chevron"
          [class.ti-chevron-down]="open()"
          [class.ti-chevron-right]="!open()"
          aria-hidden="true"
        ></i>
        <i class="ti ti-brain phorma-thought-done__icon" aria-hidden="true"></i>
        <span>{{ label() }}</span>
      </button>
      @if (open()) {
        <div class="phorma-thought-done__body selectable" [innerHTML]="html()"></div>
      }
    </div>
  `,
  styles: `
    :host { display: block; width: 100%; }

    .phorma-thought-done__head {
      display: flex;
      align-items: center;
      gap: 0.4rem;
      width: 100%;
      padding: 0.22rem 0.25rem;
      border: 0;
      border-radius: 0.35rem;
      background: none;
      font: inherit;
      font-size: 0.857rem;
      line-height: 1.45;
      font-weight: 600;
      color: var(--p-text-muted-color);
      text-align: left;
      cursor: pointer;
      transition: background 0.15s ease, color 0.15s ease;
    }
    .phorma-thought-done__head:hover {
      background: color-mix(in srgb, var(--p-text-color) 6%, transparent);
      color: var(--p-text-color);
    }
    .phorma-thought-done__head:focus-visible {
      outline: 2px solid color-mix(in srgb, var(--p-primary-color) 60%, transparent);
      outline-offset: 1px;
    }
    .phorma-thought-done__chevron { flex-shrink: 0; font-size: 0.72rem; }
    .phorma-thought-done__icon { flex-shrink: 0; font-size: 0.8rem; opacity: 0.8; }

    /* Indented under the header like expanded steps, and capped so a long
       reasoning trace scrolls in place instead of pushing the answer away. */
    .phorma-thought-done__body {
      max-height: 16rem;
      overflow-y: auto;
      margin: 0.1rem 0 0.2rem 0.55rem;
      padding: 0.1rem 0.2rem 0.1rem 0.75rem;
      border-left: 1px solid color-mix(in srgb, var(--p-text-color) 9%, transparent);
      font-size: 0.786rem;
      line-height: 1.6;
      color: var(--p-text-muted-color);
      overflow-wrap: anywhere;
    }

    /* [innerHTML] content gets no _ngcontent attribute, so descendants need
       ::ng-deep (see the note on .phorma-chat__md). */
    :host ::ng-deep .phorma-thought-done__body {
      > :first-child { margin-top: 0; }
      > :last-child { margin-bottom: 0; }
      p { margin: 0 0 0.5rem; }
      ul, ol { margin: 0 0 0.5rem; padding-left: 1.2rem; }
      ul { list-style: disc outside; }
      ol { list-style: decimal outside; }
      h1, h2, h3, h4, h5, h6 { margin: 0.6rem 0 0.25rem; font-size: 0.82rem; font-weight: 700; }
      code {
        padding: 0.05rem 0.25rem;
        border-radius: 0.25rem;
        background: color-mix(in srgb, var(--p-text-color) 8%, transparent);
        font-size: 0.92em;
      }
      pre { margin: 0 0 0.5rem; overflow-x: auto; }
      pre code { background: none; padding: 0; }
    }
  `,
})
export class ChatThought {
  private readonly sanitizer = inject(DomSanitizer);

  readonly text = input.required<string>();
  readonly durationMs = input(0);

  protected readonly open = signal(false);

  protected readonly label = computed(() => {
    const ms = this.durationMs();
    return ms >= 1000 ? `Thought for ${formatDuration(ms)}` : 'Thought briefly';
  });

  protected readonly html = computed<SafeHtml>(() =>
    this.sanitizer.bypassSecurityTrustHtml(renderMarkdown(this.text())),
  );
}
