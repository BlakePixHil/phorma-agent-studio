import {
  ChangeDetectionStrategy,
  Component,
  HostListener,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { CheckboxModule } from 'primeng/checkbox';
import { InputNumberModule } from 'primeng/inputnumber';
import { InputTextModule } from 'primeng/inputtext';
import { SelectModule } from 'primeng/select';

import type { Connection, ConnectionAuth, ConnectionType, SqlLimits } from '@phorma/engine';

import { ConnectionsService } from '../../../core/connections.service';
import { ConnectionEditorDialogService } from '../connection-editor-dialog.service';
import { ConfirmDialogService } from '../../../shared/confirm-dialog/confirm-dialog.service';
import { ToastService } from '../../../shared/toast/toast.service';

interface Choice<T extends string> {
  id: T;
  label: string;
}

const CONNECTION_TYPES: Choice<ConnectionType>[] = [
  { id: 'http', label: 'HTTP' },
  { id: 'oauth2', label: 'OAuth 2.0' },
  { id: 'sql', label: 'SQL database' },
  { id: 'aws-sigv4', label: 'AWS (SigV4)' },
  { id: 'smtp', label: 'SMTP' },
];

const AUTH_MODES: Choice<ConnectionAuth['mode']>[] = [
  { id: 'none', label: 'None' },
  { id: 'bearer', label: 'Bearer token' },
  { id: 'basic', label: 'Basic (user + password)' },
  { id: 'header', label: 'Custom header' },
  { id: 'query', label: 'Query parameter' },
  { id: 'oauth2-client-credentials', label: 'OAuth2 client credentials' },
  { id: 'oauth2-refresh', label: 'OAuth2 refresh token' },
  { id: 'aws-sigv4', label: 'AWS SigV4' },
];

/** One row in the free-form non-secret config editor. */
interface ConfigRow {
  key: string;
  value: string;
}

/**
 * The connection editor (Requirements 2.2, 19.5-19.9): a bespoke overlay
 * dialog (mirrors the skill editor / credits dialog pattern; no `p-dialog`)
 * for creating, renaming and deleting Connections, and for writing secret
 * values straight to the host secret store.
 *
 * Two things never happen here, by construction:
 * - A secret VALUE is never read back once saved - {@link secretDrafts} only
 *   ever holds text the user is CURRENTLY typing; a successful save clears it
 *   immediately, and there is no code path that populates a draft from a
 *   stored value.
 * - A secret value never reaches `ConnectionsService.update` - it goes
 *   straight to {@link ConnectionsService.writeSecret}, which forwards it to
 *   the host store and records only the field NAME in metadata.
 */
@Component({
  selector: 'app-connection-editor-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, ButtonModule, CheckboxModule, InputNumberModule, InputTextModule, SelectModule],
  templateUrl: './connection-editor-dialog.html',
  styleUrl: './connection-editor-dialog.scss',
})
export class ConnectionEditorDialog {
  protected readonly dialog = inject(ConnectionEditorDialogService);
  protected readonly connections = inject(ConnectionsService);
  private readonly confirmDialog = inject(ConfirmDialogService);
  private readonly toast = inject(ToastService);

  protected readonly connectionTypes = CONNECTION_TYPES;
  protected readonly authModes = AUTH_MODES;

  // ── Metadata form state ─────────────────────────────────────────────────

  protected readonly name = signal('');
  protected readonly type = signal<ConnectionType>('http');
  protected readonly configRows = signal<ConfigRow[]>([]);
  protected readonly authMode = signal<ConnectionAuth['mode']>('none');
  /** Draft fields for the auth descriptor, keyed by its own property names. */
  protected readonly authDraft = signal<Record<string, string>>({});
  protected readonly allowWrites = signal(false);
  protected readonly limits = signal<SqlLimits>({});

  protected readonly nameError = signal<string | null>(null);
  protected readonly saving = signal(false);
  protected readonly deleting = signal(false);

  /** The connection actually persisted for this dialog session, if any. */
  private readonly savedConnection = signal<Connection | null>(null);

  protected readonly isEditing = computed(() => this.savedConnection() !== null);

  /**
   * The persisted connection, refreshed from the live library so
   * `secretKeys` reflects every field declared since the dialog opened
   * (e.g. one just added via {@link addSecretField}).
   */
  protected readonly editingConnection = computed<Connection | null>(() => {
    const id = this.savedConnection()?.id;
    if (!id) return null;
    return this.connections.connections().find(item => item.id === id) ?? this.savedConnection();
  });

  // ── Secrets ──────────────────────────────────────────────────────────────

  /** Requirement 19.8: whether the active host can hold a secret at all. */
  protected readonly secretsSupported = this.connections.secretsSupported;

  /** Draft VALUES currently being typed, keyed by secret field name. */
  protected readonly secretDrafts = signal<Record<string, string>>({});
  /** Presence flags for each declared secret field (never a value). */
  protected readonly secretPresence = signal<Record<string, boolean>>({});
  protected readonly newSecretName = signal('');

  constructor() {
    // Re-seed the form whenever the dialog opens on a (possibly different)
    // connection. Mirrors `SkillEditorDialog`'s reset effect.
    effect(() => {
      if (!this.dialog.visible()) return;
      const editing = this.dialog.editing();
      untracked(() => this.seedForm(editing));
    });

    // Refresh secret-presence badges whenever the edited connection's declared
    // fields change. `untracked` guards the signal write.
    effect(() => {
      const connection = this.savedConnection();
      if (!connection) return;
      const keys = connection.secretKeys;
      untracked(() => void this.refreshPresence(keys));
    });
  }

  private seedForm(editing: Connection | null): void {
    this.savedConnection.set(editing);
    this.name.set(editing?.name ?? '');
    this.type.set(editing?.type ?? 'http');
    this.configRows.set(Object.entries(editing?.config ?? {}).map(([key, value]) => ({ key, value })));
    this.authMode.set(editing?.auth.mode ?? 'none');
    this.authDraft.set(authToDraft(editing?.auth));
    this.allowWrites.set(editing?.allowWrites === true);
    this.limits.set({ ...(editing?.limits ?? {}) });
    this.nameError.set(null);
    this.saving.set(false);
    this.deleting.set(false);
    this.secretDrafts.set({});
    this.newSecretName.set('');
    this.secretPresence.set({});
  }

  private async refreshPresence(secretKeys: readonly string[]): Promise<void> {
    const connectionId = this.savedConnection()?.id;
    if (!connectionId) return;
    const entries = await Promise.all(
      secretKeys.map(async key => [key, await this.connections.secretPresent(connectionId, key)] as const),
    );
    this.secretPresence.set(Object.fromEntries(entries));
  }

  @HostListener('document:keydown.escape')
  protected onEscape(): void {
    if (this.dialog.visible()) this.dialog.close();
  }

  // ── Metadata field handlers ────────────────────────────────────────────

  protected onNameInput(event: Event): void {
    this.name.set((event.target as HTMLInputElement).value);
    this.nameError.set(null);
  }

  protected onTypeChange(type: ConnectionType): void {
    this.type.set(type);
  }

  protected onAuthModeChange(mode: ConnectionAuth['mode']): void {
    this.authMode.set(mode);
  }

  protected patchAuthDraft(patch: Record<string, string>): void {
    this.authDraft.update(current => ({ ...current, ...patch }));
  }

  /** Current draft text for one auth field, or '' when untouched. */
  protected authField(key: string): string {
    return this.authDraft()[key] ?? '';
  }

  protected addConfigRow(): void {
    this.configRows.update(rows => [...rows, { key: '', value: '' }]);
  }

  protected updateConfigRow(index: number, patch: Partial<ConfigRow>): void {
    this.configRows.update(rows => {
      const next = [...rows];
      if (!next[index]) return rows;
      next[index] = { ...next[index], ...patch };
      return next;
    });
  }

  protected removeConfigRow(index: number): void {
    this.configRows.update(rows => rows.filter((_, i) => i !== index));
  }

  protected onAllowWritesChange(checked: boolean): void {
    this.allowWrites.set(checked);
  }

  protected patchLimits(patch: Partial<SqlLimits>): void {
    this.limits.update(current => ({ ...current, ...patch }));
  }

  protected numberOrUndefined(value: number | null): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  }

  // ── Save / delete metadata ─────────────────────────────────────────────

  /**
   * Requirement 19.5: creates or renames/updates a Connection. A name outside
   * 1-100 characters is rejected before anything is written, with the entered
   * text retained and the stored Connection left unchanged.
   */
  protected async save(): Promise<void> {
    if (this.saving()) return;
    const trimmed = this.name().trim();
    if (trimmed.length < 1 || trimmed.length > 100) {
      this.nameError.set('Name must be between 1 and 100 characters.');
      return;
    }

    this.saving.set(true);
    try {
      const config = Object.fromEntries(
        this.configRows()
          .map(row => [row.key.trim(), row.value] as const)
          .filter(([key]) => key.length > 0),
      );
      const auth = draftToAuth(this.authMode(), this.authDraft());
      const limits = this.type() === 'sql' ? cleanLimits(this.limits()) : undefined;

      const current = this.savedConnection();
      if (current) {
        const updated = await this.connections.update(current.id, {
          name: trimmed,
          type: this.type(),
          config,
          auth,
          allowWrites: this.allowWrites() || undefined,
          limits,
        });
        this.savedConnection.set(updated);
        this.toast.success('Connection saved', updated.name);
      } else {
        const created = await this.connections.create({
          name: trimmed,
          type: this.type(),
          config,
          auth,
          allowWrites: this.allowWrites(),
          limits,
        });
        // Switch into edit mode in place so the Secrets section activates
        // without closing and reopening the dialog.
        this.savedConnection.set(created);
        this.dialog.openEdit(created);
        this.toast.success('Connection created', created.name);
      }
    } catch (error) {
      this.toast.error('Could not save connection', error instanceof Error ? error.message : String(error));
    } finally {
      this.saving.set(false);
    }
  }

  /**
   * Requirement 19.6: lists every referencing workflow before deleting, and
   * removes metadata together with every secret entry only once confirmed.
   */
  protected async remove(): Promise<void> {
    const connection = this.savedConnection();
    if (!connection || this.deleting()) return;

    const referencing = this.connections.referencingWorkflows(connection.id);
    const message =
      referencing.length > 0
        ? `"${connection.name}" is used by ${referencing.length} workflow${referencing.length === 1 ? '' : 's'}: ` +
          `${referencing.map(w => w.name).join(', ')}. Deleting it removes every stored secret; those ` +
          `workflows will fail to resolve this connection at run time.`
        : `"${connection.name}" and every secret stored for it will be removed. This can't be undone.`;

    const confirmed = await this.confirmDialog.confirm({
      title: 'Delete connection?',
      message,
      confirmLabel: 'Delete',
      tone: 'danger',
    });
    if (!confirmed) return;

    this.deleting.set(true);
    try {
      await this.connections.remove(connection.id);
      this.toast.success('Connection deleted', connection.name);
      this.dialog.close();
    } catch (error) {
      this.toast.error('Delete failed', error instanceof Error ? error.message : String(error));
    } finally {
      this.deleting.set(false);
    }
  }

  // ── Secrets ─────────────────────────────────────────────────────────────

  protected secretConfigured(secretKey: string): boolean {
    return !!this.secretPresence()[secretKey];
  }

  protected onSecretInput(secretKey: string, event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.secretDrafts.update(drafts => ({ ...drafts, [secretKey]: value }));
  }

  /**
   * Requirement 19.7: writes the drafted value directly to the host secret
   * store, then shows the field as holding a stored secret without ever
   * showing the value - the draft is discarded immediately on success.
   */
  protected async saveSecret(secretKey: string): Promise<void> {
    const connectionId = this.savedConnection()?.id;
    const draft = this.secretDrafts()[secretKey];
    if (!connectionId || draft === undefined) return;
    try {
      await this.connections.writeSecret(connectionId, secretKey, draft);
      this.secretDrafts.update(drafts => {
        const next = { ...drafts };
        delete next[secretKey];
        return next;
      });
      this.secretPresence.update(presence => ({ ...presence, [secretKey]: draft.trim().length > 0 }));
      // A saved connection's `secretKeys` may have gained this name.
      const refreshed = await this.freshSavedConnection(connectionId);
      if (refreshed) this.savedConnection.set(refreshed);
      this.toast.success(draft.trim() ? 'Secret saved' : 'Secret removed', secretKey);
    } catch (error) {
      // Requirement 19.9: every previously stored value and the metadata stay
      // unchanged on failure - nothing here mutates either until the write
      // above has already succeeded.
      this.toast.error('Could not save secret', error instanceof Error ? error.message : String(error));
    }
  }

  /** Requirement 19.9-adjacent: drops a declared secret field entirely. */
  protected async removeSecretField(secretKey: string): Promise<void> {
    const connectionId = this.savedConnection()?.id;
    if (!connectionId) return;
    try {
      await this.connections.removeSecretField(connectionId, secretKey);
      const refreshed = await this.freshSavedConnection(connectionId);
      if (refreshed) this.savedConnection.set(refreshed);
      this.secretPresence.update(presence => {
        const next = { ...presence };
        delete next[secretKey];
        return next;
      });
      this.toast.success('Secret field removed', secretKey);
    } catch (error) {
      this.toast.error('Could not remove secret field', error instanceof Error ? error.message : String(error));
    }
  }

  /** Declares a new (initially empty) secret field name on the connection. */
  protected onNewSecretNameInput(event: Event): void {
    this.newSecretName.set((event.target as HTMLInputElement).value);
  }

  protected async addSecretField(): Promise<void> {
    const connectionId = this.savedConnection()?.id;
    const name = this.newSecretName().trim();
    if (!connectionId || !name) return;
    const current = this.savedConnection();
    if (current?.secretKeys.includes(name)) {
      this.newSecretName.set('');
      return;
    }
    try {
      const updated = await this.connections.update(connectionId, {
        secretKeys: [...(current?.secretKeys ?? []), name],
      });
      this.savedConnection.set(updated);
      this.newSecretName.set('');
    } catch (error) {
      this.toast.error('Could not add secret field', error instanceof Error ? error.message : String(error));
    }
  }

  private async freshSavedConnection(connectionId: string): Promise<Connection | null> {
    await this.connections.refresh();
    return this.connections.connections().find(item => item.id === connectionId) ?? null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Auth descriptor <-> draft conversion
// ─────────────────────────────────────────────────────────────────────────────

/** Flattens an existing auth descriptor's own fields into a text-draft map. */
function authToDraft(auth: ConnectionAuth | undefined): Record<string, string> {
  if (!auth) return {};
  const { mode, ...rest } = auth as ConnectionAuth & Record<string, unknown>;
  const draft: Record<string, string> = {};
  for (const [key, value] of Object.entries(rest)) {
    if (typeof value === 'string') draft[key] = value;
  }
  return draft;
}

/** Builds a `ConnectionAuth` descriptor from the selected mode and its draft fields. */
function draftToAuth(mode: ConnectionAuth['mode'], draft: Record<string, string>): ConnectionAuth {
  const get = (key: string) => (draft[key] ?? '').trim();
  switch (mode) {
    case 'none':
      return { mode };
    case 'bearer':
      return { mode, secretKey: get('secretKey') };
    case 'basic':
      return { mode, userSecretKey: get('userSecretKey'), passwordSecretKey: get('passwordSecretKey') };
    case 'header':
      return {
        mode,
        header: get('header'),
        secretKey: get('secretKey'),
        ...(get('prefix') ? { prefix: get('prefix') } : {}),
      };
    case 'query':
      return { mode, param: get('param'), secretKey: get('secretKey') };
    case 'oauth2-client-credentials':
      return {
        mode,
        tokenUrl: get('tokenUrl'),
        clientIdSecretKey: get('clientIdSecretKey'),
        clientSecretKey: get('clientSecretKey'),
        ...(get('scope') ? { scope: get('scope') } : {}),
      };
    case 'oauth2-refresh':
      return {
        mode,
        tokenUrl: get('tokenUrl'),
        clientIdSecretKey: get('clientIdSecretKey'),
        clientSecretKey: get('clientSecretKey'),
        refreshTokenSecretKey: get('refreshTokenSecretKey'),
      };
    case 'aws-sigv4':
      return {
        mode,
        service: get('service'),
        region: get('region'),
        accessKeySecretKey: get('accessKeySecretKey'),
        secretKeySecretKey: get('secretKeySecretKey'),
      };
  }
}

function cleanLimits(limits: SqlLimits): SqlLimits | undefined {
  const cleaned: SqlLimits = {};
  if (limits.statementTimeoutMs !== undefined) cleaned.statementTimeoutMs = limits.statementTimeoutMs;
  if (limits.maxRows !== undefined) cleaned.maxRows = limits.maxRows;
  if (limits.maxResultBytes !== undefined) cleaned.maxResultBytes = limits.maxResultBytes;
  return Object.keys(cleaned).length > 0 ? cleaned : undefined;
}
