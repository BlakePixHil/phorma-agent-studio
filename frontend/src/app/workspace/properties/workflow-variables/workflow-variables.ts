import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { CheckboxModule } from 'primeng/checkbox';
import { InputTextModule } from 'primeng/inputtext';
import { SelectModule } from 'primeng/select';
import { TextareaModule } from 'primeng/textarea';

import { validateWorkflowVariables } from '@phorma/engine';

import { WorkflowService } from '../../../core/workflow.service';
import type { WorkflowVariable, WorkflowVariableType } from '../../../core/workflow.model';

const VARIABLE_TYPES: { id: WorkflowVariableType; label: string }[] = [
  { id: 'text', label: 'Text' },
  { id: 'markdown', label: 'Markdown' },
  { id: 'number', label: 'Number' },
  { id: 'boolean', label: 'Yes / no' },
  { id: 'list', label: 'List' },
];

/** The value a freshly retyped variable starts with. */
function emptyValue(type: WorkflowVariableType): WorkflowVariable['value'] {
  switch (type) {
    case 'number':
      return 0;
    case 'boolean':
      return false;
    case 'list':
      return [];
    default:
      return '';
  }
}

/**
 * The workflow's named variables (document delivery G1), edited in the
 * Properties panel's no-selection state. Every value is read in templates as
 * `{{vars.name}}` and in expressions as `vars.name`, so a setting used by a
 * prompt, a URL and a guard is edited here once.
 *
 * Writes go through `WorkflowService.updateSettings`, exactly like the
 * timeout field beside it. Validation is the engine's own, so the panel shows
 * the same sentence a run or a deploy would refuse with.
 */
@Component({
  selector: 'app-workflow-variables',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, ButtonModule, CheckboxModule, InputTextModule, SelectModule, TextareaModule],
  templateUrl: './workflow-variables.html',
  styleUrl: './workflow-variables.scss',
})
export class WorkflowVariables {
  private readonly workflow = inject(WorkflowService);

  /** Id prefix from the host form, so panel and dialog ids never collide. */
  readonly scope = input<string>('panel');

  protected readonly types = VARIABLE_TYPES;

  protected readonly variables = computed<WorkflowVariable[]>(
    () => this.workflow.activeDoc()?.settings?.variables ?? [],
  );

  /** Engine validation, one message list per variable index. */
  protected readonly issues = computed(() => {
    const byName = new Map<string, string[]>();
    for (const issue of validateWorkflowVariables(this.variables())) {
      byName.set(issue.name, [...(byName.get(issue.name) ?? []), issue.message]);
    }
    return byName;
  });

  protected id(index: number, suffix: string): string {
    return `${this.scope()}-wfvar-${index}-${suffix}`;
  }

  protected issuesFor(variable: WorkflowVariable): string[] {
    return this.issues().get(variable.name.trim() || '(unnamed)') ?? [];
  }

  protected add(): void {
    const taken = new Set(this.variables().map(variable => variable.name));
    let index = this.variables().length + 1;
    while (taken.has(`variable${index}`)) index += 1;
    this.write([...this.variables(), { name: `variable${index}`, type: 'text', value: '' }]);
  }

  protected remove(index: number): void {
    this.write(this.variables().filter((_, at) => at !== index));
  }

  protected patch(index: number, patch: Partial<WorkflowVariable>): void {
    this.write(this.variables().map((variable, at) => (at === index ? { ...variable, ...patch } : variable)));
  }

  protected setType(index: number, type: WorkflowVariableType): void {
    this.patch(index, { type, value: emptyValue(type) });
  }

  protected text(event: Event): string {
    return (event.target as HTMLInputElement | HTMLTextAreaElement | null)?.value ?? '';
  }

  protected onName(index: number, event: Event): void {
    this.patch(index, { name: this.text(event).trim() });
  }

  protected onNumber(index: number, event: Event): void {
    const raw = this.text(event).trim();
    const parsed = Number(raw);
    this.patch(index, { value: raw.length > 0 && Number.isFinite(parsed) ? parsed : raw });
  }

  protected onList(index: number, event: Event): void {
    const items = this.text(event)
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0);
    this.patch(index, { value: items });
  }

  protected listText(value: WorkflowVariable['value']): string {
    return Array.isArray(value) ? value.join('\n') : String(value ?? '');
  }

  protected stringValue(value: WorkflowVariable['value']): string {
    return Array.isArray(value) ? value.join(', ') : String(value ?? '');
  }

  private write(variables: WorkflowVariable[]): void {
    this.workflow.updateSettings({ variables: variables.length > 0 ? variables : undefined });
  }
}
