import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { CheckboxModule } from 'primeng/checkbox';
import { InputNumberModule } from 'primeng/inputnumber';
import { InputTextModule } from 'primeng/inputtext';
import { SelectModule } from 'primeng/select';
import { TextareaModule } from 'primeng/textarea';

import { DecisionTransportService } from '../../../core/decision-transport.service';
import { WorkflowService } from '../../../core/workflow.service';
import type {
  ApprovalAutoResolve,
  ApprovalGateData,
  DecideNodeData,
  DecisionQuestionSpec,
  PortalGuardrailHazard,
  PortalGuardrailSide,
  PortalGuardrails,
  PortalTriggerData,
  RouterNodeData,
  WorkflowNode,
} from '../../../core/workflow.model';
import { SettingsDialogService } from '../../settings/settings-dialog.service';

type QuestionType = DecisionQuestionSpec['type'];

const QUESTION_TYPES: { id: QuestionType; label: string }[] = [
  { id: 'noul', label: 'Yes / no' },
  { id: 'choice', label: 'Choice' },
  { id: 'score', label: 'Score' },
];

const ROUTER_MODES: { id: 'keyword' | 'decide'; label: string }[] = [
  { id: 'keyword', label: 'Keyword match' },
  { id: 'decide', label: 'System One decides' },
];

type GuardSide = 'input' | 'output';

/** Both screening sides, with their toggle labels. */
const GUARD_SIDES: { id: GuardSide; label: string }[] = [
  { id: 'input', label: 'Screen visitor messages' },
  { id: 'output', label: 'Screen answers before they are sent' },
];

const HAZARDS: { id: PortalGuardrailHazard; label: string }[] = [
  { id: 'jailbreak', label: 'Jailbreaks' },
  { id: 'harmful', label: 'Harm or illegal' },
  { id: 'medical', label: 'Medical advice' },
  { id: 'self-harm', label: 'Self-harm' },
];

/** Question ids: a letter, then letters, digits or `_` (mirrors the engine). */
const QUESTION_ID = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

/**
 * System One (TypeSafe Jev) configuration for the three graph-walk consumers:
 * Router "Decide" mode, Approval Gate auto-resolve, and the Decide node's
 * question list. A separate component so its styles stay out of the (already
 * large) properties form sheet and it can be deferred.
 *
 * Writes go straight through `WorkflowService`, exactly like the host form.
 */
@Component({
  selector: 'app-decision-config',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, ButtonModule, CheckboxModule, InputNumberModule, InputTextModule, SelectModule, TextareaModule],
  templateUrl: './decision-config.html',
  styleUrl: './decision-config.scss',
})
export class DecisionConfig {
  private readonly workflow = inject(WorkflowService);
  private readonly decisions = inject(DecisionTransportService);
  private readonly settingsDialog = inject(SettingsDialogService);

  /** The selected node (router, approval-gate, decide or portal-trigger). */
  readonly node = input.required<WorkflowNode>();
  /** Id prefix from the host form, so panel and dialog ids never collide. */
  readonly scope = input<string>('panel');

  protected readonly questionTypes = QUESTION_TYPES;
  protected readonly routerModes = ROUTER_MODES;
  protected readonly available = this.decisions.available;
  protected readonly backendLabel = this.decisions.backendLabel;

  protected id(suffix: string): string {
    return `${this.scope()}-dc-${suffix}`;
  }

  // ── Router ────────────────────────────────────────────────────────────────

  protected readonly router = computed<RouterNodeData | null>(() => {
    const node = this.node();
    return node.kind === 'router' ? ((node.data ?? {}) as RouterNodeData) : null;
  });

  /** Route ports offered as options (the unsure port excluded). */
  protected readonly routes = computed(() => {
    const node = this.node();
    const unsure = this.router()?.unsurePortId;
    return node.ports.filter(port => port.role === 'message-out' && port.id !== unsure);
  });

  protected readonly unsurePort = computed(() => {
    const unsure = this.router()?.unsurePortId;
    return unsure ? (this.node().ports.find(port => port.id === unsure) ?? null) : null;
  });

  protected setRouterMode(mode: 'keyword' | 'decide'): void {
    this.patch({ mode });
  }

  protected setRouteCriteria(portId: string, value: string): void {
    const current = { ...(this.router()?.routeCriteria ?? {}) };
    if (value.trim()) current[portId] = value;
    else delete current[portId];
    this.patch({ routeCriteria: current });
  }

  protected toggleUnsure(enabled: boolean): void {
    const node = this.node();
    const data = this.router();
    if (!data) return;
    if (enabled) {
      if (this.unsurePort()) return;
      const port = { id: `${node.id}-unsure${Date.now().toString(36)}`, name: 'Not sure', role: 'message-out' as const };
      this.workflow.updateNodePorts(node.id, [...node.ports, port]);
      this.patch({ unsurePortId: port.id });
      return;
    }
    const portId = data.unsurePortId;
    this.patch({ unsurePortId: undefined });
    if (portId) this.workflow.updateNodePorts(node.id, node.ports.filter(port => port.id !== portId));
  }

  // ── Approval gate ─────────────────────────────────────────────────────────

  protected readonly gate = computed<ApprovalAutoResolve | null>(() => {
    const node = this.node();
    if (node.kind !== 'approval-gate') return null;
    return (node.data as ApprovalGateData).autoResolve ?? { enabled: false };
  });

  protected patchGate(patch: Partial<ApprovalAutoResolve>): void {
    const current = this.gate() ?? { enabled: false };
    this.patch({ autoResolve: { ...current, ...patch } });
  }

  /** Thresholds as whole percentages for the inputs. */
  protected percent(value: number | undefined, fallback: number): number {
    return Math.round((typeof value === 'number' ? value : fallback) * 100);
  }

  protected setPercent(field: 'approveAt' | 'rejectAt' | 'minConfidence', value: number | null): void {
    const fraction = typeof value === 'number' && Number.isFinite(value) ? Math.min(100, Math.max(0, value)) / 100 : undefined;
    if (field === 'minConfidence') this.patch({ minConfidence: fraction });
    else this.patchGate({ [field]: fraction });
  }

  // ── Decide node ───────────────────────────────────────────────────────────

  protected readonly decide = computed<DecideNodeData | null>(() => {
    const node = this.node();
    return node.kind === 'decide' ? ((node.data ?? { questions: [] }) as DecideNodeData) : null;
  });

  protected readonly questions = computed(() => this.decide()?.questions ?? []);

  /** Ids that are malformed or duplicated, for inline error styling. */
  protected readonly badIds = computed(() => {
    const seen = new Set<string>();
    const bad = new Set<number>();
    this.questions().forEach((question, index) => {
      if (!QUESTION_ID.test(question.id) || seen.has(question.id)) bad.add(index);
      seen.add(question.id);
    });
    return bad;
  });

  protected addQuestion(type: QuestionType): void {
    const list = [...this.questions()];
    const base = type === 'noul' ? 'is_' : type === 'choice' ? 'category' : 'level';
    let n = list.length + 1;
    let id = `${base}${n}`;
    while (list.some(question => question.id === id)) id = `${base}${++n}`;
    const question: DecisionQuestionSpec =
      type === 'choice'
        ? { id, type, instructions: '', options: [{ label: 'Option A' }, { label: 'Option B' }] }
        : type === 'score'
          ? { id, type, instructions: '', levels: ['Low', 'Medium', 'High'] }
          : { id, type, instructions: '' };
    this.patch({ questions: [...list, question] });
  }

  protected removeQuestion(index: number): void {
    this.patch({ questions: this.questions().filter((_, i) => i !== index) });
  }

  protected patchQuestion(index: number, patch: Partial<DecisionQuestionSpec>): void {
    const list = this.questions().map((question, i) => (i === index ? { ...question, ...patch } : question));
    this.patch({ questions: list });
  }

  protected changeType(index: number, type: QuestionType): void {
    const question = this.questions()[index];
    if (!question || question.type === type) return;
    this.patchQuestion(index, {
      type,
      options: type === 'choice' ? (question.options ?? [{ label: 'Option A' }, { label: 'Option B' }]) : undefined,
      levels: type === 'score' ? (question.levels ?? ['Low', 'Medium', 'High']) : undefined,
    });
  }

  protected patchOption(index: number, optionIndex: number, patch: { label?: string; description?: string }): void {
    const options = [...(this.questions()[index]?.options ?? [])];
    options[optionIndex] = { ...options[optionIndex], ...patch } as { label: string; description?: string };
    this.patchQuestion(index, { options });
  }

  protected addOption(index: number): void {
    const options = [...(this.questions()[index]?.options ?? [])];
    options.push({ label: `Option ${String.fromCharCode(65 + options.length)}` });
    this.patchQuestion(index, { options });
  }

  protected removeOption(index: number, optionIndex: number): void {
    const options = (this.questions()[index]?.options ?? []).filter((_, i) => i !== optionIndex);
    this.patchQuestion(index, { options });
  }

  /** Score levels edited as one level per line. */
  protected levelsText(question: DecisionQuestionSpec): string {
    return (question.levels ?? []).join('\n');
  }

  protected setLevels(index: number, text: string): void {
    this.patchQuestion(index, { levels: text.split('\n').map(line => line.trim()).filter(Boolean).slice(0, 10) });
  }

  /** How a downstream expression reads the answer. */
  protected readHint(question: DecisionQuestionSpec): string {
    const key = (this.decide()?.resultKey ?? '').trim() || 'decisions';
    return question.type === 'noul'
      ? `$.${key}.${question.id} > 0.7`
      : question.type === 'choice'
        ? `$.${key}.${question.id}.choice`
        : `$.${key}.${question.id}.score`;
  }

  // ── Portal guardrails ─────────────────────────────────────────────────────

  protected readonly hazards = HAZARDS;
  protected readonly guardSides = GUARD_SIDES;

  protected readonly guard = computed<PortalGuardrails | null>(() => {
    const node = this.node();
    if (node.kind !== 'portal-trigger') return null;
    return (node.data as PortalTriggerData).guardrails ?? {};
  });

  protected readonly guardEnabled = computed(() => {
    const guard = this.guard();
    return !!guard && (guard.input?.enabled === true || guard.output?.enabled === true);
  });

  protected patchGuard(patch: Partial<PortalGuardrails>): void {
    this.patch({ guardrails: { ...(this.guard() ?? {}), ...patch } });
  }

  protected patchSide(side: GuardSide, patch: Partial<PortalGuardrailSide>): void {
    const current = this.guard()?.[side] ?? { enabled: false };
    this.patchGuard({ [side]: { ...current, ...patch } });
  }

  protected hasHazard(side: GuardSide, hazard: PortalGuardrailHazard): boolean {
    const list = this.guard()?.[side]?.hazards;
    return !list || list.length === 0 || list.includes(hazard);
  }

  protected toggleHazard(side: GuardSide, hazard: PortalGuardrailHazard, on: boolean): void {
    const current = HAZARDS.map(entry => entry.id).filter(id => this.hasHazard(side, id));
    const next = on ? [...new Set([...current, hazard])] : current.filter(id => id !== hazard);
    const ordered = HAZARDS.map(entry => entry.id).filter(id => next.includes(id));
    // An empty list means "every hazard"; keep at least one explicit hazard.
    this.patchSide(side, { hazards: ordered.length > 0 ? ordered : [hazard] });
  }

  // ── Shared ────────────────────────────────────────────────────────────────

  protected patch(patch: Record<string, unknown>): void {
    this.workflow.updateNodeData(this.node().id, patch);
  }

  protected value(event: Event): string {
    return (event.target as HTMLInputElement | HTMLTextAreaElement | null)?.value ?? '';
  }

  protected openSettings(): void {
    this.settingsDialog.open('api-keys');
  }
}
