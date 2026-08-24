import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ButtonModule } from 'primeng/button';
import { ClerkService, type Clerk } from 'ngx-clerk';

/**
 * The not-authorized state, rendered by the shell when the Admin_API answers
 * HTTP 403 (Requirement 10.4).
 *
 * The copy is deliberately thin. It names no allowlist detail: no user id, no
 * allowlist contents, and no hint about who is on it - matching the Admin_API,
 * whose 403 body is the static string `Forbidden.` for the same reason. The only
 * action offered is sign out, so a visitor on the wrong account has a way
 * forward without being told anything about the list.
 */
@Component({
  selector: 'admin-not-authorized',
  imports: [ButtonModule],
  template: `
    <section class="admin-auth" aria-labelledby="admin-not-authorized-title">
      <h1 class="admin-auth__title" id="admin-not-authorized-title">
        <i class="ti ti-lock" aria-hidden="true"></i>
        Not authorized
      </h1>
      <p class="admin-auth__note">This account cannot view the telemetry dashboard.</p>
      <button
        pButton
        type="button"
        size="small"
        class="phorma-btn-content"
        [disabled]="!ready()"
        (click)="signOut()"
      >
        <i class="ti ti-logout" aria-hidden="true"></i>
        <span>Sign out</span>
      </button>
    </section>
  `,
  styles: `
    .admin-auth {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 1rem;
      /* rem maths is against a 14px root: 4.5rem is 63px. */
      padding: 4.5rem 1.5rem;
    }

    .admin-auth__title {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      margin: 0;
      font-size: 1.5rem;
      font-weight: 700;
    }

    .admin-auth__note {
      margin: 0;
      color: var(--admin-text-muted);
      text-align: center;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class NotAuthorized {
  /**
   * The loaded Clerk instance. `ClerkService` exposes no `signOut`, so sign out
   * goes through the instance itself. Tracked off `clerk$` rather than awaited:
   * `clerk$` never emits when the publishable key is a placeholder, and a button
   * that hangs on click is worse than one that reads as unavailable.
   */
  private clerk: Clerk | null = null;

  /** Whether sign out can actually run. Drives the disabled state. */
  readonly ready = signal(false);

  constructor() {
    inject(ClerkService)
      .clerk$.pipe(takeUntilDestroyed())
      .subscribe((instance) => {
        this.clerk = instance;
        this.ready.set(true);
      });
  }

  async signOut(): Promise<void> {
    await this.clerk?.signOut();
  }
}
