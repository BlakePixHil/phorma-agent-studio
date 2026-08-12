import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { DatePipe } from '@angular/common';
import { ButtonModule } from 'primeng/button';
import { ConfirmDialogService } from '../../../shared/confirm-dialog/confirm-dialog.service';
import { PanelCard } from '../../../shared/panel-card/panel-card';
import { SkillEditorDialogService } from '../skill-editor-dialog.service';
import { SkillsService } from '../../../core/skills.service';
import { ToastService } from '../../../shared/toast/toast.service';
import { WorkflowService } from '../../../core/workflow.service';
import { isAgentNode } from '../../../core/workflow.model';
import { serializeSkillMd, skillFileName, type SkillDef } from '../../../core/skills.model';

/**
 * The Skills panel (EPIC 6, left sidebar): the global library of reusable
 * markdown skills. Create/edit/duplicate/delete skills, import SKILL.md
 * files, and see how many agents on the ACTIVE canvas use each skill.
 * Attaching happens in the Prompt panel of the selected agent.
 */
@Component({
  selector: 'app-skills-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ButtonModule, DatePipe, PanelCard],
  templateUrl: './skills-panel.html',
  styleUrl: './skills-panel.scss',
})
export class SkillsPanel {
  protected readonly skills = inject(SkillsService);
  private readonly workflow = inject(WorkflowService);
  private readonly editor = inject(SkillEditorDialogService);
  private readonly confirmDialog = inject(ConfirmDialogService);
  private readonly toast = inject(ToastService);

  /** skill id → number of agents on the active canvas using it. */
  protected readonly usedBy = computed(() => {
    const counts = new Map<string, number>();
    for (const node of this.workflow.graph().nodes) {
      if (!isAgentNode(node)) continue;
      for (const attached of node.data.skills ?? []) {
        counts.set(attached.id, (counts.get(attached.id) ?? 0) + 1);
      }
    }
    return counts;
  });

  protected newSkill(): void {
    this.editor.openNew();
  }

  protected editSkill(skill: SkillDef): void {
    this.editor.openEdit(skill);
  }

  protected async duplicateSkill(skill: SkillDef, event: Event): Promise<void> {
    event.stopPropagation();
    await this.skills.duplicateSkill(skill);
  }

  protected deleteSkill(skill: SkillDef, event: Event): void {
    event.stopPropagation();
    void this.confirmDialog
      .confirm({
        title: 'Delete skill?',
        message: `"${skill.name}" will be removed from the library. Agents already using it keep their embedded copy.`,
        confirmLabel: 'Delete',
        tone: 'danger',
      })
      .then(confirmed => {
        if (confirmed) void this.skills.deleteSkill(skill.id);
      });
  }

  protected exportSkill(skill: SkillDef, event: Event): void {
    event.stopPropagation();
    const blob = new Blob([serializeSkillMd(skill)], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = skillFileName(skill);
    anchor.click();
    // Deferred: revoking in the same tick can invalidate the blob before the
    // browser has read it, producing an empty download.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  /** Imports a SKILL.md file straight into the library. */
  protected async importFile(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    const imported = await this.skills.importSkillMd(await file.text());
    if (imported) {
      this.toast.success('Skill imported', `"${imported.name}" was added to the library.`);
    } else {
      this.toast.warning('Nothing to import', 'That file has no skill content.');
    }
  }
}
