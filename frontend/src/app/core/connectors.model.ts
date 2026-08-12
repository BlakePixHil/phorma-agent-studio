/**
 * Installed connectors (P1-14) - the studio-side half of the bundle format.
 *
 * The format itself, its validation and every derivation live in
 * `engine/src/connectors.ts` (pure, property-tested). This module adds only what
 * an INSTALL is: a stored bundle, when it arrived, where it came from, and which
 * connection its steps are bound to.
 *
 * Two things deliberately do not exist here:
 *
 * - No copy of the bundle's own data. An installed connector holds the bundle
 *   verbatim, so re-exporting it is lossless and a format migration has one
 *   place to happen.
 * - No node ownership. Instantiating a step produces an ORDINARY data node with
 *   no back-reference, so uninstalling a connector can never break a workflow
 *   built from it. That is what keeps the canvas honest: an ops owner reads the
 *   same http-request node whether it was dragged from the palette or installed.
 *
 * Plan: `docs/connector-packaging-plan.md`.
 */

import {
  BUILTIN_CONNECTOR_PREFIX,
  CONNECTOR_FORMAT_VERSION,
  type ConnectorBundle,
  type ConnectorStep,
} from '@phorma/engine';

/** Where an installed bundle came from, for the "built-in" badge and export. */
export type ConnectorSource = 'builtin' | 'file' | 'packaged';

/** One installed connector: the bundle plus its install facts. */
export interface InstalledConnector {
  /**
   * Store key. The bundle id for a user install; the bundle id prefixed with
   * `BUILTIN_CONNECTOR_PREFIX` for a compiled-in one, so a built-in and a
   * user-installed copy of the same connector can coexist.
   */
  id: string;
  bundle: ConnectorBundle;
  /** ISO-8601 UTC. */
  installedAt: string;
  /** ISO-8601 UTC. Bumped when the bundle is replaced by a newer version. */
  updatedAt: string;
  /**
   * Connection the steps of this connector bind to. Absent when the installer
   * skipped the connection (a bundle can be installed for its steps alone).
   */
  connectionId?: string;
  source: ConnectorSource;
}

/** Palette drag payload prefix for a connector step. Mirrors `mcp-preset:`. */
export const CONNECTOR_STEP_PREFIX = 'connector-step:';

/** Drag payload / catalog entry id for one step of one installed connector. */
export function connectorStepEntryId(connectorId: string, stepId: string): string {
  return `${CONNECTOR_STEP_PREFIX}${connectorId}:${stepId}`;
}

/**
 * Splits a {@link connectorStepEntryId} back into its parts, or `null` when the
 * value is not one.
 *
 * A connector id can itself contain the `builtin:` prefix and a colon, so the
 * step id is taken from the LAST separator rather than by splitting on every
 * colon.
 */
export function parseConnectorStepEntryId(
  value: string,
): { connectorId: string; stepId: string } | null {
  if (!value.startsWith(CONNECTOR_STEP_PREFIX)) return null;
  const body = value.slice(CONNECTOR_STEP_PREFIX.length);
  const separator = body.lastIndexOf(':');
  if (separator <= 0 || separator === body.length - 1) return null;
  return { connectorId: body.slice(0, separator), stepId: body.slice(separator + 1) };
}

/** True for a connector compiled into the app (read-only, never persisted). */
export function isBuiltInConnector(connectorId: string): boolean {
  return connectorId.startsWith(BUILTIN_CONNECTOR_PREFIX);
}

/** Store id for a bundle installed from `source`. */
export function connectorInstallId(bundleId: string, source: ConnectorSource): string {
  return source === 'builtin' ? `${BUILTIN_CONNECTOR_PREFIX}${bundleId}` : bundleId;
}

/** One step of one installed connector, flattened for the palette and pickers. */
export interface ConnectorStepEntry {
  /** {@link connectorStepEntryId} - the drag payload. */
  entryId: string;
  connectorId: string;
  connectorName: string;
  /** Connection the step binds to, when the install has one. */
  connectionId?: string;
  step: ConnectorStep;
}

/**
 * A tiny descriptor of what installing a bundle will do, for the preview dialog.
 * Capability findings and egress hosts come from the existing engine walk
 * (`inspectAgainstCapabilities` over `connectorPreviewSpec`), not from here.
 */
export interface ConnectorInstallSummary {
  stepCount: number;
  tableCount: number;
  workflowCount: number;
  /** Secret names the connection will declare, in declaration order. */
  secretKeys: string[];
  /** Required config field names with no default, so the installer must type them. */
  requiredConfig: string[];
  /** True when the bundle says its steps write to the target system. */
  needsWrites: boolean;
}

/** The format version this build writes when packaging. */
export const CONNECTOR_WRITE_FORMAT = CONNECTOR_FORMAT_VERSION;
