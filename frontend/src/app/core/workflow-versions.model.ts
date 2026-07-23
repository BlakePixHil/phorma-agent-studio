import type { WorkflowSpec } from './workflow.model';

export type WorkflowVersionTrigger = 'manual' | 'autosave' | 'deploy' | 'restore';

/** Immutable workflow snapshot captured at a meaningful save boundary. */
export interface WorkflowVersion {
  id: string;
  workflowId: string;
  savedAt: string;
  trigger: WorkflowVersionTrigger;
  /** True when this exact snapshot was successfully pushed to a cloud runtime. */
  deployed?: boolean;
  spec: WorkflowSpec;
}

/** Non-deployed snapshots retained per workflow. Deployed snapshots are pinned. */
export const WORKFLOW_VERSIONS_KEEP = 100;
