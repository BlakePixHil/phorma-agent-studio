import { computed, effect, Injectable, inject, signal } from '@angular/core';

import { IndexedDbStorageService } from './indexed-db-storage.service';
import { SettingsService } from './settings.service';
import { SkillsService } from './skills.service';
import { buildNodeFromCatalog, findCatalogEntry } from './node-catalog';
import { loadLayout, saveLayout } from './layout-storage';
import { counterName } from './telemetry-catalog';
import { TelemetryService } from './telemetry.service';
import { ToastService } from '../shared/toast/toast.service';
import { ConfirmDialogService } from '../shared/confirm-dialog/confirm-dialog.service';
import { WorkflowVersionsService } from './workflow-versions.service';
import { mintWorkflowId } from './workflow-id';
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
  /**
   * A deployed workflow an EDITOR may change, whose save is a proposal
   * (multi-organisation-phorma, Requirement 12.1).
   *
   * A third state rather than a `readOnly` variant, because `readOnly` conflates
   * two things this document needs apart: it is MUTABLE (an editor changes prompts
   * and node configuration on it) and it is NOT PERSISTED (a member has no local
   * library, and Requirement 9.4 says nothing about them reaches local storage).
   * So every write rail stays open and the two PERSISTENCE rails - the open-tab
   * session effect and the autosave effect - exclude it alongside `readOnly`.
   */
  proposeOnly?: boolean;
}

/**
 * What a {@link WorkflowService.restoreSpec} call did.
 *
 * Four outcomes rather than a boolean because a restore-all has to report counts
 * (Requirement 18.5), and "the user chose to keep their local copy" is a success
 * that must not be counted as a failure.
 */
export type WorkflowRestoreOutcome = 'restored' | 'replaced' | 'kept-local' | 'failed';

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
  // Safe DI direction: `TelemetryService` is a leaf that injects only
  // `TauriService`, so it cannot pull anything back into this service.
  private readonly telemetry = inject(TelemetryService);

  /** Debounce handle for the autosave effect. */
  private autosaveTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * What SAVING a propose-only document does (Requirement 12.1).
   *
   * A settable seam installed by the shell, the same idiom as
   * `RunControllerService.deployedRunLauncher` and `CloudService.specProposer`. It
   * has to be one: the submission must carry a spec with the application defaults
   * MATERIALIZED, which only `CloudService` can do, and that service injects this
   * one. Resolves true when the change was accepted for review.
   *
   * Absent means this build cannot submit a proposal, which {@link saveActive}
   * reports rather than writing the change somewhere it does not belong.
   */
  proposeActive: (() => Promise<boolean>) | null = null;

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
    //
    // A READ-ONLY document is excluded, and that exclusion is what keeps the
    // Cloud_Library out of local storage: `openDeployedSpec` preserves the
    // deployed workflow id, so without the filter that id would be written here
    // for a member who persists nothing (multi-organisation Requirement 9.4).
    // It restores nothing either way - `restoreSession` resolves each id against
    // the local library, which a deployed-only workflow is absent from.
    //
    // A PROPOSE-ONLY document is excluded for the same reason and is not the same
    // state: it is mutable, and persisting it would put an organisation's deployed
    // workflow id into a member's local storage.
    effect(() => {
      const docs = this.docsState().filter(
        doc => doc.readOnly !== true && doc.proposeOnly !== true,
      );
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
      // A propose-only document never autosaves: there is nothing local to save
      // into, and a debounced SUBMISSION every two seconds would put a queue of
      // proposals in front of a reviewer for one sitting of typing.
      const shouldSave =
        enabled && !!doc && doc.workflowId !== null && doc.dirty && doc.proposeOnly !== true;
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
   *
   * Operates on the FULL document list, read-only tabs included. Do not filter
   * `readOnly` here, however tempting the symmetry with the open-tab session
   * effect in the constructor looks: that filter decides what gets PERSISTED,
   * and copying it into this method broke closing twice over - it dropped every
   * read-only tab from the tab bar when an ordinary neighbour closed, and made a
   * deployed preview or a version snapshot un-closable even though the tab strip
   * renders a close button for it. A read-only document is immutable, not
   * permanent, and an owner switch has to be able to close one
   * (multi-organisation Requirement 20.7).
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

  /**
   * Closes EVERY open tab and opens one fresh untitled workflow
   * (multi-organisation-phorma, Requirement 20.7).
   *
   * One operation rather than a loop over {@link closeDocument}, because that
   * method opens a replacement the moment the list empties - so a loop would mint
   * an untitled document part way through and then close it again, firing the
   * session-persistence effect several times with intermediate states. This
   * replaces the list once.
   *
   * Read-only and propose-only tabs go too. A document tab addresses a workflow id
   * INSIDE one owner, and the same id means a different workflow under another, so
   * a deployed preview is exactly the kind of tab that must not survive a switch.
   * The caller is responsible for any unsaved-changes confirmation, exactly as it
   * is for {@link closeDocument}.
   */
  closeAllDocuments(): void {
    this.docsState.set([]);
    this.activeDocIdState.set(null);
    this.newWorkflow();
  }

  /**
   * Re-reads the library for the ACTIVE owner (Requirement 20.13).
   *
   * Deliberately does NOT restore the tab session the way startup does: the
   * persisted tab list belongs to whoever was active when it was written, and
   * resolving those ids against a different owner's library is how one owner's id
   * would silently open another owner's workflow of the same id. An owner switch
   * closes the tabs and opens an untitled document instead.
   */
  async reloadLibrary(): Promise<void> {
    try {
      const specs = await this.storage.listWorkflows();
      specs.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
      this.libraryState.set(specs);
    } catch {
      // Best-effort, exactly as at startup: a broken IndexedDB must not brick the
      // app, and least of all in the middle of a switch.
      this.libraryState.set([]);
    }
    this.libraryLoadedState.set(true);
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

    // An editor's save is a PROPOSAL (Requirement 12.1), and nothing is written
    // locally. Through a settable seam rather than a service call, because the
    // performer has to MATERIALIZE the application defaults first - that lives in
    // `CloudService`, which injects this service, so the shell installs the
    // direction back. Returning null is honest: nothing entered the library.
    if (doc.proposeOnly) {
      if (!this.proposeActive) {
        this.toast.warning(
          'Submit for review',
          'This change is submitted for review rather than saved locally, and this build cannot ' +
            'submit one. Update the app and try again.',
        );
        return null;
      }
      if (await this.proposeActive()) this.updateDoc(doc.docId, { dirty: false });
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
      id: doc.workflowId ?? mintWorkflowId(),
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
    // Last-resort collision guard. Unreachable for a freshly minted id since
    // `mintWorkflowId` carries 48 bits of entropy (Requirement 14.4), but a spec
    // arriving from elsewhere can still carry an id this library already holds -
    // and this rail is a COPY, so re-minting is the right answer here. A restore
    // is the opposite case and goes through `restoreSpec`.
    const id = this.libraryState().some(item => item.id === spec.id)
      ? mintWorkflowId()
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

  /**
   * Writes a spec into the library keeping its `id` EXACTLY as received - the
   * identity-preserving counterpart to {@link importSpec} (Requirement 15).
   *
   * The distinction is the whole point. A file import is a COPY, so it mints a
   * fresh id; a restore is the SAME workflow arriving from somewhere else (a
   * cloud backup, or the spec read back off its own deployment), so it must keep
   * the id or it stops addressing its own deployment instance, run history,
   * usage rows and backup revisions (Requirement 15.4). Restoring under a new id
   * would leave the original deployment exactly as orphaned as before.
   *
   * `collision` decides what happens when the library already holds that id.
   * `'ask'` is the interactive default (Requirement 15.3); a restore-all passes
   * an explicit policy instead, because N dialogs is not a recovery flow. No
   * branch ever mints a new id.
   */
  async restoreSpec(
    spec: WorkflowSpec,
    collision: 'ask' | 'replace' | 'skip' = 'ask',
  ): Promise<WorkflowRestoreOutcome> {
    const existing = this.libraryState().find(item => item.id === spec.id);
    if (existing) {
      if (collision === 'skip') return 'kept-local';
      if (collision === 'ask') {
        const replace = await this.confirmDialog.confirm({
          title: 'Replace the local copy?',
          message:
            `"${existing.name}" is already in your library. Restoring replaces it with the ` +
            `copy from the cloud. Its version history is kept, so you can go back.`,
          confirmLabel: 'Replace',
          cancelLabel: 'Keep local',
          tone: 'danger',
        });
        if (!replace) return 'kept-local';
      }
    }

    const restored = this.withEmbeddedClosure(
      {
        ...structuredClone(spec),
        version: WORKFLOW_SPEC_VERSION,
        savedAt: new Date().toISOString(),
      },
      spec.subWorkflows,
      // Prefer the registry the spec ARRIVED with: a restore is rehydration, so
      // the carried closure is the faithful record. Library-first resolution
      // would quietly graft whatever the local library happens to hold onto a
      // workflow that has just been recovered from somewhere else.
      true,
    );

    try {
      await this.storage.saveWorkflow(restored);
    } catch {
      this.toast.error('Restore failed', 'The workflow could not be written to storage.');
      return 'failed';
    }

    this.libraryState.update(specs => [restored, ...specs.filter(item => item.id !== restored.id)]);
    // An open tab pointing at this workflow follows the restore, exactly as
    // `restoreVersion` does - otherwise the tab keeps editing the copy that was
    // just replaced and the next save undoes the restore.
    this.docsState.update(docs =>
      docs.map(doc =>
        doc.workflowId === restored.id
          ? {
              ...doc,
              name: restored.name,
              description: restored.description ?? '',
              graph: structuredClone(restored.graph),
              settings: restored.settings ? { ...restored.settings } : {},
              subWorkflows: restored.subWorkflows
                ? structuredClone(restored.subWorkflows)
                : undefined,
              dirty: false,
            }
          : doc,
      ),
    );
    // A restore is a save from history's point of view, so the copy it replaced
    // stays recoverable from the version panel.
    await this.versions.recordSave(restored, 'restore').catch(() => undefined);
    return existing ? 'replaced' : 'restored';
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
    // Forget what cloud backup uploaded for this workflow (Requirement 13.4).
    //
    // A LOCAL write and nothing else. The cloud copy is deliberately untouched: a
    // local delete never propagates, so uninstalling, wiping this database or
    // deleting a workflow here are all recoverable (Requirement 17.3). Reached
    // through storage rather than through the backup service, because
    // `WorkflowService` must stay upstream of it - the reverse edge would close the
    // NG0200 cycle through the run path.
    await this.storage.removeBackupState(workflowId).catch(() => undefined);
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
      id: doc.workflowId ?? mintWorkflowId(),
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

  /**
   * Opens a deployed spec read from the cloud as a read-only tab (Cloud_Library,
   * multi-organisation Requirements 9.2, 9.3, 9.4).
   *
   * RESTORE-shaped in IDENTITY, SNAPSHOT-shaped in PERSISTENCE, and both halves
   * are load-bearing:
   *
   * - The id is PRESERVED, unlike {@link importSpec}, which mints a fresh one
   *   because a file import is a COPY. This document has to keep addressing the
   *   deployment it was read from: an editor's proposal is keyed on that workflow
   *   id and a builder's publish pushes back to that instance, so an
   *   import-shaped open would produce a proposal against a workflow id that does
   *   not exist in the cloud. Same reasoning as {@link restoreSpec}, and it holds
   *   even when the local library already carries the id - a collision here means
   *   the user has a local copy of the SAME workflow, not a different one.
   * - Nothing is written. No `storage.saveWorkflow`, no `libraryState` touch, and
   *   the open-tab session effect skips a read-only document, so no spec, prompt
   *   body or connection secret value reaches IndexedDB or `localStorage`. The
   *   local stores are workflow-keyed by `workflowKey`, so "do not write" is the
   *   whole mechanism and there is no scoping to get wrong.
   *
   * `readOnly: true` is the existing immutability rail rather than a new one:
   * `mutateGraph`, `renameActive`, `describeActive`, `updateSettings` and
   * `saveActive` already return early on it, and `CloudService.pushWorkflow`
   * already refuses a read-only active document.
   *
   * `mode` is the caller's, and the caller is the cloud library, because the answer
   * depends on the CAPABILITY of the session rather than on the spec:
   *
   * - `'read-only'` (the default) for an operator, and for a builder who would
   *   restore rather than propose.
   * - `'propose'` for an editor: the document is MUTABLE so they can change a
   *   prompt or a node's configuration, still writes nothing locally, and its save
   *   becomes a proposal (Requirement 12.1). See `proposeOnly` on
   *   {@link OpenWorkflowDoc} for why that is a third state and not a `readOnly`
   *   variant.
   */
  openDeployedSpec(spec: WorkflowSpec, mode: 'read-only' | 'propose' = 'read-only'): void {
    // Either deployed mode matches an already-open tab for this workflow: both are
    // "the deployed copy", and opening a second one would put two documents with
    // the same workflow id in the tab bar.
    const existing = this.docsState().find(
      doc =>
        (doc.readOnly === true || doc.proposeOnly === true) && doc.workflowId === spec.id,
    );
    if (existing) {
      this.activeDocIdState.set(existing.docId);
      return;
    }
    docCounter += 1;
    const doc: OpenWorkflowDoc = {
      docId: `doc-${docCounter}`,
      workflowId: spec.id,
      name: spec.name,
      description: spec.description ?? '',
      graph: structuredClone(spec.graph),
      settings: spec.settings ? { ...spec.settings } : {},
      subWorkflows: spec.subWorkflows ? structuredClone(spec.subWorkflows) : undefined,
      dirty: false,
      readOnly: mode === 'read-only',
      proposeOnly: mode === 'propose',
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
    // Counted on the resolved node, not on `entryId`: a `connector-step:` or
    // `mcp-preset:` palette id resolves to an ordinary node whose `kind` is in
    // the catalog, and anything else is discarded by `count` (3.1, 3.2).
    this.telemetry.count(counterName('node.created', node.kind));
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
