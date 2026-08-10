# Deployed credential vault - design

## Shape

```
studio (value typed by the operator)
  |
  |-- ConnectionsService.writeSecret ---------> OS keychain  conn:{id}:{key}   (local runs)
  |
  '-- CloudService.putConnectionSecret ------->  POST {base}/api/connection-secrets
                                                   |
                                                   | encryptString(value, KEY_ENC_SECRET)
                                                   v
                                                 SecretVault DO   secrets:{ownerId}
                                                   entry key = workerSecretName(id, key)
                                                   value     = AES-GCM ciphertext
                                                                       ^
                                                                       | decryptString
  WorkflowAgent -> WorkerConnectionStore.secretValue(name) ------------'
        1. env[name]            (wrangler secret put - takes priority)
        2. secretSource.read(name)  (the vault)
```

The value never travels with a workflow push, and no route returns it. The studio's own copy is
unreadable by design, which is why the send action reads the CURRENT DRAFT rather than a stored
value: a "sync my stored secrets" button would need a keychain read path that deliberately does not
exist.

## Why a Durable Object, and why one per owner

`PortalIndex` is the precedent: a plain `DurableObject` (never the `agents` SDK `Agent`, whose state
broadcast would expose the table to any connected socket) addressed as a singleton by
`idFromName`. It needs no D1 and no KV, so a BYO operator still deploys with one
`wrangler deploy`.

Scope is per OWNER, not per workflow. A per-workflow vault would have been simpler - the connection
metadata push is already per instance - but it would force the operator to re-enter the same API key
once per workflow that uses the connection, which is its own dead end. The instance name
`secrets:{userId}` mirrors the gateway's existing `{userId}:{workflowId}` workflow-instance prefix,
so tenant isolation here is the same structural boundary rather than a second scheme to keep in
step. BYO has one tenant and uses `secrets:default`.

## Read path

`WorkerConnectionStore` gained an optional `secretSource`, which made `secretValue` and
`readDeclaredSecrets` async and therefore `list()` a loop rather than a `filter`. Lookups are
memoised per store instance, and a store is built per run/request, so a rotated secret is picked up
by the next one with no invalidation logic. A vault failure or a decryption failure reads as
ABSENT - the caller already turns absence into a named, actionable error, and a half-decrypted
credential must never reach an outbound request.

`WorkflowAgent.connectionHost(workflowId, ownerFallback?)` takes an owner fallback because the push
sequence reads the inventory BEFORE `POST /workflow` stamps `ownerId`:

```
pushConnectionMetadata -> fetchConnectionInventory -> POST /workflow (stamps ownerId)
```

Without the fallback, a hosted tenant's very first deploy of a workflow would look at the default
vault and report every secret missing. The two inventory routes pass `auth.userId`; cron and resume
paths need no fallback because a spec (and therefore an owner) already exists by then.

## Route

`GET | POST | DELETE /api/connection-secrets`, placed ABOVE the `store.enabled` gate in
`api.ts` - it is the one control-plane surface a BYO deployment needs too. Gates, in order:

1. BYO with neither `CLERK_SECRET_KEY` nor `PHORMA_TOKEN` -> 403 naming `PHORMA_TOKEN`. The rest of
   the worker treats an open instance as owner-operated; a credential store cannot.
2. `verifyRequest` -> 401. Hosted additionally requires a `userId`.
3. No `SecretVault` binding (a worker deployed before this shipped) -> 501.
4. No `KEY_ENC_SECRET` -> 501 naming it. Never a plaintext fallback.
5. `isConnectionId` + `^[A-Za-z0-9_.\-]{1,64}$` on the secret key -> 400.

`GET` returns `{ secrets: [{ name, updatedAt }] }`. The vault itself bounds entries
(`SECRET_VAULT_MAX_ENTRIES`) and value size (`SECRET_VAULT_MAX_VALUE_CHARS`).

## Validation message

`HostCapabilities.connectionSecretScheme` (`os-keychain` | `cloudflare-worker-env` | `none`) is
declared data, not an inferred host id, so the validator maps a scheme to a remedy and a future host
inherits nothing by accident. `ConnectionSummary.missingSecretKeys` is populated by both stores and
is still a name list, so it is exactly as secret-free as `secretKeys`; the validator falls back to
listing every declared name when a host omits it.

## Studio surface

Auto-declaration lives in `withAuthSecretKeys(existing, auth)` over the engine's
`authSecretKeyNames(auth)`, applied on both the create and the update path of the connection editor.
Add-only, per requirement 2.

The Secrets section gains a cloud badge and a cloud upload button per row, and its host gate widened
from "keychain available" to "keychain available OR a deploy target configured" - which also gives
browser-parity users a working path for the first time, with the local save button disabled and
labelled.

## Deployment

New DO class needs a binding plus migration `v3` in BOTH the committed `wrangler.jsonc` top level
and the `hosted` env, AND in `DeployConfigService`'s generated `wrangler.byo.jsonc` - the generated
file REPLACES the committed one, so a missing tag there silently drops the binding from every BYO
deploy. `deploy-config.test.mjs` now derives the expected class list from `src/index.ts`'s export
statement, so exporting a class without binding it fails the suite instead of the deploy.
