/**
 * Xero Practice Manager (XPM) tools — jobs and clients.
 *
 * SCOPE NOTE (spike 0.1): the public XPM API covers jobs/clients/etc. but
 * NOT tax returns or Activity Statement lodgement — entering IAS figures,
 * approving, exporting the official PDF, and lodging to the ATO are UI-only.
 * These tools therefore cover the job-list and job-state halves of the IAS
 * workflow; the lodgement itself is a human checkpoint fed by a prepared
 * pack (see ias-tools.ts).
 *
 * Base: https://api.xero.com/practicemanager/3.1/ (same OAuth token as the
 * broker; XPM scopes require Xero App Partner registration).
 */

import { optionalString, requireId, requireString, type Tool } from './mcp.js';
import { XeroBroker, xeroRequest } from './xero-auth.js';

const XPM_BASE = 'https://api.xero.com/practicemanager/3.1';

export function xpmTools(broker: XeroBroker, practiceTenantId: () => string | undefined): Tool[] {
  return [listOpenJobsTool(broker, practiceTenantId), getClientTool(broker, practiceTenantId), updateJobStateTool(broker, practiceTenantId)];
}

function tenantOrThrow(practiceTenantId: () => string | undefined): string {
  const tenantId = practiceTenantId();
  if (!tenantId) {
    throw new Error(
      'XPM_PRACTICE_TENANT_ID is not configured. Set it to the PRACTICEMANAGER tenant id from xero_list_entities.',
    );
  }
  return tenantId;
}

function listOpenJobsTool(broker: XeroBroker, practiceTenantId: () => string | undefined): Tool {
  return {
    definition: {
      name: 'xpm_list_open_jobs',
      description:
        'Lists current (open) jobs in Xero Practice Manager, optionally filtered by a name/description ' +
        'substring (e.g. "IAS"). Returns JSON [{ jobId, name, state, clientName, clientId, dueDate }]. ' +
        'Use to find last month\'s open IAS jobs at the start of the run.',
      inputSchema: {
        type: 'object',
        properties: {
          filter: { type: 'string', description: 'Case-insensitive substring to match in job name (e.g. "IAS").' },
        },
      },
    },
    handler: async (args, ctx) => {
      const tenantId = tenantOrThrow(practiceTenantId);
      const filter = optionalString(args, 'filter')?.toLowerCase();
      const json = (await xeroRequest(broker, ctx, tenantId, `${XPM_BASE}/job.api/current`, {
        headers: { Accept: 'application/json' },
      })) as {
        Jobs?: { Job?: XpmJob[] } | XpmJob[];
      };
      const raw = Array.isArray(json.Jobs) ? json.Jobs : (json.Jobs?.Job ?? []);
      const jobs = raw
        .filter(job => !filter || (job.Name ?? '').toLowerCase().includes(filter))
        .map(job => ({
          jobId: job.ID ?? job.UUID,
          name: job.Name,
          state: job.State,
          clientName: job.Client?.Name,
          clientId: job.Client?.ID ?? job.Client?.UUID,
          dueDate: job.DueDate?.slice(0, 10),
        }));
      return JSON.stringify(jobs, null, 2);
    },
  };
}

interface XpmJob {
  ID?: string;
  UUID?: string;
  Name?: string;
  State?: string;
  DueDate?: string;
  Client?: { ID?: string; UUID?: string; Name?: string };
}

function getClientTool(broker: XeroBroker, practiceTenantId: () => string | undefined): Tool {
  return {
    definition: {
      name: 'xpm_get_client',
      description:
        'Fetches an XPM client\'s details: name, contacts (with emails), and custom fields. The custom ' +
        'fields conventionally carry the linked Xero organisation name/tenant and the responsible person ' +
        'for signing. Returns JSON { name, contacts: [{ name, email, position }], customFields: { ... } }.',
      inputSchema: {
        type: 'object',
        properties: {
          clientId: { type: 'string', description: 'The XPM client UUID (from xpm_list_open_jobs).' },
        },
        required: ['clientId'],
      },
    },
    handler: async (args, ctx) => {
      const tenantId = tenantOrThrow(practiceTenantId);
      // requireId blocks path injection — the id lands in the URL path.
      const clientId = requireId(args, 'clientId');
      const json = (await xeroRequest(broker, ctx, tenantId, `${XPM_BASE}/client.api/get/${clientId}`, {
        headers: { Accept: 'application/json' },
      })) as { Clients?: { Client?: XpmClient } | XpmClient };
      const client: XpmClient | undefined = (json.Clients as { Client?: XpmClient })?.Client ?? (json.Clients as XpmClient);
      if (!client) throw new Error(`XPM client ${clientId} not found.`);
      const contactsRaw = Array.isArray(client.Contacts?.Contact)
        ? client.Contacts.Contact
        : client.Contacts?.Contact
          ? [client.Contacts.Contact]
          : [];
      return JSON.stringify(
        {
          name: client.Name,
          contacts: contactsRaw.map(contact => ({
            name: contact.Name,
            email: contact.Email,
            position: contact.Position,
          })),
        },
        null,
        2,
      );
    },
  };
}

interface XpmClient {
  Name?: string;
  Contacts?: { Contact?: XpmContact | XpmContact[] };
}
interface XpmContact {
  Name?: string;
  Email?: string;
  Position?: string;
}

function updateJobStateTool(broker: XeroBroker, practiceTenantId: () => string | undefined): Tool {
  return {
    definition: {
      name: 'xpm_update_job_state',
      description:
        'Updates a job\'s state in XPM (e.g. to "Completed" once the IAS has been lodged). ' +
        'Returns JSON { ok, jobId, state }.',
      inputSchema: {
        type: 'object',
        properties: {
          jobId: { type: 'string', description: 'The XPM job UUID.' },
          state: { type: 'string', description: 'The target state name as configured in the practice (e.g. "Completed").' },
        },
        required: ['jobId', 'state'],
      },
    },
    handler: async (args, ctx) => {
      const tenantId = tenantOrThrow(practiceTenantId);
      const jobId = requireId(args, 'jobId');
      const state = requireString(args, 'state');
      const xml = `<Job><ID>${escapeXml(jobId)}</ID><State>${escapeXml(state)}</State></Job>`;
      await xeroRequest(broker, ctx, tenantId, `${XPM_BASE}/job.api/state`, {
        method: 'PUT',
        headers: { 'Content-Type': 'text/xml', Accept: 'application/json' },
        body: xml,
      });
      return JSON.stringify({ ok: true, jobId, state });
    },
  };
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
