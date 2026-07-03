import { ChangeDetectionStrategy, Component, inject } from '@angular/core';

import { ToastService } from './toast.service';

/**
 * Renders the stack of active toasts in the top-right corner of the viewport.
 * Mounted once at the app root so any service can fire a toast.
 */
@Component({
  selector: 'app-toast',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './toast.html',
  styleUrl: './toast.scss',
})
export class Toast {
  protected readonly toast = inject(ToastService);
  protected readonly entries = this.toast.entries;
}
