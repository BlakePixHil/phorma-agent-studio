import { Injectable } from '@angular/core';

import { WORKFLOW_FILE_EXTENSION, type WorkflowSpec } from './workflow.model';

/**
 * Thin wrapper around the Tauri IPC bridge.
 *
 * Lazily imports `@tauri-apps/api` so the app still runs in a plain browser
 * (e.g. `ng serve` without the desktop shell) without throwing at startup.
 * Domain code must never import Tauri APIs directly — everything native goes
 * through this service and checks {@link isDesktop}.
 */
@Injectable({ providedIn: 'root' })
export class TauriService {
  /** True when running inside the Tauri desktop runtime. */
  readonly isDesktop = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

  /**
   * Opens a native open-file dialog for a workflow document and reads it.
   * Returns `null` when the user cancels.
   *
   * @throws When not running in the desktop shell or the file is unreadable.
   */
  async openWorkflowFileDialog(): Promise<{ path: string; spec: WorkflowSpec } | null> {
    this.requireDesktop('Opening workflow files');
    const { open } = await import('@tauri-apps/plugin-dialog');
    const selected = await open({
      title: 'Open workflow',
      multiple: false,
      filters: [{ name: 'Phorma Workflow', extensions: [WORKFLOW_FILE_EXTENSION, 'json'] }],
    });
    if (typeof selected !== 'string') return null;

    const { invoke } = await import('@tauri-apps/api/core');
    const raw = await invoke<string>('read_workflow_file', { path: selected });
    return { path: selected, spec: JSON.parse(raw) as WorkflowSpec };
  }

  /**
   * Opens a native save-file dialog and writes the workflow document.
   * Returns the chosen path, or `null` when the user cancels.
   *
   * @throws When not running in the desktop shell or the file is unwritable.
   */
  async saveWorkflowFileDialog(spec: WorkflowSpec): Promise<string | null> {
    this.requireDesktop('Saving workflow files');
    const { save } = await import('@tauri-apps/plugin-dialog');
    const suggested = `${spec.name.replace(/[^a-z0-9-_ ]/gi, '').trim() || 'workflow'}.${WORKFLOW_FILE_EXTENSION}`;
    const selected = await save({
      title: 'Export workflow',
      defaultPath: suggested,
      filters: [{ name: 'Phorma Workflow', extensions: [WORKFLOW_FILE_EXTENSION] }],
    });
    if (typeof selected !== 'string') return null;

    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('write_workflow_file', {
      path: selected,
      content: JSON.stringify(spec, null, 2),
    });
    return selected;
  }

  /**
   * Opens a native folder-picker dialog. Returns the chosen absolute path,
   * or `null` when the user cancels.
   *
   * @throws When not running in the desktop shell.
   */
  async selectFolderDialog(title: string): Promise<string | null> {
    this.requireDesktop('Selecting folders');
    const { open } = await import('@tauri-apps/plugin-dialog');
    const selected = await open({ directory: true, multiple: false, title });
    return typeof selected === 'string' ? selected : null;
  }

  private requireDesktop(action: string): void {
    if (!this.isDesktop) {
      throw new Error(`${action} is only available in the desktop app.`);
    }
  }
}
