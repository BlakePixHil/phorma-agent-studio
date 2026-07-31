import { computed, effect, Injectable, inject, signal } from '@angular/core';

import { IndexedDbStorageService } from './indexed-db-storage.service';
import { SettingsService } from './settings.service';
import { SkillsService } from './skills.service';
import { buildNodeFromCatalog, findCatalogEntry } from './node-catalog';
import { loadLayout, saveLayout } from './layout-storage';
import { ToastService } from '../shared/toast/toast.service';
import { ConfirmDialogService } from '../shared/confirm-dialog/confirm-dialog.service';
import { WorkflowVersionsService } from './workflow-versions.service';
import type { WorkflowVersion, WorkflowVersionTrigger } from './workflow-versions.model';
import {
  canConnectPorts,
  edgeKindForPorts,
  emptyGraph,
  findNodeForConnector,
  portBaseId,
  toolLinkRejection,
  WORKFLOW_SPEC_VERSION,
  type EmbeddedWorkflow,
  type GraphPosition,
  type WorkflowConnection,
  type WorkflowGraph,
  type WorkflowNode,
  type WorkflowSettings,
  type WorkflowSpec,
} from './workflow.model';

/** One open workflow document (a tab in the tab bar). */
export interface OpenWorkflowDoc {
  /** Stable per-tab id. */
  docId: string;
  /** Saved workflow id, or null for a brand-new unsaved draft. */
  workflowId: string | null;
  name: string;
  description: string;
  graph: WorkflowGraph;
  /** Workflow-level execution settings (timeout, …). */
  settings: WorkflowSettings;
  /** Portable fallback registry for Execute Workflow targets. */
  subWorkflows?: Record<string, EmbeddedWorkflow>;
  /** Historical run tabs keep their captured registry ahead of the live library. */
  preferEmbeddedWorkflows?: boolean;
  /** True when the draft has edits not yet saved to the library. */
  dirty: boolean;
  /** Historical preview tabs are immutable and cannot be saved over the library. */
  readOnly?: boolean;
}

/** Shape persisted to layout storage for tab-session restore. */
interface PersistedWorkflowTabs {
  /** Saved workflow ids of the open tabs (unsaved drafts are not restored). */
  workflowIds: string[];
  activeWorkflowId: string | null;
}

let docCounter = 0;

/**
 * Owns the open workflow documents (tabs), the active graph the canvas
 * renders, all graph mutations, and persistence to IndexedDB.
 *
 * This is Agent Studio's replacement for Phorma Code's ProjectService +
 * BuilderService pair: there is exactly one kind of document — the Workflow.
 */
@Injectable({ providedIn: 'root' })
export class WorkflowService {
  private readonly storage = inject(IndexedDbStorageService);
  private readonly settings = inject(SettingsService);
  private readonly skillsLibrary = inject(SkillsService);
  private readonly toast = inject(ToastService);
  private readonly confirmDialog = inject(ConfirmDialogService);
  private readonly versions = inject(WorkflowVersionsService);

  /** Debounce handle for the autosave effect. */
  private autosaveTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly docsState = signal<OpenWorkflowDoc[]>([]);
  private readonly activeDocIdState = signal<string | null>(null);
  private readonly libraryState = signal<WorkflowSpec[]>([]);
  private readonly libraryLoadedState = signal(false);

  /** All open documents in tab order. */
  readonly documents = this.docsState.asReadonly();
  /** The active document id (null only before startup completes). */
  readonly activeDocId = this.activeDocIdState.asReadonly();
  /** Saved workflow library (drives File > Open). */
  readonly library = this.libraryState.asReadonly();
  /** True once the saved library has been loaded from IndexedDB. */
  readonly libraryLoaded = this.libraryLoadedState.asReadonly();

  /** The active document, or null when none is open. */
  readonly activeDoc = computed<OpenWorkflowDoc | null>(() => {
    const id = this.activeDocIdState();
    return this.docsState().find(doc => doc.docId === id) ?? null;
  });

  /** The graph the canvas renders. Empty when no document is open. */
  readonly graph = computed<WorkflowGraph>(() => this.activeDoc()?.graph ?? emptyGraph());

  /** Display name of the active workflow. */
  readonly activeName = computed(() => this.activeDoc()?.name ?? 'Untitled Workflow');

  /** Whether the active document has unsaved changes. */
  readonly isDirty = computed(() => this.activeDoc()?.dirty ?? false);

  constructor() {
    void this.initialize();

    // Persist the open-tab session (saved tabs only) for restore on reload.
    effect(() => {
      const docs = this.docsState();
      const activeId = this.activeDocIdState();
      const activeDoc = docs.find(doc => doc.docId === activeId);
      saveLayout('openWorkflows', {
        workflowIds: docs.map(doc => doc.workflowId).filter((id): id is string => id !== null),
        activeWorkflowId: activeDoc?.workflowId ?? null,
      } satisfies PersistedWorkflowTabs);
    });

    // Autosave (Settings → General): debounce-save the active document after
    // edits. Only workflows ALREADY saved to the library autosave — unnamed
    // drafts never trigger the naming prompt on their own.
    effect(() => {
      const enabled = this.settings.autosaveEnabled();
      const doc = this.activeDoc();
      // Track dirtiness reactively (graph edits flip `dirty`).
      const shouldSave = enabled && !!doc && doc.workflowId !== null && doc.dirty;
      if (this.autosaveTimer !== null) {
        clearTimeout(this.autosaveTimer);
        this.autosaveTimer = null;
      }
      if (!shouldSave) return;
      this.autosaveTimer = setTimeout(() => {
        this.autosaveTimer = null;
        // Re-check at fire time: state may have changed during the debounce.
        const current = this.activeDoc();
        if (
          this.settings.autosaveEnabled() &&
          current?.docId === doc.docId &&
          current.workflowId !== null &&
          current.dirty
        ) {
          void this.saveActive('autosave');
        }
      }, 2000);
    });
  }

  // ── Startup & persistence ──────────────────────────────────────────────────

  private async initialize(): Promise<void> {
    try {
      const specs = await this.storage.listWorkflows();
      specs.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
      this.libraryState.set(specs);
    } catch {
      // Best-effort: a broken IndexedDB should not brick the app.
      this.libraryState.set([]);
    }
    this.libraryLoadedState.set(true);
    this.restoreSession();
  }

  /** Reopens the previous session's tabs, or a fresh untitled workflow. */
  private restoreSession(): void {
    const persisted = loadLayout<PersistedWorkflowTabs | null>('openWorkflows', null);
    const library = this.libraryState();

    const docs: OpenWorkflowDoc[] = [];
    for (const workflowId of persisted?.workflowIds ?? []) {
      const spec = library.find(item => item.id === workflowId);
      if (!spec || docs.some(doc => doc.workflowId === workflowId)) continue;
      docs.push(this.docFromSpec(spec));
    }

    if (docs.length === 0) {
      this.newWorkflow();
      return;
    }

    this.docsState.set(docs);
    const active =
      docs.find(doc => doc.workflowId === persisted?.activeWorkflowId) ?? docs[0];
    this.activeDocIdState.set(active.docId);
  }

  private docFromSpec(spec: WorkflowSpec): OpenWorkflowDoc {
    docCounter += 1;
    return {
      docId: `doc-${docCounter}`,
      workflowId: spec.id,
      name: spec.name,
      description: spec.description ?? '',
      graph: structuredClone(spec.graph),
      settings: spec.settings ? { ...spec.settings } : {},
      subWorkflows: spec.subWorkflows ? structuredClone(spec.subWorkflows) : undefined,
      dirty: false,
    };
  }

  // ── Document lifecycle ─────────────────────────────────────────────────────

  /** Opens a fresh untitled workflow tab and activates it. */
  newWorkflow(): void {
    docCounter += 1;
    const doc: OpenWorkflowDoc = {
      docId: `doc-${docCounter}`,
      workflowId: null,
      name: 'Untitled Workflow',
      description: '',
      graph: emptyGraph(),
      settings: {},
      dirty: false,
    };
    this.docsState.update(docs => [...docs, doc]);
    this.activeDocIdState.set(doc.docId);
  }

  /** Opens a saved workflow from the library (re-activates if already open). */
  openWorkflow(workflowId: string): void {
    const existing = this.docsState().find(doc => doc.workflowId === workflowId);
    if (existing) {
      this.activeDocIdState.set(existing.docId);
      return;
    }
    const spec = this.libraryState().find(item => item.id === workflowId);
    if (!spec) {
      this.toast.error('Workflow not found', 'It may have been deleted.');
      return;
    }
    const doc = this.docFromSpec(spec);
    this.docsState.update(docs => [...docs, doc]);
    this.activeDocIdState.set(doc.docId);
  }

  /** Activates an open tab by document id. */
  activateDocument(docId: string): void {
    if (this.docsState().some(doc => doc.docId === docId)) {
      this.activeDocIdState.set(docId);
    }
  }

  /**
   * Closes a tab. The caller is responsible for any unsaved-changes
   * confirmation. When the last tab closes, a fresh untitled workflow opens
   * so the canvas is never document-less.
   */
  closeDocument(docId: string): void {
    const docs = this.docsState();
    const index = docs.findIndex(doc => doc.docId === docId);
    if (index === -1) return;

    const wasActive = this.activeDocIdState() === docId;
    const remaining = docs.filter(doc => doc.docId !== docId);
    this.docsState.set(remaining);

    if (remaining.length === 0) {
      this.newWorkflow();
      return;
    }
    if (wasActive) {
      const next = remaining[index - 1] ?? remaining[index];
      this.activeDocIdState.set(next.docId);
    }
  }

  /** Reorders an open tab from one index to another (tab drag-drop). */
  reorderDocuments(from: number, to: number): void {
    this.docsState.update(docs => {
      if (from < 0 || from >= docs.length || to < 0 || to >= docs.length || from === to) {
        return docs;
      }
      const next = [...docs];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  }

  /** Saves the active document into the library (upsert by workflow id). */
  async saveActive(trigger: Exclude<WorkflowVersionTrigger, 'deploy' | 'restore'> = 'manual'): Promise<WorkflowSpec | null> {
    const doc = this.activeDoc();
    if (!doc) return null;
    if (doc.readOnly) {
      this.toast.warning('Preview is read-only', 'Restore this version to make it the current editable workflow.');
      return null;
    }

    // A brand-new draft that still carries the default name prompts the user
    // to name it before its first save. Subsequent saves reuse the chosen
    // name without prompting.
    let name = doc.name;
    if (doc.workflowId === null && (!name.trim() || name === 'Untitled Workflow')) {
      const chosen = await this.confirmDialog.prompt(
        {
          title: 'Name your workflow',
          message: 'Give this workflow a name so you can find it later.',
          confirmLabel: 'Save',
          cancelLabel: 'Cancel',
        },
        {
          initialValue: name === 'Untitled Workflow' ? '' : name,
          placeholder: 'Untitled Workflow',
          label: 'Workflow name',
          maxLength: 80,
        },
      );
      if (chosen === null) return null; // user cancelled
      name = chosen || 'Untitled Workflow';
      this.updateDoc(doc.docId, { name });
    }

    const baseSpec: WorkflowSpec = {
      version: WORKFLOW_SPEC_VERSION,
      id: doc.workflowId ?? `wf-${Date.now().toString(36)}`,
      name: name.trim() || 'Untitled Workflow',
      description: doc.description.trim() || undefined,
      graph: structuredClone(doc.graph),
      settings: Object.keys(doc.settings).length > 0 ? { ...doc.settings } : undefined,
      savedAt: new Date().toISOString(),
    };
    const spec = this.withEmbeddedClosure(
      baseSpec,
      doc.subWorkflows,
      doc.preferEmbeddedWorkflows,
    );

    try {
      await this.storage.saveWorkflow(spec);
    } catch {
      this.toast.error('Save failed', 'The workflow could not be written to storage.');
      return null;
    }

    this.libraryState.update(specs => [
      spec,
      ...specs.filter(item => item.id !== spec.id),
    ]);
    this.updateDoc(doc.docId, {
      workflowId: spec.id,
      subWorkflows: spec.subWorkflows ? structuredClone(spec.subWorkflows) : undefined,
      dirty: false,
    });
    try {
      await this.versions.recordSave(spec, trigger);
    } catch {
      this.toast.warning('Version history unavailable', 'The workflow was saved, but its history snapshot could not be written.');
    }
    return spec;
  }

  /**
   * Saves a newly-created spec into the workflow library without opening it
   * or changing the active tab. This is the persistence rail used by future
   * graph extraction and other background workflow-creation features.
   */
  async saveNewSpecToLibrary(spec: WorkflowSpec): Promise<WorkflowSpec | null> {
    const id = this.libraryState().some(item => item.id === spec.id)
      ? `wf-${Date.now().toString(36)}`
      : spec.id;
    const next = this.withEmbeddedClosure(
      {
        ...structuredClone(spec),
        id,
        version: WORKFLOW_SPEC_VERSION,
        savedAt: new Date().toISOString(),
      },
      spec.subWorkflows,
    );
    try {
      await this.storage.saveWorkflow(next);
      this.libraryState.update(specs => [next, ...specs.filter(item => item.id !== next.id)]);
      await this.versions.recordSave(next, 'manual').catch(() => undefined);
      return next;
    } catch {
      this.toast.error('Save failed', 'The workflow could not be written to storage.');
      return null;
    }
  }

  /** Deletes a saved workflow from the library (open tabs become unsaved). */
  async removeFromLibrary(workflowId: string): Promise<void> {
    try {
      await this.storage.removeWorkflow(workflowId);
    } catch {
      this.toast.error('Delete failed', 'The workflow could not be removed from storage.');
      return;
    }
    this.libraryState.update(specs => specs.filter(item => item.id !== workflowId));
    await this.versions.deleteForWorkflow(workflowId).catch(() => undefined);
    this.docsState.update(docs =>
      docs.map(doc =>
        doc.workflowId === workflowId ? { ...doc, workflowId: null, dirty: true } : doc,
      ),
    );
  }

  /** Renames the active workflow (marks it dirty). */
  renameActive(name: string): void {
    const doc = this.activeDoc();
    if (!doc || doc.readOnly || doc.name === name) return;
    this.updateDoc(doc.docId, { name, dirty: true });
  }

  /**
   * Renames a saved workflow in the library. Persists the new name to storage
   * and updates any open tab that points at the same workflow id. Returns
   * the new name on success, or null if the user cancelled or it failed.
   */
  async renameInLibrary(workflowId: string, name: string): Promise<string | null> {
    const trimmed = name.trim();
    if (!trimmed) return null;
    const spec = this.libraryState().find(item => item.id === workflowId);
    if (!spec) return null;
    if (spec.name === trimmed) return trimmed;

    const next: WorkflowSpec = { ...spec, name: trimmed, savedAt: new Date().toISOString() };
    try {
      await this.storage.saveWorkflow(next);
    } catch {
      this.toast.error('Rename failed', 'The workflow could not be renamed.');
      return null;
    }

    this.libraryState.update(specs =>
      specs.map(item => (item.id === workflowId ? next : item)),
    );
    this.docsState.update(docs =>
      docs.map(doc =>
        doc.workflowId === workflowId ? { ...doc, name: trimmed } : doc,
      ),
    );
    await this.versions.recordSave(next, 'manual').catch(() => undefined);
    return trimmed;
  }

  /** Updates the active workflow's description (marks it dirty). */
  describeActive(description: string): void {
    const doc = this.activeDoc();
    if (!doc || doc.readOnly || doc.description === description) return;
    this.updateDoc(doc.docId, { description, dirty: true });
  }

  /** Merges a patch into the active workflow's execution settings. */
  updateSettings(patch: Partial<WorkflowSettings>): void {
    const doc = this.activeDoc();
    if (!doc || doc.readOnly) return;
    const settings = { ...doc.settings, ...patch };
    // Drop cleared values so empty settings serialize as absent.
    for (const key of Object.keys(settings) as (keyof WorkflowSettings)[]) {
      if (settings[key] === undefined || settings[key] === null || settings[key] === 0) {
        delete settings[key];
      }
    }
    this.updateDoc(doc.docId, { settings, dirty: true });
  }

  /** Serializes the active document as a portable spec (for file export). */
  exportActiveSpec(): WorkflowSpec | null {
    const doc = this.activeDoc();
    if (!doc) return null;
    const graph = structuredClone(doc.graph);
    // Exported specs travel without the studio's skill library — refresh
    // the embedded skill copies so the file carries current content.
    this.skillsLibrary.syncAttachedSkills(graph);
    const spec: WorkflowSpec = {
      version: WORKFLOW_SPEC_VERSION,
      id: doc.workflowId ?? `wf-${Date.now().toString(36)}`,
      name: doc.name,
      description: doc.description || undefined,
      graph,
      settings: Object.keys(doc.settings).length > 0 ? { ...doc.settings } : undefined,
      savedAt: new Date().toISOString(),
    };
    const portable = this.withEmbeddedClosure(
      spec,
      doc.subWorkflows,
      doc.preferEmbeddedWorkflows,
    );
    for (const embedded of Object.values(portable.subWorkflows ?? {})) {
      this.skillsLibrary.syncAttachedSkills(embedded.graph);
    }
    return portable;
  }

  /** Opens an imported spec (from a `.phorma.json` file) as a new tab. */
  importSpec(spec: WorkflowSpec): void {
    docCounter += 1;
    const doc: OpenWorkflowDoc = {
      docId: `doc-${docCounter}`,
      workflowId: null, // saving links it into the library under a fresh id
      name: spec.name || 'Imported Workflow',
      description: spec.description ?? '',
      graph: structuredClone(spec.graph),
      settings: spec.settings ? { ...spec.settings } : {},
      subWorkflows: spec.subWorkflows ? structuredClone(spec.subWorkflows) : undefined,
      dirty: true,
    };
    this.docsState.update(docs => [...docs, doc]);
    this.activeDocIdState.set(doc.docId);
  }

  /**
   * Opens a past run's graph snapshot as a new unsaved tab ("Bring to
   * Canvas"). Always a snapshot tab — the workflow may have been edited (or
   * never saved) since the run, so the run's own graph is the only faithful
   * record of what actually executed.
   */
  openRunSnapshot(
    graph: WorkflowGraph,
    runLabel: string,
    subWorkflows?: Record<string, EmbeddedWorkflow>,
  ): void {
    docCounter += 1;
    const doc: OpenWorkflowDoc = {
      docId: `doc-${docCounter}`,
      workflowId: null,
      name: runLabel,
      description: '',
      graph: structuredClone(graph),
      settings: {},
      subWorkflows: subWorkflows ? structuredClone(subWorkflows) : undefined,
      preferEmbeddedWorkflows: true,
      dirty: false,
    };
    this.docsState.update(docs => [...docs, doc]);
    this.activeDocIdState.set(doc.docId);
  }

  /** Opens a historical version as a detached snapshot tab. */
  openVersionSnapshot(spec: WorkflowSpec): void {
    docCounter += 1;
    const savedAt = new Date(spec.savedAt).toLocaleString();
    const doc: OpenWorkflowDoc = {
      docId: `doc-${docCounter}`,
      workflowId: null,
      name: `${spec.name} - version ${savedAt}`,
      description: spec.description ?? '',
      graph: structuredClone(spec.graph),
      settings: spec.settings ? { ...spec.settings } : {},
      subWorkflows: spec.subWorkflows ? structuredClone(spec.subWorkflows) : undefined,
      dirty: false,
      readOnly: true,
    };
    this.docsState.update(docs => [...docs, doc]);
    this.activeDocIdState.set(doc.docId);
  }

  /** Opens an embedded Execute Workflow target as an immutable snapshot tab. */
  openEmbeddedSnapshot(workflow: EmbeddedWorkflow): void {
    docCounter += 1;
    const doc: OpenWorkflowDoc = {
      docId: `doc-${docCounter}`,
      workflowId: null,
      name: `${workflow.name} - embedded snapshot`,
      description: workflow.description ?? '',
      graph: structuredClone(workflow.graph),
      settings: workflow.settings ? { ...workflow.settings } : {},
      dirty: false,
      readOnly: true,
    };
    this.docsState.update(docs => [...docs, doc]);
    this.activeDocIdState.set(doc.docId);
  }

  /** Restores a historical snapshot as the workflow's new current version. */
  async restoreVersion(version: WorkflowVersion): Promise<boolean> {
    const current = this.libraryState().find(item => item.id === version.workflowId);
    if (!current) return false;

    // Preserve the pre-restore state as a safety point before replacing it.
    await this.versions.recordSave(current, 'manual').catch(() => undefined);
    const restored: WorkflowSpec = {
      ...structuredClone(version.spec),
      id: version.workflowId,
      savedAt: new Date().toISOString(),
    };
    try {
      await this.storage.saveWorkflow(restored);
      await this.versions.recordSave(restored, 'restore');
    } catch {
      this.toast.error('Restore failed', 'The selected workflow version could not be restored.');
      return false;
    }

    this.libraryState.update(specs => [restored, ...specs.filter(item => item.id !== restored.id)]);
    this.docsState.update(docs => docs.map(doc =>
      doc.workflowId === restored.id
        ? {
            ...doc,
            name: restored.name,
            description: restored.description ?? '',
            graph: structuredClone(restored.graph),
            settings: restored.settings ? { ...restored.settings } : {},
            subWorkflows: restored.subWorkflows ? structuredClone(restored.subWorkflows) : undefined,
            dirty: false,
          }
        : doc,
    ));
    return true;
  }

  // ── Graph mutations (active document) ──────────────────────────────────────

  /** Drops a node from a palette catalog entry onto the canvas. */
  addNodeFromCatalog(entryId: string, position: GraphPosition): WorkflowNode | null {
    const entry = findCatalogEntry(entryId);
    if (!entry) return null;
    const node = buildNodeFromCatalog(entry, position);
    this.mutateGraph(graph => ({ ...graph, nodes: [...graph.nodes, node] }));
    return node;
  }

  /** Applies new positions after a canvas drag commit. */
  moveNodes(updates: ReadonlyMap<string, GraphPosition>): void {
    if (updates.size === 0) return;
    this.mutateGraph(graph => ({
      ...graph,
      nodes: graph.nodes.map(node => {
        const position = updates.get(node.id);
        return position ? { ...node, position } : node;
      }),
    }));
  }

  /** Removes a node and every connection touching one of its ports. */
  removeNode(nodeId: string): void {
    this.mutateGraph(graph => {
      const node = graph.nodes.find(item => item.id === nodeId);
      if (!node) return graph;
      const portIds = new Set(node.ports.map(port => port.id));
      return {
        nodes: graph.nodes.filter(item => item.id !== nodeId),
        connections: graph.connections.filter(
          conn => !portIds.has(portBaseId(conn.outputId)) && !portIds.has(portBaseId(conn.inputId)),
        ),
      };
    });
  }

  /** Patches top-level node fields (name, icon, description, data). */
  updateNode(
    nodeId: string,
    patch: Partial<Pick<WorkflowNode, 'name' | 'icon' | 'description' | 'data'>>,
  ): void {
    this.mutateGraph(graph => ({
      ...graph,
      nodes: graph.nodes.map(node => (node.id === nodeId ? { ...node, ...patch } : node)),
    }));
  }

  /** Merges a partial patch into a node's kind-specific `data`. */
  updateNodeData(nodeId: string, dataPatch: Record<string, unknown>): void {
    this.mutateGraph(graph => ({
      ...graph,
      nodes: graph.nodes.map(node =>
        node.id === nodeId ? { ...node, data: { ...node.data, ...dataPatch } } : node,
      ),
    }));
  }

  /** Replaces a node's ports (e.g. adding a router route). */
  updateNodePorts(nodeId: string, ports: WorkflowNode['ports']): void {
    this.mutateGraph(graph => {
      const node = graph.nodes.find(item => item.id === nodeId);
      if (!node) return graph;
      const keptIds = new Set(ports.map(port => port.id));
      const removed = node.ports.filter(port => !keptIds.has(port.id));
      const removedIds = new Set(removed.map(port => port.id));
      return {
        nodes: graph.nodes.map(item => (item.id === nodeId ? { ...item, ports } : item)),
        // Drop connections referencing deleted ports.
        connections: graph.connections.filter(
          conn =>
            !removedIds.has(portBaseId(conn.outputId)) &&
            !removedIds.has(portBaseId(conn.inputId)),
        ),
      };
    });
  }

  /**
   * Creates a connection between two connector ids. Validates port-role
   * compatibility and derives the edge kind (handoff vs tool-link).
   * Duplicate edges are silently ignored.
   */
  addConnection(outputId: string, inputId: string): WorkflowConnection | null {
    const graph = this.graph();
    const source = findNodeForConnector(graph, outputId);
    const target = findNodeForConnector(graph, inputId);
    if (!source || !target) return null;
    if (source.node.id === target.node.id) return null;
    if (!canConnectPorts(source.port.role, target.port.role)) return null;

    const kind = edgeKindForPorts(source.port.role, target.port.role);
    // A data node is never an agent's tool — reject before touching the graph.
    const toolLinkReason = toolLinkRejection(
      { node: source.node, role: source.port.role },
      { node: target.node, role: target.port.role },
    );
    if (toolLinkReason) return null;

    const duplicate = graph.connections.some(
      conn => conn.outputId === outputId && conn.inputId === inputId,
    );
    if (duplicate) return null;

    const connection: WorkflowConnection = {
      id: `conn-${Date.now().toString(36)}-${graph.connections.length}`,
      outputId,
      inputId,
      kind,
    };
    this.mutateGraph(current => ({
      ...current,
      connections: [...current.connections, connection],
    }));
    return connection;
  }

  /** Removes a connection by id. */
  removeConnection(connectionId: string): void {
    this.mutateGraph(graph => ({
      ...graph,
      connections: graph.connections.filter(conn => conn.id !== connectionId),
    }));
  }

  /** Replaces the whole graph (undo/redo restore). */
  replaceGraph(graph: WorkflowGraph): void {
    this.mutateGraph(() => graph);
  }

  /** Inserts pre-built nodes + connections (clipboard paste). */
  insertNodes(nodes: WorkflowNode[], connections: WorkflowConnection[]): void {
    if (nodes.length === 0) return;
    this.mutateGraph(graph => ({
      nodes: [...graph.nodes, ...nodes],
      connections: [...graph.connections, ...connections],
    }));
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  /**
   * Builds the flat transitive Execute Workflow registry. Resolution is
   * library-first, then falls back to snapshots already carried by the
   * source spec. A visited set makes self and mutual recursion portable.
   */
  private withEmbeddedClosure(
    root: WorkflowSpec,
    existing?: Record<string, EmbeddedWorkflow>,
    preferExisting = false,
  ): WorkflowSpec {
    const closure: Record<string, EmbeddedWorkflow> = {};
    const visited = new Set<string>();

    const visit = (workflowId: string, fallback?: Record<string, EmbeddedWorkflow>): void => {
      if (!workflowId || visited.has(workflowId)) return;
      visited.add(workflowId);

      const librarySpec = this.libraryState().find(item => item.id === workflowId);
      const embedded = fallback?.[workflowId] ?? existing?.[workflowId];
      const source = workflowId === root.id
        ? root
        : preferExisting
          ? embedded ?? librarySpec
          : librarySpec ?? embedded;
      if (!source) return;

      closure[workflowId] = {
        id: source.id,
        name: source.name,
        description: source.description,
        graph: structuredClone(source.graph),
        settings: source.settings ? { ...source.settings } : undefined,
      };
      const nextFallback: Record<string, EmbeddedWorkflow> | undefined =
        'subWorkflows' in source
          ? (source.subWorkflows as Record<string, EmbeddedWorkflow> | undefined)
          : fallback;
      for (const node of source.graph.nodes) {
        if (node.kind !== 'execute-workflow') continue;
        const targetId = (node.data as { workflowId?: string }).workflowId?.trim();
        if (targetId) visit(targetId, nextFallback);
      }
    };

    for (const node of root.graph.nodes) {
      if (node.kind !== 'execute-workflow') continue;
      const targetId = (node.data as { workflowId?: string }).workflowId?.trim();
      if (targetId) visit(targetId, existing);
    }

    return {
      ...root,
      subWorkflows: Object.keys(closure).length > 0 ? closure : undefined,
    };
  }

  private mutateGraph(mutate: (graph: WorkflowGraph) => WorkflowGraph): void {
    const doc = this.activeDoc();
    if (!doc || doc.readOnly) return;
    const next = mutate(doc.graph);
    if (next === doc.graph) return;
    this.updateDoc(doc.docId, { graph: next, dirty: true });
  }

  private updateDoc(docId: string, patch: Partial<OpenWorkflowDoc>): void {
    this.docsState.update(docs =>
      docs.map(doc => (doc.docId === docId ? { ...doc, ...patch } : doc)),
    );
  }
}
