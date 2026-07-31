import { Injectable, inject } from '@angular/core';

import { AiEditSessionService } from '../ai-edit-session.service';
import { LocalAgentRouterService } from '../local-agent-router.service';
import { PromptLibraryService } from '../prompt-library.service';
import { WorkflowService } from '../workflow.service';
import type { WorkflowNode } from '../workflow.model';
import { hasPromptField } from './graph-actions.service';
import {
  actionFail,
  actionOk,
  argList,
  argStr,
  type ActionArgs,
  type ActionResult,
  type StudioAction,
} from './studio-action.model';

/**
 * Surface `prompts` Studio_Actions (Requirement 2.3, Requirement 9).
 *
 * `prompt_read` returns the COMPLETE prompt body. That is the fix for the
 * 120-character `prompt-gist` truncation that made "modify that specific
 * prompt" unanswerable: the graph summary no longer carries prompt fragments
 * at all, it points here instead (Requirements 5.3, 5.4).
 *
 * `prompt_write` applies the patch to any node whose data declares a `prompt`
 * field rather than agent nodes only - the old `isAgentNode` gate silently
 * discarded prompt patches aimed at other kinds (Requirement 9.3, 9.4).
 */
@Injectable({ providedIn: 'root' })
export class PromptActionsService {
  private readonly workflow = inject(WorkflowService);
  private readonly router = inject(LocalAgentRouterService);
  private readonly session = inject(AiEditSessionService);
  private readonly library = inject(PromptLibraryService);

  actions(): StudioAction[] {
    return [
      {
        id: 'prompt_read',
        label: 'Read a node prompt',
        description:
          "Returns a node's COMPLETE markdown prompt body. Identify the node by id, or by display name when it is unique.",
        surface: 'prompts',
        access: 'read',
        risk: 'silent',
        params: {
          nodeId: { type: 'string', description: 'Node id (preferred).' },
          nodeName: { type: 'string', description: 'Display name, when the id is unknown.' },
        },
        activity: args =>
          `Reading the prompt of ${argStr(args, 'nodeName') ?? argStr(args, 'nodeId') ?? 'a node'}`,
        run: args => this.readPrompt(args),
      },
      {
        id: 'prompt_write',
        label: 'Write a node prompt',
        description:
          "Replaces a node's markdown prompt with a complete new body. Read the current prompt with prompt_read first so the rewrite keeps what matters. Include {{input}} where the incoming task text goes.",
        surface: 'prompts',
        access: 'write',
        risk: 'silent',
        graphEdit: true,
        params: {
          nodeId: { type: 'string', description: 'Node id (preferred).' },
          nodeName: { type: 'string', description: 'Display name, when the id is unknown.' },
          prompt: {
            type: 'string',
            description: 'The complete replacement prompt body, in markdown.',
            required: true,
          },
        },
        activity: args =>
          `Rewriting the prompt of ${argStr(args, 'nodeName') ?? argStr(args, 'nodeId') ?? 'a node'}`,
        run: args => this.writePrompt(args),
      },
      {
        id: 'prompt_library_list',
        label: 'List library prompts',
        description:
          'Lists the prompt library: built-in catalog prompts and user-saved entries, with ids, names, descriptions and tags.',
        surface: 'prompts',
        access: 'read',
        risk: 'silent',
        params: {
          query: { type: 'string', description: 'Optional name/description/tag filter.' },
        },
        activity: () => 'Listing library prompts',
        run: args => this.listLibrary(args),
      },
      {
        id: 'prompt_library_read',
        label: 'Read a library prompt',
        description: 'Returns the full markdown content of one prompt-library entry.',
        surface: 'prompts',
        access: 'read',
        risk: 'silent',
        params: { promptId: { type: 'string', description: 'Prompt id.', required: true } },
        activity: () => 'Reading a library prompt',
        run: args => this.readLibrary(args),
      },
      {
        id: 'prompt_library_save',
        label: 'Save a prompt to the library',
        description:
          'Saves a markdown prompt to the reusable prompt library. Pass `nodeId` instead of `content` to capture a node\'s current prompt.',
        surface: 'prompts',
        access: 'write',
        risk: 'silent',
        params: {
          name: { type: 'string', description: 'Library entry name.', required: true },
          content: { type: 'string', description: 'Markdown prompt body.' },
          nodeId: { type: 'string', description: "Capture this node's current prompt instead." },
          description: { type: 'string', description: 'One-line description.' },
          tags: { type: 'string[]', description: 'Search tags.' },
        },
        activity: args => `Saving prompt "${argStr(args, 'name') ?? ''}" to the library`,
        run: args => this.saveToLibrary(args),
      },
      {
        id: 'prompt_library_apply',
        label: 'Apply a library prompt',
        description:
          "Copies a library prompt's markdown into a node's prompt. The workflow stays self-contained - later library edits never change the node.",
        surface: 'prompts',
        access: 'write',
        risk: 'silent',
        graphEdit: true,
        params: {
          promptId: { type: 'string', description: 'Library prompt id.', required: true },
          nodeId: { type: 'string', description: 'Target node id.' },
          nodeName: { type: 'string', description: 'Target display name, when the id is unknown.' },
        },
        activity: () => 'Applying a library prompt',
        run: args => this.applyLibrary(args),
      },
    ];
  }

  // ── Executors ────────────────────────────────────────────────────────────

  private readPrompt(args: ActionArgs): ActionResult {
    const resolved = this.resolveNode(args);
    if ('message' in resolved) return resolved;
    const node = resolved.value;
    if (!hasPromptField(node.data)) {
      return actionFail(`Nodes of kind '${node.kind}' do not carry a prompt.`);
    }
    return actionOk({
      nodeId: node.id,
      name: node.name,
      kind: node.kind,
      prompt: node.data.prompt,
    });
  }

  private writePrompt(args: ActionArgs): ActionResult {
    const prompt = argStr(args, 'prompt');
    if (prompt === undefined) return actionFail('Missing the replacement prompt body.');
    const resolved = this.resolveNode(args);
    if ('message' in resolved) return resolved;
    const node = resolved.value;
    // Requirement 9.4: a node kind with no prompt field is a clear failure,
    // never a silently dropped patch.
    if (!hasPromptField(node.data)) {
      return actionFail(`Nodes of kind '${node.kind}' do not carry a prompt.`);
    }
    const result = this.router.updateNode(node.id, {
      data: { ...(node.data as object), prompt },
    });
    if (!result.ok) return actionFail(result.error ?? 'Failed to write the prompt.');
    this.session.record(`Rewrote the prompt of ${node.name}`);
    return actionOk(
      { nodeId: node.id, name: node.name, characters: prompt.length },
      { revertable: true },
    );
  }

  private listLibrary(args: ActionArgs): ActionResult {
    const query = argStr(args, 'query')?.toLowerCase();
    const entries = this.library.all().filter(entry => {
      if (!query) return true;
      const haystack = [entry.name, entry.description ?? '', ...(entry.tags ?? [])]
        .join(' ')
        .toLowerCase();
      return haystack.includes(query);
    });
    return actionOk({
      prompts: entries.map(entry => ({
        id: entry.id,
        name: entry.name,
        description: entry.description,
        tags: entry.tags,
        builtIn: entry.builtIn ?? false,
        characters: entry.content.length,
      })),
    });
  }

  private readLibrary(args: ActionArgs): ActionResult {
    const promptId = argStr(args, 'promptId');
    if (!promptId) return actionFail('Missing the prompt id.');
    const entry = this.library.byId().get(promptId);
    if (!entry) return actionFail(`Prompt '${promptId}' is not in the library.`);
    return actionOk({
      id: entry.id,
      name: entry.name,
      description: entry.description,
      tags: entry.tags,
      builtIn: entry.builtIn ?? false,
      content: entry.content,
    });
  }

  private async saveToLibrary(args: ActionArgs): Promise<ActionResult> {
    const name = argStr(args, 'name');
    if (!name) return actionFail('Missing the library entry name.');
    let content = argStr(args, 'content');
    if (content === undefined) {
      const nodeId = argStr(args, 'nodeId');
      if (!nodeId) return actionFail('Pass either content or a nodeId to capture.');
      const node = this.workflow.graph().nodes.find(item => item.id === nodeId);
      if (!node) return actionFail(`Node '${nodeId}' is not on the canvas.`);
      if (!hasPromptField(node.data)) {
        return actionFail(`Nodes of kind '${node.kind}' do not carry a prompt.`);
      }
      content = node.data.prompt;
    }
    const entry = await this.library.createPrompt({
      name,
      content,
      ...(argStr(args, 'description') ? { description: argStr(args, 'description')! } : {}),
      ...(argList(args, 'tags') ? { tags: argList(args, 'tags')! } : {}),
    });
    return actionOk({ promptId: entry.id, name: entry.name }, { revertable: false });
  }

  private async applyLibrary(args: ActionArgs): Promise<ActionResult> {
    const promptId = argStr(args, 'promptId');
    if (!promptId) return actionFail('Missing the prompt id.');
    const entry = this.library.byId().get(promptId);
    if (!entry) return actionFail(`Prompt '${promptId}' is not in the library.`);
    const resolved = this.resolveNode(args);
    if ('message' in resolved) return resolved;
    const node = resolved.value;
    if (!hasPromptField(node.data)) {
      return actionFail(`Nodes of kind '${node.kind}' do not carry a prompt.`);
    }
    const result = this.router.updateNode(node.id, {
      data: { ...(node.data as object), prompt: entry.content },
    });
    if (!result.ok) return actionFail(result.error ?? 'Failed to apply the prompt.');
    this.session.record(`Applied prompt "${entry.name}" to ${node.name}`);
    await this.library.markUsed(entry.id).catch(() => undefined);
    return actionOk({ nodeId: node.id, promptId: entry.id }, { revertable: true });
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  /**
   * Resolves a node from `nodeId` or `nodeName`. An ambiguous display name is
   * a hard failure listing the candidate ids, so the assistant asks which node
   * to edit instead of guessing (Requirement 9.2).
   */
  private resolveNode(
    args: ActionArgs,
  ): { value: WorkflowNode } | (ActionResult & { message: string }) {
    const nodes = this.workflow.graph().nodes;
    const nodeId = argStr(args, 'nodeId');
    if (nodeId) {
      const node = nodes.find(item => item.id === nodeId);
      return node
        ? { value: node }
        : { ok: false, message: `Node '${nodeId}' is not on the canvas.` };
    }
    const nodeName = argStr(args, 'nodeName');
    if (!nodeName) return { ok: false, message: 'Pass either a nodeId or a nodeName.' };
    const matches = nodes.filter(
      item => item.name.toLowerCase() === nodeName.toLowerCase(),
    );
    if (matches.length === 0) {
      return { ok: false, message: `No node on the canvas is named "${nodeName}".` };
    }
    if (matches.length > 1) {
      return {
        ok: false,
        message: `${matches.length} nodes are named "${nodeName}" (${matches
          .map(item => item.id)
          .join(', ')}); ask the user which one and pass its nodeId.`,
      };
    }
    return { value: matches[0] };
  }
}
