/**
 * Performs an owner switch (multi-organisation-phorma, Requirement 20).
 *
 * ## Why this is a second service
 *
 * `ActiveOwnerService` holds the signal and must stay a DI LEAF - the active owner
 * is read on the transport path and by `IndexedDbStorageService`, so anything it
 * reached would be pulled onto the known NG0200 cycle and into the injector path
 * of half the app. A switch, on the other hand, has to touch almost everything:
 * the confirm rail, the document tabs, the local library, three notification
 * services, the deployment list, Clerk and `/api/me`.
 *
 * So the split is the same one `NotificationsService` / `NotificationCenterService`
 * already uses: a bare store nothing may reach through, and an orchestrator that
 * only COMPONENTS inject. Nothing on the transport path injects this service, and
 * nothing should.
 *
 * ## The order is the design
 *
 * 1. **Confirm first, change nothing yet.** A dirty document routes through
 *    `ConfirmDialogService` (Requirement 20.8) and a cancel leaves the active owner
 *    exactly as it was. Everything below this line is irreversible within the
 *    session, so the question has to come before all of it.
 * 2. **Close the tabs.** Before the signal moves, so the autosave effect cannot
 *    write a previous-owner document into the NEW owner's library on its way out.
 * 3. **Move the signal.** From here on every store read, store write and request
 *    header names the new owner.
 * 4. **Tell Clerk, in a browser.** `setActive` is what puts the organisation in the
 *    session CLAIM, and the worker prefers a verified claim over the header. A
 *    desktop build has no Clerk session at all and the header is the whole
 *    mechanism there.
 * 5. **Reset the owner-scoped session state**, notification store first, because
 *    the poll reads that store's read marker as its cursor.
 * 6. **Re-resolve from the worker.** `/api/me` answers the new owner's profile,
 *    quota, capability level and owner list, and pushing that is what recomputes
 *    every capability-derived surface with no reload (Requirement 20.5).
 */

import { inject, Injectable } from '@angular/core';
import { ClerkService } from 'ngx-clerk';
import { firstValueFrom } from 'rxjs';

import { ConfirmDialogService } from '../shared/confirm-dialog/confirm-dialog.service';
import { ToastService } from '../shared/toast/toast.service';
import { ActiveOwnerService, type OwnerChoice } from './active-owner.service';
import { DeployedNotificationsService } from './deployed-notifications.service';
import { DeploymentsService } from './deployments.service';
import { NotificationsService } from './notifications.service';
import { PhormaCloudService } from './phorma-cloud.service';
import { TauriService } from './tauri.service';
import { WorkflowService } from './workflow.service';

@Injectable({ providedIn: 'root' })
export class OwnerSwitchService {
  private readonly activeOwner = inject(ActiveOwnerService);
  private readonly confirm = inject(ConfirmDialogService);
  private readonly workflow = inject(WorkflowService);
  private readonly notifications = inject(NotificationsService);
  private readonly deployedNotifications = inject(DeployedNotificationsService);
  private readonly deployments = inject(DeploymentsService);
  private readonly phormaCloud = inject(PhormaCloudService);
  private readonly clerk = inject(ClerkService);
  private readonly tauri = inject(TauriService);
  private readonly toast = inject(ToastService);

  /** The owners the switcher offers, personal account first. */
  readonly owners = this.activeOwner.owners;

  /** Whether to render a switching surface at all (Requirement 20.3). */
  readonly canSwitch = this.activeOwner.canSwitch;

  /** The active owner, for the label the toolbar always shows. */
  readonly activeOwner$ = this.activeOwner.activeOwner;

  /** True while a switch is in flight, so the control can disable itself. */
  private switching = false;

  /**
   * Switches to `orgId` (null for the personal account).
   *
   * Resolves true when the active owner changed. A no-op selection of the owner
   * already active resolves false and prompts nothing - re-picking the current
   * owner from a menu is not a request to throw away unsaved work.
   */
  async switchTo(orgId: string | null): Promise<boolean> {
    if (this.switching) return false;
    if (this.activeOwner.activeOrgId() === orgId) return false;

    // 1. Confirm before anything moves.
    if (!(await this.confirmUnsaved())) return false;

    this.switching = true;
    try {
      // 2. Tabs go before the signal moves.
      this.workflow.closeAllDocuments();

      // 3. The signal. Refused for an owner that is not on the list, which is the
      //    one case where nothing else should run.
      if (!this.activeOwner.setActiveOrg(orgId)) return false;

      // 4. Clerk, in a browser build only.
      await this.tellClerk(orgId);

      // 5. Owner-scoped session state. The notification store FIRST: the poll below
      //    reads its read marker as the `?since=` cursor.
      this.notifications.resetForOwner();
      this.deployedNotifications.resetForOwner();
      await Promise.all([this.workflow.reloadLibrary(), this.deployments.resetForOwner()]);

      // 6. The worker's answer, which carries the level, the profile and the list.
      await this.phormaCloud.refresh();
      return true;
    } finally {
      this.switching = false;
    }
  }

  /**
   * Asks before discarding unsaved work (Requirement 20.8).
   *
   * Reads EVERY open document rather than only the active one, because the switch
   * closes every tab and any of them may be dirty - a confirmation that only looked
   * at the front tab would discard a background document silently, which is the
   * exact failure this requirement is about.
   *
   * Uses the RESOLVED value of the promise, never `ConfirmDialogService.active()`
   * in the `.then()`: that signal is already cleared by the time the dialog
   * resolves.
   */
  private async confirmUnsaved(): Promise<boolean> {
    const dirty = this.workflow.documents().filter(doc => doc.dirty);
    if (dirty.length === 0) return true;
    const names = dirty.map(doc => doc.name).join(', ');
    return this.confirm.confirm({
      title: dirty.length === 1 ? 'Discard unsaved changes?' : 'Discard unsaved changes?',
      message:
        `Switching account closes every open workflow, and ${names} ` +
        `${dirty.length === 1 ? 'has' : 'have'} changes that are not saved. ` +
        'Save first if you want to keep them.',
      confirmLabel: 'Discard and switch',
      cancelLabel: 'Keep editing',
      tone: 'danger',
    });
  }

  /**
   * Puts the organisation in the Clerk session claim, in a browser build.
   *
   * On the RAW Clerk instance behind `ClerkService.clerk$`, because `ClerkService`
   * does not expose `setActive` - the same idiom `PhormaCloudService.signOut()`
   * already uses. Deliberately NOT `ngx-clerk`'s `ClerkOrganizationSwitcherComponent`:
   * it offers organisation creation and self-join, which Requirement 20.12 forbids,
   * and it carries Clerk's own chrome.
   *
   * A failure is REPORTED and the switch continues, which is the right trade in
   * both directions. The `X-Phorma-Owner` header is already in force by the time
   * this runs, and the worker confirms membership on every request - so the switch
   * works without the claim. What is lost is only that the claim and the header
   * would then disagree until the next sign-in, and the worker prefers the claim,
   * so the user needs to know.
   *
   * A desktop build holds no Clerk session at all (`user$` emits null for a
   * genuinely signed-in install), so `isDesktop` short-circuits rather than
   * awaiting a `clerk$` that would answer with nothing useful.
   */
  private async tellClerk(orgId: string | null): Promise<void> {
    if (this.tauri.isDesktop) return;
    try {
      const clerk = await firstValueFrom(this.clerk.clerk$);
      if (!clerk?.session) return;
      await clerk.setActive({ organization: orgId });
    } catch {
      this.toast.warning(
        'Switched, with one thing outstanding',
        'Your sign-in session could not be told about the change. Everything in this ' +
          'session uses the account you picked; sign in again if something looks wrong.',
      );
    }
  }

  /** The label for one owner, for a menu item. */
  labelOf(owner: OwnerChoice): string {
    return owner.label;
  }
}
