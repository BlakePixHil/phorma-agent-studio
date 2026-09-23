import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { CheckboxModule } from 'primeng/checkbox';
import { InputNumberModule } from 'primeng/inputnumber';
import { SelectModule } from 'primeng/select';
import { TextareaModule } from 'primeng/textarea';

import { DecisionTransportService } from '../../../core/decision-transport.service';
import { WorkflowService } from '../../../core/workflow.service';
import type {
  AgentNodeData,
  AgentPreselectConfig,
  AgentVerifyCheck,
  AgentVerifyConfig,
  WorkflowNode,
} from '../../../core/workflow.model';

/** Built-in verification checks, in display order. */
const VERIFY_CHECKS: readonly { id: AgentVerifyCheck; label: string }[] = [
  { id: 'unsupported', label: 'Unsupported claims' },
  { id: 'off-task', label: 'Off task' },
  { id: 'incomplete', label: 'Incomplete' },
  { id: 'format', label: 'Wrong format' },
];

/** Checks asked when a config names none (mirrors the engine default). */
const DEFAULT_VERIFY_CHECKS: readonly AgentVerifyCheck[] = ['unsupported', 'off-task', 'incomplete'];

const ON_FAIL_OPTIONS: { id: NonNullable<AgentVerifyConfig['onFail']>; label: string }[] = [
  { id: 'fallback', label: 'Rerun on the fallback model' },
  { id: 'error', label: 'Fail the step' },
  { id: 'warn', label: 'Keep the output, log a warning' },
];

/**
 * An agent's System One settings: output verification and tool/skill
 * preselection. Its own component so `AgentConfig` can `@defer` it and keep
 * it out of the initial bundle. Writes go straight through `WorkflowService`.
 */
@Component({
  selector: 'app-agent-decisions',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, CheckboxModule, InputNumberModule, SelectModule, TextareaModule],
  templateUrl: './agent-decisions.html',
  styleUrl: './agent-decisions.scss',
})
export class AgentDecisions {
  private readonly workflow = inject(WorkflowService);
  private readonly decisionTransport = inject(DecisionTransportService);

  readonly agent = input.required<WorkflowNode & { data: AgentNodeData }>();
  /** Id prefix from the host, so panel and dialog ids never collide. */
  readonly scope = input<string>('panel');

  protected readonly verifyChecks = VERIFY_CHECKS;
  protected readonly onFailOptions = ON_FAIL_OPTIONS;

  protected readonly decisionsAvailable = computed(() => this.decisionTransport.available());
  protected readonly verify = computed(() => this.agent().data.verify);
  protected readonly preselect = computed(() => this.agent().data.preselect);

  protected readonly verifyCustomText = computed(() => (this.verify()?.custom ?? []).join('\n'));
  protected readonly verifyFirePercent = computed(() => Math.round((this.verify()?.fireAt ?? 0.7) * 100));
  protected readonly preselectFitPercent = computed(() =>
    Math.round((this.preselect()?.minFit ?? 0.3) * 100),
  );

  /** Fallback escalation chosen, but the agent has no fallback model. */
  protected readonly verifyNeedsFallback = computed(() => {
    const fallback = this.agent().data.fallback;
    return (this.verify()?.onFail ?? 'fallback') === 'fallback' && !(fallback?.provider && fallback.model);
  });

  protected id(suffix: string): string {
    return `${this.scope()}-${suffix}`;
  }

  protected verifyHasCheck(check: AgentVerifyCheck): boolean {
    const checks = this.verify()?.checks;
    return (checks && checks.length > 0 ? checks : DEFAULT_VERIFY_CHECKS).includes(check);
  }

  private patchVerify(patch: Partial<AgentVerifyConfig>): void {
    const current = this.verify() ?? { enabled: false };
    this.workflow.updateNodeData(this.agent().id, { verify: { ...current, ...patch } });
  }

  private patchPreselect(patch: Partial<AgentPreselectConfig>): void {
    const current = this.preselect() ?? { enabled: false };
    this.workflow.updateNodeData(this.agent().id, { preselect: { ...current, ...patch } });
  }

  protected toggleVerify(enabled: boolean): void {
    this.patchVerify({ enabled });
  }

  protected toggleVerifyCheck(check: AgentVerifyCheck, on: boolean): void {
    const current = VERIFY_CHECKS.map(entry => entry.id).filter(id => this.verifyHasCheck(id));
    const next = on ? [...new Set([...current, check])] : current.filter(id => id !== check);
    // Keep display order; never store an empty list (that would mean "defaults").
    const ordered = VERIFY_CHECKS.map(entry => entry.id).filter(id => next.includes(id));
    this.patchVerify({ checks: ordered.length > 0 ? ordered : [check] });
  }

  protected onVerifyCustomChange(text: string): void {
    const custom = (text ?? '')
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean);
    this.patchVerify({ custom: custom.length > 0 ? custom : undefined });
  }

  protected onVerifyFireChange(value: number | null): void {
    const pct = Number(value);
    this.patchVerify({ fireAt: Number.isFinite(pct) && pct > 0 ? Math.min(100, pct) / 100 : undefined });
  }

  protected onVerifyOnFailChange(onFail: AgentVerifyConfig['onFail']): void {
    this.patchVerify({ onFail });
  }

  protected togglePreselect(enabled: boolean): void {
    this.patchPreselect({ enabled });
  }

  protected togglePreselectTools(on: boolean): void {
    this.patchPreselect({ tools: on ? undefined : false });
  }

  protected togglePreselectSkills(on: boolean): void {
    this.patchPreselect({ skills: on ? undefined : false });
  }

  protected onPreselectTopKChange(value: number | null): void {
    const topK = Number(value);
    this.patchPreselect({
      topK: Number.isFinite(topK) && topK > 0 ? Math.min(20, Math.round(topK)) : undefined,
    });
  }

  protected onPreselectFitChange(value: number | null): void {
    const pct = Number(value);
    this.patchPreselect({
      minFit: Number.isFinite(pct) && pct >= 0 ? Math.min(100, pct) / 100 : undefined,
    });
  }
}
