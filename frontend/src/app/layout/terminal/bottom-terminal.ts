import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  ElementRef,
  inject,
  OnDestroy,
  signal,
  viewChild,
} from '@angular/core';
import { ButtonModule } from 'primeng/button';
import { TooltipModule } from 'primeng/tooltip';

import { PanelRegistryService } from '../../core/panel-registry.service';
import { TerminalChannelId, TerminalOutputService } from '../../core/terminal-output.service';

@Component({
  selector: 'app-bottom-terminal',
  imports: [ButtonModule, TooltipModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './bottom-terminal.html',
  styleUrl: './bottom-terminal.scss',
})
export class BottomTerminal implements OnDestroy {
  protected readonly terminal = inject(TerminalOutputService);
  private readonly panels = inject(PanelRegistryService);
  private readonly terminalBody = viewChild<ElementRef<HTMLElement>>('terminalBody');

  protected readonly leftOffset = computed(() =>
    this.panels.collapsedLeft() || this.panels.leftTabs().length === 0 ? 0 : this.panels.leftWidth(),
  );
  protected readonly rightOffset = computed(() =>
    this.panels.collapsedRight() || this.panels.rightTabs().length === 0 ? 0 : this.panels.rightWidth(),
  );
  protected readonly dockHeight = computed(() => (this.terminal.collapsed() ? 0 : this.terminal.height()));
  protected readonly activeValue = computed(() => this.terminal.activeChannel());
  protected readonly entries = computed(() => this.terminal.activeEntries());
  protected readonly statusLabel = computed(() => this.terminal.phase());
  protected readonly resizing = signal(false);
  protected readonly copied = signal(false);

  private copiedResetId: ReturnType<typeof setTimeout> | null = null;

  private resizeFrameId: number | null = null;
  private pendingHeight: number | null = null;
  private stopResize?: () => void;

  private readonly minHeight = 140;
  private readonly maxHeight = 520;

  constructor() {
    // Auto-scroll to the bottom whenever new output arrives, the tab changes,
    // or the dock is re-opened (the body remounts with no new entry event).
    effect(() => {
      this.entries();
      if (this.terminal.collapsed()) return;
      this.scrollToBottom();
    });
  }

  protected formatTime(timestamp: string): string {
    return new Date(timestamp).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  }

  ngOnDestroy(): void {
    this.stopResize?.();
    if (this.resizeFrameId !== null) cancelAnimationFrame(this.resizeFrameId);
    if (this.copiedResetId !== null) clearTimeout(this.copiedResetId);
  }

  protected setActive(value: TerminalChannelId): void {
    this.terminal.setActiveChannel(value);
  }

  /** Copies the active tab's output to the clipboard and flashes a check icon. */
  protected async copyActive(): Promise<void> {
    const text = this.terminal.activeEntries()
      .map(entry => `[${this.formatTime(entry.timestamp)}] ${entry.message}`)
      .join('\n');
    if (!text) return;

    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Fallback for environments where the async clipboard API is unavailable.
      const area = document.createElement('textarea');
      area.value = text;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      document.execCommand('copy');
      document.body.removeChild(area);
    }

    this.copied.set(true);
    if (this.copiedResetId !== null) clearTimeout(this.copiedResetId);
    this.copiedResetId = setTimeout(() => this.copied.set(false), 1500);
  }

  protected onResizeStart(event: PointerEvent): void {
    if (event.target instanceof HTMLElement && event.target.closest('button')) return;

    event.preventDefault();
    this.terminal.open();
    this.resizing.set(true);
    const startY = event.clientY;
    const startHeight = this.terminal.height();
    const handle = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
    handle?.setPointerCapture(event.pointerId);

    const commitPendingHeight = () => {
      this.resizeFrameId = null;
      if (this.pendingHeight === null) return;
      this.terminal.setHeight(this.pendingHeight);
      this.pendingHeight = null;
    };

    const onMove = (moveEvent: PointerEvent) => {
      moveEvent.preventDefault();
      const delta = startY - moveEvent.clientY;
      this.pendingHeight = Math.min(this.maxHeight, Math.max(this.minHeight, startHeight + delta));
      if (this.resizeFrameId === null) this.resizeFrameId = requestAnimationFrame(commitPendingHeight);
    };

    const onUp = (upEvent: PointerEvent) => {
      if (this.resizeFrameId !== null) {
        cancelAnimationFrame(this.resizeFrameId);
        commitPendingHeight();
      }
      handle?.releasePointerCapture(upEvent.pointerId);
      this.stopResize?.();
      this.stopResize = undefined;
      this.resizing.set(false);
    };

    window.addEventListener('pointermove', onMove, { passive: false });
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);

    this.stopResize = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }

  protected scrollToBottom(): void {
    const body = this.terminalBody()?.nativeElement;
    if (!body) return;
    queueMicrotask(() => {
      body.scrollTop = body.scrollHeight;
    });
  }
}
