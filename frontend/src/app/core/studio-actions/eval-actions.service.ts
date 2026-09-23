import { Injectable, inject } from '@angular/core';

import type { EvalCase, EvalMatcher, EvalSuite } from '@phorma/engine';

import { EvalRunnerService } from '../eval-runner.service';
import { EvalService } from '../eval.service';
import { WorkflowService } from '../workflow.service';
import {
  actionFail,
  actionOk,
  argStr,
  type ActionArgs,
  type ActionResult,
  type StudioAction,
} from './studio-action.model';

const MATCHERS: readonly EvalMatcher[] = ['exact', 'contains', 'llm-judge'];

/**
 * Surface `evals` Studio_Actions (Requirement 2.1). This is the surface the
 * reported defect landed on: "create an eval for me" used to funnel into
 * `add_node` and drop a node on the canvas. `eval_create_suite` now handles it
 * through {@link EvalService}, leaving the graph untouched (Requirement 8.2).
 *
 * Declared minimums (multi-organisation-phorma Requirement 8.1): the WHOLE
 * surface is builder, reads included, and that is deliberate rather than
 * over-restrictive. `eval.manage` is a builder capability, and the Evals PANEL
 * carries `minLevel: 'builder'` in `DEFAULT_TABS` - so offering an operator an
 * eval read would answer about a surface their studio does not show them, and
 * the panel reveal after the action would do nothing.
 */
@Injectable({ providedIn: 'root' })
export class EvalActionsService {
  private readonly evals = inject(EvalService);
  private readonly runner = inject(EvalRunnerService);
  private readonly workflow = inject(WorkflowService);

  actions(): StudioAction[] {
    return [
      {
        id: 'eval_list_suites',
        label: 'List eval suites',
        description:
          'Lists the eval suites for the active workflow with their ids, names and case counts.',
        surface: 'evals',
        access: 'read',
        risk: 'silent',
        minLevel: 'builder',
        activity: () => 'Listing eval suites',
        run: () => this.listSuites(),
      },
      {
        id: 'eval_read_suite',
        label: 'Read an eval suite',
        description:
          'Returns one eval suite with all of its cases (input, expected value, matcher and judge criteria).',
        surface: 'evals',
        access: 'read',
        risk: 'silent',
        minLevel: 'builder',
        params: { suiteId: { type: 'string', description: 'Suite id.', required: true } },
        activity: () => 'Reading an eval suite',
        run: args => this.readSuite(args),
      },
      {
        id: 'eval_create_suite',
        label: 'Create an eval suite',
        description:
          'Creates an empty eval suite for the active workflow and returns its id. Add cases with eval_add_case. This does NOT touch the canvas.',
        surface: 'evals',
        access: 'write',
        risk: 'silent',
        minLevel: 'builder',
        params: { name: { type: 'string', description: 'Suite name.', required: true } },
        activity: args => `Creating eval suite "${argStr(args, 'name') ?? ''}"`,
        run: args => this.createSuite(args),
      },
      {
        id: 'eval_add_case',
        label: 'Add an eval case',
        description:
          'Adds a test case to an eval suite. `matcher` is exact, contains or llm-judge; llm-judge compares against `expected` as a reference answer and may take extra judgeCriteria.',
        surface: 'evals',
        access: 'write',
        risk: 'silent',
        minLevel: 'builder',
        params: {
          suiteId: { type: 'string', description: 'Suite id.', required: true },
          name: { type: 'string', description: 'Case name.', required: true },
          input: {
            type: 'string',
            description: 'Run input handed to the workflow trigger.',
            required: true,
          },
          expected: {
            type: 'string',
            description: 'Expected output, or the reference answer for llm-judge.',
            required: true,
          },
          matcher: {
            type: 'string',
            description: 'How the output is compared.',
            enum: MATCHERS,
          },
          judgeCriteria: {
            type: 'string',
            description: 'Extra grading instructions (llm-judge only).',
          },
        },
        activity: args => `Adding eval case "${argStr(args, 'name') ?? ''}"`,
        run: args => this.addCase(args),
      },
      {
        id: 'eval_update_case',
        label: 'Update an eval case',
        description: 'Updates the name, input, expected value, matcher or judge criteria of a case.',
        surface: 'evals',
        access: 'write',
        risk: 'silent',
        minLevel: 'builder',
        params: {
          suiteId: { type: 'string', description: 'Suite id.', required: true },
          caseId: { type: 'string', description: 'Case id.', required: true },
          name: { type: 'string', description: 'New case name.' },
          input: { type: 'string', description: 'New run input.' },
          expected: { type: 'string', description: 'New expected output.' },
          matcher: { type: 'string', description: 'New matcher.', enum: MATCHERS },
          judgeCriteria: { type: 'string', description: 'New judge criteria.' },
        },
        activity: () => 'Updating an eval case',
        run: args => this.updateCase(args),
      },
      {
        id: 'eval_remove_case',
        label: 'Remove an eval case',
        description: 'Removes one case from an eval suite.',
        surface: 'evals',
        access: 'write',
        risk: 'confirm',
        minLevel: 'builder',
        params: {
          suiteId: { type: 'string', description: 'Suite id.', required: true },
          caseId: { type: 'string', description: 'Case id.', required: true },
        },
        confirmSummary: args =>
          `Remove case "${this.caseName(argStr(args, 'suiteId'), argStr(args, 'caseId'))}" from suite "${this.suiteName(argStr(args, 'suiteId'))}"?`,
        activity: () => 'Removing an eval case',
        run: args => this.removeCase(args),
      },
      {
        id: 'eval_delete_suite',
        label: 'Delete an eval suite',
        description: 'Deletes an eval suite and its recorded suite runs.',
        surface: 'evals',
        access: 'write',
        risk: 'confirm',
        minLevel: 'builder',
        params: { suiteId: { type: 'string', description: 'Suite id.', required: true } },
        confirmSummary: args =>
          `Delete eval suite "${this.suiteName(argStr(args, 'suiteId'))}" and its run history? This cannot be undone.`,
        activity: args => `Deleting eval suite "${this.suiteName(argStr(args, 'suiteId'))}"`,
        run: args => this.deleteSuite(args),
      },
      {
        id: 'eval_run_suite',
        label: 'Run an eval suite',
        description:
          'Starts an eval suite run. Every case is a real workflow run, so this spends model credits. Returns once the run has started; progress appears in the Evals panel.',
        surface: 'evals',
        access: 'write',
        risk: 'confirm',
        minLevel: 'builder',
        params: {
          suiteId: { type: 'string', description: 'Suite id.', required: true },
          environment: {
            type: 'string',
            description: 'Where the cases run. Defaults to local.',
            enum: ['local', 'cloud'],
          },
        },
        confirmSummary: args => {
          const suite = this.findSuite(argStr(args, 'suiteId'));
          const count = suite?.cases.length ?? 0;
          return `Run eval suite "${suite?.name ?? argStr(args, 'suiteId') ?? ''}"? That executes ${count} workflow run${count === 1 ? '' : 's'} and spends model credits.`;
        },
        activity: args => `Running eval suite "${this.suiteName(argStr(args, 'suiteId'))}"`,
        run: args => this.runSuite(args),
      },
      {
        id: 'eval_cancel_run',
        label: 'Cancel the eval run',
        description: 'Cancels the eval suite run currently in progress.',
        surface: 'evals',
        access: 'write',
        risk: 'silent',
        minLevel: 'builder',
        activity: () => 'Cancelling the eval run',
        run: () => this.cancelRun(),
      },
      {
        id: 'eval_read_results',
        label: 'Read eval results',
        description:
          'Returns the most recent suite run for a suite: status, pass counts and per-case outcomes with scores and errors.',
        surface: 'evals',
        access: 'read',
        risk: 'silent',
        minLevel: 'builder',
        params: { suiteId: { type: 'string', description: 'Suite id.', required: true } },
        activity: () => 'Reading eval results',
        run: args => this.readResults(args),
      },
    ];
  }

  // ── Executors ────────────────────────────────────────────────────────────

  private get activeWorkflowId(): string | null {
    return this.workflow.activeDoc()?.workflowId ?? null;
  }

  private async listSuites(): Promise<ActionResult> {
    await this.evals.refresh(this.activeWorkflowId);
    return actionOk({
      suites: this.evals.suites().map(suite => ({
        id: suite.id,
        name: suite.name,
        cases: suite.cases.length,
        updatedAt: new Date(suite.updatedAt).toISOString(),
      })),
    });
  }

  private async readSuite(args: ActionArgs): Promise<ActionResult> {
    const suite = await this.requireSuite(args);
    if ('message' in suite) return suite;
    return actionOk({
      id: suite.value.id,
      name: suite.value.name,
      judge: suite.value.judge,
      models: suite.value.models,
      cases: suite.value.cases,
    });
  }

  private async createSuite(args: ActionArgs): Promise<ActionResult> {
    const name = argStr(args, 'name');
    if (!name) return actionFail('Missing the suite name.');
    await this.evals.refresh(this.activeWorkflowId);
    const suite = await this.evals.createSuite(this.activeWorkflowId, name);
    return actionOk(
      { suiteId: suite.id, name: suite.name },
      { revertable: false, message: `Created eval suite "${suite.name}" in the Evals panel.` },
    );
  }

  private async addCase(args: ActionArgs): Promise<ActionResult> {
    const found = await this.requireSuite(args);
    if ('message' in found) return found;
    const suite = found.value;
    const name = argStr(args, 'name');
    const input = argStr(args, 'input');
    const expected = argStr(args, 'expected');
    if (!name || !input || !expected) {
      return actionFail('A case needs a name, an input and an expected value.');
    }
    const testCase: EvalCase = {
      id: `case-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      name,
      input,
      expected,
      matcher: (argStr(args, 'matcher') as EvalMatcher | undefined) ?? 'contains',
      ...(argStr(args, 'judgeCriteria') ? { judgeCriteria: argStr(args, 'judgeCriteria')! } : {}),
    };
    await this.evals.saveSuite({ ...suite, cases: [...suite.cases, testCase] });
    return actionOk({ suiteId: suite.id, caseId: testCase.id }, { revertable: false });
  }

  private async updateCase(args: ActionArgs): Promise<ActionResult> {
    const found = await this.requireSuite(args);
    if ('message' in found) return found;
    const suite = found.value;
    const caseId = argStr(args, 'caseId');
    const existing = suite.cases.find(item => item.id === caseId);
    if (!existing) return actionFail(`Case '${caseId ?? ''}' is not in suite "${suite.name}".`);
    const patched: EvalCase = {
      ...existing,
      ...(argStr(args, 'name') ? { name: argStr(args, 'name')! } : {}),
      ...(argStr(args, 'input') ? { input: argStr(args, 'input')! } : {}),
      ...(argStr(args, 'expected') ? { expected: argStr(args, 'expected')! } : {}),
      ...(argStr(args, 'matcher') ? { matcher: argStr(args, 'matcher') as EvalMatcher } : {}),
      ...(argStr(args, 'judgeCriteria') ? { judgeCriteria: argStr(args, 'judgeCriteria')! } : {}),
    };
    await this.evals.saveSuite({
      ...suite,
      cases: suite.cases.map(item => (item.id === existing.id ? patched : item)),
    });
    return actionOk({ suiteId: suite.id, caseId: existing.id }, { revertable: false });
  }

  private async removeCase(args: ActionArgs): Promise<ActionResult> {
    const found = await this.requireSuite(args);
    if ('message' in found) return found;
    const suite = found.value;
    const caseId = argStr(args, 'caseId');
    if (!suite.cases.some(item => item.id === caseId)) {
      return actionFail(`Case '${caseId ?? ''}' is not in suite "${suite.name}".`);
    }
    await this.evals.saveSuite({
      ...suite,
      cases: suite.cases.filter(item => item.id !== caseId),
    });
    return actionOk({ suiteId: suite.id, caseId }, { revertable: false });
  }

  private async deleteSuite(args: ActionArgs): Promise<ActionResult> {
    const found = await this.requireSuite(args);
    if ('message' in found) return found;
    await this.evals.deleteSuite(found.value);
    return actionOk({ suiteId: found.value.id }, { revertable: false });
  }

  private async runSuite(args: ActionArgs): Promise<ActionResult> {
    if (this.runner.running()) return actionFail('An eval suite run is already in progress.');
    const found = await this.requireSuite(args);
    if ('message' in found) return found;
    const suite = found.value;
    if (suite.cases.length === 0) {
      return actionFail(`Suite "${suite.name}" has no cases to run.`);
    }
    const environment = (argStr(args, 'environment') as 'local' | 'cloud' | undefined) ?? 'local';
    if (environment === 'cloud' && !suite.workflowId) {
      return actionFail('Save the workflow before running cloud evals.');
    }
    // Requirement 11.3: report once the run has STARTED, naming where progress
    // shows. Awaiting the whole suite would block the turn for minutes, so the
    // promise is deliberately detached - with a catch, because an unhandled
    // rejection from a detached suite run would surface as a console error the
    // user cannot act on. The Evals panel reports the real outcome.
    void this.runner.runSuite(suite, environment).catch(() => undefined);
    return actionOk(
      { suiteId: suite.id, cases: suite.cases.length, environment },
      {
        revertable: false,
        message: `Started "${suite.name}" (${suite.cases.length} case${suite.cases.length === 1 ? '' : 's'}); progress appears in the Evals panel.`,
      },
    );
  }

  private cancelRun(): ActionResult {
    if (!this.runner.running()) return actionFail('No eval suite run is in progress.');
    this.runner.cancel();
    return actionOk(undefined, { revertable: false });
  }

  private async readResults(args: ActionArgs): Promise<ActionResult> {
    const found = await this.requireSuite(args);
    if ('message' in found) return found;
    const suite = found.value;
    await this.evals.refreshRuns(suite.id);
    const latest = this.evals.runs()[0];
    if (!latest) return actionOk({ suiteId: suite.id, runs: 0, message: 'No eval runs recorded.' });
    const byId = new Map(suite.cases.map(item => [item.id, item.name]));
    return actionOk({
      suiteId: suite.id,
      runId: latest.id,
      status: latest.status,
      environment: latest.environment,
      models: latest.models,
      startedAt: new Date(latest.startedAt).toISOString(),
      passed: latest.results.filter(result => result.status === 'passed').length,
      total: latest.results.length,
      results: latest.results.map(result => ({
        caseId: result.caseId,
        caseName: byId.get(result.caseId) ?? result.caseId,
        model: result.model,
        status: result.status,
        score: result.score,
        error: result.error,
        judgeReasoning: result.judgeReasoning,
        runId: result.runId,
      })),
    });
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private async requireSuite(
    args: ActionArgs,
  ): Promise<{ value: EvalSuite } | (ActionResult & { message: string })> {
    const suiteId = argStr(args, 'suiteId');
    if (!suiteId) return { ok: false, message: 'Missing the suite id.' };
    await this.evals.refresh(this.activeWorkflowId);
    const suite = this.evals.suites().find(item => item.id === suiteId);
    if (!suite) {
      return {
        ok: false,
        message: `Eval suite '${suiteId}' was not found for this workflow.`,
      };
    }
    return { value: suite };
  }

  private findSuite(suiteId: string | undefined): EvalSuite | undefined {
    return this.evals.suites().find(item => item.id === suiteId);
  }

  private suiteName(suiteId: string | undefined): string {
    return this.findSuite(suiteId)?.name ?? suiteId ?? 'the suite';
  }

  private caseName(suiteId: string | undefined, caseId: string | undefined): string {
    return (
      this.findSuite(suiteId)?.cases.find(item => item.id === caseId)?.name ?? caseId ?? 'the case'
    );
  }
}
