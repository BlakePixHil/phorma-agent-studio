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

import {
  authSecretKeyNames,
  workerSecretName,
  type Connection,
  type ConnectionAuth,
  type ConnectionType,
  type SqlLimits,
} from '@phorma/engine';

import { CloudService } from '../../../core/cloud.service';
import { ConnectionsService } from '../../../core/connections.service';
import { SettingsService } from '../../../core/settings.service';
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
  { id: 'basic-token', label: 'Basic (token)' },
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
 * - A secret VALUE is never read back once saved. {@link secretDrafts} only
 *   ever holds text the user typed in this dialog session, it is dropped when
 *   the dialog closes, and there is no code path that populates a draft from a
 *   stored value.
 * - A secret value never reaches `ConnectionsService.update` - it goes
 *   straight to {@link ConnectionsService.writeSecret}, which forwards it to
 *   the host store and records only the field NAME in metadata.
 *
 * A credential needs a copy in EVERY store this install runs on: the OS
 * keychain for local runs, the deploy target's vault for deployed ones. Since
 * neither store can be read back, a value that reached only one of them can
 * never be copied into the other - so {@link saveSecret} writes to all of them
 * from the one draft, and the draft survives until they all hold it.
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
  private readonly cloud = inject(CloudService);
  private readonly settings = inject(SettingsService);

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

  // ── Cloud copies of the secrets ─────────────────────────────────────────
  // A deployed run cannot read this machine's keychain, so a connection secret
  // needs a SECOND copy on the deploy target. There is deliberately no way to
  // read either store back, which is why sending happens from the draft the
  // operator is currently typing rather than from the stored value.

  /** True once the user picked a deploy target in Settings > Cloud. */
  protected readonly cloudConfigured = computed(
    () => this.settings.cloudProvider() !== null && this.cloud.configured(),
  );

  /** Entry names the deploy target already holds (`CONN_*`), never values. */
  private readonly cloudSecretNames = signal<readonly string[]>([]);
  /** The secret field currently being written to either store, for its spinner. */
  protected readonly busySecret = signal<string | null>(null);

  /**
   * Session answer to "may a value go to Phorma Cloud?", null until asked.
   * That target is somebody else's infrastructure, so a value only leaves the
   * machine on an explicit confirmation; asking once per dialog rather than
   * once per field keeps a two-secret mode like `basic` from stacking two
   * identical prompts. Own-Cloudflare is the operator's own worker and is
   * never asked about.
   */
  private readonly cloudConsent = signal<boolean | null>(null);

  /** What the row's save button will do, given the stores this install has. */
  protected readonly saveSecretTitle = computed(() => {
    if (!this.secretsSupported) return 'Send to your deploy target';
    return this.cloudConfigured()
      ? 'Save on this machine and send to your deploy target'
      : 'Save on this machine';
  });

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

    // Ask the deploy target which secrets it holds, once per dialog opening.
    // `untracked` is required: the refresh writes `cloudSecretNames`, which the
    // template reads, and tracking it here would loop the effect.
    effect(() => {
      if (!this.dialog.visible() || !this.cloudConfigured()) return;
      untracked(() => void this.refreshCloudSecrets());
    });
  }

  private async refreshCloudSecrets(): Promise<void> {
    this.cloudSecretNames.set(await this.cloud.connectionSecretNames());
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
    this.busySecret.set(null);
    this.cloudConsent.set(null);
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
          secretKeys: withAuthSecretKeys(current.secretKeys, auth),
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
          secretKeys: authSecretKeyNames(auth),
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
   * Requirement 19.7: writes the drafted value to every secret store this
   * install has - the OS keychain, and the deploy target's vault when one is
   * configured - then shows the field as holding a stored secret without ever
   * showing the value.
   *
   * Both stores are written from the SAME draft on purpose. Writing one and
   * clearing the draft used to be a dead end: with no read-back path, the value
   * could not then be copied to the other store, so a secret saved locally
   * could never be deployed and the push kept reporting it missing.
   */
  protected async saveSecret(secretKey: string): Promise<void> {
    const connectionId = this.savedConnection()?.id;
    const draft = this.secretDrafts()[secretKey];
    if (!connectionId || draft === undefined || this.busySecret()) return;

    // Claimed before the first `await`: the consent prompt is modal, and a
    // second Enter on the row must not open a second one.
    this.busySecret.set(secretKey);
    try {
      // An empty draft means "remove the local value". Replicating a removal to
      // the deploy target belongs to `removeCloudSecret`, which confirms first.
      const value = draft.trim();
      const toCloud = value.length > 0 && this.cloudConfigured() && (await this.cloudAllowed(false));

      if (this.secretsSupported && !(await this.writeLocalSecret(connectionId, secretKey, draft))) return;
      const sentToCloud = toCloud && (await this.sendToCloud(connectionId, secretKey, draft));

      if (this.secretsSupported && sentToCloud) {
        this.toast.success('Secret saved', `${secretKey} is stored on this machine and in the cloud.`);
      } else if (this.secretsSupported) {
        this.toast.success(value ? 'Secret saved' : 'Secret removed', secretKey);
      } else if (sentToCloud) {
        this.toast.success('Secret saved to the cloud', `${secretKey} is available to deployed runs.`);
      }

      if (!value || !this.secretMissingSomewhere(secretKey)) this.discardDraft(secretKey);
    } finally {
      this.busySecret.set(null);
    }
  }

  /**
   * Writes one value to the host secret store, reporting success. Requirement
   * 19.9: a failed write leaves every stored value and the metadata unchanged,
   * so nothing here mutates either until the write has already succeeded.
   */
  private async writeLocalSecret(
    connectionId: string,
    secretKey: string,
    draft: string,
  ): Promise<boolean> {
    try {
      await this.connections.writeSecret(connectionId, secretKey, draft);
      this.secretPresence.update(presence => ({ ...presence, [secretKey]: draft.trim().length > 0 }));
      // A saved connection's `secretKeys` may have gained this name.
      const refreshed = await this.freshSavedConnection(connectionId);
      if (refreshed) this.savedConnection.set(refreshed);
      return true;
    } catch (error) {
      this.toast.error('Could not save secret', error instanceof Error ? error.message : String(error));
      return false;
    }
  }

  /** Sends one value to the deploy target and refreshes the cloud badges. */
  private async sendToCloud(connectionId: string, secretKey: string, draft: string): Promise<boolean> {
    const sent = await this.cloud.putConnectionSecret(connectionId, secretKey, draft, { silent: true });
    if (sent) await this.refreshCloudSecrets();
    return sent;
  }

  /** Forgets a draft value once every store this install uses holds it. */
  private discardDraft(secretKey: string): void {
    this.secretDrafts.update(drafts => {
      const next = { ...drafts };
      delete next[secretKey];
      return next;
    });
  }

  /**
   * True when a store this install runs on still lacks this secret's value.
   * While that holds, the draft is the ONLY way to reach that store, so it is
   * kept on screen rather than discarded.
   */
  private secretMissingSomewhere(secretKey: string): boolean {
    if (this.secretsSupported && !this.secretConfigured(secretKey)) return true;
    return this.cloudConfigured() && !this.storedInCloud(secretKey);
  }

  /**
   * Whether a value may be sent to the current deploy target, asking the
   * operator once per dialog session when that target is Phorma Cloud.
   * `explicit` marks a direct "send to the cloud" click, which re-asks after an
   * earlier decline instead of silently doing nothing.
   */
  private async cloudAllowed(explicit: boolean): Promise<boolean> {
    if (this.settings.cloudProvider() !== 'phorma') return true;
    const consent = this.cloudConsent();
    if (consent === true) return true;
    if (consent === false && !explicit) return false;

    const confirmed = await this.confirmDialog.confirm({
      title: 'Store these secrets on Phorma Cloud?',
      message:
        `Secret values you save for "${this.name().trim() || 'this connection'}" will be stored ` +
        `encrypted on Phorma Cloud so your deployed runs can use them - a deployed run cannot ` +
        `read this machine's keychain. Remove them any time from this dialog. Deploying to your ` +
        `own Cloudflare account instead keeps them entirely within your infrastructure.`,
      confirmLabel: 'Store in the cloud',
    });
    this.cloudConsent.set(confirmed);
    return confirmed;
  }

  /** True when the deploy target already holds this secret. */
  protected storedInCloud(secretKey: string): boolean {
    const connectionId = this.savedConnection()?.id;
    if (!connectionId) return false;
    return this.cloudSecretNames().includes(workerSecretName(connectionId, secretKey));
  }

  /** True while this row's value is being written to either store. */
  protected sendingSecret(secretKey: string): boolean {
    return this.busySecret() === secretKey;
  }

  /**
   * True when the deploy target is configured but does not hold this secret,
   * which is exactly the state that makes a deployed run fail to resolve it.
   * Rendered as a badge so the gap is visible before the push reports it.
   */
  protected cloudCopyMissing(secretKey: string): boolean {
    return this.cloudConfigured() && !this.storedInCloud(secretKey);
  }

  /**
   * Sends the drafted value to the deploy target only, so a DEPLOYED run can
   * resolve it. {@link saveSecret} already does this as part of a normal save;
   * this is the retry after a failed send, and the way back in for an operator
   * who declined the Phorma Cloud prompt earlier in the session.
   */
  protected async sendSecretToCloud(secretKey: string): Promise<void> {
    const connectionId = this.savedConnection()?.id;
    const draft = this.secretDrafts()[secretKey];
    if (!connectionId || !draft?.trim() || this.busySecret()) return;

    this.busySecret.set(secretKey);
    try {
      if (!(await this.cloudAllowed(true))) return;
      if (!(await this.sendToCloud(connectionId, secretKey, draft))) return;
      this.toast.success('Secret saved to the cloud', `${secretKey} is available to deployed runs.`);
      if (!this.secretMissingSomewhere(secretKey)) this.discardDraft(secretKey);
    } finally {
      this.busySecret.set(null);
    }
  }

  /** Removes the deploy target's copy, leaving the local one untouched. */
  protected async removeCloudSecret(secretKey: string): Promise<void> {
    const connectionId = this.savedConnection()?.id;
    if (!connectionId) return;
    const confirmed = await this.confirmDialog.confirm({
      title: 'Remove the cloud copy?',
      message:
        `Deployed runs will stop being able to resolve "${secretKey}" and will fail until it ` +
        `is stored again. The copy on this machine is not affected.`,
      confirmLabel: 'Remove',
      tone: 'danger',
    });
    if (!confirmed) return;
    if (await this.cloud.deleteConnectionSecret(connectionId, secretKey)) {
      this.toast.success('Cloud copy removed', secretKey);
      await this.refreshCloudSecrets();
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

/**
 * `existing` plus every secret name the selected auth mode points at, in place
 * and without duplicates.
 *
 * This is what keeps the two halves of the Secrets story in step. `auth` only
 * ever holds a POINTER (which is why `basic` needs two names and the OAuth modes
 * need three); `secretKeys` is the list of fields the store actually holds.
 * Requiring the operator to type `apiKey` in both places, with nothing linking
 * them, made a silent misconfiguration the default outcome. Declaring the
 * pointer's target automatically makes it unreachable through the editor.
 *
 * Names are only ADDED. A key dropped from auth stays declared, because the
 * store may still hold a value for it and silently orphaning that value is
 * worse than one stale row the operator can delete deliberately.
 */
function withAuthSecretKeys(existing: readonly string[], auth: ConnectionAuth): string[] {
  return [...new Set([...existing, ...authSecretKeyNames(auth)])];
}

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
    case 'basic-token':
      return { mode, tokenSecretKey: get('tokenSecretKey') };
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
