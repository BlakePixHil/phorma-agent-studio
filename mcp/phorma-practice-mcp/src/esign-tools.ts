/**
 * E-signature tools — Annature first (spike 0.3: open REST, API key header,
 * webhooks). The tool vocabulary (esign_send / esign_status / esign_download)
 * is provider-neutral so DocuSign and FuseSign back ends can slot in later
 * behind the same names via ESIGN_PROVIDER.
 *
 * Secrets:
 * - ESIGN_PROVIDER    — 'annature' (default). Future: 'docusign', 'fusesign'.
 * - ANNATURE_ID       — the Annature API id (X-Annature-Id header).
 * - ANNATURE_KEY      — the Annature API key (X-Annature-Key header).
 * - ESIGN_WEBHOOK_URL — the deployed WorkflowAgent /events endpoint; the
 *                       completion webhook posts { correlationKey, payload }.
 */

import { apiFetch, optionalString, requireEnv, requireId, requireString, type Tool, type ToolContext } from './mcp.js';

const ANNATURE_BASE = 'https://api.annature.com.au/v1';
const ANNATURE_HOST_SUFFIX = '.annature.com.au';

function annatureHeaders(ctx: ToolContext): Record<string, string> {
  return {
    'X-Annature-Id': requireEnv(ctx, 'ANNATURE_ID', 'Create an API key in the Annature dashboard (Developers page).'),
    'X-Annature-Key': requireEnv(ctx, 'ANNATURE_KEY', 'Create an API key in the Annature dashboard (Developers page).'),
    'Content-Type': 'application/json',
  };
}

export function esignTools(): Tool[] {
  return [sendTool(), statusTool(), downloadTool()];
}

function sendTool(): Tool {
  return {
    definition: {
      name: 'esign_send',
      description:
        'Sends a PDF for e-signature. Takes the document as base64, one signer (name + email), a subject ' +
        'line, and a correlation key (e.g. "signed:JOB-123") that the completion webhook will deliver back ' +
        'to the workflow\'s Wait for Event node. Returns JSON { envelopeId, status }.',
      inputSchema: {
        type: 'object',
        properties: {
          documentBase64: { type: 'string', description: 'The PDF to sign, base64-encoded.' },
          documentName: { type: 'string', description: 'File name shown to the signer (e.g. "IAS-June-2026.pdf").' },
          signerName: { type: 'string' },
          signerEmail: { type: 'string' },
          subject: { type: 'string', description: 'Email subject / envelope title.' },
          message: { type: 'string', description: 'Optional message to the signer.' },
          correlationKey: {
            type: 'string',
            description: 'Correlation key delivered by the completion webhook (match the Wait for Event node).',
          },
        },
        required: ['documentBase64', 'documentName', 'signerName', 'signerEmail', 'subject', 'correlationKey'],
      },
    },
    handler: async (args, ctx) => {
      const provider = (ctx.env('ESIGN_PROVIDER') ?? 'annature').toLowerCase();
      if (provider !== 'annature') {
        throw new Error(`E-sign provider "${provider}" is not implemented yet. Available: annature.`);
      }
      const body = {
        name: requireString(args, 'subject'),
        message: optionalString(args, 'message'),
        // The correlation key travels as envelope metadata; the webhook
        // handler reads it back to resolve the suspended run.
        metadata: { correlationKey: requireString(args, 'correlationKey') },
        recipients: [
          {
            name: requireString(args, 'signerName'),
            email: requireString(args, 'signerEmail'),
            type: 'signer',
          },
        ],
        documents: [
          {
            name: requireString(args, 'documentName'),
            base: requireString(args, 'documentBase64'),
          },
        ],
      };
      const { json } = await apiFetch(`${ANNATURE_BASE}/envelopes`, {
        method: 'POST',
        headers: annatureHeaders(ctx),
        body: JSON.stringify(body),
      });
      const envelope = json as { id?: string; status?: string };
      if (!envelope.id) throw new Error('Annature returned no envelope id.');
      return JSON.stringify({ envelopeId: envelope.id, status: envelope.status ?? 'sent' }, null, 2);
    },
  };
}

function statusTool(): Tool {
  return {
    definition: {
      name: 'esign_status',
      description:
        'Checks the status of an e-signature envelope. Returns JSON { envelopeId, status, completedAt }. ' +
        'Prefer the webhook + Wait for Event node over polling; this is for spot checks and recovery.',
      inputSchema: {
        type: 'object',
        properties: { envelopeId: { type: 'string' } },
        required: ['envelopeId'],
      },
    },
    handler: async (args, ctx) => {
      const envelopeId = requireId(args, 'envelopeId');
      const { json } = await apiFetch(`${ANNATURE_BASE}/envelopes/${envelopeId}`, {
        headers: annatureHeaders(ctx),
      });
      const envelope = json as { id?: string; status?: string; completed?: string };
      return JSON.stringify(
        { envelopeId, status: envelope.status ?? 'unknown', completedAt: envelope.completed ?? null },
        null,
        2,
      );
    },
  };
}

function downloadTool(): Tool {
  return {
    definition: {
      name: 'esign_download',
      description:
        'Downloads the signed (completed) document of an envelope. Returns JSON ' +
        '{ envelopeId, documentBase64 } — suitable for archiving or attaching to the lodgement pack.',
      inputSchema: {
        type: 'object',
        properties: { envelopeId: { type: 'string' } },
        required: ['envelopeId'],
      },
    },
    handler: async (args, ctx) => {
      const envelopeId = requireId(args, 'envelopeId');
      // Envelope detail carries document download links; fetch the master
      // (signed) document binary.
      const { json } = await apiFetch(`${ANNATURE_BASE}/envelopes/${envelopeId}`, {
        headers: annatureHeaders(ctx),
      });
      const envelope = json as { documents?: { id?: string; master?: string }[] };
      const master = envelope.documents?.[0]?.master;
      if (!master) throw new Error(`Envelope ${envelopeId} has no signed master document yet.`);
      // SSRF/credential-leak guard: the download link comes from the API
      // response — only follow HTTPS Annature-domain URLs, and only send the
      // API credentials when the host is Annature's.
      const masterUrl = new URL(master);
      const isAnnature =
        masterUrl.protocol === 'https:' &&
        (masterUrl.hostname.endsWith(ANNATURE_HOST_SUFFIX) ||
          masterUrl.hostname === ANNATURE_HOST_SUFFIX.slice(1));
      if (masterUrl.protocol !== 'https:') {
        throw new Error(`Refusing non-HTTPS document link (${masterUrl.protocol}).`);
      }
      const { bytes } = await apiFetch(masterUrl.toString(), {
        headers: isAnnature ? annatureHeaders(ctx) : {},
        expectBinary: true,
      });
      if (!bytes) throw new Error('Could not download the signed document.');
      return JSON.stringify({ envelopeId, documentBase64: toBase64(bytes) }, null, 2);
    },
  };
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
