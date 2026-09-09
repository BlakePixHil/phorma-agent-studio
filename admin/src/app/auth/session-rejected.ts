import { ChangeDetectionStrategy, Component } from '@angular/core';

/**
 * The surface for "we sent a session token and the Worker refused it" - HTTP 401
 * on a call the dashboard was authenticated enough to make.
 *
 * ## Why this exists as its own screen
 *
 * This case used to render {@link SignedOut}, because the API client mapped 401
 * onto `no-session`. That cost real debugging time on 2026-09-09: the dashboard
 * showed a sign-in form to an operator who was already signed in, so the obvious
 * action was to sign in again, which cannot possibly fix it. The two failures look
 * identical on screen and have opposite causes:
 *
 *   no session       Clerk never produced one here. Signing in fixes it.
 *   session rejected The Worker verifies a DIFFERENT Clerk instance, or this
 *                    origin is missing from its `CLERK_AUTHORIZED_PARTIES`.
 *                    Nothing the visitor can do fixes it.
 *
 * So the copy names the deployment, not the visitor, and offers no sign-in
 * button - there is deliberately no action here, because every action available in
 * a browser is the wrong one.
 *
 * ## What it may and may not say
 *
 * The two named causes are the only two that produce a 401 on this path, and both
 * are configuration on OUR side, so naming them is help rather than disclosure -
 * neither reveals anything about the allowlist or about who is on it. It carries
 * no user id, no instance id and no secret name beyond a public `var` name.
 */
@Component({
  selector: 'admin-session-rejected',
  template: `
    <section class="admin-auth" aria-labelledby="admin-session-rejected-title" role="alert">
      <h1 class="admin-auth__title" id="admin-session-rejected-title">
        <i class="ti ti-plug-connected-x" aria-hidden="true"></i>
        Session not accepted
      </h1>
      <p class="admin-auth__note">
        You are signed in, but the telemetry API rejected this session. Signing in again will not
        help.
      </p>
      <p class="admin-auth__note admin-auth__note--detail">
        The Worker is verifying a different Clerk instance, or this dashboard's origin is missing
        from its authorized parties. Both are deployment configuration.
      </p>
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
      max-width: 30rem;
      margin: 0;
      color: var(--admin-text-muted);
      text-align: center;
    }

    .admin-auth__note--detail {
      font-size: 0.857rem; /* 12px against a 14px root */
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SessionRejected {}
