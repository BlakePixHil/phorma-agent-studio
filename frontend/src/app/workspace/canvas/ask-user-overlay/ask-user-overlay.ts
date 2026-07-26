import {
    ChangeDetectionStrategy,
    Component,
    ElementRef,
    computed,
    effect,
    inject,
    input,
    output,
    viewChild,
} from '@angular/core';
import { DomSanitizer, type SafeHtml } from '@angular/platform-browser';
import DOMPurify from 'dompurify';
import { marked } from 'marked';

/**
 * The answer box for a suspended Ask-User node, anchored directly beneath its
 * canvas node.
 *
 * Ask User is the one flow primitive that cannot advance without the operator,
 * so the input lives where their eyes already are — on the node that is
 * pulsing amber — rather than only in a side panel they may not have open.
 * It is deliberately NON-blocking: the canvas stays pannable and the trace
 * stays readable while the user decides what to answer.
 *
 * Positioning is driven by the host (GraphCanvas) via the `screenX`, `screenY`,
 * `screenW` inputs, which are updated every animation frame from the renderer's
 * transform so the card tracks pan/zoom — the same contract as ThinkingOverlay.
 */
@Component({
    selector: 'app-ask-user-overlay',
    changeDetection: ChangeDetectionStrategy.OnPush,
    template: `
    <div class="phorma-ask" (pointerdown)="$event.stopPropagation()">
      <header class="phorma-ask__header">
        <i class="ti ti-message-question" aria-hidden="true"></i>
        <span class="phorma-ask__title">{{ nodeName() }}</span>
      </header>
      <div class="phorma-ask__question" [innerHTML]="renderedQuestion()"></div>
      <textarea
        #box
        class="phorma-ask__input"
        rows="2"
        placeholder="Type your answer…"
        [attr.aria-label]="'Answer for ' + nodeName()"
        [value]="draft()"
        (input)="onInput($event)"
        (keydown.control.enter)="submit()"
        (keydown.meta.enter)="submit()"
      ></textarea>
      <div class="phorma-ask__actions">
        <span class="phorma-ask__hint">Ctrl+Enter</span>
        <button
          type="button"
          class="phorma-ask__send"
          [disabled]="!canSubmit()"
          (click)="submit()"
        >
          <i class="ti ti-send" aria-hidden="true"></i>
          Send
        </button>
      </div>
    </div>
  `,
    styles: [
        `
      :host {
        position: absolute;
        z-index: 16;
        pointer-events: auto;
        display: block;
        font-family: inherit;
        --phorma-ask-accent: var(--phorma-port-tools, #fbbf24);
        --phorma-ask-bg: var(--phorma-node-bg, #161b27);
        --phorma-ask-fg: var(--phorma-node-title, #e2e8f0);
        --phorma-ask-muted: var(--phorma-row-text, #94a3b8);
      }

      .phorma-ask {
        display: flex;
        flex-direction: column;
        gap: 0.35rem;
        padding: 0.5rem 0.55rem;
        border-radius: 0.6rem;
        border: 1px solid color-mix(in srgb, var(--phorma-ask-accent) 55%, transparent);
        background: color-mix(in srgb, var(--phorma-ask-bg) 92%, transparent);
        box-shadow: 0 8px 24px rgb(0 0 0 / 35%);
        backdrop-filter: blur(6px);
      }

      .phorma-ask__header {
        display: flex;
        align-items: center;
        gap: 0.3rem;
        font-size: 0.7rem;
        font-weight: 600;
        color: var(--phorma-ask-fg);
      }
      .phorma-ask__header i {
        font-size: 0.8rem;
        color: var(--phorma-ask-accent);
      }
      .phorma-ask__title {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .phorma-ask__question {
        max-height: 4.5rem;
        overflow-y: auto;
        font-size: 0.7rem;
        line-height: 1.35;
        color: var(--phorma-ask-muted);
        word-break: break-word;
        scrollbar-width: thin;

        :first-child {
          margin-top: 0;
        }
        :last-child {
          margin-bottom: 0;
        }
        p,
        ul,
        ol {
          margin: 0.3rem 0;
        }
        ul,
        ol {
          padding-left: 1rem;
        }
        li {
          margin: 0.12rem 0;
        }
        h1,
        h2,
        h3,
        h4 {
          margin: 0.45rem 0 0.2rem;
          font-size: 0.74rem;
          font-weight: 700;
          color: var(--phorma-ask-fg);
        }
        code {
          padding: 0.05rem 0.28rem;
          border-radius: 0.3rem;
          background: color-mix(in srgb, var(--phorma-ask-muted) 12%, transparent);
          font-size: 0.66rem;
        }
        pre {
          margin: 0.3rem 0;
          padding: 0.4rem;
          border-radius: 0.4rem;
          background: color-mix(in srgb, var(--phorma-ask-muted) 8%, transparent);
          overflow-x: auto;

          code {
            padding: 0;
            background: none;
          }
        }
        a {
          color: var(--phorma-ask-fg);
          text-decoration: underline;
        }
        blockquote {
          margin: 0.3rem 0;
          padding-left: 0.5rem;
          border-left: 2px solid color-mix(in srgb, var(--phorma-ask-accent) 40%, transparent);
        }
      }

      .phorma-ask__input {
        width: 100%;
        resize: vertical;
        padding: 0.3rem 0.4rem;
        border-radius: 0.4rem;
        border: 1px solid var(--phorma-card-border, rgb(255 255 255 / 10%));
        background: color-mix(in srgb, var(--phorma-ask-bg) 70%, transparent);
        color: var(--phorma-ask-fg);
        font-family: inherit;
        font-size: 0.7rem;
        line-height: 1.35;
      }
      .phorma-ask__input:focus {
        outline: none;
        border-color: color-mix(in srgb, var(--phorma-ask-accent) 70%, transparent);
      }
      .phorma-ask__input::placeholder {
        color: color-mix(in srgb, var(--phorma-ask-muted) 70%, transparent);
      }

      .phorma-ask__actions {
        display: flex;
        align-items: center;
        justify-content: flex-end;
        gap: 0.4rem;
      }

      .phorma-ask__hint {
        font-size: 0.62rem;
        color: color-mix(in srgb, var(--phorma-ask-muted) 75%, transparent);
      }

      .phorma-ask__send {
        display: inline-flex;
        align-items: center;
        gap: 0.25rem;
        padding: 0.22rem 0.5rem;
        border-radius: 0.4rem;
        border: 1px solid color-mix(in srgb, var(--phorma-accent-green, #34d399) 55%, transparent);
        background: transparent;
        color: var(--phorma-accent-green, #34d399);
        font-size: 0.68rem;
        font-weight: 600;
        cursor: pointer;
        transition:
          background 0.15s ease,
          opacity 0.15s ease;
      }
      .phorma-ask__send:hover:not(:disabled) {
        background: color-mix(in srgb, var(--phorma-accent-green, #34d399) 14%, transparent);
      }
      .phorma-ask__send:disabled {
        opacity: 0.4;
        cursor: not-allowed;
      }
      .phorma-ask__send i {
        font-size: 0.72rem;
      }
    `,
    ],
})
export class AskUserOverlay {
    /** Engine identity for this exact ask occurrence. */
    readonly requestId = input.required<string>();
    /** Display name of the Ask User node. */
    readonly nodeName = input.required<string>();
    /** The interpolated question shown to the user. */
    readonly question = input.required<string>();
    /** Screen-space left, in CSS pixels (host canvas-relative). */
    readonly screenX = input.required<number>();
    /** Screen-space top, in CSS pixels. */
    readonly screenY = input.required<number>();
    /** Screen-space width, in CSS pixels (matches the node width at zoom). */
    readonly screenW = input.required<number>();
    /** Answer text, owned by RunControllerService so the Runs panel shares it. */
    readonly draft = input.required<string>();

    /** Emits on every keystroke so the shared draft stays in sync. */
    readonly draftChange = output<string>();
    /** Emits the trimmed answer when the user submits. */
    readonly answered = output<string>();

    private readonly host = inject(ElementRef<HTMLElement>);
    private readonly sanitizer = inject(DomSanitizer);
    private readonly box = viewChild.required<ElementRef<HTMLTextAreaElement>>('box');

    protected readonly canSubmit = computed(() => this.draft().trim().length > 0);

    /** Sanitized markdown rendering of the question text. */
    protected readonly renderedQuestion = computed<SafeHtml>(() => {
        const raw = marked.parse(this.question(), { async: false });
        return this.sanitizer.bypassSecurityTrustHtml(DOMPurify.sanitize(raw));
    });

    constructor() {
        // Position the host element every time the screen-space inputs change.
        effect(() => {
            const x = this.screenX();
            const y = this.screenY();
            const w = this.screenW();
            const el = this.host.nativeElement;
            el.style.left = `${x}px`;
            el.style.top = `${y}px`;
            // Narrow nodes at low zoom would give an unusable input, so hold a
            // readable floor and let the card overhang the node.
            el.style.width = `${Math.max(w, 220)}px`;
        });

        // The run is blocked on this input — take focus so the user can just type.
        effect(() => {
            this.box().nativeElement.focus();
        });
    }

    protected onInput(event: Event): void {
        this.draftChange.emit((event.target as HTMLTextAreaElement | null)?.value ?? '');
    }

    protected submit(): void {
        const response = this.draft().trim();
        if (!response) return;
        this.answered.emit(response);
    }
}
