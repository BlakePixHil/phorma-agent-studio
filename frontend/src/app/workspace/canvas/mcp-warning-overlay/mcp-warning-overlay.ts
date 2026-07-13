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
import { SettingsDialogService } from '../../settings/settings-dialog.service';

/**
 * A configuration-warning badge + popover anchored to a canvas node's
 * top-right corner.
 *
 * Renders a small amber warning pip (Tabler `ti-alert-triangle`) that, when
 * clicked, opens a frosted-glass popover explaining what is missing and
 * offering a deep-link to Settings -> Integrations. Positioning is driven by
 * the host (GraphCanvas) via `screenX` / `screenY`, updated every animation
 * frame from the renderer's transform so the badge tracks pan/zoom.
 *
 * The popover appears **above** the node by default. If there is not enough
 * vertical space above (the node is near the top of the viewport), it flips
 * below. Horizontally it clamps to stay within the viewport.
 *
 * The badge is only rendered when `warning()` is truthy; the host decides
 * which nodes carry a warning (missing MCP credentials, OAuth not connected,
 * etc.) and only emits overlay items for those nodes.
 */
@Component({
  selector: 'app-mcp-warning-overlay',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <button
      type="button"
      class="phorma-mcp-warn-badge"
      [attr.aria-label]="warning() + ' - click for details'"
      [attr.aria-expanded]="open()"
      (click)="toggle($event)"
    >
      <i class="ti ti-alert-triangle" aria-hidden="true"></i>
    </button>

    @if (open()) {
      <div
        class="phorma-mcp-warn-popover"
        [class.phorma-mcp-warn-popover--below]="placement() === 'below'"
        role="dialog"
        aria-label="Configuration warning"
      >
        <div class="phorma-mcp-warn-popover__header">
          <i class="ti ti-alert-triangle" aria-hidden="true"></i>
          <span>Configuration required</span>
        </div>
        <p class="phorma-mcp-warn-popover__body">{{ warning() }}</p>
        <button
          type="button"
          class="phorma-mcp-warn-popover__link"
          (click)="openSettings()"
        >
          <i class="ti ti-settings" aria-hidden="true"></i>
          <span>Configure in Settings - Integrations</span>
        </button>
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
        /* The host element is sized to the node's screen-space box. */
      }

      .phorma-mcp-warn-badge {
        position: absolute;
        top: 0;
        right: 0;
        transform: translate(35%, -35%);
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 1.15rem;
        height: 1.15rem;
        border-radius: 9999px;
        border: 1.5px solid var(--phorma-canvas-bg, #0b0e16);
        background: var(--phorma-accent-amber, #f59e0b);
        color: #1a1206;
        cursor: pointer;
        padding: 0;
        pointer-events: auto;
        box-shadow:
          0 0 0 1px rgba(245, 158, 11, 0.35),
          0 2px 8px rgba(245, 158, 11, 0.4);
        transition:
          transform 0.15s ease,
          box-shadow 0.15s ease;
      }
      .phorma-mcp-warn-badge:hover {
        transform: translate(35%, -35%) scale(1.12);
        box-shadow:
          0 0 0 2px rgba(245, 158, 11, 0.5),
          0 4px 14px rgba(245, 158, 11, 0.55);
      }
      .phorma-mcp-warn-badge i {
        font-size: 0.72rem;
        line-height: 1;
      }

      .phorma-mcp-warn-popover {
        position: absolute;
        /* Default: above the node. Bottom anchored to the host's top edge. */
        bottom: 100%;
        right: 0;
        margin-bottom: 0.5rem;
        width: 17rem;
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
        animation: phorma-mcp-warn-in 0.14s ease-out;
        z-index: 17;
        pointer-events: auto;
      }
      /* When there's not enough space above, flip below the node. */
      .phorma-mcp-warn-popover--below {
        bottom: auto;
        top: 100%;
        margin-bottom: 0;
        margin-top: 0.5rem;
      }
      @keyframes phorma-mcp-warn-in {
        from {
          opacity: 0;
          transform: translateY(4px) scale(0.98);
        }
        to {
          opacity: 1;
          transform: translateY(0) scale(1);
        }
      }

      .phorma-mcp-warn-popover__header {
        display: flex;
        align-items: center;
        gap: 0.4rem;
        font-size: 0.78rem;
        font-weight: 700;
        color: var(--p-text-color, #e2e8f0);
      }
      .phorma-mcp-warn-popover__header i {
        font-size: 0.85rem;
        color: var(--phorma-accent-amber, #f59e0b);
      }

      .phorma-mcp-warn-popover__body {
        margin: 0;
        font-size: 0.74rem;
        line-height: 1.45;
        color: var(--p-text-muted-color, #94a3b8);
      }

      /* Underlined link - mirrors .phorma-props__link from the properties
         panel: a button reset to look like a text link, underline on hover. */
      .phorma-mcp-warn-popover__link {
        display: inline-flex;
        align-items: center;
        gap: 0.3rem;
        padding: 0;
        border: none;
        background: transparent;
        color: var(--p-primary-color, #818cf8);
        font-size: 0.74rem;
        font-weight: 600;
        cursor: pointer;
        align-self: flex-start;
        transition: color 0.15s ease;
      }
      .phorma-mcp-warn-popover__link:hover {
        text-decoration: underline;
      }
      .phorma-mcp-warn-popover__link i {
        font-size: 0.8rem;
      }
    `,
  ],
})
export class McpWarningOverlay {
  private readonly settingsDialog = inject(SettingsDialogService);
  private readonly el = inject(ElementRef<HTMLElement>);

  /** Node id this overlay is anchored to. */
  readonly nodeId = input.required<string>();
  /** Human-readable description of what is missing. */
  readonly warning = input.required<string>();
  /** MCP preset id (for deep-linking to the specific integration card). */
  readonly presetId = input<string | null>(null);

  /** Whether the popover is expanded. */
  protected readonly open = signal(false);

  /** Bumped on scroll/resize so placement re-evaluates. */
  private readonly viewportTick = signal(0);

  /**
   * Whether the popover should appear below the node instead of above.
   * Checks if there's enough space above the node's top edge for the
   * popover (approx. 180px). Recomputed on open + scroll/resize.
   */
  protected readonly placement = computed<'above' | 'below'>(() => {
    this.viewportTick();
    if (!this.open()) return 'above';
    const rect = this.el.nativeElement.getBoundingClientRect();
    const popoverHeight = 180; // approximate popover height
    return rect.top < popoverHeight + 12 ? 'below' : 'above';
  });

  protected toggle(e: Event): void {
    e.stopPropagation();
    e.preventDefault();
    this.open.update(v => !v);
  }

  protected openSettings(): void {
    this.open.set(false);
    const presetId = this.presetId();
    const anchor = presetId ? `integration-${presetId}` : undefined;
    this.settingsDialog.open('integrations', anchor);
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
