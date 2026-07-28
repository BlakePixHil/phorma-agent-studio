/**
 * The Prompt Library - reusable agent system prompts.
 *
 * A prompt entry is a named markdown system prompt that can be applied to
 * any agent node, independent of the workflow it was authored in. The
 * library is GLOBAL (cross-workflow), mirroring the skill library.
 *
 * Two flavours exist:
 * - **Built-in** entries, derived at read time from the agent presets in
 *   `node-catalog.ts`. They are never persisted, so the catalog stays the
 *   single source of truth; editing one forks it into a user entry.
 * - **User** entries, persisted in the IndexedDB `prompts` store.
 */

import { NODE_CATALOG, type NodeCatalogEntry } from './node-catalog';
import { isAgentNode, type WorkflowNode } from './workflow.model';

/** A prompt as stored in the library (IndexedDB `prompts` store). */
export interface PromptEntry {
  id: string;
  name: string;
  description?: string;
  /** The markdown system prompt. */
  content: string;
  /** Node-catalog agent preset this prompt targets, e.g. `agent-researcher`. */
  presetId?: string;
  tags?: string[];
  /**
   * Extra search terms that are deliberately NOT shown as tags. Built-ins
   * carry the catalog's `keywords` here: they make search work without
   * flooding the tag filter with two dozen chips nobody chose.
   */
  keywords?: string[];
  /** True for catalog-derived entries: read-only, fork to edit. */
  builtIn?: boolean;
  /** Times this prompt has been applied to an agent. */
  usageCount?: number;
  lastUsedAt?: number;
  createdAt: number;
  updatedAt: number;
}

/** Soft cap for prompt content; larger prompts warn in the editor. */
export const PROMPT_CONTENT_SOFT_CAP = 16 * 1024;

/** Prefix marking a built-in (catalog-derived) prompt id. */
export const BUILT_IN_PROMPT_PREFIX = 'builtin:';

/** Mints a fresh library prompt id. */
export function newPromptId(): string {
  return `prompt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

// ── Built-in seeds ───────────────────────────────────────────────────────────

/** Every agent preset in the node catalog, as read-only library entries. */
export function builtInPrompts(): PromptEntry[] {
  return NODE_CATALOG.filter(entry => entry.kind === 'agent').map(toBuiltInPrompt);
}

function toBuiltInPrompt(entry: NodeCatalogEntry): PromptEntry {
  const data = entry.defaultData();
  const content = typeof (data as { prompt?: unknown }).prompt === 'string'
    ? (data as { prompt: string }).prompt
    : '';
  return {
    id: `${BUILT_IN_PROMPT_PREFIX}${entry.id}`,
    name: entry.label,
    description: entry.description,
    content,
    presetId: entry.id,
    ...(entry.keywords?.length ? { keywords: [...entry.keywords] } : {}),
    builtIn: true,
    // Built-ins have no real timestamps; 0 sorts them last by recency.
    createdAt: 0,
    updatedAt: 0,
  };
}

/** Labels for the preset filter, derived from the catalog. */
export function agentPresetOptions(): { label: string; value: string }[] {
  return NODE_CATALOG.filter(entry => entry.kind === 'agent').map(entry => ({
    label: entry.label,
    value: entry.id,
  }));
}

/** Human label for a preset id, falling back to the raw id. */
export function agentPresetLabel(presetId: string | undefined): string {
  if (!presetId) return '';
  return NODE_CATALOG.find(entry => entry.id === presetId)?.label ?? presetId;
}

// ── Capture from a node ──────────────────────────────────────────────────────

/** Seed values for saving the currently selected agent's prompt. */
export interface PromptCaptureSeed {
  name: string;
  content: string;
  presetId?: string;
}

/**
 * Builds a library seed from an agent node. Nodes carry no preset id after
 * being dropped, so the preset is guessed by matching the node name against
 * catalog `defaultName`s - a best-effort tag the user can change.
 */
export function captureSeedFromNode(node: WorkflowNode): PromptCaptureSeed | null {
  if (!isAgentNode(node)) return null;
  const preset = NODE_CATALOG.find(
    entry => entry.kind === 'agent' && entry.defaultName === node.name,
  );
  return {
    name: node.name || 'Untitled prompt',
    content: node.data.prompt ?? '',
    ...(preset ? { presetId: preset.id } : {}),
  };
}

// ── Template variables ───────────────────────────────────────────────────────

/**
 * Extracts distinct `{{variable}}` placeholders in first-appearance order.
 * Used to show users which inputs a prompt expects.
 */
export function promptVariables(content: string): string[] {
  const found: string[] = [];
  for (const match of content.matchAll(/\{\{\s*([\w.-]+)\s*\}\}/g)) {
    const name = match[1];
    if (!found.includes(name)) found.push(name);
  }
  return found;
}

// ── PROMPT.md interchange ────────────────────────────────────────────────────
//
// Same minimal-frontmatter convention as SKILL.md (see skills.model.ts):
// `---` block with scalar keys, then the markdown body. No YAML dependency.

/** Parsed PROMPT.md content, ready to become a {@link PromptEntry}. */
export interface ParsedPromptMd {
  name: string;
  description?: string;
  presetId?: string;
  tags?: string[];
  content: string;
}

/**
 * Parses PROMPT.md text: `---` frontmatter (name/description/preset/tags)
 * followed by the markdown body. Tolerates missing frontmatter, falling back
 * to the first markdown heading as the name. Returns null for blank input.
 */
export function parsePromptMd(text: string): ParsedPromptMd | null {
  const raw = text.replace(/\r\n/g, '\n').trim();
  if (!raw) return null;

  let name = '';
  let description: string | undefined;
  let presetId: string | undefined;
  let tags: string[] | undefined;
  let body = raw;

  const fm = /^---\n([\s\S]*?)\n---\n?/.exec(raw);
  if (fm) {
    body = raw.slice(fm[0].length).trim();
    for (const line of fm[1].split('\n')) {
      const match = /^(name|description|preset|tags):\s*(.*)$/.exec(line.trim());
      if (!match) continue;
      const value = unquote(match[2].trim());
      if (match[1] === 'name') name = value;
      else if (match[1] === 'description') description = value || undefined;
      else if (match[1] === 'preset') presetId = value || undefined;
      else if (match[1] === 'tags') {
        const list = value
          .replace(/^\[|\]$/g, '')
          .split(',')
          .map(tag => unquote(tag.trim()))
          .filter(Boolean);
        tags = list.length > 0 ? list : undefined;
      }
    }
  }

  if (!name) {
    const heading = /^#{1,6}\s+(.+)$/m.exec(body);
    name = heading?.[1].trim() ?? 'Imported prompt';
  }
  if (!body) return null;
  return {
    name,
    ...(description ? { description } : {}),
    ...(presetId ? { presetId } : {}),
    ...(tags ? { tags } : {}),
    content: body,
  };
}

/** Serializes a prompt to the PROMPT.md interchange format. */
export function serializePromptMd(entry: PromptEntry): string {
  const lines = ['---', `name: ${quoteIfNeeded(entry.name)}`];
  if (entry.description) lines.push(`description: ${quoteIfNeeded(entry.description)}`);
  if (entry.presetId) lines.push(`preset: ${entry.presetId}`);
  if (entry.tags?.length) lines.push(`tags: [${entry.tags.map(quoteIfNeeded).join(', ')}]`);
  lines.push('---', '', entry.content.trim(), '');
  return lines.join('\n');
}

/** Suggested file name for an exported prompt (kebab-cased). */
export function promptFileName(entry: PromptEntry): string {
  const kebab = entry.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${kebab || 'prompt'}.PROMPT.md`;
}

function unquote(value: string): string {
  const match = /^(['"])(.*)\1$/.exec(value);
  return match ? match[2] : value;
}

function quoteIfNeeded(value: string): string {
  return /[:#[\]{}"'|>&*!%@`,]/.test(value) ? JSON.stringify(value) : value;
}
