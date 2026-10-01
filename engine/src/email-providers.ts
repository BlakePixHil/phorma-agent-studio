/**
 * Email provider adapters for the `notify` step's `email` channel (G4).
 *
 * The engine never speaks SMTP: an email is an HTTPS request to a provider
 * API, built here from a provider-neutral {@link OutboundEmail}. An adapter
 * only DESCRIBES the request (url, headers, body); the engine sends it through
 * the host's `DataFetcher`, so retry, redaction, timeouts and connection auth
 * stay exactly as they are for every other data step.
 *
 * The adapter is chosen by `Connection.config.emailProvider`; absent means
 * `generic-json`, which keeps the original `{to, subject, body}` contract
 * byte-identical when none of the newer fields is set.
 *
 * Adding a provider (SendGrid, Postmark) is one entry in `EMAIL_PROVIDERS`.
 * A binding-based transport such as Cloudflare Email Service would be an
 * adapter whose host performs the send; the description-only interface leaves
 * room for that without the engine importing a platform API.
 */

import type { ResolvedConnection } from './connections.js';
import { joinUrl as joinUrlPath } from './data-http.js';
import { EMAIL_PROVIDER_IDS, type EmailProviderId } from './delivery-limits.js';
import { markdownToHtml } from './markdown-blocks.js';

export { EMAIL_PROVIDER_IDS, type EmailProviderId };

/** One attachment, already base64-encoded. */
export interface EmailAttachment {
  fileName: string;
  mimeType: string;
  /** Standard base64 of the bytes. */
  content: string;
}

/** A provider-neutral message. Every address list is already split and trimmed. */
export interface OutboundEmail {
  /** The recipient template exactly as rendered (the `generic-json` contract). */
  toText: string;
  to: string[];
  cc: string[];
  from?: string;
  replyTo?: string;
  subject?: string;
  /** The rendered body template. */
  body: string;
  /** Absent = the adapter's default. */
  bodyFormat?: 'markdown' | 'html' | 'text';
  attachments: EmailAttachment[];
  idempotencyKey?: string;
}

/** What an adapter returns: the request to send, minus auth (the engine applies it). */
export interface EmailRequestDescription {
  url: string;
  headers: Record<string, string>;
  body: string;
}

export interface EmailProviderAdapter {
  readonly id: EmailProviderId;
  readonly label: string;
  /** True when the provider refuses a message without a sender. */
  readonly requiresSender: boolean;
  /** Builds the request, or throws an authoring error naming what is missing. */
  build(email: OutboundEmail, conn: ResolvedConnection | undefined): EmailRequestDescription;
}


/** The connection's configured endpoint: `notifyUrl`, else `baseUrl` + `notifyPath`, else `baseUrl`. */
export function configuredEmailEndpoint(conn: ResolvedConnection | undefined): string {
  const config = conn?.config ?? {};
  const notifyUrl = (config['notifyUrl'] ?? '').trim();
  if (notifyUrl) return notifyUrl;
  const baseUrl = (config['baseUrl'] ?? '').trim();
  const notifyPath = (config['notifyPath'] ?? '').trim();
  if (baseUrl && notifyPath) return joinUrlPath(baseUrl, notifyPath);
  return baseUrl;
}

const GENERIC_JSON: EmailProviderAdapter = {
  id: 'generic-json',
  label: 'Generic JSON webhook',
  requiresSender: false,
  build(email, conn) {
    // The original contract first, in the original key order, so a step that
    // uses none of the newer fields sends exactly the bytes it always did.
    const message: Record<string, unknown> = {
      ...(email.toText.length > 0 ? { to: email.toText } : {}),
      ...(email.subject !== undefined ? { subject: email.subject } : {}),
      body: email.body,
    };
    if (email.from) message['from'] = email.from;
    if (email.replyTo) message['replyTo'] = email.replyTo;
    if (email.cc.length > 0) message['cc'] = email.cc;
    if (email.bodyFormat) {
      message['bodyFormat'] = email.bodyFormat;
      if (email.bodyFormat === 'markdown') message['html'] = markdownToHtml(email.body);
    }
    if (email.attachments.length > 0) message['attachments'] = email.attachments;
    return {
      url: configuredEmailEndpoint(conn),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(message),
    };
  },
};

/** Resend REST API: https://resend.com/docs/api-reference/emails/send-email */
const RESEND: EmailProviderAdapter = {
  id: 'resend',
  label: 'Resend',
  requiresSender: true,
  build(email, conn) {
    const from = email.from || (conn?.config['defaultFrom'] ?? '').trim();
    if (!from) {
      throw new Error(
        'Resend needs a sender: set "From" on the step or "defaultFrom" on the connection ' +
          '(an address on a domain verified in Resend).',
      );
    }
    if (email.to.length === 0) throw new Error('Resend needs at least one recipient.');
    const format = email.bodyFormat ?? 'markdown';
    const message: Record<string, unknown> = {
      from,
      to: email.to,
      subject: email.subject ?? '',
    };
    if (email.cc.length > 0) message['cc'] = email.cc;
    if (email.replyTo) message['reply_to'] = email.replyTo;
    if (format === 'text') {
      message['text'] = email.body;
    } else if (format === 'html') {
      message['html'] = email.body;
    } else {
      message['html'] = markdownToHtml(email.body);
      message['text'] = email.body;
    }
    if (email.attachments.length > 0) {
      message['attachments'] = email.attachments.map(attachment => ({
        filename: attachment.fileName,
        content: attachment.content,
        content_type: attachment.mimeType,
      }));
    }
    const config = conn?.config ?? {};
    const url =
      (config['notifyUrl'] ?? '').trim() ||
      joinUrlPath(
        (config['baseUrl'] ?? '').trim() || 'https://api.resend.com',
        (config['notifyPath'] ?? '').trim() || '/emails',
      );
    return {
      url,
      headers: {
        'Content-Type': 'application/json',
        ...(email.idempotencyKey ? { 'Idempotency-Key': email.idempotencyKey } : {}),
      },
      body: JSON.stringify(message),
    };
  },
};

export const EMAIL_PROVIDERS: Readonly<Record<EmailProviderId, EmailProviderAdapter>> = {
  'generic-json': GENERIC_JSON,
  resend: RESEND,
};

/** The adapter a connection selects. Throws for an unknown provider id. */
export function emailProviderFor(conn: ResolvedConnection | undefined): EmailProviderAdapter {
  const id = (conn?.config['emailProvider'] ?? '').trim();
  if (id.length === 0) return GENERIC_JSON;
  const adapter = (EMAIL_PROVIDERS as Readonly<Record<string, EmailProviderAdapter>>)[id];
  if (!adapter) {
    throw new Error(
      `Connection "${conn?.id ?? ''}" names email provider "${id}", which is not one of ` +
        `${EMAIL_PROVIDER_IDS.join(', ')}.`,
    );
  }
  return adapter;
}

/** Splits a comma or semicolon separated address list, dropping blanks. */
export function splitAddresses(raw: string): string[] {
  return raw
    .split(/[,;]/)
    .map(address => address.trim())
    .filter(address => address.length > 0);
}
