import { Injectable, inject } from '@angular/core';
import type { ArtifactRef, ArtifactStore, StoredArtifact } from '@phorma/engine';

import { IndexedDbStorageService } from './indexed-db-storage.service';

/**
 * The local host's run artifact store (document delivery G2): files a step
 * produced during a desktop or browser run, kept in IndexedDB beside the run
 * record and deleted with it (`removeRun`, `pruneRuns`).
 *
 * Injects storage ONLY. `RunControllerService` hands this to the engine, and
 * anything on the run path must not reach `CloudService` (the NG0200 cycle in
 * the structure steering); a deployed run's files are fetched by the Runs panel.
 */
@Injectable({ providedIn: 'root' })
export class RunArtifactsService implements ArtifactStore {
  private readonly storage = inject(IndexedDbStorageService);

  put(runId: string, artifact: StoredArtifact): Promise<void> {
    return this.storage.putRunArtifact(runId, artifact);
  }

  get(runId: string, id: string): Promise<StoredArtifact | undefined> {
    return this.storage.getRunArtifact(runId, id);
  }

  list(runId: string): Promise<ArtifactRef[]> {
    return this.storage.listRunArtifacts(runId);
  }
}

/**
 * Saves bytes as a file through a transient object URL. The revoke is deferred
 * one task so the browser has read the blob before it is invalidated.
 */
export function saveBytesAsFile(bytes: Uint8Array, name: string, mimeType: string): void {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  const blob = new Blob([copy.buffer], { type: mimeType || 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
