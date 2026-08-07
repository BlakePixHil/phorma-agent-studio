import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  HostListener,
  computed,
  inject,
  input,
  signal,
} from '@angular/core';

import type { CapabilityFinding } from '@phorma/engine';

/**
 * A capability-finding badge + popover anchored to a canvas node's top-left
 * corner (Requirement 17.8) — mirrors {@link McpWarningOverlay}'s
 * badge-plus-popover pattern at the OPPOSITE corner, so a node carrying both
 * an MCP configuration warning and a capability finding shows two distinct
 * badges rather than one overwriting the other.
 *
 * Renders red (`ti-alert-circle`) when any finding for this node is severity
 * `error`, amber (`ti-alert-triangle`) when every finding is a `warning`.
 * Clicking opens a frosted-glass popover listing every finding's message —
 * editing the node is never blocked by this overlay; it is purely
 * informational (Requirement 17.8's "leave every node editing action
 * available").
 */
@Component({
  selector: 'app-capability-finding-overlay',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <button
      type="button"
      class="phorma-cap-badge"
      [class.phorma-cap-badge--warning]="!hasError()"
      [attr.aria-label]="badgeLabel() + ' - click for details'"
      [attr.aria-expanded]="open()"
      (click)="toggle($event)"
    >
      <i class="ti {{ hasError() ? 'ti-alert-circle' : 'ti-alert-triangle' }}" aria-hidden="true"></i>
    </button>

    @if (open()) {
      <div
        class="phorma-cap-popover"
        [class.phorma-cap-popover--below]="placement() === 'below'"
        role="dialog"
        aria-label="Capability findings"
      >
        <div class="phorma-cap-popover__header" [class.phorma-cap-popover__header--warning]="!hasError()">
          <i class="ti {{ hasError() ? 'ti-alert-circle' : 'ti-alert-triangle' }}" aria-hidden="true"></i>
          <span>{{ badgeLabel() }}</span>
        </div>
        <ul class="phorma-cap-popover__list">
          @for (finding of findings(); track $index) {
            <li [class.phorma-cap-popover__item--warning]="finding.severity === 'warning'">
              @if (finding.deployOnly) {
                <span class="phorma-cap-popover__tag">Deploy</span>
              }
              {{ finding.message }}
            </li>
          }
        </ul>
      </div>
    }
  `,
  styles: [
    `
      :host {
        position: absolute;
        z-index: 16;
        pointer-events: none;
        font-family: inherit;
      }

      .phorma-cap-badge {
        position: absolute;
        top: 0;
        left: 0;
        transform: translate(-35%, -35%);
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 1.15rem;
        height: 1.15rem;
        border-radius: 9999px;
        border: 1.5px solid var(--phorma-canvas-bg, #0b0e16);
        background: var(--phorma-accent-red, #ef4444);
        color: #1a0606;
        cursor: pointer;
        padding: 0;
        pointer-events: auto;
        box-shadow:
          0 0 0 1px rgba(239, 68, 68, 0.35),
          0 2px 8px rgba(239, 68, 68, 0.4);
        transition:
          transform 0.15s ease,
          box-shadow 0.15s ease;
      }
      .phorma-cap-badge--warning {
        background: var(--phorma-accent-amber, #f59e0b);
        color: #1a1206;
        box-shadow:
          0 0 0 1px rgba(245, 158, 11, 0.35),
          0 2px 8px rgba(245, 158, 11, 0.4);
      }
      .phorma-cap-badge:hover {
        transform: translate(-35%, -35%) scale(1.12);
      }
      .phorma-cap-badge i {
        font-size: 0.72rem;
        line-height: 1;
      }

      .phorma-cap-popover {
        position: absolute;
        bottom: 100%;
        left: 0;
        margin-bottom: 0.5rem;
        width: 18rem;
        border-radius: 0.7rem;
        border: 1px solid var(--phorma-card-border, rgba(255, 255, 255, 0.1));
        background: color-mix(in srgb, var(--phorma-card-bg, #161b27) 72%, transparent);
        backdrop-filter: blur(16px) saturate(1.4);
        -webkit-backdrop-filter: blur(16px) saturate(1.4);
        box-shadow:
          0 12px 40px rgb(0 0 0 / 0.4),
          0 0 0 1px rgba(255, 255, 255, 0.04) inset;
        padding: 0.7rem 0.8rem 0.8rem;
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
        animation: phorma-cap-in 0.14s ease-out;
        z-index: 17;
        pointer-events: auto;
      }
      .phorma-cap-popover--below {
        bottom: auto;
        top: 100%;
        margin-bottom: 0;
        margin-top: 0.5rem;
      }
      @keyframes phorma-cap-in {
        from {
          opacity: 0;
          transform: translateY(4px) scale(0.98);
        }
        to {
          opacity: 1;
          transform: translateY(0) scale(1);
        }
      }

      .phorma-cap-popover__header {
        display: flex;
        align-items: center;
        gap: 0.4rem;
        font-size: 0.78rem;
        font-weight: 700;
        color: var(--p-text-color, #e2e8f0);
      }
      .phorma-cap-popover__header i {
        font-size: 0.85rem;
        color: var(--phorma-accent-red, #ef4444);
      }
      .phorma-cap-popover__header--warning i {
        color: var(--phorma-accent-amber, #f59e0b);
      }

      .phorma-cap-popover__list {
        margin: 0;
        padding: 0;
        list-style: none;
        display: flex;
        flex-direction: column;
        gap: 0.4rem;
        max-height: 14rem;
        overflow-y: auto;
      }
      .phorma-cap-popover__list li {
        font-size: 0.74rem;
        line-height: 1.45;
        color: var(--p-text-muted-color, #94a3b8);
        padding-left: 0.6rem;
        border-left: 2px solid var(--phorma-accent-red, #ef4444);
      }
      .phorma-cap-popover__list li.phorma-cap-popover__item--warning {
        border-left-color: var(--phorma-accent-amber, #f59e0b);
      }
      .phorma-cap-popover__tag {
        display: inline-block;
        margin-right: 0.35rem;
        padding: 0.05rem 0.3rem;
        border-radius: 0.2rem;
        background: color-mix(in srgb, var(--phorma-accent-amber, #f59e0b) 22%, transparent);
        color: var(--phorma-accent-amber, #f59e0b);
        font-size: 0.62rem;
        font-weight: 700;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        vertical-align: 0.05rem;
      }
    `,
  ],
})
export class CapabilityFindingOverlay {
  private readonly el = inject(ElementRef<HTMLElement>);

  /** Node id this overlay is anchored to. */
  readonly nodeId = input.required<string>();
  /** Every finding for this node, error or warning. */
  readonly findings = input.required<readonly CapabilityFinding[]>();

  /** Whether the popover is expanded. */
  protected readonly open = signal(false);

  /** Bumped on scroll/resize so placement re-evaluates. */
  private readonly viewportTick = signal(0);

  protected readonly hasError = computed(() =>
    this.findings().some(finding => finding.severity === 'error'),
  );

  protected readonly badgeLabel = computed(() => {
    const findings = this.findings();
    const count = findings.length;
    const noun = count === 1 ? 'problem' : 'problems';
    if (this.hasError()) {
      return `${count} capability ${noun} would prevent this node from running`;
    }
    // All-deploy-only is the common case for a node that runs fine here but
    // cannot be deployed - say which, or the amber badge reads as noise.
    if (findings.length > 0 && findings.every(finding => finding.deployOnly)) {
      return `${count} ${noun} would prevent this node from being deployed to the cloud`;
    }
    return `${count} capability ${noun}`;
  });

  protected readonly placement = computed<'above' | 'below'>(() => {
    this.viewportTick();
    if (!this.open()) return 'above';
    const rect = this.el.nativeElement.getBoundingClientRect();
    const popoverHeight = 200; // approximate popover height
    return rect.top < popoverHeight + 12 ? 'below' : 'above';
  });

  protected toggle(e: Event): void {
    e.stopPropagation();
    e.preventDefault();
    this.open.update(v => !v);
  }

  /** Close the popover when a click lands outside this overlay. */
  @HostListener('document:pointerdown', ['$event'])
  protected onDocumentPointerDown(e: PointerEvent): void {
    if (!this.open()) return;
    if (this.el.nativeElement.contains(e.target as Node)) return;
    this.open.set(false);
  }

  /** Re-evaluate placement on scroll/resize. */
  @HostListener('window:scroll')
  @HostListener('window:resize')
  protected onViewportChange(): void {
    if (this.open()) this.viewportTick.update(v => v + 1);
  }
}
