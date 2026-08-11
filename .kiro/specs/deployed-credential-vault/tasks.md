# Deployed credential vault - tasks

- [x] 1. Engine contract
  - [x] 1.1 `authSecretKeyNames(auth)` in `engine/src/connections.ts` - every pointer of every auth
        mode, trimmed, de-duplicated, blanks dropped
    - _Requirements: 1, 2_
  - [x] 1.2 `ConnectionSummary.missingSecretKeys?: string[]`
    - _Requirements: 3_
  - [x] 1.3 `HostCapabilities.connectionSecretScheme` + the value on all three capability records
    - _Requirements: 4_
  - [x] 1.4 Actionable missing-secret finding in `capabilities.ts` (`secretRemedy`)
    - _Requirements: 3, 4_
  - [x] 1.5 Unit tests: `authSecretKeyNames` per mode, per-scheme remedy text, missing-key naming
    - _Requirements: 1, 3, 4_

- [x] 2. Worker vault
  - [x] 2.1 `cloud/src/secret-vault.ts` - plain `DurableObject`, ciphertext only, entry/value caps,
        `secretVaultName` / `secretVault` addressing
    - _Requirements: 6, 7, 11_
  - [x] 2.2 `WorkerConnectionStore.secretSource` - env first, vault second, memoised per instance,
        failures read as absent
    - _Requirements: 5_
  - [x] 2.3 `WorkflowAgent.vaultSecretSource` + `connectionHost(workflowId, ownerFallback)` wired
        into both inventory routes
    - _Requirements: 5, 6, 10_
  - [x] 2.4 `GET | POST | DELETE /api/connection-secrets` with the five gates
    - _Requirements: 7, 8, 9, 10, 11_
  - [x] 2.5 Binding + migration `v3` in `wrangler.jsonc` (top level and `hosted`), export from
        `index.ts`, mirror in `DeployConfigService`
  - [x] 2.6 `cloud/test/connection-secrets.test.mjs` - Miniflare, real deploy bundle: the refusal
        paths, the malformed-input paths, and the end-to-end claim that a stored secret flips the
        same `GET /connections` inventory the push validator reads
    - _Requirements: 5, 7, 8, 9, 11_
  - [x] 2.7 `deploy-config.test.mjs` asserts DO classes as a set derived from `src/index.ts`

- [x] 3. Studio surface
  - [x] 3.1 Auto-declare auth pointers on save (`withAuthSecretKeys`), add-only
    - _Requirements: 1, 2_
  - [x] 3.2 `ConnectionStoreService.list()` reports `missingSecretKeys`
    - _Requirements: 3_
  - [x] 3.3 `CloudService.connectionSecretNames` / `putConnectionSecret` / `deleteConnectionSecret`
    - _Requirements: 12, 14_
  - [x] 3.4 Connection editor: cloud badge, upload and remove per secret row, hosted-target
        confirmation, gate widened to keychain OR deploy target
    - _Requirements: 12, 13, 14_
  - [x] 3.6 Fan-out save (2026-08-11 follow-up): one save writes every store, the draft survives
        until they all hold the value, Phorma consent asked once per editor session, amber
        `ti-cloud-exclamation` badge for a value the deploy target lacks
    - _Requirements: 12a, 13, 14_
  - [x] 3.5 Free-form worker secret name/value row in Settings > Cloud
    - _Requirements: 15_

- [x] 4. Documentation
  - [x] 4.1 `wrangler.jsonc` header documents both ingestion paths and the `KEY_ENC_SECRET` /
        `PHORMA_TOKEN` one-time setup
  - [x] 4.2 `cloud-worker` steering + `.github/agent-memory.md` corrected - the old "no credential
        ingestion path exists in hosted mode" entry was the thing this change invalidates

## Follow-up, not done here

- `MCP_<AUTHKEY>` bearer tokens through the same vault. `CloudToolHost`'s `resolveBearer` is the
  only reader, so it is a small change, but it needs its own test pass.
- Hosted mode currently requires `KEY_ENC_SECRET`, which Phorma's deployment already sets. A BYO
  operator has to set it once. Generating it for them during the studio's Deploy flow would remove
  the last terminal step.
