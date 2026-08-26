# Requirements Document

## Introduction

A user reinstalled Phorma Agent Studio and lost the entire local workflow library with the
IndexedDB that held it. One of those workflows was deployed to Phorma Cloud. That deployment is
still live: cron still fires, the portal still answers, credits are still spent, and nothing in the
studio can address or remove it, because the only copy of its `workflowId` was in the wiped local
database. A deployment became unreachable and unbillable-to-a-name at the same moment the local
copy disappeared.

This feature closes both halves of that failure:

- **Phase 1 - reconciliation.** Every live deployment in a signed-in user's account becomes
  discoverable, downloadable, restorable and removable from the studio, including deployments with
  no local counterpart. This is the fix for the orphan and it requires no subscription.
- **Phase 2 - durable backup.** Phorma Cloud subscribers get append-only, revision-tracked backups
  of their workflow specs with a restore path that preserves workflow identity, so a wiped install
  can be rehydrated.

Phase 1 ships as a self-contained release: it must work with no Phase 2 component present, so the
orphan fix is not blocked behind backup storage. BYO and free installs get Phase 1 for free because
the Portal_Index lives in their own worker, and they get a file-based durability path in the same
release rather than Phorma-hosted storage.

The guiding principle is that **a backup is not a mirror**. A local delete must never propagate as
a cloud delete. Backups are append-only with soft-delete, a tombstone retention window, and an
explicit separate purge action. Losing a laptop, uninstalling the app, or deleting a workflow
locally are all recoverable events.

Encryption at rest reuses the existing `encryptString` / `KEY_ENC_SECRET` rail, which means Phorma
Labs can technically decrypt a backup body. That is deliberate, so support-assisted recovery stays
possible, and it must be disclosed plainly in the product with a one-click disable and delete-all.
End-to-end encryption under a user passphrase is rejected: a forgotten passphrase would reproduce
the exact loss this feature exists to prevent.

## Glossary

- **Studio**: the Angular frontend of Phorma Agent Studio.
- **Worker_Host**: the Cloudflare Worker in `cloud/`, in either hosted or BYO shape.
- **Workflow_Agent**: the `WorkflowAgent` Durable Object that holds one deployed workflow.
- **Portal_Index**: the existing `PortalIndex` Durable Object in `cloud/src/portal-registry.ts`.
- **Deployment_Registry**: the third key space added to Portal_Index under
  `deploy:{ownerId}:{workflowId}`, holding one Deployment_Record per live deployment.
- **Deployment_Record**: `{workflowId, ownerId, workflowName, deployedAt, updatedAt, specHash,
  cronArmed, portalSlug}`.
- **Deployments_API**: the Clerk-authenticated `GET /api/deployments` route on the Worker_Host.
- **Reconciliation_List**: the "Deployed in your account" list in Studio Settings > Cloud.
- **Orphan**: a live deployment whose `workflowId` is present in the Deployment_Registry and absent
  from the local workflow library.
- **Backup_Metadata_Store**: the hosted-only D1 table `workflow_backups`.
- **Backup_Body_Store**: the hosted-only R2 bucket holding
  `backup/{tenantId}/{workflowId}/{revision}.json.gz`.
- **Backup_Service**: `frontend/src/app/core/cloud/workflow-backup.service.ts`.
- **Backup_State_Store**: the IndexedDB store `workflow-backup-state`, per-workflow
  `{lastUploadedHash, revision}`.
- **Restore_Rail**: `WorkflowService.restoreSpec`, the identity-preserving counterpart to
  `importSpec`.
- **Library_Exporter**: the file-based "Export library" capability for BYO and free installs.
- **Workflow_Actions**: the assistant action registry surface in
  `core/studio-actions/workflow-actions.service.ts`.
- **Operator_Runbook**: the documented support procedure for identifying and tearing down orphans
  created before this feature shipped.
- **Backup_Body**: the gzipped, encrypted serialized Workflow_Spec stored in the Backup_Body_Store.
- **Workflow_Spec**: a version-1 `WorkflowSpec` as produced by `WorkflowService.exportActiveSpec()`,
  including the embedded skill and sub-workflow closure.
- **Tombstone**: a Backup_Metadata_Store row with `deleted_at` set and its Backup_Body still
  present.
- **Tenant_Id**: the Clerk user id, matching `tenants.id` in D1.
- **Revision**: the monotonically increasing integer the Worker_Host assigns to each accepted
  backup upload for one workflow.

## Requirements

### Requirement 1: Deployment registry key space

**User Story:** As a Phorma Cloud user, I want every workflow I have deployed to be enumerable from
my account, so that a deployment can never become unreachable when my local library is lost.

#### Acceptance Criteria

1. THE Portal_Index SHALL store one Deployment_Record per live deployment under the storage key
   `deploy:{ownerId}:{workflowId}`.
2. THE Portal_Index SHALL expose an owner enumeration that reads
   `ctx.storage.list({prefix: 'deploy:{ownerId}:'})` and returns every Deployment_Record for that
   owner.
3. THE Portal_Index SHALL retain the class name `PortalIndex`, so that no `renamed_classes`
   migration is required in `cloud/wrangler.jsonc`, `env.hosted` and the `DeployConfigService`
   generated BYO override.
4. THE Deployment_Registry SHALL be available in both hosted and BYO deployments, because the
   Portal_Index exists in both.
5. WHERE the deployment is BYO and single-tenant, THE Portal_Index SHALL use the literal owner
   segment `default` in the `deploy:` key, so that the key shape stays uniform.
6. THE Deployment_Registry SHALL hold no secret value and no Workflow_Spec body, only the
   Deployment_Record fields named in the Glossary.
7. FOR ALL Deployment_Records written twice with the same `workflowId` and `ownerId`, the resulting
   registry contents SHALL equal the contents after a single write of the later record
   (register idempotence property).
8. FOR ALL sequences of register and deregister calls for one `workflowId`, the final registry
   contents SHALL depend only on the last call in the sequence (deregister idempotence property).

### Requirement 2: Server-side registry lifecycle

**User Story:** As a Phorma Cloud user, I want the deployment list to be written by the server, so
that a client that crashes, is uninstalled, or is an old version can never leave the list wrong.

#### Acceptance Criteria

1. WHEN the Workflow_Agent accepts `POST /workflow`, THE Workflow_Agent SHALL write the
   Deployment_Record for that workflow to the Deployment_Registry.
2. WHEN the Workflow_Agent accepts `DELETE /workflow`, THE Workflow_Agent SHALL remove that
   workflow's Deployment_Record from the Deployment_Registry.
3. WHEN `purgeSelf(true)` runs, THE Workflow_Agent SHALL remove that workflow's Deployment_Record
   from the Deployment_Registry.
4. THE Studio SHALL perform no direct write to the Deployment_Registry.
5. IF `POST /workflow` is rejected by the deploy-time capability gate, THEN THE Workflow_Agent SHALL
   leave the Deployment_Registry unchanged.
6. WHEN a Deployment_Record is written, THE Workflow_Agent SHALL set `cronArmed` to the armed state
   of the schedule trigger and `portalSlug` to the current portal slug, or to `null` when no portal
   is published.
7. WHEN a Deployment_Record is written for a workflow that already has one, THE Workflow_Agent SHALL
   preserve the original `deployedAt` value and set `updatedAt` to the write time.
8. THE Workflow_Agent SHALL treat a Deployment_Registry write failure as non-fatal to the
   deployment, and SHALL report the failure through the existing settings-issue channel.
9. THE Workflow_Agent SHALL write no Deployment_Record for a portal session instance
   (an instance name containing `#s`).

### Requirement 3: Lazy backfill of existing deployments

**User Story:** As a user who deployed before this feature existed, I want my old deployments to
appear in the list without redeploying them, so that today's orphan becomes visible.

#### Acceptance Criteria

1. WHILE the Worker_Host is in hosted mode, WHEN `onStart()` runs and a Workflow_Spec is present in
   the Durable Object state and no Deployment_Record exists for that workflow, THE Workflow_Agent
   SHALL write the Deployment_Record from the state it already holds.
2. WHEN the backfill writes a Deployment_Record with no recorded deployment time, THE
   Workflow_Agent SHALL set `deployedAt` from the stored `savedAt` value.
3. THE Workflow_Agent SHALL perform the backfill on any wake, including a wake caused by a cron
   trigger, a portal request, a run, or an authenticated route.
4. IF no Workflow_Spec is present in the Durable Object state, THEN THE Workflow_Agent SHALL write
   no Deployment_Record during `onStart()`.
5. THE backfill SHALL leave an existing Deployment_Record unmodified, so that a wake never
   overwrites a newer record with older state.
6. THE Operator_Runbook SHALL state that a deployment with no armed cron, no published portal and no
   run history stays absent from the Deployment_Registry until its next wake, and that such a
   deployment spends no credits while it sleeps.

### Requirement 4: Deployed spec read-back

**User Story:** As a user whose local library is gone, I want to download the spec that is actually
deployed, so that the deployment itself is a recoverable copy.

#### Acceptance Criteria

1. THE Workflow_Agent SHALL serve `GET /agents/workflow-agent/{id}/workflow` returning the deployed
   Workflow_Spec from Durable Object state.
2. THE Workflow_Agent SHALL require the same authentication and ownership checks on that route as
   every other authenticated instance route.
3. IF the caller is authenticated but is not the owner recorded in Durable Object state, THEN THE
   Workflow_Agent SHALL refuse the request with the existing ownership response.
4. IF no Workflow_Spec is deployed on that instance, THEN THE Workflow_Agent SHALL respond with
   HTTP 404 and a message stating that nothing is deployed.
5. THE response body SHALL carry no secret value, no connection secret, and no cached OAuth token.

### Requirement 5: Deployments API

**User Story:** As a signed-in user, I want one call that lists my live deployments and what they
are costing me, so that I can see spend I did not know about.

#### Acceptance Criteria

1. THE Deployments_API SHALL serve `GET /api/deployments` and SHALL require a valid Clerk session.
2. THE Deployments_API SHALL return only the Deployment_Records whose `ownerId` equals the
   authenticated caller's Tenant_Id.
3. THE Deployments_API SHALL join each returned row with that workflow's month-to-date usage from
   the D1 `usage` table for the caller's Tenant_Id.
4. THE Deployments_API SHALL express spend as plan credits, and SHALL express no Phorma Cloud spend
   in dollars.
5. IF the D1 binding is absent, THEN THE Deployments_API SHALL return the Deployment_Records with a
   null spend figure rather than failing the request.
6. THE Deployments_API SHALL be reachable by any signed-in user, independent of subscription state.
7. FOR ALL Deployment_Registry contents and all authenticated callers, the response SHALL contain no
   row whose `ownerId` differs from the caller's Tenant_Id (tenant isolation property).

### Requirement 6: Reconciliation list in Settings > Cloud

**User Story:** As a user, I want to see every live deployment in my account next to what it costs,
so that I can clean up what I no longer want.

#### Acceptance Criteria

1. WHILE the user is signed in, THE Studio SHALL render a "Deployed in your account" list in
   Settings > Cloud populated from the Deployments_API.
2. THE Reconciliation_List SHALL include every returned deployment, including an Orphan with no
   local library counterpart.
3. THE Reconciliation_List SHALL mark each Orphan visibly as having no local copy.
4. THE Reconciliation_List SHALL show, per row, the workflow name, the deployment time, whether cron
   is armed, the portal address when one is published, and the month-to-date credits spent.
5. THE Reconciliation_List SHALL offer, per row, the actions Download spec, Restore to library,
   Undeploy and Purge.
6. THE Studio SHALL gate the Reconciliation_List on being signed in and SHALL NOT gate it on
   `phormaCloud.subscribed()`, so that a lapsed subscriber can still remove a cron Orphan.
7. IF the Deployments_API is unreachable, THEN THE Studio SHALL show the failure in the panel and
   SHALL keep the retry action available.
8. THE Studio SHALL route every Reconciliation_List request through a `CloudOperation` entry in
   `frontend/src/app/core/deploy/deploy-targets.ts`, and SHALL issue no bespoke fetch.

### Requirement 7: Self-service orphan removal

**User Story:** As a user with a deployment I cannot find locally, I want to stop and remove it
myself, so that I do not have to contact support to stop spending credits.

#### Acceptance Criteria

1. WHEN the user confirms Undeploy for a Reconciliation_List row, THE Studio SHALL call
   `DELETE /workflow` for that instance, which cancels cron and removes the deployed spec while
   keeping run history, the usage ledger and connection metadata.
2. WHEN the user confirms Purge for a Reconciliation_List row, THE Studio SHALL call
   `DELETE /workflow/purge` for that instance, which additionally unpublishes the portal, purges
   tracked portal session Durable Objects and empties every Durable Object SQLite table.
3. THE Studio SHALL require an explicit confirmation through `ConfirmDialogService` before Undeploy
   and before Purge.
4. WHEN an Undeploy or Purge succeeds, THE Studio SHALL remove that row from the
   Reconciliation_List without a full page reload.
5. IF a run is in progress on that instance, THEN THE Studio SHALL surface the Worker_Host's HTTP
   409 message telling the user to stop the run first.
6. WHEN the user chooses Download spec, THE Studio SHALL write the read-back Workflow_Spec to a
   `.phorma.json` file.
7. WHEN the user chooses Restore to library, THE Studio SHALL add the read-back Workflow_Spec to the
   local library through the Restore_Rail, preserving its `id`.
8. THE Undeploy and Purge actions SHALL leave any Backup_Metadata_Store row and Backup_Body for that
   workflow untouched.

### Requirement 8: Operator runbook for pre-existing orphans

**User Story:** As a support operator, I want a documented procedure for finding an orphan that
predates this feature, so that a user who reports unexplained spend can be helped today.

#### Acceptance Criteria

1. THE Operator_Runbook SHALL be committed as a document in the repository.
2. THE Operator_Runbook SHALL state that `tenants.id` is the Clerk user id and that `tenants.email`
   maps a reported email address to it.
3. THE Operator_Runbook SHALL state that
   `SELECT DISTINCT workflow_id FROM usage WHERE tenant_id = ?` in D1 yields every workflow that has
   spent credits for that tenant.
4. THE Operator_Runbook SHALL state that Portal_Index `portal:{slug}` records carry
   `{workflowId, ownerId}` and are the second handle on an unknown deployment.
5. THE Operator_Runbook SHALL state that
   `DELETE /agents/workflow-agent/{userId}:{workflowId}/workflow/purge` with an admin-minted token
   performs the teardown.
6. THE Operator_Runbook SHALL state that the Deployment_Registry and its lazy backfill are the
   forward fix, so that the manual procedure applies only to deployments created before this
   feature.

### Requirement 9: Backup metadata store

**User Story:** As a Phorma Cloud subscriber, I want the server to keep an authoritative record of
my backed-up workflows, so that a restore can list what is available before downloading anything.

#### Acceptance Criteria

1. THE Worker_Host SHALL add the migration `cloud/migrations/0003_workflow_backups.sql` creating the
   table `workflow_backups(tenant_id, workflow_id, name, revision, spec_hash, size_bytes, saved_at,
   updated_at, deleted_at)` with primary key `(tenant_id, workflow_id)`.
2. THE Backup_Metadata_Store SHALL be hosted-only and SHALL be gated by the same `TenantStore.enabled`
   check as every other D1 read and write.
3. IF the D1 binding is absent, THEN THE Worker_Host SHALL answer every backup route with a response
   stating that backup is not available on this deployment, and SHALL NOT fail any deployment,
   trigger or portal route.
4. THE Backup_Metadata_Store SHALL hold no Workflow_Spec body and no secret value.
5. THE Worker_Host SHALL return only rows whose `tenant_id` equals the authenticated caller's
   Tenant_Id.

### Requirement 10: Backup bodies and revision history

**User Story:** As a subscriber, I want previous versions of a backed-up workflow, so that a bad
edit that was autosaved is not the only copy I can restore.

#### Acceptance Criteria

1. THE Worker_Host SHALL store each accepted Backup_Body in the Backup_Body_Store at
   `backup/{tenantId}/{workflowId}/{revision}.json.gz`.
2. THE Worker_Host SHALL gzip-compress each Backup_Body before storing it.
3. WHEN the Worker_Host stores a Backup_Body, THE Worker_Host SHALL write to a key that does not
   already exist, because each accepted upload receives a new Revision.
4. THE Worker_Host SHALL serve a download route returning a single Backup_Body for a named
   `{workflowId, revision}` belonging to the caller.
5. THE Worker_Host SHALL serve a route listing the retained Revisions for one workflow.
6. THE Worker_Host SHALL require the R2 binding to exist under `env.hosted` only, and the new
   binding SHALL keep `cloud/test/deploy-config.test.mjs` passing.
7. THE Worker_Host SHALL retain the 10 most recent Revisions per workflow and SHALL delete older
   Backup_Bodies for that workflow when a new Revision is accepted.
8. IF an upload's uncompressed Backup_Body exceeds 2 MB, THEN THE Worker_Host SHALL refuse it with a
   response naming the limit and the actual size, and SHALL store nothing.
9. THE Worker_Host SHALL cap the number of backed-up workflows per tenant at 25 on starter, 100 on
   pro and 250 on team.
10. IF a tenant is at the workflow-count cap and uploads a workflow that has no existing
    Backup_Metadata_Store row, THEN THE Worker_Host SHALL refuse the upload with a response naming
    the cap, and SHALL leave every existing backup intact.
11. WHILE a tenant is at the workflow-count cap, THE Worker_Host SHALL continue to accept uploads for
    workflows that already have a Backup_Metadata_Store row, so an existing backup never goes stale
    because of the cap.
12. FOR ALL Workflow_Specs uploaded and then downloaded at the same Revision, the parsed downloaded
    spec SHALL equal the uploaded spec (backup body round-trip property).
13. FOR ALL sequences of accepted uploads for one workflow, the count of retained Backup_Bodies SHALL
    be at most 10 and SHALL always include the newest Revision (retention bound property).

### Requirement 11: Encryption at rest and its disclosure

**User Story:** As a subscriber, I want my backed-up workflows encrypted at rest and I want to know
exactly who can read them, so that I can make an informed choice about using the feature.

#### Acceptance Criteria

1. THE Worker_Host SHALL encrypt every Backup_Body with the existing `encryptString` rail under
   `KEY_ENC_SECRET` before storing it.
2. IF `KEY_ENC_SECRET` is absent, THEN THE Worker_Host SHALL refuse the upload naming the missing
   secret, and SHALL NOT store an unencrypted Backup_Body.
3. THE Studio SHALL state in the Settings > Cloud backup copy that Phorma Labs holds the encryption
   key and can technically decrypt a backup, and that this is what makes support-assisted recovery
   possible.
4. WHILE backup is enabled, THE Studio SHALL show the decryption disclosure beside the backup state
   in Settings > Cloud, so the disclosure is visible without opening a dialog.
5. THE Studio SHALL offer a single control that disables backup and deletes every stored
   Backup_Body and Backup_Metadata_Store row for the signed-in user.
6. WHEN the user confirms disable-and-delete-all, THE Worker_Host SHALL remove the caller's
   Backup_Metadata_Store rows and Backup_Bodies, and SHALL treat this as the only user-facing path
   that destroys backup data outright.
7. THE Studio SHALL NOT offer end-to-end encryption under a user passphrase, because a forgotten
   passphrase would reproduce the loss this feature prevents.

### Requirement 12: Backup client service

**User Story:** As a subscriber, I want my workflows backed up as I work without thinking about it,
so that durability is not another thing to remember.

#### Acceptance Criteria

1. THE Backup_Service SHALL live at `frontend/src/app/core/cloud/workflow-backup.service.ts`.
2. THE Backup_Service SHALL inject `WorkflowService` and `IndexedDbStorageService`, and SHALL read
   the Phorma Cloud base URL through `loadPhormaCloudUrl()`.
3. THE `WorkflowService` SHALL NOT inject the Backup_Service, and the Backup_Service SHALL observe
   library changes through an `effect()` on `WorkflowService.library()`, so that the NG0200 cycle
   hazard stays closed.
4. THE Backup_Service SHALL debounce upload scheduling to an interval longer than the 2 second
   autosave interval.
5. THE Backup_Service SHALL serialize a workflow for upload through the same rail as
   `exportActiveSpec()`, so that embedded skills and the sub-workflow closure travel with the spec.
6. THE Backup_Service SHALL compare a candidate spec with the last uploaded spec using
   `workflowSpecsEqual` from `core/workflow-diff.ts`, and SHALL upload only when they differ.
7. WHILE the user is not signed in, THE Backup_Service SHALL schedule no upload.
8. WHILE the signed-in user has an active Phorma Cloud subscription and has not disabled backup, THE
   Backup_Service SHALL treat backup as enabled, so a subscriber is protected without opting in.
9. WHILE the signed-in user has no active Phorma Cloud subscription and has no existing backups, THE
   Backup_Service SHALL schedule no upload.
10. IF an upload fails with a network or server error, THEN THE Backup_Service SHALL keep the local
    spec unchanged, retain the previous `lastUploadedHash`, and retry on the next change or on the
    next sign-in.
11. THE Backup_Service SHALL route every request through a `CloudOperation` entry in
    `frontend/src/app/core/deploy/deploy-targets.ts`.
12. FOR ALL sequences of library changes that leave a workflow semantically unchanged, the
    Backup_Service SHALL issue zero upload requests (no-op suppression property).

### Requirement 13: Backup state store

**User Story:** As a subscriber, I want the app to know what it has already uploaded, so that
restarting the studio does not re-upload my whole library.

#### Acceptance Criteria

1. THE Studio SHALL add the IndexedDB store `workflow-backup-state` holding, per workflow,
   `lastUploadedHash` and the server-assigned `revision`.
2. THE Studio SHALL raise `DB_VERSION` from 10 to 11 and SHALL add the matching migration in
   `indexed-db-storage.service.ts`.
3. WHEN the IndexedDB upgrade runs on an existing install, THE Studio SHALL preserve every existing
   store and its contents.
4. WHEN a workflow is deleted from the local library, THE Studio SHALL delete that workflow's
   Backup_State_Store entry and SHALL make no cloud call as a result of the local delete.

### Requirement 14: Collision-safe workflow ids

**User Story:** As a user restoring workflows across installs, I want workflow ids to be globally
unique, so that two machines cannot mint the same id and lose one another's history.

#### Acceptance Criteria

1. WHEN the Studio mints a new workflow id, THE Studio SHALL produce an id combining the existing
   `wf-${Date.now().toString(36)}` prefix with a `crypto.randomUUID()` derived suffix.
2. THE Studio SHALL leave every existing workflow id unchanged and SHALL continue to address,
   deploy, restore and back up workflows that carry a legacy id.
3. FOR ALL pairs of ids minted in the same millisecond, the two ids SHALL differ (id uniqueness
   property).
4. THE Studio SHALL keep the `saveNewSpecToLibrary` collision re-mint as a last-resort guard, and
   the guard SHALL be unreachable for newly minted ids.

### Requirement 15: Identity-preserving restore

**User Story:** As a user restoring a backup, I want the restored workflow to keep its original id,
so that it still addresses its own deployment, run history and usage.

#### Acceptance Criteria

1. THE Studio SHALL provide a Restore_Rail that writes a Workflow_Spec into the library keeping the
   spec's `id` exactly as received.
2. THE `importSpec` behaviour SHALL remain unchanged and SHALL continue to mint a fresh id, because
   file import is a copy, not a restore.
3. IF a local workflow already exists with the restored `id`, THEN THE Studio SHALL ask the user to
   choose between keeping the local copy and replacing it with the restored copy, and SHALL mint no
   new id in either case.
4. WHEN a restore completes, THE Studio SHALL make the restored workflow addressable at its original
   deployment instance without any further user step.
5. FOR ALL Workflow_Specs taken through export, upload, download and restore, the restored spec's
   `id`, `name`, graph node ids and edge list SHALL equal those of the original
   (identity round-trip property).

### Requirement 16: Optimistic concurrency

**User Story:** As a user with the studio open on two machines, I want a conflicting backup upload
to be reported rather than silently discarded, so that I do not lose work to last-write-wins.

#### Acceptance Criteria

1. THE Worker_Host SHALL hold a monotonically increasing integer Revision per
   `(tenant_id, workflow_id)`.
2. THE Backup_Service SHALL send the Revision it last observed as an `If-Match` header on every
   upload.
3. WHEN an upload arrives with an `If-Match` Revision equal to the stored Revision, THE Worker_Host
   SHALL accept the upload and SHALL increment the stored Revision by exactly one.
4. IF an upload arrives with an `If-Match` Revision that differs from the stored Revision, THEN THE
   Worker_Host SHALL respond with HTTP 409 and the current Revision, and SHALL store no
   Backup_Body.
5. WHEN the Studio receives a 409 from an upload, THE Studio SHALL surface the conflict through the
   existing version-history UI so the user can compare and choose.
6. THE Worker_Host SHALL NOT merge two conflicting specs.
7. FOR ALL interleavings of concurrent uploads for one workflow, the stored Revision SHALL be
   strictly increasing and SHALL never repeat a value (revision monotonicity property).
8. FOR ALL concurrent upload pairs carrying the same `If-Match` value, exactly one SHALL be accepted
   (single-winner property).

### Requirement 17: Append-only semantics, soft delete and purge

**User Story:** As a user who deleted a workflow locally or reinstalled the app, I want my backup to
still be there, so that a local action can never destroy my last copy.

#### Acceptance Criteria

1. THE Worker_Host SHALL treat the Backup_Metadata_Store and Backup_Body_Store as append-only, and
   SHALL express a delete as setting `deleted_at` on the metadata row.
2. THE Worker_Host SHALL destroy backup data through exactly three paths and no other: the revision
   retention prune of Requirement 10.7, the explicit purge of a Tombstone, and the
   disable-and-delete-all of Requirement 11.6.
3. WHEN a workflow is deleted from the local library, THE Studio SHALL send no delete of any kind to
   the Backup_Metadata_Store or Backup_Body_Store.
4. WHEN the user explicitly deletes a backup, THE Worker_Host SHALL set `deleted_at`, retain the
   Backup_Bodies, and keep the workflow restorable for 30 days from `deleted_at`.
5. WHILE a Tombstone is within 30 days of its `deleted_at` value, THE Worker_Host SHALL continue to
   serve its Backup_Bodies for download and restore.
6. THE Studio SHALL provide a purge action, separate from delete, that removes a Tombstone's
   metadata row and Backup_Bodies permanently.
7. WHEN the user invokes purge, THE Studio SHALL require an explicit confirmation naming the
   workflow and stating that the action cannot be undone.
8. WHEN a Tombstone passes 30 days from its `deleted_at` value, THE Worker_Host SHALL remove its
   metadata row and Backup_Bodies.
9. THE Studio SHALL show, for each Tombstone, the number of days remaining before it is removed.
10. FOR ALL sequences of local library operations, including delete-all and a full local database
    wipe, the set of Backup_Bodies in the Backup_Body_Store SHALL be unchanged
    (local delete never propagates property).
11. FOR ALL Tombstones within 30 days of `deleted_at`, restore SHALL produce a Workflow_Spec equal to
    the one that was backed up before deletion (soft-delete restorability property).

### Requirement 18: Restore surface

**User Story:** As a user signing in on a fresh install, I want to be told my workflows can be
restored, so that I do not have to know the feature exists to benefit from it.

#### Acceptance Criteria

1. WHEN the user signs in and the local library is empty and at least one non-purged backup exists,
   THE Studio SHALL show an inline banner in the Workflows panel offering restore.
2. THE Studio SHALL NOT show a modal or a required wizard step for restore, so that a user can still
   run something immediately after sign-in.
3. THE restore banner SHALL offer restore of one selected workflow and restore of every available
   workflow.
4. THE Studio SHALL let the user dismiss the banner, and SHALL keep restore reachable from
   Settings > Cloud after dismissal.
5. WHEN a restore-all completes, THE Studio SHALL report the count restored and the count that
   failed, and SHALL leave a partial result in place rather than rolling back successful restores.
6. WHILE the local library is not empty, THE Studio SHALL NOT show the restore banner, and restore
   SHALL remain reachable from Settings > Cloud.

### Requirement 19: Connection metadata and the dependency gap

**User Story:** As a user restoring a workflow, I want to be told which connections I need to
reconnect, so that a restore does not fail silently at run time.

#### Acceptance Criteria

1. THE Backup_Service SHALL include, in the Backup_Body, the id and display name of every connection
   the spec references.
2. THE Backup_Service SHALL include no connection secret value, no token, and no credential field in
   the Backup_Body.
3. WHEN a restore completes, THE Studio SHALL compare referenced connection ids with the local
   connections store and SHALL report by name every referenced connection that is missing locally.
4. THE Studio SHALL state, on the restore surface, that prompts, skills, connectors and connection
   secrets are not part of a v1 backup.
5. FOR ALL Backup_Bodies produced by the Backup_Service, the body SHALL contain no value from the
   connections secret material and no field matching the secret-shaped detection used by
   `validateConnectorBundle` (no-secret-in-backup property).

### Requirement 20: Subscription lapse policy

**User Story:** As a user whose subscription lapsed, I want my existing backups to remain
restorable, so that lapsing does not destroy my work.

#### Acceptance Criteria

1. WHILE a tenant's subscription is lapsed and within 90 days of the lapse, THE Worker_Host SHALL
   allow list, download and restore of that tenant's backups.
2. WHILE a tenant's subscription is lapsed, THE Worker_Host SHALL refuse new uploads with a response
   stating that backups are read-only until the subscription is renewed.
3. THE Worker_Host SHALL NOT delete a lapsed tenant's backups during the 90 day read-only window.
4. WHEN a lapsed tenant renews, THE Worker_Host SHALL accept uploads again with no further user
   action.
5. WHILE a subscription is lapsed, THE Studio SHALL show the read-only state and the remaining
   window in Settings > Cloud.

### Requirement 21: Durability for BYO and free installs

**User Story:** As a user who brings my own everything, I want a durable copy of my library without
sending it to Phorma storage, so that the product rule still holds for me.

#### Acceptance Criteria

1. THE Library_Exporter SHALL write every library Workflow_Spec plus a `deployments.json` manifest
   to a user-chosen folder.
2. THE `deployments.json` manifest SHALL list each deployment's `workflowId`, name and deployment
   time as read from the Deployment_Registry of the deployment the user is configured against.
3. THE Library_Exporter SHALL be available without a Phorma Cloud subscription and SHALL ship in the
   same release as Phase 1 and Phase 2.
4. WHERE the export folder has been chosen and re-write on save is enabled, THE Studio SHALL rewrite
   the export after a library save.
5. THE Library_Exporter SHALL write no secret value into any exported file.
6. WHERE the app runs in a browser with no Tauri present, THE Studio SHALL fall back to a single
   downloadable archive rather than a folder write, so browser parity holds.

### Requirement 22: Assistant capabilities

**User Story:** As a user, I want to ask the assistant what is deployed and to restore a workflow,
so that recovery is reachable from the same place as every other studio capability.

#### Acceptance Criteria

1. THE Workflow_Actions SHALL register a read action listing the caller's deployments and a read
   action listing available backups, both at the `silent` tier.
2. THE Workflow_Actions SHALL register restore, undeploy, delete-backup and purge actions at the
   `confirm` tier.
3. THE Workflow_Actions SHALL delegate every registered executor to the owning service and SHALL
   reimplement no capability.
4. THE Workflow_Actions SHALL expose deployment and backup data through read actions rather than
   embedding it in a system prompt.

### Requirement 23: Verification

**User Story:** As a maintainer, I want this feature covered by the suites that already gate the
repository, so that a regression is caught before release.

#### Acceptance Criteria

1. THE `cloud` package SHALL gain unit coverage for the Deployment_Registry lifecycle, the backfill,
   the read-back route, the Deployments_API and the backup routes, runnable through
   `npm run test:unit`.
2. WHERE a new Miniflare suite is added, THE suite SHALL create its workers through
   `withLoopbackRetry` from `cloud/test/miniflare-loopback.mjs`.
3. THE frontend SHALL gain karma specs for the Backup_Service, the Restore_Rail, the
   Reconciliation_List and the restore banner.
4. THE property-based coverage SHALL include registry register and deregister idempotence, backup
   body round-trip, identity round-trip through export and restore, revision monotonicity under
   concurrent uploads, the local-delete-never-propagates invariant, and the no-secret-in-backup
   invariant.
5. WHEN a new test suite is added, THE change SHALL add that suite to `.github/workflows/ci.yml` in
   the same commit.
6. IF a shared workflow type changes, THEN THE change SHALL update `engine/src/types.ts` and
   `frontend/src/app/core/workflow.model.ts` together.
7. THE change SHALL keep `cloud/test/deploy-config.test.mjs` passing after the new R2 binding is
   added under `env.hosted`.

### Requirement 24: Phase independence

**User Story:** As a user with an Orphan today, I want the reconciliation fix to reach me without
waiting for backup storage, so that the spend stops sooner.

#### Acceptance Criteria

1. THE Phase 1 surfaces, being the Deployment_Registry, the backfill, the spec read-back route, the
   Deployments_API and the Reconciliation_List, SHALL function on a deployment that has no
   Backup_Metadata_Store table and no Backup_Body_Store binding.
2. IF the Backup_Body_Store binding is absent, THEN THE Studio SHALL hide the backup controls and
   SHALL keep the Reconciliation_List fully operable.
3. THE task list SHALL order every Phase 2 task after every Phase 1 task, so Phase 1 is releasable on
   its own.
4. THE Phase 1 surfaces SHALL require no Clerk subscription check, and the Phase 2 surfaces SHALL be
   the only ones that consult subscription state.

## Resolved decisions

Recorded so the design phase does not re-open them.

1. **Phase sequencing.** Strict: every Phase 2 task follows every Phase 1 task, and Phase 1 must be
   shippable alone (Requirement 24).
2. **Backup default.** ON by default for subscribers, with the decryption disclosure visible in
   Settings > Cloud and a one-click disable-and-delete-all (Requirements 11.4, 11.5, 12.8).
3. **Retention numbers.** 10 Revisions per workflow, 30 day tombstone window, 25 / 100 / 250 backed-up
   workflows on starter / pro / team, 2 MB per spec (Requirements 10.7 to 10.11, 17.3, 17.7). The 90
   day figure in Requirement 20 is the subscription-lapse read-only window and is deliberately a
   different number from the tombstone window.
4. **BYO export scope.** In scope for v1 (Requirement 21.3).

## Out of scope

- End-to-end encryption under a user passphrase. Rejected: a forgotten passphrase reproduces the
  loss this feature prevents.
- Mirror semantics of any kind. A local delete never becomes a cloud delete.
- Backing up secret values, prompts, skills or connector bundles. v1 backs up specs plus connection
  metadata only.
- Renaming the `PortalIndex` Durable Object class.
- Adding a new Durable Object class.
