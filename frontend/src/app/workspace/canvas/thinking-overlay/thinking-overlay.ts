import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { DomSanitizer, type SafeHtml } from '@angular/platform-browser';
import DOMPurify from 'dompurify';
import { marked } from 'marked';

/**
 * A collapsible "thinking" overlay anchored to a single canvas node.
 *
 * Renders nothing when `text()` is empty (non-reasoning models get no UI).
 * While `streaming()` is true a shimmering "Thinking..." label is shown; when
 * streaming finishes the label collapses into an expander button. Expanding
 * reveals the reasoning text in a readonly, scrollable body with a faded top
 * edge (unless scrolled to the top). The overlay auto-collapses when a
 * streaming run finishes if the user had it open.
 *
 * Positioning is driven by the host (GraphCanvas) via the `screenX`, `screenY`,
 * `screenW` inputs, which are updated every animation frame from the renderer's
 * transform so the overlay tracks pan/zoom.
 */
@Component({
  selector: 'app-thinking-overlay',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (hasText()) {
      @if (streaming()) {
        <span class="phorma-thinking-label" aria-live="polite">
          <i class="ti ti-bubble-loading" aria-hidden="true"></i>
          <span class="phorma-thinking-word">Thinking…</span>
        </span>
      } @else {
        <button
          type="button"
          class="phorma-thinking-toggle"
          (click)="toggleExpanded()"
          [attr.aria-expanded]="expanded()"
          [attr.aria-controls]="bodyId()"
        >
          <i
            class="ti"
            [class.ti-chevron-down]="!expanded()"
            [class.ti-chevron-up]="expanded()"
            aria-hidden="true"
          ></i>
          <span>Thinking</span>
        </button>
      }

      @if (expanded() && !streaming()) {
        <div
          #body
          class="phorma-thinking-body"
          [id]="bodyId()"
          role="region"
          aria-label="Model reasoning"
          (scroll)="atTop.set(body.scrollTop === 0)"
        >
          <div class="phorma-thinking-md" [innerHTML]="renderedText()"></div>
          @if (!atTop()) {
            <div class="phorma-thinking-fade" aria-hidden="true"></div>
          }
        </div>
      }
    }
  `,
  styles: [
    `
      :host {
        position: absolute;
        z-index: 15;
        pointer-events: auto;
        display: flex;
        flex-direction: column;
        gap: 0.25rem;
        font-family: inherit;
        --phorma-thinking-fg: var(--phorma-row-text, #94a3b8);
        --phorma-thinking-fg-bright: var(--phorma-node-title, #e2e8f0);
        --phorma-thinking-bg: var(--phorma-node-bg, #161b27);
        --phorma-thinking-border: var(--phorma-card-border, rgba(255, 255, 255, 0.1));
      }

      .phorma-thinking-label {
        display: inline-flex;
        align-items: center;
        gap: 0.35rem;
        padding: 0.18rem 0.5rem;
        border-radius: 0.4rem;
        font-size: 0.72rem;
        font-weight: 500;
        color: var(--phorma-thinking-fg);
        background: color-mix(in srgb, var(--phorma-thinking-bg) 80%, transparent);
        border: 1px solid var(--phorma-thinking-border);
        backdrop-filter: blur(6px);
        pointer-events: none;
        width: fit-content;
      }
      .phorma-thinking-label i {
        font-size: 0.78rem;
        color: var(--phorma-thinking-fg);
      }
      .phorma-thinking-word {
        background: linear-gradient(
          90deg,
          var(--phorma-thinking-fg) 0%,
          var(--phorma-thinking-fg-bright) 50%,
          var(--phorma-thinking-fg) 100%
        );
        background-size: 200% 100%;
        -webkit-background-clip: text;
        background-clip: text;
        -webkit-text-fill-color: transparent;
        animation: phorma-thinking-shimmer 1.4s linear infinite;
      }
      @keyframes phorma-thinking-shimmer {
        0% {
          background-position: 200% 0;
        }
        100% {
          background-position: -200% 0;
        }
      }

      .phorma-thinking-toggle {
        display: inline-flex;
        align-items: center;
        gap: 0.3rem;
        padding: 0.16rem 0.45rem;
        border-radius: 0.4rem;
        font-size: 0.7rem;
        font-weight: 500;
        color: var(--phorma-thinking-fg);
        background: color-mix(in srgb, var(--phorma-thinking-bg) 80%, transparent);
        border: 1px solid var(--phorma-thinking-border);
        backdrop-filter: blur(6px);
        cursor: pointer;
        width: fit-content;
        transition:
          color 0.15s ease,
          border-color 0.15s ease;
      }
      .phorma-thinking-toggle:hover {
        color: var(--phorma-thinking-fg-bright);
        border-color: color-mix(in srgb, var(--phorma-thinking-fg) 40%, transparent);
      }
      .phorma-thinking-toggle i {
        font-size: 0.72rem;
      }

      .phorma-thinking-body {
        position: relative;
        max-height: 180px;
        overflow-y: auto;
        overflow-x: hidden;
        padding: 0.4rem 0.55rem;
        border-radius: 0.45rem;
        font-size: 0.7rem;
        line-height: 1.35;
        color: var(--phorma-thinking-fg);
        background: color-mix(in srgb, var(--phorma-thinking-bg) 92%, transparent);
        border: 1px solid var(--phorma-thinking-border);
        backdrop-filter: blur(6px);
        scrollbar-width: thin;
      }
      .phorma-thinking-md {
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
          color: var(--phorma-thinking-fg-bright);
        }
        code {
          padding: 0.05rem 0.28rem;
          border-radius: 0.3rem;
          background: color-mix(in srgb, var(--phorma-thinking-fg) 10%, transparent);
          font-size: 0.66rem;
        }
        pre {
          margin: 0.3rem 0;
          padding: 0.4rem;
          border-radius: 0.4rem;
          background: color-mix(in srgb, var(--phorma-thinking-fg) 7%, transparent);
          overflow-x: auto;

          code {
            padding: 0;
            background: none;
          }
        }
        a {
          color: var(--phorma-thinking-fg-bright);
          text-decoration: underline;
        }
        blockquote {
          margin: 0.3rem 0;
          padding-left: 0.5rem;
          border-left: 2px solid var(--phorma-thinking-border);
        }
      }
      .phorma-thinking-fade {
        position: absolute;
        left: 0;
        right: 0;
        top: 0;
        height: 1.6rem;
        pointer-events: none;
        background: linear-gradient(
          to bottom,
          color-mix(in srgb, var(--phorma-thinking-bg) 95%, transparent),
          transparent
        );
      }
    `,
  ],
})
export class ThinkingOverlay {
  /** Node id this overlay is anchored to. */
  readonly nodeId = input.required<string>();
  /** Screen-space left, in CSS pixels (host canvas-relative). */
  readonly screenX = input.required<number>();
  /** Screen-space top, in CSS pixels. */
  readonly screenY = input.required<number>();
  /** Screen-space width, in CSS pixels (matches the node width at zoom). */
  readonly screenW = input.required<number>();
  /** Accumulated reasoning text. Empty => overlay renders nothing. */
  readonly text = input.required<string>();
  /** True while the node is still emitting thinking tokens. */
  readonly streaming = input.required<boolean>();

  private readonly host = inject(ElementRef<HTMLElement>);
  private readonly sanitizer = inject(DomSanitizer);

  /** Local expanded state (user toggled the body open). */
  readonly expanded = signal(false);
  /** Whether the body is scrolled to the top (controls the fade mask). */
  readonly atTop = signal(true);

  private readonly bodyRef = viewChild<ElementRef<HTMLElement>>('body');

  protected readonly hasText = computed(() => this.text().length > 0);
  protected readonly bodyId = computed(() => `phorma-thinking-${this.nodeId()}`);

  /** Sanitized markdown rendering of the reasoning text. */
  protected readonly renderedText = computed<SafeHtml>(() => {
    const raw = marked.parse(this.text(), { async: false });
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
      el.style.width = `${w}px`;
    });

    // Auto-collapse when a streaming run finishes if the user had it open.
    effect(() => {
      const streaming = this.streaming();
      // Only react to the true -> false transition.
      if (!streaming) {
        // Defer the collapse so it lands after the body re-renders.
        queueMicrotask(() => this.expanded.set(false));
      }
    });
  }

  protected toggleExpanded(): void {
    this.expanded.update(v => !v);
    if (this.expanded()) {
      // Reset scroll state when opening.
      queueMicrotask(() => {
        const body = this.bodyRef()?.nativeElement;
        if (body) {
          body.scrollTop = 0;
          this.atTop.set(true);
        }
      });
    }
  }
}
