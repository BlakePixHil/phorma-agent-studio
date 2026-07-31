import { Injectable, inject } from '@angular/core';

import type { Connection, ConnectionType } from '@phorma/engine';

import { AiEditSessionService } from '../ai-edit-session.service';
import { ConnectionsService } from '../connections.service';
import { LocalAgentRouterService } from '../local-agent-router.service';
import { WorkflowService } from '../workflow.service';
import {
  actionFail,
  actionOk,
  argBool,
  argList,
  argObj,
  argStr,
  type ActionArgs,
  type ActionResult,
  type StudioAction,
} from './studio-action.model';

const CONNECTION_TYPES: readonly ConnectionType[] = [
  'http',
  'oauth2',
  'sql',
  'aws-sigv4',
  'smtp',
];

/**
 * Surface `connections` Studio_Actions (Requirement 2.6).
 *
 * Requirement 6.5: a secret VALUE never appears in an Action_Result. Every
 * payload here reports secret field NAMES plus a per-name presence boolean
 * resolved through `ConnectionsService.secretPresent`, which reads the
 * keychain's existence flag and never the value.
 */
@Injectable({ providedIn: 'root' })
export class ConnectionActionsService {
  private readonly connections = inject(ConnectionsService);
  private readonly workflow = inject(WorkflowService);
  private readonly router = inject(LocalAgentRouterService);
  private readonly session = inject(AiEditSessionService);

  actions(): StudioAction[] {
    return [
      {
        id: 'connection_list',
        label: 'List connections',
        description:
          'Lists stored connections by id, display name and type, with their non-secret config and which secret fields are present. Secret values are never returned.',
        surface: 'connections',
        access: 'read',
        risk: 'silent',
        activity: () => 'Listing connections',
        run: () => this.list(),
      },
      {
        id: 'connection_create',
        label: 'Create a connection',
        description:
          'Creates a connection with non-secret config only. The user must enter secret values themselves in the Connections panel.',
        surface: 'connections',
        access: 'write',
        risk: 'confirm',
        params: {
          name: { type: 'string', description: 'Display name (1-100 characters).', required: true },
          type: {
            type: 'string',
            description: 'Credential family.',
            required: true,
            enum: CONNECTION_TYPES,
          },
          config: {
            type: 'object',
            description:
              'Non-secret config as string values: baseUrl, host, port, database, tokenUrl, region, driver.',
          },
          secretKeys: {
            type: 'string[]',
            description: 'Secret field NAMES the connection declares (never values).',
          },
          allowWrites: {
            type: 'boolean',
            description: 'Opt in to write operations (SQL). Defaults to false.',
          },
        },
        confirmSummary: args =>
          `Create the ${argStr(args, 'type') ?? ''} connection "${argStr(args, 'name') ?? ''}"? You will need to enter its secret values in the Connections panel.`,
        activity: args => `Creating connection "${argStr(args, 'name') ?? ''}"`,
        run: args => this.create(args),
      },
      {
        id: 'connection_update',
        label: 'Update a connection',
        description:
          "Updates a connection's non-secret fields: name, type, config, declared secret key names and the write opt-in. Secret values are never accepted here.",
        surface: 'connections',
        access: 'write',
        risk: 'confirm',
        params: {
          connectionId: { type: 'string', description: 'Connection id.', required: true },
          name: { type: 'string', description: 'New display name.' },
          type: { type: 'string', description: 'New credential family.', enum: CONNECTION_TYPES },
          config: { type: 'object', description: 'Replacement non-secret config.' },
          secretKeys: { type: 'string[]', description: 'Replacement secret field NAMES.' },
          allowWrites: { type: 'boolean', description: 'Write opt-in.' },
        },
        confirmSummary: args =>
          `Update connection "${this.connectionName(argStr(args, 'connectionId'))}"? Workflows using it pick up the change on their next run.`,
        activity: args =>
          `Updating connection "${this.connectionName(argStr(args, 'connectionId'))}"`,
        run: args => this.update(args),
      },
      {
        id: 'connection_delete',
        label: 'Delete a connection',
        description:
          'Deletes a connection and its stored secrets. Workflows still referencing it will fail until they are pointed at another connection.',
        surface: 'connections',
        access: 'write',
        risk: 'confirm',
        params: {
          connectionId: { type: 'string', description: 'Connection id.', required: true },
        },
        confirmSummary: args => {
          const id = argStr(args, 'connectionId');
          const referencing = id ? this.connections.referencingWorkflows(id) : [];
          const used = referencing.length
            ? `\n\nUsed by: ${referencing.map(item => item.name).join(', ')}.`
            : '';
          return `Delete connection "${this.connectionName(id)}" and its stored secrets? This cannot be undone.${used}`;
        },
        activity: args =>
          `Deleting connection "${this.connectionName(argStr(args, 'connectionId'))}"`,
        run: args => this.remove(args),
      },
      {
        id: 'connection_assign_node',
        label: 'Assign a connection to a node',
        description:
          'Points a data node (HTTP request, SQL query, notify) at a stored connection by setting its connectionId.',
        surface: 'connections',
        access: 'write',
        risk: 'silent',
        graphEdit: true,
        params: {
          connectionId: { type: 'string', description: 'Connection id.', required: true },
          nodeId: { type: 'string', description: 'Node id.', required: true },
        },
        activity: args =>
          `Assigning connection "${this.connectionName(argStr(args, 'connectionId'))}"`,
        run: args => this.assign(args),
      },
    ];
  }

  // ── Executors ────────────────────────────────────────────────────────────

  private async list(): Promise<ActionResult> {
    await this.connections.refresh();
    const rows = await Promise.all(
      this.connections.connections().map(async connection => ({
        id: connection.id,
        name: connection.name,
        type: connection.type,
        config: connection.config,
        authMode: connection.auth.mode,
        allowWrites: connection.allowWrites ?? false,
        secrets: await this.secretFlags(connection),
        usedBy: this.connections.referencingWorkflows(connection.id).map(item => item.name),
      })),
    );
    return actionOk({ connections: rows, secretsSupported: this.connections.secretsSupported });
  }

  private async create(args: ActionArgs): Promise<ActionResult> {
    const name = argStr(args, 'name');
    const type = argStr(args, 'type') as ConnectionType | undefined;
    if (!name) return actionFail('Missing the connection name.');
    if (!type) return actionFail('Missing the connection type.');
    try {
      const connection = await this.connections.create({
        name,
        type,
        config: toStringMap(argObj(args, 'config')),
        secretKeys: argList(args, 'secretKeys') ?? [],
        ...(argBool(args, 'allowWrites') ? { allowWrites: true } : {}),
      });
      return actionOk(
        { connectionId: connection.id, name: connection.name },
        {
          revertable: false,
          message: connection.secretKeys.length
            ? `Created "${connection.name}"; enter its secret values in the Connections panel.`
            : `Created "${connection.name}".`,
        },
      );
    } catch (error) {
      return actionFail(messageOf(error));
    }
  }

  private async update(args: ActionArgs): Promise<ActionResult> {
    const connectionId = argStr(args, 'connectionId');
    if (!connectionId) return actionFail('Missing the connection id.');
    await this.connections.refresh();
    if (!this.connections.connections().some(item => item.id === connectionId)) {
      return actionFail(`Connection '${connectionId}' was not found.`);
    }
    const config = argObj(args, 'config');
    const secretKeys = argList(args, 'secretKeys');
    const allowWrites = argBool(args, 'allowWrites');
    const name = argStr(args, 'name');
    const type = argStr(args, 'type') as ConnectionType | undefined;
    if (
      name === undefined &&
      type === undefined &&
      config === undefined &&
      secretKeys === undefined &&
      allowWrites === undefined
    ) {
      return actionFail('Nothing to update: pass name, type, config, secretKeys or allowWrites.');
    }
    try {
      const updated = await this.connections.update(connectionId, {
        ...(name ? { name } : {}),
        ...(type ? { type } : {}),
        ...(config ? { config: toStringMap(config) } : {}),
        ...(secretKeys ? { secretKeys } : {}),
        ...(allowWrites === undefined ? {} : { allowWrites }),
      });
      return actionOk({ connectionId: updated.id, name: updated.name }, { revertable: false });
    } catch (error) {
      return actionFail(messageOf(error));
    }
  }

  private async remove(args: ActionArgs): Promise<ActionResult> {
    const connectionId = argStr(args, 'connectionId');
    if (!connectionId) return actionFail('Missing the connection id.');
    await this.connections.refresh();
    const connection = this.connections.connections().find(item => item.id === connectionId);
    if (!connection) return actionFail(`Connection '${connectionId}' was not found.`);
    try {
      await this.connections.remove(connectionId);
    } catch (error) {
      return actionFail(messageOf(error));
    }
    return actionOk({ connectionId, name: connection.name }, { revertable: false });
  }

  private async assign(args: ActionArgs): Promise<ActionResult> {
    const connectionId = argStr(args, 'connectionId');
    const nodeId = argStr(args, 'nodeId');
    if (!connectionId) return actionFail('Missing the connection id.');
    if (!nodeId) return actionFail('Missing the node id.');
    await this.connections.refresh();
    const connection = this.connections.connections().find(item => item.id === connectionId);
    if (!connection) return actionFail(`Connection '${connectionId}' was not found.`);
    const node = this.workflow.graph().nodes.find(item => item.id === nodeId);
    if (!node) return actionFail(`Node '${nodeId}' is not on the canvas.`);
    const data = node.data as Record<string, unknown> | undefined;
    if (!data || !('connectionId' in data)) {
      return actionFail(`Nodes of kind '${node.kind}' do not use a connection.`);
    }
    const patch: { data?: object } = { data: { ...data, connectionId } };
    const result = this.router.updateNode(nodeId, patch);
    if (!result.ok) return actionFail(result.error ?? 'Failed to assign the connection.');
    this.session.record(`Pointed ${node.name} at connection "${connection.name}"`);
    return actionOk({ nodeId, connectionId }, { revertable: true });
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  /** Secret field names with a presence flag - never a value. */
  private async secretFlags(connection: Connection): Promise<Record<string, boolean>> {
    const flags: Record<string, boolean> = {};
    for (const key of connection.secretKeys) {
      flags[key] = await this.connections
        .secretPresent(connection.id, key)
        .catch(() => false);
    }
    return flags;
  }

  private connectionName(connectionId: string | undefined): string {
    if (!connectionId) return 'the connection';
    return (
      this.connections.connections().find(item => item.id === connectionId)?.name ?? connectionId
    );
  }
}

/** Coerces an arbitrary object argument into the string map connections store. */
function toStringMap(value: Record<string, unknown> | undefined): Record<string, string> {
  if (!value) return {};
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry === null || entry === undefined) continue;
    out[key] = typeof entry === 'string' ? entry : String(entry);
  }
  return out;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
