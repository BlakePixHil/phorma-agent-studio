/**
 * The step bodies of the document-delivery primitives, loaded lazily by the
 * engine (one dynamic `import()` per run that uses them). Everything here is a
 * pure function of its inputs plus the small {@link DeliveryHost} the engine
 * hands over, so the engine keeps sole ownership of claims, artifact caps,
 * events and retries while the bulky assembly code stays out of every host's
 * initial bundle.
 */

import type { ResolvedConnection } from './connections.js';
import type { ArtifactRef, StateEntry, StoredArtifact } from './data-host.js';
import { EMAIL_ATTACHMENTS_MAX_BYTES } from './delivery-limits.js';
import { encodeBase64, sanitizeArtifactName } from './artifacts.js';
import { emailProviderFor, splitAddresses, type EmailAttachment } from './email-providers.js';
import type { Json } from './expr.js';
import { encodeMultipart, type EncodedMultipart, type MultipartPart } from './multipart.js';
import { renderMarkdownPdf } from './pdf.js';
import { reservedStateNamespaceOf, unscopeStateKey } from './state.js';
import type {
  HttpRequestNodeData,
  NotifyNodeData,
  RenderDocumentNodeData,
  WorkflowNode,
} from './types.js';

/** What a step body needs from the engine. */
export interface DeliveryHost {
  /** Template interpolation against the payload and the frame's variables. */
  render(template: string, payload: string): string;
  /** Artifact references at payload paths; errors name the step. */
  artifactRefsAt(node: WorkflowNode, payload: string, paths: readonly string[]): ArtifactRef[];
  /** One artifact of this run; a missing one is an error. */
  readArtifact(node: WorkflowNode, ref: ArtifactRef): Promise<StoredArtifact>;
}

/** The email request, minus auth, plus what the trace reports about attachments. */
export interface EmailRequestParts {
  url: string;
  headers: Record<string, string>;
  body: string;
  attachments: number;
  omitted: number;
}

/**
 * Builds an email step's provider request: loads attachments under the size
 * cap, assembles the provider-neutral message and lets the connection's
 * adapter shape it.
 */
export async function buildEmailRequest(
  host: DeliveryHost,
  node: WorkflowNode,
  payload: string,
  message: {
    to: string;
    subject: string | undefined;
    body: string;
    idempotencyKey: string | undefined;
    attachmentPaths: readonly string[];
    conn: ResolvedConnection | undefined;
  },
): Promise<EmailRequestParts> {
  const data = (node.data ?? {}) as NotifyNodeData;
  const adapter = emailProviderFor(message.conn);
  const loaded = await loadAttachments(host, node, data, message.attachmentPaths, payload);
  const optional = (template: string | undefined): string | undefined => {
    const rendered = host.render(template ?? '', payload).trim();
    return rendered.length > 0 ? rendered : undefined;
  };
  const described = adapter.build(
    {
      toText: message.to,
      to: splitAddresses(message.to),
      cc: splitAddresses(host.render(data.cc ?? '', payload)),
      from: optional(data.from),
      replyTo: optional(data.replyTo),
      subject: message.subject,
      body: message.body,
      bodyFormat: data.bodyFormat,
      attachments: loaded.attachments,
      idempotencyKey: message.idempotencyKey,
    },
    message.conn,
  );
  const url = described.url.trim();
  if (!url) {
    throw new Error(
      `Step "${node.name}" has no notification endpoint: set ` +
        `${message.conn ? `a "baseUrl" on connection "${message.conn.id}"` : 'a connection'}.`,
    );
  }
  if (!/^https?:\/\//i.test(url)) {
    throw new Error(
      `Step "${node.name}" cannot deliver to "${url}": a notification endpoint must be ` +
        'an http or https url.',
    );
  }
  return {
    url,
    headers: { ...described.headers },
    body: described.body,
    attachments: loaded.attachments.length,
    omitted: loaded.omitted,
  };
}

/**
 * Attachment paths to base64 attachments under the total size cap: a `fail`
 * step (the default) fails before anything is sent, a `truncate` step keeps
 * attachments in order until the next would exceed the cap and reports how
 * many it dropped.
 */
async function loadAttachments(
  host: DeliveryHost,
  node: WorkflowNode,
  data: NotifyNodeData,
  paths: readonly string[],
  payload: string,
): Promise<{ attachments: EmailAttachment[]; omitted: number }> {
  if (paths.length === 0) return { attachments: [], omitted: 0 };
  const refs = host.artifactRefsAt(node, payload, paths);
  const attachments: EmailAttachment[] = [];
  let total = 0;
  for (let index = 0; index < refs.length; index += 1) {
    const ref = refs[index]!;
    if (total + ref.sizeBytes > EMAIL_ATTACHMENTS_MAX_BYTES) {
      if (data.attachmentLimit === 'truncate') return { attachments, omitted: refs.length - index };
      throw new Error(
        `Step "${node.name}" would attach ${refs.length} files totalling more than ` +
          `${EMAIL_ATTACHMENTS_MAX_BYTES} bytes. Attach fewer, or set the limit to truncate.`,
      );
    }
    const stored = await host.readArtifact(node, ref);
    total += stored.bytes.length;
    attachments.push({
      fileName: stored.ref.name,
      mimeType: stored.ref.mimeType,
      content: encodeBase64(stored.bytes),
    });
  }
  return { attachments, omitted: 0 };
}

/** Builds a `multipart/form-data` body from text fields and artifact files. */
export async function buildMultipartBody(
  host: DeliveryHost,
  node: WorkflowNode,
  payload: string,
): Promise<EncodedMultipart> {
  const config = (node.data as HttpRequestNodeData).multipart ?? {};
  const parts: MultipartPart[] = [];
  for (const field of config.fields ?? []) {
    const name = (field?.name ?? '').trim();
    if (name.length === 0) continue;
    parts.push({ kind: 'field', name, value: host.render(field.value ?? '', payload) });
  }
  for (const file of config.files ?? []) {
    const name = (file?.name ?? '').trim();
    const path = (file?.artifact ?? '').trim();
    if (name.length === 0 || path.length === 0) continue;
    for (const ref of host.artifactRefsAt(node, payload, [path])) {
      const stored = await host.readArtifact(node, ref);
      const override = host.render(file.fileName ?? '', payload).trim();
      parts.push({
        kind: 'file',
        name,
        fileName: override.length > 0 ? override.replace(/[\r\n"]/g, ' ') : stored.ref.name,
        mimeType: stored.ref.mimeType,
        bytes: stored.bytes,
      });
    }
  }
  if (parts.length === 0) throw new Error(`Step "${node.name}" sends a multipart body with no parts.`);
  return encodeMultipart(parts);
}

/** Renders a render-document step's markdown to a named PDF. */
export function renderDocumentFile(
  host: Pick<DeliveryHost, 'render'>,
  node: WorkflowNode,
  payload: string,
): { name: string; bytes: Uint8Array } {
  const data = (node.data ?? {}) as RenderDocumentNodeData;
  if ((data.format ?? 'pdf') !== 'pdf') {
    throw new Error(`Step "${node.name}" declares format "${data.format}"; only pdf is supported.`);
  }
  const markdown = host.render(data.markdown ?? '', payload);
  if (markdown.trim().length === 0) {
    throw new Error(`Step "${node.name}" rendered empty markdown; there is nothing to put in the document.`);
  }
  const name = sanitizeArtifactName(host.render(data.fileName ?? '', payload), 'pdf');
  const title = host.render(data.title ?? '', payload).trim();
  try {
    return {
      name,
      bytes: renderMarkdownPdf(markdown, { title: title || undefined, layout: data.layout }).bytes,
    };
  } catch (error) {
    throw new Error(`Step "${node.name}": ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Store entries under a scoped prefix shaped for the payload: unscoped keys,
 * values parsed as JSON when they parse, ISO dates, reserved namespaces
 * dropped, and the list cut at `maxChars` of JSON.
 */
export function shapeStateEntries(
  listed: readonly StateEntry[],
  scopedPrefix: string,
  maxChars: number,
): { entries: Json[]; truncated: boolean } {
  const entries: Json[] = [];
  let size = 2;
  for (const entry of listed) {
    const key = unscopeStateKey(entry.key);
    if (reservedStateNamespaceOf(key) || !entry.key.startsWith(scopedPrefix)) continue;
    const item: Json = {
      key,
      value: parseOrText(entry.value),
      updatedAt: isoOrNull(entry.updatedAt),
      expiresAt: isoOrNull(entry.expiresAt),
    };
    const itemSize = JSON.stringify(item).length + 1;
    if (size + itemSize > maxChars) return { entries, truncated: true };
    size += itemSize;
    entries.push(item);
  }
  return { entries, truncated: false };
}

function parseOrText(value: string): Json {
  try {
    return JSON.parse(value) as Json;
  } catch {
    return value;
  }
}

/** Epoch milliseconds as an ISO string, or null when absent or invalid. */
function isoOrNull(epochMs: number | undefined): string | null {
  if (typeof epochMs !== 'number' || !Number.isFinite(epochMs)) return null;
  const date = new Date(epochMs);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
