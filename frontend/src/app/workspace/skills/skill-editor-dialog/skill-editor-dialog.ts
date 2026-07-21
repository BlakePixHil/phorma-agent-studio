import {
  ChangeDetectionStrategy,
  Component,
  HostListener,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { DomSanitizer, type SafeHtml } from '@angular/platform-browser';
import { ButtonModule } from 'primeng/button';
import DOMPurify from 'dompurify';
import { marked } from 'marked';

import { FieldGenerationService } from '../../../core/field-generation.service';
import { SkillsService } from '../../../core/skills.service';
import {
  SKILL_CONTENT_SOFT_CAP,
  parseSkillMd,
  serializeSkillMd,
  skillFileName,
} from '../../../core/skills.model';
import { SkillEditorDialogService } from '../skill-editor-dialog.service';
import { ToastService } from '../../../shared/toast/toast.service';

/**
 * The skill editor (EPIC 6) - a bespoke overlay dialog (mirrors the
 * credits/cloud dialog pattern; no p-dialog) for creating and editing
 * library skills: name, description, markdown body with sanitized preview,
 * AI drafting, and SKILL.md import/export.
 */
@Component({
  selector: 'app-skill-editor-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ButtonModule],
  templateUrl: './skill-editor-dialog.html',
  styleUrl: './skill-editor-dialog.scss',
})
export class SkillEditorDialog {
  protected readonly dialog = inject(SkillEditorDialogService);
  private readonly skills = inject(SkillsService);
  private readonly fieldGen = inject(FieldGenerationService);
  private readonly sanitizer = inject(DomSanitizer);
  private readonly toast = inject(ToastService);

  protected readonly name = signal('');
  protected readonly description = signal('');
  protected readonly content = signal('');
  protected readonly previewing = signal(false);
  protected readonly saving = signal(false);
  protected readonly generating = signal(false);

  protected readonly canSave = computed(
    () => this.name().trim().length > 0 && this.content().trim().length > 0,
  );

  /** Warns (never blocks) when the body outgrows the soft cap. */
  protected readonly oversized = computed(() => this.content().length > SKILL_CONTENT_SOFT_CAP);

  protected readonly previewHtml = computed<SafeHtml>(() => {
    const html = DOMPurify.sanitize(marked.parse(this.content(), { async: false }));
    return this.sanitizer.bypassSecurityTrustHtml(html);
  });

  constructor() {
    // Re-seed the form whenever the dialog opens on a (possibly different) skill.
    effect(() => {
      if (!this.dialog.visible()) return;
      const editing = this.dialog.editing();
      this.name.set(editing?.name ?? '');
      this.description.set(editing?.description ?? '');
      this.content.set(editing?.content ?? '');
      this.previewing.set(false);
    });
  }

  @HostListener('document:keydown.escape')
  protected onEscape(): void {
    if (this.dialog.visible()) this.dialog.close();
  }

  protected onNameInput(event: Event): void {
    this.name.set((event.target as HTMLInputElement).value);
  }

  protected onDescriptionInput(event: Event): void {
    this.description.set((event.target as HTMLInputElement).value);
  }

  protected onContentInput(event: Event): void {
    this.content.set((event.target as HTMLTextAreaElement).value);
  }

  protected togglePreview(): void {
    this.previewing.update(value => !value);
  }

  protected async save(): Promise<void> {
    if (!this.canSave() || this.saving()) return;
    this.saving.set(true);
    try {
      const editing = this.dialog.editing();
      if (editing) {
        await this.skills.saveSkill({
          ...editing,
          name: this.name().trim(),
          description: this.description().trim() || undefined,
          content: this.content(),
        });
      } else {
        await this.skills.createSkill({
          name: this.name(),
          description: this.description(),
          content: this.content(),
        });
      }
      this.dialog.close();
    } catch (error) {
      this.toast.error('Save failed', error instanceof Error ? error.message : String(error));
    } finally {
      this.saving.set(false);
    }
  }

  /** One-shot AI draft (or improvement) of the skill body. */
  protected async generate(): Promise<void> {
    if (this.generating()) return;
    if (!this.name().trim()) {
      this.toast.warning('Name the skill first', 'The AI drafts from the name and purpose.');
      return;
    }
    this.generating.set(true);
    try {
      const body = await this.fieldGen.generateSkill({
        name: this.name(),
        description: this.description(),
        content: this.content(),
      });
      if (body) this.content.set(body);
    } catch (error) {
      this.toast.error('Drafting failed', error instanceof Error ? error.message : String(error));
    } finally {
      this.generating.set(false);
    }
  }

  /** Imports a SKILL.md file into the form (does not save yet). */
  protected async importFile(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    const parsed = parseSkillMd(await file.text());
    if (!parsed) {
      this.toast.warning('Nothing to import', 'That file has no skill content.');
      return;
    }
    this.name.set(parsed.name);
    if (parsed.description) this.description.set(parsed.description);
    this.content.set(parsed.content);
  }

  /** Downloads the form's current state as a SKILL.md file. */
  protected exportFile(): void {
    if (!this.canSave()) return;
    const skill = {
      id: this.dialog.editing()?.id ?? 'export',
      name: this.name().trim(),
      description: this.description().trim() || undefined,
      content: this.content(),
    };
    const blob = new Blob([serializeSkillMd(skill)], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = skillFileName(skill);
    anchor.click();
    URL.revokeObjectURL(url);
  }
}
