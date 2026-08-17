/**
 * Egress allow-list derivation (Req 10.4, 10.12).
 *
 * Collects every statically determinable outbound hostname a set of deployed
 * workflows can reach: http-request URLs, sql-query connection hosts (both
 * already gathered by `inspectAgainstCapabilities`), and the configured model
 * provider endpoints from `model.ts`.
 *
 * Pure: no I/O, no host imports. The Studio calls this before a deploy and
 * hands the result to the IaC_App as configuration.
 */

import {
  type CapabilityValidationTarget,
  inspectAgainstCapabilities,
  TAURI_DESKTOP_CAPABILITIES,
} from './capabilities.js';
import type { ConnectionSummary } from './connections.js';
import type { ModelProviderId } from './types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Public interface
// ─────────────────────────────────────────────────────────────────────────────

export interface EgressAllowList {
  /** Distinct hostnames, lower-cased, alphabetical, capped at 200. */
  hosts: string[];
  /** Nodes whose outbound host is not statically determinable. */
  undeterminable: { nodeId?: string; nodeName?: string; message: string }[];
  /** True when the 200 cap dropped entries. */
  capped: boolean;
}

/** Maximum number of hosts the allow-list can hold. */
const MAX_HOSTS = 200;

/**
 * Derives the egress allow-list from the workflow specs, their connections and
 * the configured model providers.
 *
 * Hosts are lower-cased, deduplicated case-insensitively, sorted
 * alphabetically, and capped at 200 entries. Nodes whose outbound host cannot
 * be determined statically appear in `undeterminable` rather than blocking the
 * deploy (Req 10.12).
 */
export function deriveEgressAllowList(input: {
  specs: readonly CapabilityValidationTarget[];
  connections: readonly ConnectionSummary[];
  providers: readonly ModelProviderId[];
}): EgressAllowList {
  const hostSet = new Set<string>();
  const undeterminable: EgressAllowList['undeterminable'] = [];

  // 1. Collect hosts from every spec using the existing capability walk.
  //    We use TAURI_DESKTOP_CAPABILITIES as the capability record because egress
  //    collection is host-agnostic - it only needs every node kind accepted so
  //    the walk enters every branch.
  for (const spec of input.specs) {
    const report = inspectAgainstCapabilities(spec, TAURI_DESKTOP_CAPABILITIES, input.connections);

    // Statically determined hosts from http-request URLs and sql-query connections.
    for (const host of report.egressHosts) {
      hostSet.add(host.toLowerCase());
    }

    // Warnings about non-determinable URLs become undeterminable entries.
    for (const f of report.findings) {
      if (f.severity === 'warning' && f.message.includes('not statically determinable')) {
        undeterminable.push({
          nodeId: f.nodeId,
          nodeName: f.nodeName,
          message: f.message,
        });
      }
    }
  }

  // 2. Add provider endpoint hostnames.
  for (const provider of input.providers) {
    const host = providerHost(provider);
    if (host) {
      hostSet.add(host.toLowerCase());
    }
  }

  // 3. Deduplicate (Set already handles that), sort alphabetically, cap at 200.
  const sorted = [...hostSet].sort();
  const capped = sorted.length > MAX_HOSTS;
  const hosts = capped ? sorted.slice(0, MAX_HOSTS) : sorted;

  return { hosts, undeterminable, capped };
}

// ─────────────────────────────────────────────────────────────────────────────
// Provider hostname extraction
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Known static hostnames for each provider. Providers with dynamic endpoints
 * (ollama, lmstudio use localhost; bedrock is reached through a VPC endpoint)
 * return undefined - they are not internet-egress targets for a deployed host.
 */
const PROVIDER_HOSTS: Readonly<Record<ModelProviderId, string | undefined>> = {
  anthropic: 'api.anthropic.com',
  openai: 'api.openai.com',
  openrouter: 'openrouter.ai',
  gemini: 'generativelanguage.googleapis.com',
  'phorma-cloud': 'openrouter.ai',
  // Local servers - not reachable from a deployed container.
  ollama: undefined,
  lmstudio: undefined,
  // Bedrock is accessed through a VPC endpoint, not internet egress.
  bedrock: undefined,
};

/** Returns the static egress hostname for a provider, or undefined. */
function providerHost(provider: ModelProviderId): string | undefined {
  return PROVIDER_HOSTS[provider];
}
