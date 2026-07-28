import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { DomSanitizer, type SafeHtml } from '@angular/platform-browser';
import { DatePipe, NgTemplateOutlet } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { SelectModule } from 'primeng/select';
import { SelectButtonModule } from 'primeng/selectbutton';
import { TextareaModule } from 'primeng/textarea';

import { AgentConfig } from '../agent-config/agent-config';
import { ConfirmDialogService } from '../../../shared/confirm-dialog/confirm-dialog.service';
import { FieldGenerationService } from '../../../core/field-generation.service';
import { PanelExpandService } from '../../../core/panel-expand.service';
import { PromptLibraryService } from '../../../core/prompt-library.service';
import { SelectionService } from '../../../core/selection.service';
import { ToastService } from '../../../shared/toast/toast.service';
import { WorkflowService } from '../../../core/workflow.service';
import { ExpandedPanelDialog } from '../../../shared/expanded-panel-dialog/expanded-panel-dialog';
import { renderMarkdown } from '../../../shared/markdown/render-markdown';
import {
  PROMPT_CONTENT_SOFT_CAP,
  agentPresetLabel,
  agentPresetOptions,
  captureSeedFromNode,
  promptFileName,
  promptVariables,
  serializePromptMd,
  type PromptEntry,
} from '../../../core/prompt-library.model';
import { isAgentNode, type AgentNodeData, type WorkflowNode } from '../../../core/workflow.model';

/** Editor layout modes for the centre column. */
type EditorMode = 'edit' | 'split' | 'preview';

/** Markdown scaffolding the toolbar can insert at the caret. */
const SNIPPETS: { label: string; title: string; text: string }[] = [
  { label: '# Role', title: 'Insert a Role heading', text: '# Role\n\nYou are …\n\n' },
  { label: '# Rules', title: 'Insert a Rules heading', text: '# Rules\n\n- \n\n' },
  { label: '# Task', title: 'Insert a Task heading', text: '# Task\n\n{{input}}\n' },
  { label: '# Output', title: 'Insert an Output heading', text: '# Output\n\n- \n\n' },
  { label: '{{input}}', title: 'Insert the incoming task variable', text: '{{input}}' },
];

/**
 * The expanded Prompt panel: a three-column prompt workbench.
 *
 * Left is the prompt library (built-in catalog prompts plus the user's saved
 * ones), centre is a full-height markdown editor with an optional side-by-side
 * preview, right is the shared {@link AgentConfig} rail. All edits write
 * straight through to the workflow document, so the sidebar panel and the
 * canvas stay in lockstep with no synchronisation.
 */
@Component({
  selector: 'app-prompt-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    AgentConfig,
    DatePipe,
    ExpandedPanelDialog,
    FormsModule,
    NgTemplateOutlet,
    ButtonModule,
    InputTextModule,
    SelectButtonModule,
    SelectModule,
    TextareaModule,
  ],
  templateUrl: './prompt-dialog.html',
  styleUrl: './prompt-dialog.scss',
})
export class PromptDialog {
  private readonly expand = inject(PanelExpandService);
  private readonly selection = inject(SelectionService);
  private readonly workflow = inject(WorkflowService);
  private readonly sanitizer = inject(DomSanitizer);
  private readonly confirmDialog = inject(ConfirmDialogService);
  private readonly toast = inject(ToastService);
  protected readonly library = inject(PromptLibraryService);
  protected readonly fieldGen = inject(FieldGenerationService);

  private readonly editorRef = viewChild<ElementRef<HTMLTextAreaElement>>('editor');
  private readonly fileInput = viewChild<ElementRef<HTMLInputElement>>('fileInput');

  protected readonly visible = computed(() => this.expand.isOpen('prompt'));

  /** The selected agent node, or null when the selection isn't an agent. */
  protected readonly agent = computed<(WorkflowNode & { data: AgentNodeData }) | null>(() => {
    const node = this.selection.selectedNode();
    return node && isAgentNode(node) ? node : null;
  });

  protected readonly softCap = PROMPT_CONTENT_SOFT_CAP;
  protected readonly presetOptions = agentPresetOptions();
  protected readonly snippets = SNIPPETS;

  protected readonly modeOptions: { label: string; value: EditorMode }[] = [
    { label: 'Edit', value: 'edit' },
    { label: 'Split', value: 'split' },
    { label: 'Preview', value: 'preview' },
  ];

  protected readonly mode = signal<EditorMode>('split');

  // ── Library filters ─────────────────────────────────────────────────────

  protected readonly search = signal('');
  protected readonly presetFilter = signal<string | null>(null);
  protected readonly tagFilter = signal<string | null>(null);

  /** Library entries matching the search, preset and tag filters. */
  protected readonly filtered = computed<PromptEntry[]>(() => {
    const needle = this.search().trim().toLowerCase();
    const preset = this.presetFilter();
    const tag = this.tagFilter();
    return this.library.all().filter(entry => {
      if (preset && entry.presetId !== preset) return false;
      if (tag && !(entry.tags ?? []).includes(tag)) return false;
      if (!needle) return true;
      return (
        entry.name.toLowerCase().includes(needle) ||
        (entry.description ?? '').toLowerCase().includes(needle) ||
        (entry.tags ?? []).some(tag => tag.toLowerCase().includes(needle)) ||
        (entry.keywords ?? []).some(word => word.toLowerCase().includes(needle)) ||
        entry.content.toLowerCase().includes(needle)
      );
    });
  });

  protected readonly builtInResults = computed(() => this.filtered().filter(e => e.builtIn));
  protected readonly userResults = computed(() => this.filtered().filter(e => !e.builtIn));

  protected readonly hasFilters = computed(
    () => !!this.search().trim() || !!this.presetFilter() || !!this.tagFilter(),
  );

  protected clearFilters(): void {
    this.search.set('');
    this.presetFilter.set(null);
    this.tagFilter.set(null);
  }

  protected toggleTag(tag: string): void {
    this.tagFilter.update(current => (current === tag ? null : tag));
  }

  protected presetLabel(presetId: string | undefined): string {
    return agentPresetLabel(presetId);
  }

  // ── Editor ──────────────────────────────────────────────────────────────

  protected readonly promptText = computed(() => this.agent()?.data.prompt ?? '');

  protected readonly previewHtml = computed<SafeHtml>(() =>
    this.sanitizer.bypassSecurityTrustHtml(renderMarkdown(this.promptText())),
  );

  protected readonly charCount = computed(() => this.promptText().length);

  protected readonly wordCount = computed(() => {
    const words = this.promptText().trim().match(/\S+/g);
    return words ? words.length : 0;
  });

  /** Rough token estimate - ~4 characters per token is close enough to guide. */
  protected readonly tokenEstimate = computed(() => Math.ceil(this.charCount() / 4));

  protected readonly overSoftCap = computed(() => this.charCount() > PROMPT_CONTENT_SOFT_CAP);

  /** `{{variable}}` placeholders the prompt expects, in first-use order. */
  protected readonly variables = computed(() => promptVariables(this.promptText()));

  protected onPromptInput(event: Event): void {
    const agent = this.agent();
    if (!agent) return;
    const prompt = (event.target as HTMLTextAreaElement | null)?.value ?? '';
    this.workflow.updateNodeData(agent.id, { prompt });
  }

  /** True while the AI is drafting this agent's prompt. */
  protected readonly generating = computed(
    () => this.fieldGen.generatingFor() === this.agent()?.id,
  );

  protected async generatePrompt(): Promise<void> {
    const agent = this.agent();
    if (!agent || this.generating()) return;
    const prompt = await this.fieldGen.generateAgentPrompt(agent).catch(() => null);
    const current = this.agent();
    if (prompt && current?.id === agent.id) {
      this.workflow.updateNodeData(current.id, { prompt });
    }
  }

  /** Inserts markdown at the caret (or appends when the editor isn't focused). */
  protected insertSnippet(text: string): void {
    this.insertAtCaret(text);
  }

  private insertAtCaret(text: string): void {
    const agent = this.agent();
    if (!agent) return;
    const editor = this.editorRef()?.nativeElement;
    const current = agent.data.prompt ?? '';
    if (!editor) {
      this.workflow.updateNodeData(agent.id, { prompt: `${current}${text}` });
      return;
    }
    const start = editor.selectionStart ?? current.length;
    const end = editor.selectionEnd ?? start;
    const next = `${current.slice(0, start)}${text}${current.slice(end)}`;
    this.workflow.updateNodeData(agent.id, { prompt: next });
    // Restore the caret after Angular re-renders the bound value.
    const caret = start + text.length;
    queueMicrotask(() => {
      editor.focus();
      editor.setSelectionRange(caret, caret);
    });
  }

  // ── Applying library entries ────────────────────────────────────────────

  /** Replaces the agent's prompt with a library entry (confirms overwrites). */
  protected async apply(entry: PromptEntry): Promise<void> {
    const agent = this.agent();
    if (!agent) return;
    const current = (agent.data.prompt ?? '').trim();
    if (current && current !== entry.content.trim()) {
      const ok = await this.confirmDialog.confirm({
        title: 'Replace this prompt?',
        message: `"${entry.name}" will overwrite the current prompt for ${agent.name}. This can be undone from the canvas.`,
        confirmLabel: 'Replace',
        tone: 'danger',
      });
      if (!ok) return;
    }
    // Re-read: the selection may have changed while the confirm was open.
    const target = this.agent();
    if (!target) return;
    this.workflow.updateNodeData(target.id, { prompt: entry.content });
    void this.library.markUsed(entry.id);
  }

  /** Inserts a library entry at the caret instead of replacing the prompt. */
  protected insert(entry: PromptEntry): void {
    if (!this.agent()) return;
    this.insertAtCaret(entry.content.trim() + '\n\n');
    void this.library.markUsed(entry.id);
  }

  // ── Library CRUD ────────────────────────────────────────────────────────

  /** The entry open in the inline save/edit form, or null when closed. */
  protected readonly editing = signal<PromptEntry | null>(null);
  /** True when the form is creating rather than editing. */
  protected readonly creatingNew = signal(false);

  protected readonly formName = signal('');
  protected readonly formDescription = signal('');
  protected readonly formPreset = signal<string | null>(null);
  protected readonly formTags = signal('');

  /** Opens the form pre-filled from the selected agent's current prompt. */
  protected saveCurrent(): void {
    const agent = this.agent();
    if (!agent) return;
    const seed = captureSeedFromNode(agent);
    if (!seed) return;
    this.openForm(null, {
      name: seed.name,
      description: '',
      preset: seed.presetId ?? null,
      tags: '',
    });
  }

  /** Opens an empty form for a brand-new library entry. */
  protected newPrompt(): void {
    this.openForm(null, { name: '', description: '', preset: null, tags: '' });
  }

  protected editEntry(entry: PromptEntry): void {
    this.openForm(entry, {
      name: entry.name,
      description: entry.description ?? '',
      preset: entry.presetId ?? null,
      tags: (entry.tags ?? []).join(', '),
    });
  }

  private openForm(
    entry: PromptEntry | null,
    values: { name: string; description: string; preset: string | null; tags: string },
  ): void {
    this.editing.set(entry);
    this.creatingNew.set(entry === null);
    this.formName.set(values.name);
    this.formDescription.set(values.description);
    this.formPreset.set(values.preset);
    this.formTags.set(values.tags);
  }

  protected closeForm(): void {
    this.editing.set(null);
    this.creatingNew.set(false);
  }

  protected readonly formValid = computed(() => this.formName().trim().length > 0);

  /** Commits the inline form: creates a new entry or updates an existing one. */
  protected async submitForm(): Promise<void> {
    if (!this.formValid()) return;
    const tags = this.formTags()
      .split(',')
      .map(tag => tag.trim())
      .filter(Boolean);
    const existing = this.editing();

    if (existing) {
      await this.library.savePrompt({
        ...existing,
        name: this.formName().trim(),
        description: this.formDescription().trim() || undefined,
        presetId: this.formPreset() ?? undefined,
        tags: tags.length > 0 ? tags : undefined,
      });
      this.toast.success('Prompt updated', existing.name);
    } else {
      // New entries capture whatever is in the editor right now.
      const content = this.promptText();
      if (!content.trim()) {
        this.toast.warning('Nothing to save', 'The prompt editor is empty.');
        return;
      }
      const created = await this.library.createPrompt({
        name: this.formName().trim(),
        description: this.formDescription().trim() || undefined,
        content,
        presetId: this.formPreset() ?? undefined,
        tags,
      });
      this.toast.success('Saved to library', created.name);
    }
    this.closeForm();
  }

  protected async fork(entry: PromptEntry): Promise<void> {
    const copy = await this.library.fork(entry);
    this.toast.success(entry.builtIn ? 'Forked to your library' : 'Duplicated', copy.name);
  }

  protected async remove(entry: PromptEntry): Promise<void> {
    const ok = await this.confirmDialog.confirm({
      title: 'Delete prompt?',
      message: `"${entry.name}" will be removed from your library. Agents already using it keep their copy.`,
      confirmLabel: 'Delete',
      tone: 'danger',
    });
    if (!ok) return;
    await this.library.deletePrompt(entry.id);
    if (this.editing()?.id === entry.id) this.closeForm();
  }

  /** Downloads an entry as PROMPT.md. */
  protected exportEntry(entry: PromptEntry): void {
    const blob = new Blob([serializePromptMd(entry)], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = promptFileName(entry);
    link.click();
    // Deferred: revoking synchronously can invalidate the URL before the
    // browser has started reading it, producing an empty download.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  protected pickImportFile(): void {
    this.fileInput()?.nativeElement.click();
  }

  protected async onImportFile(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    // Clear immediately so re-picking the same file still fires a change event.
    input.value = '';
    if (!file) return;
    const entry = await this.library.importPromptMd(await file.text());
    if (entry) this.toast.success('Prompt imported', entry.name);
    else this.toast.error('Could not import', 'The file had no readable prompt content.');
  }

  constructor() {
    // The library is warmed at construction, but refresh on open so entries
    // saved in another window show up.
    effect(() => {
      if (!this.visible()) return;
      untracked(() => void this.library.refresh());
    });

    // Close the inline form whenever the dialog closes, so re-opening is clean.
    effect(() => {
      if (this.visible()) return;
      untracked(() => this.closeForm());
    });
  }
}
