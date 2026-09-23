import { Injectable, inject } from '@angular/core';

import { AiEditSessionService } from '../ai-edit-session.service';
import { LocalAgentRouterService } from '../local-agent-router.service';
import { SkillsService } from '../skills.service';
import { toAgentSkill } from '../skills.model';
import { WorkflowService } from '../workflow.service';
import { isAgentNode } from '../workflow.model';
import {
  actionFail,
  actionOk,
  argStr,
  type ActionArgs,
  type ActionResult,
  type StudioAction,
} from './studio-action.model';

/**
 * Surface `skills` Studio_Actions (Requirement 2.5).
 *
 * Attaching a skill embeds it BY VALUE into the agent node (the same thing the
 * Prompt panel does), so it is a graph edit covered by the Edit_Session.
 * Library CRUD is not.
 *
 * Declared minimums (multi-organisation-phorma Requirement 8.1): the whole
 * surface is builder, matching the Skills PANEL in `DEFAULT_TABS`. The skill
 * library is local authoring material, and attaching one rewrites an agent's
 * prompt out of it - an operator has neither the library nor the panel that
 * shows it.
 */
@Injectable({ providedIn: 'root' })
export class SkillActionsService {
  private readonly skills = inject(SkillsService);
  private readonly workflow = inject(WorkflowService);
  private readonly router = inject(LocalAgentRouterService);
  private readonly session = inject(AiEditSessionService);

  actions(): StudioAction[] {
    return [
      {
        id: 'skill_list',
        label: 'List skills',
        description:
          'Lists the skill library with ids, names, descriptions and body sizes. Skills are reusable markdown fragments attachable to agents.',
        surface: 'skills',
        access: 'read',
        risk: 'silent',
        minLevel: 'builder',
        activity: () => 'Listing skills',
        run: () => this.list(),
      },
      {
        id: 'skill_read',
        label: 'Read a skill',
        description: 'Returns one library skill with its complete markdown body.',
        surface: 'skills',
        access: 'read',
        risk: 'silent',
        minLevel: 'builder',
        params: { skillId: { type: 'string', description: 'Skill id.', required: true } },
        activity: () => 'Reading a skill',
        run: args => this.read(args),
      },
      {
        id: 'skill_create',
        label: 'Create a skill',
        description:
          'Creates a library skill from markdown. Skills are prompt guidance only - no scripts, no sandbox.',
        surface: 'skills',
        access: 'write',
        risk: 'silent',
        minLevel: 'builder',
        params: {
          name: { type: 'string', description: 'Skill name.', required: true },
          content: { type: 'string', description: 'Markdown body.', required: true },
          description: { type: 'string', description: 'One-line description.' },
        },
        activity: args => `Creating skill "${argStr(args, 'name') ?? ''}"`,
        run: args => this.create(args),
      },
      {
        id: 'skill_update',
        label: 'Update a skill',
        description: 'Updates a library skill name, description or markdown body.',
        surface: 'skills',
        access: 'write',
        risk: 'silent',
        minLevel: 'builder',
        params: {
          skillId: { type: 'string', description: 'Skill id.', required: true },
          name: { type: 'string', description: 'New name.' },
          content: { type: 'string', description: 'New markdown body.' },
          description: { type: 'string', description: 'New description.' },
        },
        activity: args => `Updating skill "${this.skillName(argStr(args, 'skillId'))}"`,
        run: args => this.update(args),
      },
      {
        id: 'skill_delete',
        label: 'Delete a skill',
        description:
          'Deletes a skill from the library. Agents that already embedded it keep their copy, so existing workflows stay runnable.',
        surface: 'skills',
        access: 'write',
        risk: 'confirm',
        minLevel: 'builder',
        params: { skillId: { type: 'string', description: 'Skill id.', required: true } },
        confirmSummary: args =>
          `Delete skill "${this.skillName(argStr(args, 'skillId'))}" from the library? Agents keep their embedded copy.`,
        activity: args => `Deleting skill "${this.skillName(argStr(args, 'skillId'))}"`,
        run: args => this.remove(args),
      },
      {
        id: 'skill_attach',
        label: 'Attach a skill',
        description: "Attaches a library skill to an agent node, appending it to that agent's prompt.",
        surface: 'skills',
        access: 'write',
        risk: 'silent',
        minLevel: 'builder',
        graphEdit: true,
        params: {
          skillId: { type: 'string', description: 'Skill id.', required: true },
          nodeId: { type: 'string', description: 'Agent node id.', required: true },
        },
        activity: args => `Attaching skill "${this.skillName(argStr(args, 'skillId'))}"`,
        run: args => this.attach(args),
      },
      {
        id: 'skill_detach',
        label: 'Detach a skill',
        description: 'Removes a skill from an agent node.',
        surface: 'skills',
        access: 'write',
        risk: 'silent',
        minLevel: 'builder',
        graphEdit: true,
        params: {
          skillId: { type: 'string', description: 'Skill id.', required: true },
          nodeId: { type: 'string', description: 'Agent node id.', required: true },
        },
        activity: args => `Detaching skill "${this.skillName(argStr(args, 'skillId'))}"`,
        run: args => this.detach(args),
      },
    ];
  }

  // ── Executors ────────────────────────────────────────────────────────────

  private async list(): Promise<ActionResult> {
    await this.skills.refresh();
    return actionOk({
      skills: this.skills.skills().map(skill => ({
        id: skill.id,
        name: skill.name,
        description: skill.description,
        characters: skill.content.length,
        updatedAt: new Date(skill.updatedAt).toISOString(),
      })),
    });
  }

  private async read(args: ActionArgs): Promise<ActionResult> {
    const skillId = argStr(args, 'skillId');
    if (!skillId) return actionFail('Missing the skill id.');
    await this.skills.refresh();
    const skill = this.skills.byId().get(skillId);
    if (!skill) return actionFail(`Skill '${skillId}' is not in the library.`);
    return actionOk({
      id: skill.id,
      name: skill.name,
      description: skill.description,
      content: skill.content,
    });
  }

  private async create(args: ActionArgs): Promise<ActionResult> {
    const name = argStr(args, 'name');
    const content = argStr(args, 'content');
    if (!name) return actionFail('Missing the skill name.');
    if (content === undefined) return actionFail('Missing the skill markdown body.');
    const skill = await this.skills.createSkill({
      name,
      content,
      ...(argStr(args, 'description') ? { description: argStr(args, 'description')! } : {}),
    });
    return actionOk({ skillId: skill.id, name: skill.name }, { revertable: false });
  }

  private async update(args: ActionArgs): Promise<ActionResult> {
    const skillId = argStr(args, 'skillId');
    if (!skillId) return actionFail('Missing the skill id.');
    await this.skills.refresh();
    const skill = this.skills.byId().get(skillId);
    if (!skill) return actionFail(`Skill '${skillId}' is not in the library.`);
    const name = argStr(args, 'name');
    const content = argStr(args, 'content');
    const description = argStr(args, 'description');
    if (name === undefined && content === undefined && description === undefined) {
      return actionFail('Nothing to update: pass name, content or description.');
    }
    await this.skills.saveSkill({
      ...skill,
      ...(name ? { name } : {}),
      ...(content !== undefined ? { content } : {}),
      ...(description ? { description } : {}),
    });
    return actionOk({ skillId }, { revertable: false });
  }

  private async remove(args: ActionArgs): Promise<ActionResult> {
    const skillId = argStr(args, 'skillId');
    if (!skillId) return actionFail('Missing the skill id.');
    await this.skills.refresh();
    if (!this.skills.byId().has(skillId)) {
      return actionFail(`Skill '${skillId}' is not in the library.`);
    }
    await this.skills.deleteSkill(skillId);
    return actionOk({ skillId }, { revertable: false });
  }

  private async attach(args: ActionArgs): Promise<ActionResult> {
    const skillId = argStr(args, 'skillId');
    const nodeId = argStr(args, 'nodeId');
    if (!skillId) return actionFail('Missing the skill id.');
    if (!nodeId) return actionFail('Missing the node id.');
    await this.skills.refresh();
    const skill = this.skills.byId().get(skillId);
    if (!skill) return actionFail(`Skill '${skillId}' is not in the library.`);
    const node = this.workflow.graph().nodes.find(item => item.id === nodeId);
    if (!node) return actionFail(`Node '${nodeId}' is not on the canvas.`);
    if (!isAgentNode(node)) return actionFail('Skills attach to agent nodes only.');
    const attached = node.data.skills ?? [];
    if (attached.some(item => item.id === skillId)) {
      return actionFail(`"${skill.name}" is already attached to ${node.name}.`);
    }
    const result = this.router.updateNode(nodeId, {
      data: { ...node.data, skills: [...attached, toAgentSkill(skill)] },
    });
    if (!result.ok) return actionFail(result.error ?? 'Failed to attach the skill.');
    this.session.record(`Attached skill "${skill.name}" to ${node.name}`);
    return actionOk({ skillId, nodeId }, { revertable: true });
  }

  private detach(args: ActionArgs): ActionResult {
    const skillId = argStr(args, 'skillId');
    const nodeId = argStr(args, 'nodeId');
    if (!skillId) return actionFail('Missing the skill id.');
    if (!nodeId) return actionFail('Missing the node id.');
    const node = this.workflow.graph().nodes.find(item => item.id === nodeId);
    if (!node) return actionFail(`Node '${nodeId}' is not on the canvas.`);
    if (!isAgentNode(node)) return actionFail('Skills attach to agent nodes only.');
    const attached = node.data.skills ?? [];
    const skill = attached.find(item => item.id === skillId);
    if (!skill) return actionFail(`No skill '${skillId}' is attached to ${node.name}.`);
    const result = this.router.updateNode(nodeId, {
      data: { ...node.data, skills: attached.filter(item => item.id !== skillId) },
    });
    if (!result.ok) return actionFail(result.error ?? 'Failed to detach the skill.');
    this.session.record(`Detached skill "${skill.name}" from ${node.name}`);
    return actionOk({ skillId, nodeId }, { revertable: true });
  }

  private skillName(skillId: string | undefined): string {
    if (!skillId) return 'the skill';
    return this.skills.byId().get(skillId)?.name ?? skillId;
  }
}
