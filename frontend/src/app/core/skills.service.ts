import { Injectable, computed, inject, signal } from '@angular/core';

import { IndexedDbStorageService } from './indexed-db-storage.service';
import {
  newSkillId,
  parseSkillMd,
  toAgentSkill,
  type SkillDef,
} from './skills.model';
import { isAgentNode, type WorkflowGraph } from './workflow.model';

/**
 * The global skill library (EPIC 6) - CRUD over the IndexedDB `skills`
 * store, exposed as signals for the Skills panel and the Prompt panel's
 * attach UI.
 *
 * Attached skills are embedded BY VALUE into agent node data (portable
 * specs, no cloud library access needed); {@link syncAttachedSkills}
 * refreshes those embedded copies from the library at use time (run start,
 * cloud push, export). The library wins; skills deleted from the library
 * keep their embedded snapshot so old specs stay runnable.
 */
@Injectable({ providedIn: 'root' })
export class SkillsService {
  private readonly storage = inject(IndexedDbStorageService);

  /** All library skills, most recently updated first. */
  readonly skills = signal<SkillDef[]>([]);

  /** Library lookup by id, for sync + attach checks. */
  readonly byId = computed(() => new Map(this.skills().map(skill => [skill.id, skill])));

  constructor() {
    // Warm the library so syncAttachedSkills works synchronously at run start.
    void this.refresh();
  }

  async refresh(): Promise<void> {
    try {
      this.skills.set(await this.storage.listSkills());
    } catch {
      // The skill library must never break the studio - unreadable lists empty.
      this.skills.set([]);
    }
  }

  /** Creates a new library skill and returns it. */
  async createSkill(seed: { name: string; description?: string; content: string }): Promise<SkillDef> {
    const now = Date.now();
    const skill: SkillDef = {
      id: newSkillId(),
      name: seed.name.trim() || 'Untitled skill',
      ...(seed.description?.trim() ? { description: seed.description.trim() } : {}),
      content: seed.content,
      createdAt: now,
      updatedAt: now,
    };
    await this.storage.saveSkill(skill);
    await this.refresh();
    return skill;
  }

  /** Upserts a library skill (bumps `updatedAt`). */
  async saveSkill(skill: SkillDef): Promise<void> {
    await this.storage.saveSkill({ ...skill, updatedAt: Date.now() });
    await this.refresh();
  }

  async deleteSkill(id: string): Promise<void> {
    await this.storage.removeSkill(id);
    await this.refresh();
  }

  /** Duplicates a library skill under a fresh id and returns the copy. */
  async duplicateSkill(skill: SkillDef): Promise<SkillDef> {
    return this.createSkill({
      name: `${skill.name} (copy)`,
      description: skill.description,
      content: skill.content,
    });
  }

  /** Imports SKILL.md text as a new library skill; null if unparseable. */
  async importSkillMd(text: string): Promise<SkillDef | null> {
    const parsed = parseSkillMd(text);
    if (!parsed) return null;
    return this.createSkill(parsed);
  }

  /**
   * Refreshes skills embedded in agent nodes from the library (by id).
   * MUTATES the given graph in place - callers pass a clone (run snapshot,
   * exported spec). Skills missing from the library keep their embedded
   * snapshot so the spec stays runnable.
   */
  syncAttachedSkills(graph: WorkflowGraph): void {
    const library = this.byId();
    for (const node of graph.nodes) {
      if (!isAgentNode(node) || !Array.isArray(node.data.skills)) continue;
      node.data.skills = node.data.skills.map(attached => {
        const current = library.get(attached.id);
        return current ? toAgentSkill(current) : attached;
      });
    }
  }
}
