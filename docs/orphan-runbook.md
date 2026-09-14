# Runbook: an unexplained Phorma Cloud deployment

**When to use this.** A user reports credit spend they cannot account for, or a
published portal that answers for a workflow they say they deleted, and the
studio's own **Settings > Cloud > Deployed in your account** list does not show
it.

That list is the forward fix and it covers almost everything. Reach for this
document only for the residue it cannot: a deployment made before the deployment
registry shipped that has **not woken since**, because the registry is written on
push and backfilled on wake, and an instance with no armed cron, no published
portal and no runs simply does not wake. Such a deployment also **spends nothing
while it sleeps**, so it is a tidiness problem rather than a billing one - the
billing case has already woken and is therefore already listed.

Ask the user to open Settings > Cloud first. If the deployment is listed, they can
stop or delete it themselves and this document is not needed.

---

## 1. Turn the reported email into a tenant id

`tenants.id` **is** the Clerk user id. It is simultaneously the D1 primary key,
the KV cache key, the first segment of every Durable Object instance name, and the
owner segment of a deployment registry key. `tenants.email` is the only mapping
from something a user can tell you.

```bash
npx wrangler d1 execute phorma-cloud --env hosted --remote \
  --command "SELECT id, email, tier, status FROM tenants WHERE email = 'them@example.com'"
```

An empty result is meaningful: a tenant row only exists once someone has
subscribed or been provisioned, so a user with no row has never had hosted
inference and cannot have a hosted deployment spending credits.

Do not re-validate the id you get back. Rows hand-provisioned before
`isClerkUserId` existed can hold an id that check would reject, and refusing to
resolve one would strand a real account.

## 2. Find every workflow that has spent credits

The usage ledger is the authoritative record of spend, and it is keyed by workflow.

```bash
npx wrangler d1 execute phorma-cloud --env hosted --remote \
  --command "SELECT workflow_id, month, COUNT(*) AS runs, SUM(cost_usd) AS cost_usd
               FROM usage
              WHERE tenant_id = 'user_...'
              GROUP BY workflow_id, month
              ORDER BY month DESC, cost_usd DESC"
```

Every `workflow_id` here is a live handle. Cross-check against what the user says
they have: an id they do not recognise is the deployment you are looking for.

`cost_usd` is real USD and is internal. Never quote it to a user - the customer
figure is plan credits, and `creditsForTier` is the only conversion.

## 3. Find a deployment that has spent nothing

A deployment with no runs leaves no usage row, so step 2 cannot see it. Two other
handles:

**A published portal.** `PortalIndex` holds `portal:{slug}` records carrying
`{workflowId, ownerId}`, which is the second handle on an unknown deployment and
the only one that matters if the complaint is "a page I did not know about is
answering". If the user can give you the address, the slug is in it.

**The deployment registry.** `deploy:{ownerId}:{workflowId}` in the same Durable
Object, written on push and backfilled on wake. This is what
`GET /api/deployments` reads, so if it holds the record then so does the studio's
own list, and the user can act without you.

Neither key space is queryable from the CLI - a Durable Object namespace cannot be
enumerated, which is the whole reason the registry exists. Reach them by asking
the worker as the user:

```bash
curl -s -H "Authorization: Bearer $SESSION_TOKEN" \
  https://cloud.phorma-labs.com/api/deployments
```

`$SESSION_TOKEN` has to be that user's own credential; there is no operator
override on this route by design. In practice this step is "ask the user to read
the list to you", which is exactly what Settings > Cloud shows them.

## 4. Read the deployment back before you destroy it

Once you have a `workflowId`, the deployed spec is downloadable. Do this first if
the user has no local copy - the teardown in step 5 is irreversible.

```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  "https://cloud.phorma-labs.com/agents/workflow-agent/user_...:wf-.../workflow"
```

The instance name is `{userId}:{workflowId}`. The hosted gateway rewrites a bare
workflow id to that form for the caller's own account and **refuses a foreign
prefix with 403**, so this cannot be used to read another tenant's deployment.

## 5. Tear it down

Two levels, and the difference matters:

```bash
# Stop it. Cron cancelled, deployed spec removed. Run history, the usage ledger
# and connection metadata are kept, so a re-push needs no other setup.
curl -X DELETE -H "Authorization: Bearer $TOKEN" \
  "https://cloud.phorma-labs.com/agents/workflow-agent/user_...:wf-.../workflow"

# Remove everything. Also unpublishes the portal, purges tracked portal session
# Durable Objects, and empties every table in the instance.
curl -X DELETE -H "Authorization: Bearer $TOKEN" \
  "https://cloud.phorma-labs.com/agents/workflow-agent/user_...:wf-.../workflow/purge"
```

Both answer **409** while a run is in progress. That is not a failure to retry
around: stop the run first, or wait for it.

Neither touches D1 usage rows (retained for billing), the per-tenant
`SecretVault` (connection secrets may be shared across workflows), or any workflow
backup.

## 6. Prefer the self-service path

Everything above is reachable by the user from **Settings > Cloud > Deployed in
your account**, per row: Download, Restore, Stop, Delete. That surface is
deliberately gated on being signed in and **not** on having an active
subscription, because a lapsed subscriber is exactly the person who needs to stop
a cron deployment they are still being billed for.

If a user ends up here, the useful outcome is usually not the curl - it is finding
out why their list did not show them the deployment, and fixing that.

---

## What made this necessary

A user reinstalled the studio. The local IndexedDB that held their workflow
library went with it, and with it the only copy of a deployed workflow's
`workflowId`. The deployment stayed live: cron fired, the portal answered, credits
were spent, and nothing in the studio could name it, because a Durable Object
namespace cannot be enumerated and there was no registry to consult.

The forward fix is the `deploy:` key space in `PortalIndex`, written by the worker
on push, undeploy and purge, backfilled on any wake, and read by
`GET /api/deployments`. Spec: `.kiro/specs/cloud-workflow-backup/`.
