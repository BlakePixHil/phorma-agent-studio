import { ChangeDetectionStrategy, Component } from '@angular/core';
import { ClerkSignInComponent } from 'ngx-clerk';

/**
 * The sign-in surface, rendered by the shell while no Clerk session exists
 * (Requirement 10.3).
 *
 * Clerk's own sign-in component is mounted here rather than a hand-rolled form:
 * credentials, factors and error copy stay inside Clerk, so this package holds no
 * authentication logic and no secret (10.15). It mounts itself off `clerk$`, so
 * it simply stays empty until Clerk has loaded instead of erroring.
 *
 * This surface issues NO Admin_API request. Nothing here can: the request path
 * runs through `TelemetryApiService`, which returns early without a session.
 */
@Component({
  selector: 'admin-signed-out',
  imports: [ClerkSignInComponent],
  template: `
    <section class="admin-auth" aria-labelledby="admin-signed-out-title">
      <h1 class="admin-auth__title" id="admin-signed-out-title">
        <i class="ti ti-chart-histogram" aria-hidden="true"></i>
        Phorma Telemetry
      </h1>
      <p class="admin-auth__note">Sign in to view the dashboard.</p>
      <clerk-sign-in />
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
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SignedOut {}
