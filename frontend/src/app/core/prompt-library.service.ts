import { Injectable, computed, inject, signal } from '@angular/core';

import { IndexedDbStorageService } from './indexed-db-storage.service';
import {
  builtInPrompts,
  newPromptId,
  parsePromptMd,
  type PromptEntry,
} from './prompt-library.model';

/**
 * The global prompt library - CRUD over the IndexedDB `prompts` store plus
 * the read-only built-ins derived from the node catalog.
 *
 * Unlike skills, prompts are NOT embedded by reference into node data:
 * applying a prompt copies its markdown into `AgentNodeData.prompt`, so the
 * workflow stays self-contained and later library edits never mutate a
 * running workflow behind the user's back.
 */
@Injectable({ providedIn: 'root' })
export class PromptLibraryService {
  private readonly storage = inject(IndexedDbStorageService);

  /** User-saved prompts, most recently updated first. */
  readonly prompts = signal<PromptEntry[]>([]);

  /** Catalog-derived read-only prompts (stable for the app's lifetime). */
  readonly builtIns = builtInPrompts();

  /** Built-ins followed by user prompts. */
  readonly all = computed<PromptEntry[]>(() => [...this.builtIns, ...this.prompts()]);

  readonly byId = computed(() => new Map(this.all().map(entry => [entry.id, entry])));

  /** User prompts grouped by the agent preset they target (`''` = untagged). */
  readonly byPreset = computed(() => {
    const groups = new Map<string, PromptEntry[]>();
    for (const entry of this.all()) {
      const key = entry.presetId ?? '';
      const bucket = groups.get(key);
      if (bucket) bucket.push(entry);
      else groups.set(key, [entry]);
    }
    return groups;
  });

  /** Every distinct tag across the library, alphabetical. */
  readonly allTags = computed(() => {
    const tags = new Set<string>();
    for (const entry of this.all()) for (const tag of entry.tags ?? []) tags.add(tag);
    return [...tags].sort((a, b) => a.localeCompare(b));
  });

  constructor() {
    void this.refresh();
  }

  async refresh(): Promise<void> {
    try {
      this.prompts.set(await this.storage.listPrompts());
    } catch {
      // The library must never break the studio - unreadable lists empty.
      this.prompts.set([]);
    }
  }

  /** Creates a new user prompt and returns it. */
  async createPrompt(seed: {
    name: string;
    description?: string;
    content: string;
    presetId?: string;
    tags?: string[];
  }): Promise<PromptEntry> {
    const now = Date.now();
    const entry: PromptEntry = {
      id: newPromptId(),
      name: seed.name.trim() || 'Untitled prompt',
      ...(seed.description?.trim() ? { description: seed.description.trim() } : {}),
      content: seed.content,
      ...(seed.presetId ? { presetId: seed.presetId } : {}),
      ...(seed.tags?.length ? { tags: dedupeTags(seed.tags) } : {}),
      usageCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    await this.storage.savePrompt(entry);
    await this.refresh();
    return entry;
  }

  /** Upserts a user prompt (bumps `updatedAt`). Built-ins are ignored. */
  async savePrompt(entry: PromptEntry): Promise<void> {
    if (entry.builtIn) return;
    await this.storage.savePrompt({ ...entry, updatedAt: Date.now() });
    await this.refresh();
  }

  async deletePrompt(id: string): Promise<void> {
    if (this.byId().get(id)?.builtIn) return;
    await this.storage.removePrompt(id);
    await this.refresh();
  }

  /** Duplicates a prompt under a fresh id and returns the copy. */
  async duplicatePrompt(entry: PromptEntry): Promise<PromptEntry> {
    return this.createPrompt({
      name: `${entry.name} (copy)`,
      description: entry.description,
      content: entry.content,
      presetId: entry.presetId,
      tags: entry.tags,
    });
  }

  /**
   * Forks a built-in into an editable user prompt. User entries are simply
   * duplicated, so callers can wire one button to both cases.
   */
  async fork(entry: PromptEntry): Promise<PromptEntry> {
    if (!entry.builtIn) return this.duplicatePrompt(entry);
    return this.createPrompt({
      name: entry.name,
      description: entry.description,
      content: entry.content,
      presetId: entry.presetId,
      // A built-in's search keywords become real, editable tags on the fork -
      // the user now owns the entry, so they should be able to see and change them.
      tags: entry.tags ?? entry.keywords,
    });
  }

  /** Imports PROMPT.md text as a new user prompt; null if unparseable. */
  async importPromptMd(text: string): Promise<PromptEntry | null> {
    const parsed = parsePromptMd(text);
    if (!parsed) return null;
    return this.createPrompt(parsed);
  }

  /** Records that a prompt was applied to an agent. Built-ins are skipped. */
  async markUsed(id: string): Promise<void> {
    const entry = this.prompts().find(candidate => candidate.id === id);
    if (!entry) return;
    // Usage bookkeeping must not bump `updatedAt` (it would reorder the list
    // on every apply), so write straight through to storage.
    await this.storage.savePrompt({
      ...entry,
      usageCount: (entry.usageCount ?? 0) + 1,
      lastUsedAt: Date.now(),
    });
    await this.refresh();
  }
}

function dedupeTags(tags: string[]): string[] {
  const seen = new Set<string>();
  for (const tag of tags) {
    const clean = tag.trim();
    if (clean) seen.add(clean);
  }
  return [...seen];
}
