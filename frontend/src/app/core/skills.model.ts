/**
 * Agent Skills (EPIC 6) - library types and the SKILL.md interchange format.
 *
 * A skill is a named, reusable markdown fragment (prompt guidance +
 * tool-usage instructions) attachable to agent nodes. Markdown ONLY - no
 * scripts, no sandbox. Attached skills are embedded BY VALUE into
 * `AgentNodeData.skills` so `.phorma.json` stays portable and the cloud
 * runtime needs no library access; the `id` links back to this library
 * for re-sync on run/push/export.
 */

import type { AgentSkill } from './workflow.model';

/** A skill as stored in the global library (IndexedDB `skills` store). */
export interface SkillDef extends AgentSkill {
  createdAt: number;
  updatedAt: number;
}

/** Soft cap for skill content; larger skills warn in the editor. */
export const SKILL_CONTENT_SOFT_CAP = 16 * 1024;

/** Strips library timestamps, returning the embeddable by-value shape. */
export function toAgentSkill(skill: SkillDef): AgentSkill {
  return {
    id: skill.id,
    name: skill.name,
    ...(skill.description ? { description: skill.description } : {}),
    content: skill.content,
  };
}

/** Mints a fresh library skill id. */
export function newSkillId(): string {
  return `skill-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

// ── SKILL.md interchange ─────────────────────────────────────────────────────
//
// The ecosystem format: YAML frontmatter with `name` and `description`
// followed by the markdown body. We parse only those two scalar keys with a
// minimal line parser - no YAML dependency (nested structures are ignored).

/** Parsed SKILL.md content, ready to become a {@link SkillDef}. */
export interface ParsedSkillMd {
  name: string;
  description?: string;
  content: string;
}

/**
 * Parses SKILL.md text: `---` frontmatter (name/description) + markdown
 * body. Tolerates missing frontmatter - falls back to the first markdown
 * heading (or "Imported skill") as the name and uses the whole text as body.
 * Returns null only for blank input.
 */
export function parseSkillMd(text: string): ParsedSkillMd | null {
  const raw = text.replace(/\r\n/g, '\n').trim();
  if (!raw) return null;

  let name = '';
  let description: string | undefined;
  let body = raw;

  const fm = /^---\n([\s\S]*?)\n---\n?/.exec(raw);
  if (fm) {
    body = raw.slice(fm[0].length).trim();
    for (const line of fm[1].split('\n')) {
      const match = /^(name|description):\s*(.*)$/.exec(line.trim());
      if (!match) continue;
      const value = unquote(match[2].trim());
      if (match[1] === 'name') name = value;
      else description = value || undefined;
    }
  }

  if (!name) {
    const heading = /^#{1,6}\s+(.+)$/m.exec(body);
    name = heading?.[1].trim() ?? 'Imported skill';
  }
  if (!body) return null;
  return { name, ...(description ? { description } : {}), content: body };
}

/** Serializes a skill to the SKILL.md interchange format. */
export function serializeSkillMd(skill: AgentSkill): string {
  const lines = ['---', `name: ${quoteIfNeeded(skill.name)}`];
  if (skill.description) lines.push(`description: ${quoteIfNeeded(skill.description)}`);
  lines.push('---', '', skill.content.trim(), '');
  return lines.join('\n');
}

/** Suggested file name for an exported skill (kebab-cased). */
export function skillFileName(skill: AgentSkill): string {
  const kebab = skill.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${kebab || 'skill'}.SKILL.md`;
}

function unquote(value: string): string {
  const match = /^(['"])(.*)\1$/.exec(value);
  return match ? match[2] : value;
}

function quoteIfNeeded(value: string): string {
  // Quote values that YAML would misread as structures or comments.
  return /[:#[\]{}"'|>&*!%@`,]/.test(value) ? JSON.stringify(value) : value;
}
