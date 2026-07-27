/**
 * Portal contract (EPIC 9) - the shared rail between the studio and the
 * cloud worker for published endpoints.
 *
 * Three concerns live here, all pure:
 *
 * 1. **Validation** - {@link validatePortal} is the single source of truth for
 *    "can this workflow be published?". The studio runs it to render the
 *    Portal panel's checklist; the worker runs it again at publish time so a
 *    hand-crafted spec can't bypass the UI.
 * 2. **Responder resolution** - {@link resolveResponderNodeId} decides whose
 *    tokens the visitor is allowed to see. Everything else is withheld, so
 *    intermediate agents' reasoning never reaches the public.
 * 3. **Input envelope** - {@link buildPortalInput} serializes a visitor turn
 *    into the engine's single `input: string` channel. Because the payload is
 *    JSON, `interpolatePayload` resolves `{{message}}`, `{{history}}` and
 *    `{{fields.x}}` with no engine changes.
 *
 * Pure TypeScript, zero framework dependencies - same rules as the rest of
 * the engine package.
 */

import type {
  PortalAccess,
  PortalField,
  PortalMode,
  PortalTriggerData,
  WorkflowGraph,
  WorkflowNode,
} from './types.js';

/** Node kind of the canvas-visible "this workflow is published" declaration. */
export const PORTAL_TRIGGER_KIND = 'portal-trigger';

/** Flow kinds that suspend a run awaiting somebody who isn't the visitor. */
const OPERATOR_WAIT_KINDS = new Set(['approval-gate', 'wait-event']);

/** Default per-visitor request ceiling when the portal doesn't set one. */
export const PORTAL_DEFAULT_RATE_LIMIT_PER_MIN = 10;

/** Hard ceiling on turns kept in a session transcript (oldest dropped). */
export const PORTAL_MAX_HISTORY_TURNS = 20;

/** Hard ceiling on characters kept in a session transcript. */
export const PORTAL_MAX_HISTORY_CHARS = 12_000;

// ── Slugs ────────────────────────────────────────────────────────────────────

/** 2-48 characters; must start and end alphanumeric. */
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,46}[a-z0-9]$/;

/** Reserved first segments that would collide with worker routes. */
const RESERVED_SLUGS = new Set([
  'api',
  'agents',
  'p',
  'releases',
  'update',
  'download',
  'health',
  'favicon.ico',
  'robots.txt',
]);

/** True when `slug` is a legal, non-reserved portal slug. */
export function isValidPortalSlug(slug: string): boolean {
  return SLUG_PATTERN.test(slug) && !RESERVED_SLUGS.has(slug);
}

/**
 * Coerces arbitrary text into a slug candidate (lower-case, dash-separated).
 * Returns `''` when nothing usable survives - callers then fall back to
 * {@link randomPortalSlug}.
 */
export function toPortalSlug(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');
  return isValidPortalSlug(slug) ? slug : '';
}

/**
 * Derives a slug from a workflow name, falling back to a random suffix so
 * publishing never blocks on naming. `random` supplies the entropy (the host
 * passes `crypto`-backed randomness).
 */
export function suggestPortalSlug(workflowName: string, random: () => number): string {
  return toPortalSlug(workflowName) || randomPortalSlug(random);
}

/** An opaque, URL-safe slug - used when no name-derived slug is available. */
export function randomPortalSlug(random: () => number): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let slug = 'portal-';
  for (let index = 0; index < 8; index += 1) {
    slug += alphabet[Math.floor(random() * alphabet.length)];
  }
  return slug;
}

// ── Field keys ───────────────────────────────────────────────────────────────

const FIELD_KEY_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]*$/;

/** True when `key` is addressable from a prompt as `{{fields.<key>}}`. */
export function isValidPortalFieldKey(key: string): boolean {
  return FIELD_KEY_PATTERN.test(key);
}

// ── Graph shape helpers ──────────────────────────────────────────────────────

/** The `portal-trigger` node of a graph, if it has one. */
export function findPortalTrigger(
  graph: WorkflowGraph,
): (WorkflowNode & { data: PortalTriggerData }) | undefined {
  const node = graph.nodes.find(candidate => candidate.kind === PORTAL_TRIGGER_KIND);
  return node as (WorkflowNode & { data: PortalTriggerData }) | undefined;
}

/**
 * Nodes with no outgoing handoff - the leaves whose payloads become the run's
 * terminal output. The responder must be one of these, otherwise the visitor
 * would see a mid-graph node's text while the run kept going.
 */
export function terminalLeafNodes(graph: WorkflowGraph): WorkflowNode[] {
  const sources = new Set<string>();
  for (const connection of graph.connections) {
    if (connection.kind !== 'handoff') continue;
    sources.add(connection.outputId.replace(/-out$/, ''));
  }
  return graph.nodes.filter(node => {
    if (node.kind === PORTAL_TRIGGER_KIND) return false;
    // Tool nodes hang off `tools` ports and never carry the conversation.
    if (node.category === 'tool') return false;
    const hasOutgoing = node.ports.some(
      port => port.role === 'message-out' && sources.has(port.id),
    );
    return !hasOutgoing;
  });
}

/**
 * The node whose tokens and output the visitor may see.
 *
 * Explicit configuration wins when it still names a terminal leaf. Otherwise
 * auto-resolution picks the single leaf; an ambiguous graph resolves to
 * `null`, which callers treat as "stream nothing, show the joined final
 * output" - safe, if less lively.
 */
export function resolveResponderNodeId(
  graph: WorkflowGraph,
  configured?: string | null,
): string | null {
  const leaves = terminalLeafNodes(graph);
  if (configured && leaves.some(leaf => leaf.id === configured)) return configured;
  return leaves.length === 1 ? leaves[0].id : null;
}

/** Node ids reachable by handoff from the portal trigger (inclusive). */
function reachableFromPortal(graph: WorkflowGraph, startId: string): Set<string> {
  const portsByNode = new Map<string, WorkflowNode>();
  for (const node of graph.nodes) {
    for (const port of node.ports) portsByNode.set(port.id, node);
  }
  const reached = new Set<string>([startId]);
  const queue = [startId];
  while (queue.length) {
    const current = queue.shift()!;
    const node = graph.nodes.find(candidate => candidate.id === current);
    if (!node) continue;
    const outIds = new Set(
      node.ports.filter(port => port.role === 'message-out').map(port => port.id),
    );
    for (const connection of graph.connections) {
      if (connection.kind !== 'handoff') continue;
      if (!outIds.has(connection.outputId.replace(/-out$/, ''))) continue;
      const target = portsByNode.get(connection.inputId.replace(/-in$/, ''));
      if (!target || reached.has(target.id)) continue;
      reached.add(target.id);
      queue.push(target.id);
    }
  }
  return reached;
}

// ── Validation ───────────────────────────────────────────────────────────────

/** One validation finding. `nodeId` lets the UI focus the offender. */
export interface PortalIssue {
  code: string;
  message: string;
  nodeId?: string;
}

/**
 * Publish readiness. `errors` block publishing outright; `warnings` are
 * publishable after the owner confirms (they describe runtime surprises for
 * visitors, not malformed config).
 */
export interface PortalValidation {
  errors: PortalIssue[];
  warnings: PortalIssue[];
  /** Resolved responder, or null when ambiguous. */
  responderNodeId: string | null;
}

/**
 * Validates a graph for publishing. `takenSlugs` are slugs already claimed by
 * OTHER workflows on the same host (the caller excludes this workflow's own).
 */
export function validatePortal(
  graph: WorkflowGraph,
  options: { takenSlugs?: readonly string[] } = {},
): PortalValidation {
  const errors: PortalIssue[] = [];
  const warnings: PortalIssue[] = [];
  const trigger = findPortalTrigger(graph);

  if (!trigger) {
    return {
      errors: [
        {
          code: 'no-portal-trigger',
          message: 'Add a Portal trigger node to publish this workflow.',
        },
      ],
      warnings,
      responderNodeId: null,
    };
  }

  const data = trigger.data ?? ({} as PortalTriggerData);

  // ── Slug ──
  if (data.slug) {
    if (!isValidPortalSlug(data.slug)) {
      errors.push({
        code: 'invalid-slug',
        message:
          'The portal address may only use lower-case letters, numbers and dashes (2-48 characters).',
        nodeId: trigger.id,
      });
    } else if (options.takenSlugs?.includes(data.slug)) {
      errors.push({
        code: 'slug-taken',
        message: `The address "${data.slug}" is already used by another published workflow.`,
        nodeId: trigger.id,
      });
    }
  }

  // ── Reachability ──
  const outgoing = graph.connections.filter(
    connection =>
      connection.kind === 'handoff' &&
      trigger.ports.some(port => port.id === connection.outputId.replace(/-out$/, '')),
  );
  if (!outgoing.length) {
    errors.push({
      code: 'portal-not-connected',
      message: 'Connect the Portal trigger to the agent that should answer visitors.',
      nodeId: trigger.id,
    });
  }

  // ── Fields (form mode) ──
  if (data.mode === 'form') {
    const fields = data.fields ?? [];
    if (!fields.length) {
      errors.push({
        code: 'form-without-fields',
        message: 'A form portal needs at least one field.',
        nodeId: trigger.id,
      });
    }
    const seen = new Set<string>();
    for (const field of fields) {
      if (!isValidPortalFieldKey(field.key)) {
        errors.push({
          code: 'invalid-field-key',
          message: `Field key "${field.key}" must start with a letter and use only letters, numbers and underscores.`,
          nodeId: trigger.id,
        });
      } else if (seen.has(field.key)) {
        errors.push({
          code: 'duplicate-field-key',
          message: `Two fields both use the key "${field.key}".`,
          nodeId: trigger.id,
        });
      }
      seen.add(field.key);
      if (!field.label.trim()) {
        errors.push({
          code: 'field-without-label',
          message: `Field "${field.key}" needs a label.`,
          nodeId: trigger.id,
        });
      }
      if (field.type === 'select' && !(field.options ?? []).length) {
        errors.push({
          code: 'select-without-options',
          message: `Field "${field.key}" is a dropdown but has no options.`,
          nodeId: trigger.id,
        });
      }
    }
  }

  // ── Responder ──
  const leaves = terminalLeafNodes(graph);
  const responderNodeId = resolveResponderNodeId(graph, data.responderNodeId);
  if (data.responderNodeId && !leaves.some(leaf => leaf.id === data.responderNodeId)) {
    errors.push({
      code: 'responder-not-terminal',
      message:
        'The responding node must be the last step of a branch. Pick a node with no outgoing handoff.',
      nodeId: data.responderNodeId,
    });
  } else if (!responderNodeId && leaves.length > 1) {
    warnings.push({
      code: 'ambiguous-responder',
      message: `This workflow ends in ${leaves.length} places. Choose which one answers the visitor, or they will only see the combined result at the end.`,
      nodeId: trigger.id,
    });
  }

  // ── Embedding ──
  if (data.embedEnabled) {
    const rawOrigins = data.embedOrigins ?? [];
    const bad = rawOrigins.filter(origin => origin.trim() && !normalizeEmbedOrigin(origin));
    for (const origin of bad) {
      errors.push({
        code: 'invalid-embed-origin',
        message: `"${origin}" is not a valid site address. Use the form https://example.com.`,
        nodeId: trigger.id,
      });
    }
    if (!rawOrigins.some(origin => normalizeEmbedOrigin(origin))) {
      warnings.push({
        code: 'embed-open-to-any-site',
        message:
          'Any website will be able to embed this portal. Add the sites you trust to lock it down.',
        nodeId: trigger.id,
      });
    }
    if (data.access === 'token') {
      warnings.push({
        code: 'embed-with-access-key',
        message:
          'Embedding a key-protected portal means the key travels in the host page, where visitors can read it. Prefer a public portal for embeds.',
        nodeId: trigger.id,
      });
    }
  }

  // ── Runtime surprises for visitors ──
  const reachable = reachableFromPortal(graph, trigger.id);
  for (const node of graph.nodes) {
    if (!reachable.has(node.id)) continue;
    if (!OPERATOR_WAIT_KINDS.has(node.kind)) continue;
    warnings.push(
      node.kind === 'approval-gate'
        ? {
            code: 'approval-gate-reachable',
            message: `"${node.name}" pauses for your review. Visitors will see "awaiting review" until you approve it from the studio.`,
            nodeId: node.id,
          }
        : {
            code: 'wait-event-reachable',
            message: `"${node.name}" waits for an external event. Visitors will wait with no feedback until it arrives.`,
            nodeId: node.id,
          },
    );
  }

  return { errors, warnings, responderNodeId };
}

// ── Input envelope ───────────────────────────────────────────────────────────

/** One recorded exchange in a portal session transcript. */
export interface PortalTurn {
  role: 'user' | 'assistant';
  text: string;
  at: number;
}

/**
 * What the engine receives as `RunOptions.input` for a portal run, serialized
 * as JSON. Prompts address it with `{{message}}`, `{{history}}`,
 * `{{fields.x}}` and `{{sessionId}}`.
 */
export interface PortalInputEnvelope {
  /** The visitor's latest message (chat mode) or a rendered field summary. */
  message: string;
  /** Prior turns as readable transcript text. Empty on the first turn. */
  history: string;
  /** Submitted form values, keyed by field key. Absent in chat mode. */
  fields?: Record<string, string | number | boolean>;
  /** Opaque per-visitor conversation id. */
  sessionId: string;
  /** Turn ordinal, starting at 1. */
  turn: number;
}

/** Renders a transcript as `You: …` / `Assistant: …` lines. */
export function renderPortalHistory(turns: readonly PortalTurn[]): string {
  return turns
    .map(turn => `${turn.role === 'user' ? 'You' : 'Assistant'}: ${turn.text}`)
    .join('\n\n');
}

/**
 * Trims a transcript to the retention caps, dropping the OLDEST turns first.
 * Returns a new array; the input is untouched.
 */
export function trimPortalHistory(turns: readonly PortalTurn[]): PortalTurn[] {
  const kept = turns.slice(-PORTAL_MAX_HISTORY_TURNS);
  let total = kept.reduce((sum, turn) => sum + turn.text.length, 0);
  while (kept.length > 1 && total > PORTAL_MAX_HISTORY_CHARS) {
    total -= kept[0].text.length;
    kept.shift();
  }
  return kept;
}

/**
 * Builds the JSON string handed to `RunOptions.input`.
 *
 * Field values are stringified into `message` too, so a prompt that only uses
 * `{{input}}` still receives something readable - the "defaults must be
 * runnable" rule applied to prompts.
 */
export function buildPortalInput(options: {
  message?: string;
  fields?: Record<string, string | number | boolean>;
  history?: readonly PortalTurn[];
  sessionId: string;
  turn: number;
}): string {
  const fields = options.fields;
  const message = options.message?.trim() || (fields ? renderFields(fields) : '');
  const envelope: PortalInputEnvelope = {
    message,
    history: renderPortalHistory(trimPortalHistory(options.history ?? [])),
    sessionId: options.sessionId,
    turn: options.turn,
  };
  if (fields && Object.keys(fields).length) envelope.fields = fields;
  return JSON.stringify(envelope);
}

function renderFields(fields: Record<string, string | number | boolean>): string {
  return Object.entries(fields)
    .map(([key, value]) => `${key}: ${String(value)}`)
    .join('\n');
}

/**
 * Coerces raw submitted values against the declared field schema, returning
 * either the cleaned record or the list of validation messages. Mirrors what
 * the portal page checks client-side so a hand-rolled POST can't bypass it.
 */
export function coercePortalFields(
  schema: readonly PortalField[],
  raw: Record<string, unknown>,
): { values: Record<string, string | number | boolean> } | { errors: string[] } {
  const values: Record<string, string | number | boolean> = {};
  const errors: string[] = [];

  for (const field of schema) {
    const provided = raw[field.key];
    const missing = provided === undefined || provided === null || provided === '';

    if (missing) {
      if (field.required) errors.push(`${field.label} is required.`);
      continue;
    }

    switch (field.type) {
      case 'number': {
        const parsed = typeof provided === 'number' ? provided : Number(String(provided).trim());
        if (!Number.isFinite(parsed)) {
          errors.push(`${field.label} must be a number.`);
        } else {
          values[field.key] = parsed;
        }
        break;
      }
      case 'boolean':
        values[field.key] = provided === true || provided === 'true' || provided === 'on';
        break;
      case 'select': {
        const text = String(provided);
        if (!(field.options ?? []).includes(text)) {
          errors.push(`${field.label} must be one of: ${(field.options ?? []).join(', ')}.`);
        } else {
          values[field.key] = text;
        }
        break;
      }
      default:
        values[field.key] = String(provided);
    }
  }

  return errors.length ? { errors } : { values };
}

// ── Public projection ────────────────────────────────────────────────────────

/**
 * What a visitor's browser is allowed to know about a published workflow.
 * Deliberately excludes the graph, prompts, models, node names and owner -
 * the portal page renders from this and nothing else.
 */
export interface PortalPublicConfig {
  slug: string;
  mode: PortalMode;
  title: string;
  greeting?: string;
  fields: PortalField[];
  access: PortalAccess;
  theme: 'auto' | 'light' | 'dark';
  showBranding: boolean;
  /** True when this portal may be framed by another site. */
  embedEnabled: boolean;
  /** Normalized origins allowed to frame it. Empty + enabled = any site. */
  embedOrigins: string[];
  /** Launcher bubble label used by the embed loader. */
  embedLabel: string;
}

/** Default launcher label when the owner hasn't set one. */
export const PORTAL_DEFAULT_EMBED_LABEL = 'Chat with us';

/**
 * Reduces owner input to a bare origin (`https://acme.com`), dropping any path,
 * trailing slash or stray whitespace. Returns '' when nothing usable survives,
 * so callers can drop it. `http://localhost:PORT` is allowed for development.
 */
export function normalizeEmbedOrigin(value: string): string {
  const text = value.trim();
  if (!text) return '';
  try {
    // Assume https when a bare hostname was pasted, which is what people do.
    const url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return '';
    // `new URL('https://*')` succeeds with hostname '*'. Emitting that into a
    // CSP would produce a meaningless token that silently blocks everything, so
    // require a hostname that looks like a real host. Wildcards are expressed by
    // leaving the list EMPTY, not by typing one.
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i.test(url.hostname)) {
      return '';
    }
    return url.origin;
  } catch {
    return '';
  }
}

/** Builds the visitor-facing config from a trigger's data. */
export function portalPublicConfig(
  data: PortalTriggerData,
  fallbackTitle: string,
): PortalPublicConfig {
  return {
    slug: data.slug ?? '',
    mode: data.mode === 'form' ? 'form' : 'chat',
    title: data.title?.trim() || fallbackTitle,
    greeting: data.greeting?.trim() || undefined,
    fields: data.mode === 'form' ? (data.fields ?? []) : [],
    access: data.access === 'token' ? 'token' : 'public',
    theme: data.theme ?? 'auto',
    showBranding: data.showBranding !== false,
    embedEnabled: data.embedEnabled === true,
    embedOrigins: (data.embedOrigins ?? [])
      .map(normalizeEmbedOrigin)
      .filter((origin, index, all) => !!origin && all.indexOf(origin) === index),
    embedLabel: data.embedLabel?.trim() || PORTAL_DEFAULT_EMBED_LABEL,
  };
}
