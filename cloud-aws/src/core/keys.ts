/**
 * Run_Table key derivation - every partition key, sort key and GSI key pair
 * lives in this one module.
 *
 * Partition key is always `wf#{workflowId}`. Sort keys discriminate item type.
 * Sequences use 12-digit zero-padding so lexicographic order equals numeric order.
 * GSI timestamps use 13-digit zero-padding (epoch ms fits in 13 digits until 2286).
 */

// ---------------------------------------------------------------------------
// Partition key
// ---------------------------------------------------------------------------

/** Primary partition key: one per workflow. */
export function pk(workflowId: string): string {
  return `wf#${workflowId}`;
}

// ---------------------------------------------------------------------------
// Sort keys
// ---------------------------------------------------------------------------

/** Spec item sort key. */
export function specSk(): string {
  return 'spec';
}

/** Execution_Lease sort key - derived from workflowId alone (Req 2.12). */
export function leaseSk(): string {
  return 'lease';
}

/** Run record sort key. */
export function runSk(runId: string): string {
  return `run#${runId}`;
}

/** Journal entry sort key. */
export function journalSk(runId: string, key: string): string {
  return `journal#${runId}#${key}`;
}

/** Run event sort key with 12-digit zero-padded sequence. */
export function eventSk(runId: string, sequence: number): string {
  return `event#${runId}#${String(sequence).padStart(12, '0')}`;
}

/** Usage ledger entry sort key. */
export function usageSk(runId: string, nodeId: string): string {
  return `usage#${runId}#${nodeId}`;
}

/** Workflow state entry sort key. */
export function stateSk(scopedKey: string): string {
  return `state#${scopedKey}`;
}

/** Inbound ControlFrame sort key. */
export function frameSk(arrivedAtMs: number, connectionId: string, n: number): string {
  return `frame#${String(arrivedAtMs).padStart(13, '0')}#${connectionId}#${String(n).padStart(4, '0')}`;
}

/** Monitor connection record sort key. */
export function connSk(connectionId: string): string {
  return `conn#${connectionId}`;
}

/**
 * Skipped-run record sort key: `skip#{triggeredAtMs}#{runnerId}` (unfenced).
 *
 * The trailing segment is the id of the Runner whose acquire lost, so a losing
 * trigger writes one item and nothing else (Req 8.5, 15.6).
 */
export function skipSk(atMs: number, runnerId: string): string {
  return `skip#${String(atMs).padStart(13, '0')}#${runnerId}`;
}

// ---------------------------------------------------------------------------
// GSI1 - Run history descending (pk = workflowId, sk = start timestamp + runId)
// ---------------------------------------------------------------------------

/** GSI1 partition key for run history. */
export function gsi1pk(workflowId: string): string {
  return `wf#${workflowId}#runs`;
}

/** GSI1 sort key: 13-digit zero-padded start timestamp + runId. */
export function gsi1sk(startedAtMs: number, runId: string): string {
  return `${String(startedAtMs).padStart(13, '0')}#${runId}`;
}

// ---------------------------------------------------------------------------
// GSI2 - Usage ledger ascending (pk = workflowId, sk = timestamp + runId + nodeId)
// ---------------------------------------------------------------------------

/** GSI2 partition key for usage ledger. */
export function gsi2pk(workflowId: string): string {
  return `wf#${workflowId}#usage`;
}

/** GSI2 sort key: 13-digit zero-padded timestamp + runId + nodeId. */
export function gsi2sk(startedAtMs: number, runId: string, nodeId: string): string {
  return `${String(startedAtMs).padStart(13, '0')}#${runId}#${nodeId}`;
}
