import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { CheckboxModule } from 'primeng/checkbox';

import {
  MUTABLE_NOTIFICATION_KINDS,
  NotificationsService,
} from '../../../core/notifications.service';
import { PhormaCloudService } from '../../../core/phorma-cloud.service';
import type { NotificationKind } from '../../../core/notifications.model';

/**
 * Distinguishes concurrently-mounted instances. See `NotificationSettings.idPrefix`.
 *
 * Declared above the class so the field initializer that reads it is obviously
 * past its temporal dead zone - it runs at construction, long after this module
 * evaluates, but a reader should not have to work that out.
 */
let instanceCounter = 0;

/**
 * "Notifications" - what the toolbar bell is allowed to tell you about.
 *
 * ## Why only some kinds appear here
 *
 * The list is generated from {@link MUTABLE_NOTIFICATION_KINDS}, and the three
 * kinds deliberately absent from it are the two run-FAILED kinds and a
 * deployment's own reported problems. A user can silence noise; they cannot
 * silence problems. A bell that can be configured to say nothing when a deployed
 * workflow breaks is a bell nobody can trust, and "why did nobody tell me" is a
 * far worse outcome than one row too many.
 *
 * Generating the rows rather than hand-writing a checkbox each is what stops a
 * kind added later from having no setting: the list is the single declaration.
 *
 * ## Why it sits on the Cloud page
 *
 * Beside the deployment list, because that is where the notifications this feature
 * exists for come from. Local-run rows are configurable here too, and that is a
 * mild misfiling accepted on purpose: a second Settings page for four checkboxes
 * costs the user more than the odd adjacency does.
 *
 * Rendered UNCONDITIONALLY, matching the bell. The bell is not gated on an account
 * at all - a local run finishing while the user looks at another workflow is its
 * content for a signed-out install too - so gating its settings would leave
 * somebody with a bell they cannot quieten.
 */
@Component({
  selector: 'app-notification-settings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CheckboxModule, FormsModule],
  templateUrl: './notification-settings.html',
  styleUrl: './notification-settings.scss',
})
export class NotificationSettings {
  private readonly notifications = inject(NotificationsService);
  private readonly phormaCloud = inject(PhormaCloudService);

  protected readonly signedIn = this.phormaCloud.signedIn;
  protected readonly subscribed = this.phormaCloud.subscribed;

  /** Every kind the user may switch off, with its label. */
  protected readonly kinds = MUTABLE_NOTIFICATION_KINDS;

  /** Disclosure state, matching the sibling sections on this page. */
  protected readonly open = signal(false);

  protected onToggle(event: Event): void {
    this.open.set((event.target as HTMLDetailsElement).open);
  }

  /**
   * Checkbox state is "tell me", the inverse of the stored "muted".
   *
   * Stored as a mute so that the DEFAULT - an empty set - means everything is on.
   * Storing "enabled kinds" instead would make a fresh install silent, and would
   * silently drop any kind added in a later version.
   */
  protected enabled(kind: NotificationKind): boolean {
    return !this.notifications.isMuted(kind);
  }

  protected setEnabled(kind: NotificationKind, enabled: boolean): void {
    this.notifications.setMuted(kind, !enabled);
  }

  /** `p-checkbox` hands back a value; this keeps the template free of casts. */
  protected onCheckbox(kind: NotificationKind, value: unknown): void {
    this.setEnabled(kind, value === true);
  }

  /**
   * Per-INSTANCE id prefix.
   *
   * A static `phorma-notify-{kind}` is what shipped first and it was wrong: the
   * settings dialog can be mounted twice (its own spec asserts on exactly that),
   * and two instances then emit the same `inputId` five times over, so every
   * `<label for>` points at whichever checkbox the browser found first. The bug was
   * invisible while this section was gated on being signed in, because nothing
   * rendered.
   *
   * A counter rather than a `scope` input, unlike `PropertiesForm` and
   * `AgentConfig`: those have a genuine panel-and-dialog pair whose caller knows
   * which is which, while this has one home and no caller with anything useful to
   * say. Uniqueness is all that is needed here.
   */
  private readonly idPrefix = `phorma-notify-${(instanceCounter += 1)}`;

  protected id(kind: string): string {
    return `${this.idPrefix}-${kind}`;
  }
}
