/**
 * Run artifacts for the Cloudflare Worker host (document delivery G2).
 *
 * Files a run produced live in the Durable Object's embedded SQLite, in the
 * `run_artifacts` table beside `runs`, and are deleted with the run record:
 * `WorkflowAgent.pruneRunHistory()` drops the artifacts of every pruned run and
 * `purgeSelf()` clears the table.
 *
 * Bytes are stored as base64 TEXT. The engine caps one artifact at 1 MiB, so a
 * row stays well inside the platform's 2 MB value limit with no R2 binding,
 * which keeps the BYO worker (no R2 by design) able to run every primitive.
 */

import {
  decodeBase64,
  encodeBase64,
  type ArtifactRef,
  type ArtifactStore,
  type StoredArtifact,
} from '@phorma/engine';

import type { DurableSqlExecutor } from './workflow-state';

interface ArtifactRow {
  run_id: string;
  id: string;
  name: string;
  mime_type: string;
  size_bytes: number;
  node_id: string;
  created_at: number;
  bytes: string;
}

/** Creates the `run_artifacts` table. Idempotent; called from `ensureTables()`. */
export function ensureRunArtifactsTable(sql: DurableSqlExecutor): void {
  sql`
    CREATE TABLE IF NOT EXISTS run_artifacts (
      run_id TEXT NOT NULL,
      id TEXT NOT NULL,
      name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      node_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      bytes TEXT NOT NULL,
      PRIMARY KEY (run_id, id)
    )
  `;
}

/** The artifact store one Durable Object hands the engine. */
export class DurableArtifactStore implements ArtifactStore {
  constructor(private readonly sql: DurableSqlExecutor) {}

  async put(runId: string, artifact: StoredArtifact): Promise<void> {
    const { ref } = artifact;
    this.sql`
      INSERT OR REPLACE INTO run_artifacts
        (run_id, id, name, mime_type, size_bytes, node_id, created_at, bytes)
      VALUES (${runId}, ${ref.id}, ${ref.name}, ${ref.mimeType}, ${ref.sizeBytes},
              ${artifact.nodeId}, ${artifact.createdAt}, ${encodeBase64(artifact.bytes)})
    `;
  }

  async get(runId: string, id: string): Promise<StoredArtifact | undefined> {
    const [row] = this.sql<ArtifactRow>`
      SELECT * FROM run_artifacts WHERE run_id = ${runId} AND id = ${id}
    `;
    if (!row) return undefined;
    return {
      ref: refOf(row),
      nodeId: row.node_id,
      createdAt: Number(row.created_at),
      bytes: decodeBase64(row.bytes),
    };
  }

  async list(runId: string): Promise<ArtifactRef[]> {
    return this.sql<ArtifactRow>`
      SELECT run_id, id, name, mime_type, size_bytes, node_id, created_at, '' AS bytes
      FROM run_artifacts WHERE run_id = ${runId} ORDER BY created_at ASC, id ASC
    `.map(refOf);
  }
}

function refOf(row: ArtifactRow): ArtifactRef {
  return { id: row.id, name: row.name, mimeType: row.mime_type, sizeBytes: Number(row.size_bytes) };
}
