/**
 * Portal wire types (EPIC 9) — the studio's view of a published endpoint.
 *
 * These mirror the shapes the cloud worker returns from the owner-side routes
 * in `cloud/src/workflow-agent.ts`. Access-key HASHES are stripped by the
 * worker before it responds, which is why {@link PortalToken} has no `hash`
 * field: the plaintext exists exactly once, in the mint response.
 */

import type { PortalAccess, PortalField, PortalMode, PortalValidation } from '@phorma/engine';

/** Owner-facing metadata for one scoped access key. */
export interface PortalToken {
  /** Identifier used to revoke the key. */
  id: string;
  /** Owner-supplied note ("Zapier", "partner API"). */
  label: string;
  createdAt: number;
  /** Epoch ms of the most recent successful use, when known. */
  lastUsedAt?: number;
}

/** A live publish record as the owner sees it. */
export interface PortalRecord {
  slug: string;
  workflowId: string;
  ownerId: string | null;
  workflowName: string;
  mode: PortalMode;
  access: PortalAccess;
  title: string;
  greeting?: string;
  fields: PortalField[];
  /** Node whose answer visitors see; null = the combined final output. */
  responderNodeId: string | null;
  rateLimitPerMin: number;
  theme: 'auto' | 'light' | 'dark';
  showBranding: boolean;
  /** True when other sites may frame this portal. */
  embedEnabled?: boolean;
  /** Normalized origins allowed to frame it. Empty + enabled = any site. */
  embedOrigins?: string[];
  /** Launcher label used by the embed snippet. */
  embedLabel?: string;
  tokens: PortalToken[];
  publishedAt: number;
  updatedAt: number;
  /** Visitor messages accepted since publishing. */
  hits: number;
  lastHitAt?: number;
}

/** `GET /portal` — the record (or null) plus current publish readiness. */
export interface PortalStatusResponse {
  record: PortalRecord | null;
  validation: PortalValidation;
  /**
   * Version of the deployed worker. Absent on workers deployed before build
   * stamping existed — treat that as "unknown", never as "stale".
   */
  workerBuild?: string;
}

/** `POST /publish`. */
export interface PortalPublishResponse {
  ok: boolean;
  error?: string;
  record?: PortalRecord;
  validation?: PortalValidation;
}

/** `POST /portal-tokens` — `secret` is returned once and never again. */
export interface PortalMintResponse {
  ok: boolean;
  error?: string;
  /** The plaintext key. Show it immediately; it cannot be recovered. */
  secret?: string;
  token?: PortalToken;
}
