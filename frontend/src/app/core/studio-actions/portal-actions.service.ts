import { Injectable, inject } from '@angular/core';

import { PortalService } from '../portal.service';
import { WorkflowService } from '../workflow.service';
import {
  actionFail,
  actionOk,
  argBool,
  type ActionArgs,
  type ActionResult,
  type StudioAction,
} from './studio-action.model';

/** Human-readable reason for each publish blocker. */
const BLOCKER_MESSAGES: Record<string, string> = {
  'no-provider': 'Pick a cloud provider in Settings, Cloud first.',
  'no-worker-url': 'The cloud provider has no worker URL configured yet.',
  unsaved: 'Save the workflow before publishing it.',
  'read-only': 'This is a read-only preview; restore it before publishing.',
  invalid: 'The portal configuration on the canvas has errors that must be fixed first.',
};

/**
 * Surface `portal` Studio_Actions (Requirement 2.7) - reading the published
 * endpoint configuration for the active workflow and changing its exposure.
 *
 * Publishing exposes a public endpoint, so it is confirm-tier
 * (Requirement 6.1). Access keys are deliberately NOT mintable from here: the
 * worker only ever shows a minted key once, and a key that scrolls past in a
 * chat transcript is a leaked key (Requirement 6.5).
 *
 * Declared minimums (multi-organisation-phorma Requirement 8.1): both actions are
 * builder - `portal.manage`, and the Portal PANEL carries the same minimum.
 * Reading is gated with writing here, unlike the runs surface, because the read
 * reports the public address and the access key labels of a live endpoint.
 */
@Injectable({ providedIn: 'root' })
export class PortalActionsService {
  private readonly portal = inject(PortalService);
  private readonly workflow = inject(WorkflowService);

  actions(): StudioAction[] {
    return [
      {
        id: 'portal_read',
        label: 'Read the portal configuration',
        description:
          'Returns the published-endpoint configuration for the active workflow: whether a portal trigger exists, publish state, public URL, validation problems and access key labels. Key values are never returned.',
        surface: 'portal',
        access: 'read',
        risk: 'silent',
        minLevel: 'builder',
        activity: () => 'Reading the portal configuration',
        run: () => this.read(),
      },
      {
        id: 'portal_set_exposure',
        label: 'Change the portal exposure',
        description:
          'Publishes the active workflow to its public portal endpoint, or unpublishes it. Publishing pushes the workflow first.',
        surface: 'portal',
        access: 'write',
        risk: 'confirm',
        minLevel: 'builder',
        params: {
          published: {
            type: 'boolean',
            description: 'True to publish, false to unpublish.',
            required: true,
          },
        },
        confirmSummary: args =>
          argBool(args, 'published')
            ? `Publish "${this.workflow.activeName()}" to a public portal endpoint? Anyone with the URL and an access key can trigger it.`
            : `Unpublish "${this.workflow.activeName()}"? Its public URL stops working immediately.`,
        activity: args =>
          argBool(args, 'published') ? 'Publishing the portal' : 'Unpublishing the portal',
        run: args => this.setExposure(args),
      },
    ];
  }

  // ── Executors ────────────────────────────────────────────────────────────

  private async read(): Promise<ActionResult> {
    await this.portal.refresh().catch(() => undefined);
    const record = this.portal.record();
    const validation = this.portal.validation();
    const blocker = this.portal.blocker();
    return actionOk({
      hasPortalTrigger: this.portal.hasPortalTrigger(),
      published: this.portal.published(),
      url: this.portal.url(),
      slug: record?.slug ?? null,
      blocker,
      blockerReason: blocker ? (BLOCKER_MESSAGES[blocker] ?? null) : null,
      unreachable: this.portal.unreachable(),
      workerOutOfDate: this.portal.stale(),
      errors: validation?.errors ?? [],
      warnings: validation?.warnings ?? [],
      accessKeys: (record?.tokens ?? []).map(token => ({
        id: token.id,
        label: token.label,
        createdAt: token.createdAt,
      })),
    });
  }

  private async setExposure(args: ActionArgs): Promise<ActionResult> {
    const published = argBool(args, 'published');
    if (published === undefined) return actionFail("Missing 'published'.");
    if (published) {
      if (!this.portal.hasPortalTrigger()) {
        return actionFail(
          'This workflow has no Portal trigger node, so there is nothing to publish.',
        );
      }
      const blocker = this.portal.blocker();
      if (blocker) {
        return actionFail(BLOCKER_MESSAGES[blocker] ?? 'The workflow cannot be published yet.');
      }
      const ok = await this.portal.publish();
      if (!ok) return actionFail('Publishing failed; see the toast for details.');
      return actionOk({ published: true, url: this.portal.url() }, { revertable: false });
    }
    if (!this.portal.published()) return actionFail('This workflow is not published.');
    await this.portal.unpublish();
    return actionOk({ published: false }, { revertable: false });
  }
}
