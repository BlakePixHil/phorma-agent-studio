/**
 * Default materialization and the Canonical_Spec_Hash, as PURE functions
 * (multi-organisation-phorma, Requirements 12.3, 12.4; design section 10).
 *
 * ## Why this module exists
 *
 * A comparison of two specs is only meaningful when both sides ran the SAME
 * transform first. The transform used to live inside `CloudService` as a private
 * method, and `CloudService` is the one service on the transport path that
 * nothing on that path may inject (the NG0200 cycle
 * `RunControllerService -> ModelTransportService -> PhormaCloudService ->
 * CloudService -> RunControllerService`). So a service that wanted to compare a
 * local spec against a deployed one had exactly two options, and both were
 * wrong: reproduce the transform as a second copy, or compare against the
 * un-materialized spec and report a difference on every deployment that is
 * perfectly current. `notifications.model.ts` records that defect at the point
 * where it bit - there is no `spec-drift` notification kind because of it.
 *
 * This module is the fix. It is a LEAF: it imports types and two pure engine
 * helpers, and no service at all, so anything that can read three settings
 * values can compute a hash that agrees with the one the push path stored.
 *
 * ## What the hash covers, and what it deliberately does not
 *
 * `CloudService.materializeDefaults` also refreshes attached skill bodies from
 * the local skills library. That stays OUT of here, and the consequence is worth
 * stating rather than discovering: **the hash compares workflow CONFIGURATION,
 * not attached skill CONTENT.** A spec whose attached skill body changed locally
 * hashes the same.
 *
 * That is the correct trade for a value two machines have to agree on. A skills
 * refresh is a LIBRARY READ, not a default, and a member working out of their
 * organisation's cloud library has no local skills library at all - so including
 * it would make the hash depend on machine state and would reintroduce exactly
 * the unsoundness this module exists to remove, one layer down.
 *
 * ## Why the worker never runs this
 *
 * It does not need to. The studio materializes at push time, so the spec the
 * Durable Object stores and the `specHash` its registry record carries are both
 * over the MATERIALIZED spec. A proposal body is created from a materialized
 * spec, and its frozen `liveSpecHash` is copied from that registry record. The
 * transform therefore runs exactly ONCE, on a studio, and every hash any side
 * compares is a hash of a materialized spec.
 */

import { canonicalJson, fnv1a } from '@phorma/engine';

import { isAgentNode, type ModelProviderId, type WorkflowSpec } from './workflow.model';

/**
 * The application-level model defaults an agent node inherits when it names
 * neither a provider nor a model.
 *
 * A plain value rather than a service read, so the transform is pure and the
 * caller is the one place that decides where the defaults come from.
 */
export interface SpecDefaults {
  provider: ModelProviderId;
  model: string;
  temperature: number;
}

/**
 * Every graph in a spec's embedded closure: the root graph plus every
 * sub-workflow's.
 *
 * Exported because both the transform and its wrapper in `CloudService` walk the
 * same closure, and two walks are two chances to miss a sub-workflow.
 */
export function graphsOf(spec: WorkflowSpec): WorkflowSpec['graph'][] {
  return [spec.graph, ...Object.values(spec.subWorkflows ?? {}).map(workflow => workflow.graph)];
}

/**
 * Bakes the application defaults into every agent node that inherits them.
 * PURE: the argument is cloned, never mutated.
 *
 * A deployed run cannot reach the studio's settings, which is the whole reason
 * this transform exists: an agent left on "Default" has to carry a real provider
 * and model by the time it reaches a worker.
 *
 * Only a node carrying NEITHER a provider nor a model inherits, which keeps this
 * idempotent - running it twice, or running it with different defaults over a
 * spec whose agents are all explicit, changes nothing. That idempotence is what
 * makes {@link canonicalSpecHash} comparable across two machines whose
 * application defaults differ.
 */
export function materializeSpecDefaults(spec: WorkflowSpec, defaults: SpecDefaults): WorkflowSpec {
  const resolved = structuredClone(spec);
  for (const graph of graphsOf(resolved)) {
    for (const node of graph.nodes) {
      if (!isAgentNode(node)) continue;
      if (!node.data.provider || !node.data.model) {
        node.data.provider = defaults.provider;
        node.data.model = defaults.model;
        node.data.temperature ??= defaults.temperature;
      }
    }
  }
  return resolved;
}

/**
 * THE definition of a Canonical_Spec_Hash: `fnv1a(canonicalJson(spec))` over the
 * spec AFTER {@link materializeSpecDefaults}.
 *
 * The same expression `WorkflowAgent.syncDeployment` writes into
 * `DeploymentRecord.specHash`, over a spec that reached it already materialized -
 * which is why a studio can compute the hash of what is deployed without
 * downloading it.
 */
export function canonicalSpecHash(spec: WorkflowSpec, defaults: SpecDefaults): string {
  return fnv1a(canonicalJson(materializeSpecDefaults(spec, defaults)));
}
