import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';

import {
  BROWSER_CAPABILITIES,
  TAURI_DESKTOP_CAPABILITIES,
  validateAgainstCapabilities,
  type CapabilityFinding,
  type ConnectionSummary,
} from '@phorma/engine';

import { ConnectionStoreService } from './connection-store.service';
import { TauriService } from './tauri.service';
import { WorkflowService } from './workflow.service';

/**
 * Capability findings for the active graph against the active LOCAL host
 * (Requirements 17.8, 17.9, 17.15) — the shared read used by the canvas node
 * badge and, indirectly, the properties panel's own per-node computed.
 *
 * Deliberately top-level-graph only: the canvas and the properties panel
 * both render the currently open document's graph, never the inside of an
 * embedded sub-workflow (those open as their own read-only tab), so there is
 * no `subWorkflows` traversal here — that full-graph walk belongs to
 * `RunControllerService.start()` before `startRun` (Requirement 17.9's other
 * call site), which validates the complete portable spec including every
 * embedded sub-workflow.
 *
 * The connection inventory is refreshed whenever the graph changes, which is
 * cheap (one IndexedDB + keychain-presence read) and keeps findings accurate
 * as connections are edited or created from the Connections panel while a
 * node is selected. Findings land well inside the 500 ms window Requirement
 * 17.9 allows: this is a plain Angular `computed()`, so a graph edit's
 * change-detection pass on the very next tick recomputes it.
 */
@Injectable({ providedIn: 'root' })
export class CapabilityFindingsService {
  private readonly tauri = inject(TauriService);
  private readonly connectionStore = inject(ConnectionStoreService);
  private readonly workflow = inject(WorkflowService);

  /** The local host's capability record — Desktop inside Tauri, Browser otherwise. */
  readonly activeHostCapabilities = computed(() =>
    this.tauri.isDesktop ? TAURI_DESKTOP_CAPABILITIES : BROWSER_CAPABILITIES,
  );

  /** Every locally known connection, secret-free. */
  private readonly connectionSummaries = signal<ConnectionSummary[]>([]);

  /** Reloads the connection inventory whenever the active graph changes. */
  private readonly connectionListRefresher = effect(() => {
    this.workflow.graph();
    untracked(() => {
      void this.connectionStore
        .list()
        .then(list => this.connectionSummaries.set(list))
        .catch(() => this.connectionSummaries.set([]));
    });
  });

  /** Every capability finding for the active document's top-level graph. */
  readonly findings = computed<CapabilityFinding[]>(() =>
    validateAgainstCapabilities(
      { graph: this.workflow.graph() },
      this.activeHostCapabilities(),
      this.connectionSummaries(),
    ),
  );
}
