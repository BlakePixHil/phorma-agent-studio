# Deployed credential vault - requirements

## Problem

A connection secret typed in the studio is written to the OS keychain under `conn:{id}:{key}`. A
deployed run cannot read that store. Before this feature the ONLY credential a deployed run could
resolve was a worker environment secret (`CONN_*`, `MCP_*`), and the only way to set one is
`npx wrangler secret put` - a deploy-time command run against the operator's own Cloudflare
account.

The observable failure: push-time validation reported

```
Connection "JIRA Connection" is missing 1 of 1 secret values on Cloudflare Worker
(secret keys: apiKey)
```

and aborted the push, for a secret the operator had just saved successfully. The message named no
remedy, the studio offered no way to supply one (the Settings > Cloud wizard hardcoded five
provider names with no free-form input), and for a Phorma-hosted tenant no remedy existed at all.

Two smaller defects surfaced in the same report:

- The connection editor asks for the same secret name twice: once as the auth mode's pointer
  (`auth.secretKey`), once as a declared field in the Secrets list. Nothing linked them, so a
  mismatch was silent and resolved to nothing at run time.
- The finding counted missing secrets without naming which ones, so even a determined operator
  could not derive the `CONN_*` name to set.

## Requirements

1. THE Studio SHALL declare every secret field name the selected `ConnectionAuth` mode points at
   on the connection's `secretKeys` when the connection is saved, so the operator never types a
   secret name twice and an auth pointer to an undeclared field is unreachable through the editor.
2. THE Studio SHALL only ADD such names, never remove one, because the secret store may still hold
   a value for a name the operator has stopped pointing at.
3. THE Capability_Validator SHALL name WHICH declared secrets a host is missing, not only how many,
   using `ConnectionSummary.missingSecretKeys` when the host supplies it.
4. THE Capability_Validator SHALL end a missing-secret finding with the remedy for that host,
   derived from a declared `HostCapabilities.connectionSecretScheme`, naming the exact store entry.
   A host that declares no scheme SHALL get no remedy text rather than another host's.
5. THE Worker_Host SHALL resolve a connection secret from the worker environment first and from the
   Vault second, so an operator who already set a real worker secret is never overridden.
6. THE Vault SHALL hold one entry per `workerSecretName(connectionId, secretKey)`, scoped to one
   tenant in hosted mode and to the deployment in BYO mode, so a credential is entered once per
   account rather than once per workflow.
7. THE Vault SHALL store only AES-GCM ciphertext, encrypted by the caller with `KEY_ENC_SECRET`
   before it arrives, and SHALL expose no route that returns a decrypted value.
8. THE Vault SHALL refuse to store anything when `KEY_ENC_SECRET` is absent, naming the secret to
   set, rather than falling back to plaintext.
9. THE Vault SHALL refuse to store anything on a BYO deployment that has no authentication
   credential configured at all, because an open worker treats every caller as the owner and a
   stranger could stash a credential and then spend it through a deployed workflow.
10. THE Vault SHALL derive the owner scope from the VERIFIED request identity, never from a request
    field, so one tenant cannot address another's vault.
11. THE Vault SHALL reject a malformed connection id or secret key before storing anything, and
    SHALL bound both the number of entries per owner and the size of one value.
12. THE Studio SHALL send a secret value to the deploy target from the draft the operator is
    currently typing, because neither secret store can be read back and a "sync stored value"
    action would require a read path that must not exist.
12a. THE Studio SHALL write one drafted value to EVERY secret store the install has in a single
    save, and SHALL keep the draft until every one of them holds it. Writing one store and
    discarding the draft made the other store unreachable for that value - the dead end reported
    on 2026-08-11, where a secret saved locally could never be deployed.
13. THE Studio SHALL confirm explicitly before sending a value to Phorma Cloud, once per editor
    session rather than once per secret field, and SHALL NOT require confirmation for the
    operator's own Cloudflare worker. A declined confirmation SHALL still store the value locally
    and SHALL leave the draft on screen, so the decision is reversible without retyping.
14. THE Studio SHALL show, per declared secret, whether the local store and the deploy target each
    hold it, using names only.
15. THE Studio SHALL accept any `^[A-Z][A-Z0-9_]*$` worker secret name in the Settings > Cloud
     wizard, so the fixed provider list is never a dead end for `CONN_*`, `MCP_*` or
     `KEY_ENC_SECRET`.

## Out of scope

- `MCP_<AUTHKEY>` bearer tokens. The vault is shaped to serve them (entries are keyed by worker
  secret name, and `CloudToolHost`'s `resolveBearer` is the only reader), but wiring that path is a
  separate change.
- Interactive-OAuth MCP sessions, which are held per device and have no worker representation at
  all. Still correctly reported as undeployable by the capability validator.
