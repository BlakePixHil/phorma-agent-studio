import { Injectable, inject } from '@angular/core';

import { RunControllerService } from '../run-controller.service';
import { RunHistoryService } from '../run-history.service';
import { WorkflowService } from '../workflow.service';
import {
  actionFail,
  actionOk,
  argBool,
  argNum,
  argStr,
  type ActionArgs,
  type ActionResult,
  type StudioAction,
} from './studio-action.model';

/** Cap on run records returned by a single list call. */
const RUN_LIST_LIMIT = 20;

/**
 * Surface `runs` Studio_Actions (Requirement 2.2) - run control plus run
 * history, all through {@link RunControllerService} and
 * {@link RunHistoryService}.
 *
 * Starting a run spends model credits, so it is confirm-tier
 * (Requirement 6.1); the rest of the transport controls are silent because the
 * user can see and undo them from the toolbar.
 */
@Injectable({ providedIn: 'root' })
export class RunActionsService {
  private readonly runs = inject(RunControllerService);
  private readonly history = inject(RunHistoryService);
  private readonly workflow = inject(WorkflowService);

  actions(): StudioAction[] {
    return [
      {
        id: 'run_start',
        label: 'Run the workflow',
        description:
          'Starts a run of the active workflow. Pass `input` to set the task text first. Returns once the run has started; progress appears in the Runs panel and on the canvas.',
        surface: 'runs',
        access: 'write',
        risk: 'confirm',
        params: {
          input: { type: 'string', description: 'Task text handed to the trigger node.' },
        },
        confirmSummary: args => {
          const input = argStr(args, 'input');
          return `Run "${this.workflow.activeName()}"? This executes the workflow and spends model credits.${
            input ? `\n\nInput: ${clip(input, 160)}` : ''
          }`;
        },
        activity: () => `Running "${this.workflow.activeName()}"`,
        run: args => this.start(args),
      },
      {
        id: 'run_pause_resume',
        label: 'Pause or resume the run',
        description: 'Pauses a running workflow, or resumes it when already paused.',
        surface: 'runs',
        access: 'write',
        risk: 'silent',
        activity: () => 'Pausing or resuming the run',
        run: () => this.pauseOrResume(),
      },
      {
        id: 'run_step',
        label: 'Step the run',
        description: 'Advances a paused run by one node.',
        surface: 'runs',
        access: 'write',
        risk: 'silent',
        activity: () => 'Stepping the run',
        run: () => this.step(),
      },
      {
        id: 'run_stop',
        label: 'Stop the run',
        description: 'Stops the run in progress.',
        surface: 'runs',
        access: 'write',
        risk: 'silent',
        activity: () => 'Stopping the run',
        run: () => this.stop(),
      },
      {
        id: 'run_reset',
        label: 'Reset the run session',
        description:
          'Clears the finished run from the canvas and the Runs panel, back to a pre-run state.',
        surface: 'runs',
        access: 'write',
        risk: 'silent',
        activity: () => 'Resetting the run session',
        run: () => this.reset(),
      },
      {
        id: 'run_toggle_breakpoint',
        label: 'Toggle a breakpoint',
        description: 'Toggles the run breakpoint on a node, so the next run pauses before it.',
        surface: 'runs',
        access: 'write',
        risk: 'silent',
        params: {
          nodeId: { type: 'string', description: 'Node id.', required: true },
        },
        activity: args => `Toggling the breakpoint on ${argStr(args, 'nodeId') ?? 'a node'}`,
        run: args => this.toggleBreakpoint(args),
      },
      {
        id: 'run_resolve_approval',
        label: 'Resolve an approval',
        description:
          'Approves or rejects an approval gate waiting on a human. Read the pending gates with run_read_state first.',
        surface: 'runs',
        access: 'write',
        risk: 'confirm',
        params: {
          requestId: { type: 'string', description: 'Pending approval request id.', required: true },
          approved: {
            type: 'boolean',
            description: 'True to approve, false to reject.',
            required: true,
          },
        },
        confirmSummary: args =>
          `${argBool(args, 'approved') ? 'Approve' : 'Reject'} the approval gate on "${this.approvalName(argStr(args, 'requestId'))}"?`,
        activity: args =>
          `${argBool(args, 'approved') ? 'Approving' : 'Rejecting'} an approval gate`,
        run: args => this.resolveApproval(args),
      },
      {
        id: 'run_resolve_question',
        label: 'Answer a question',
        description: 'Sends a free-text answer to an Ask-User node waiting on a response.',
        surface: 'runs',
        access: 'write',
        risk: 'silent',
        params: {
          requestId: { type: 'string', description: 'Pending question request id.', required: true },
          response: { type: 'string', description: 'The answer text.', required: true },
        },
        activity: () => 'Answering a question from the run',
        run: args => this.resolveQuestion(args),
      },
      {
        id: 'run_read_state',
        label: 'Read the live run state',
        description:
          'Returns the current run phase, per-node states, pending approvals and questions, breakpoints and accumulated cost.',
        surface: 'runs',
        access: 'read',
        risk: 'silent',
        activity: () => 'Reading the run state',
        run: () => this.readState(),
      },
      {
        id: 'run_list',
        label: 'List recorded runs',
        description:
          'Lists recorded local runs, newest first, with status, duration and cost. Optionally filtered to the active workflow.',
        surface: 'runs',
        access: 'read',
        risk: 'silent',
        params: {
          activeWorkflowOnly: {
            type: 'boolean',
            description: 'Limit to the active workflow. Defaults to true.',
          },
          limit: { type: 'number', description: `Maximum rows (default ${RUN_LIST_LIMIT}).` },
        },
        activity: () => 'Listing recorded runs',
        run: args => this.list(args),
      },
      {
        id: 'run_read',
        label: 'Read a run record',
        description:
          'Returns one recorded run: its summary, input, output, error and per-node outcomes.',
        surface: 'runs',
        access: 'read',
        risk: 'silent',
        params: { runId: { type: 'string', description: 'Run id.', required: true } },
        activity: () => 'Reading a run record',
        run: args => this.read(args),
      },
      {
        id: 'run_load_historical',
        label: 'Load a past run',
        description:
          'Brings a recorded run onto the canvas so its node states and trace are visible ("Bring to Canvas"). Does not change the workflow.',
        surface: 'runs',
        access: 'write',
        risk: 'silent',
        params: { runId: { type: 'string', description: 'Run id.', required: true } },
        activity: () => 'Loading a past run onto the canvas',
        run: args => this.loadHistorical(args),
      },
    ];
  }

  // ── Executors ────────────────────────────────────────────────────────────

  private start(args: ActionArgs): ActionResult {
    if (this.runs.running()) return actionFail('A run is already in progress.');
    const graph = this.workflow.graph();
    if (graph.nodes.length === 0) return actionFail('The canvas is empty, so there is nothing to run.');
    if (!graph.nodes.some(node => node.category === 'trigger')) {
      return actionFail('This workflow has no trigger node, so a run has no starting point.');
    }
    const input = argStr(args, 'input');
    if (input !== undefined) this.runs.runInput.set(input);
    this.runs.start();
    return actionOk(
      { started: true },
      { revertable: false, message: 'Run started; progress appears in the Runs panel.' },
    );
  }

  private pauseOrResume(): ActionResult {
    if (!this.runs.running()) return actionFail('No run is in progress.');
    const wasPaused = this.runs.paused();
    this.runs.pauseOrResume();
    return actionOk({ paused: !wasPaused }, { revertable: false });
  }

  private step(): ActionResult {
    if (!this.runs.paused()) return actionFail('Stepping needs a paused run.');
    this.runs.step();
    return actionOk(undefined, { revertable: false });
  }

  private stop(): ActionResult {
    if (!this.runs.running()) return actionFail('No run is in progress.');
    this.runs.stop();
    return actionOk(undefined, { revertable: false });
  }

  private reset(): ActionResult {
    if (!this.runs.canReset()) return actionFail('There is no finished run to reset.');
    this.runs.reset();
    return actionOk(undefined, { revertable: false });
  }

  private toggleBreakpoint(args: ActionArgs): ActionResult {
    const nodeId = argStr(args, 'nodeId');
    if (!nodeId) return actionFail('Missing the node id.');
    if (!this.workflow.graph().nodes.some(node => node.id === nodeId)) {
      return actionFail(`Node '${nodeId}' is not on the canvas.`);
    }
    this.runs.toggleBreakpoint(nodeId);
    return actionOk(
      { nodeId, enabled: this.runs.breakpoints().has(nodeId) },
      { revertable: false },
    );
  }

  private resolveApproval(args: ActionArgs): ActionResult {
    const requestId = argStr(args, 'requestId');
    const approved = argBool(args, 'approved');
    if (!requestId) return actionFail('Missing the approval request id.');
    if (approved === undefined) return actionFail("Missing 'approved'.");
    if (!this.runs.pendingApprovals().some(item => item.requestId === requestId)) {
      return actionFail(`No approval is pending for request '${requestId}'.`);
    }
    this.runs.resolveApproval(requestId, approved);
    return actionOk({ requestId, approved }, { revertable: false });
  }

  private resolveQuestion(args: ActionArgs): ActionResult {
    const requestId = argStr(args, 'requestId');
    const response = argStr(args, 'response');
    if (!requestId) return actionFail('Missing the question request id.');
    if (response === undefined) return actionFail('Missing the answer text.');
    if (!this.runs.pendingQuestions().some(item => item.requestId === requestId)) {
      return actionFail(`No question is pending for request '${requestId}'.`);
    }
    this.runs.resolveQuestion(requestId, response);
    return actionOk({ requestId }, { revertable: false });
  }

  private readState(): ActionResult {
    const usage = this.runs.runUsage();
    return actionOk({
      running: this.runs.running(),
      paused: this.runs.paused(),
      viewingHistoricalRunId: this.runs.viewingHistoricalRunId(),
      nodeStates: [...this.runs.nodeStates()].map(([nodeId, state]) => ({
        nodeId,
        name: this.nodeName(nodeId),
        state,
      })),
      breakpoints: [...this.runs.breakpoints()],
      pendingApprovals: this.runs.pendingApprovals().map(item => ({
        requestId: item.requestId,
        nodeId: item.nodeId,
        nodeName: item.nodeName,
        message: item.message,
      })),
      pendingQuestions: this.runs.pendingQuestions().map(item => ({
        requestId: item.requestId,
        nodeId: item.nodeId,
        nodeName: item.nodeName,
        question: item.question,
      })),
      usage: {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        costUsd: usage.costUsd,
        phormaCloudCostUsd: usage.phormaCloudCostUsd,
        estimated: usage.estimated,
      },
    });
  }

  private async list(args: ActionArgs): Promise<ActionResult> {
    await this.history.refresh();
    const limit = Math.max(1, Math.min(argNum(args, 'limit') ?? RUN_LIST_LIMIT, 50));
    const activeOnly = argBool(args, 'activeWorkflowOnly') ?? true;
    const workflowId = this.workflow.activeDoc()?.workflowId ?? null;
    const rows = this.history
      .localRuns()
      .filter(record => !activeOnly || record.summary.workflowId === workflowId)
      .slice(0, limit)
      .map(record => ({
        id: record.summary.id,
        workflowName: record.summary.workflowName,
        status: record.summary.status,
        source: record.summary.source,
        environment: record.summary.environment,
        startedAt: new Date(record.summary.startedAt).toISOString(),
        durationMs: record.summary.endedAt
          ? record.summary.endedAt - record.summary.startedAt
          : undefined,
        costUsd: record.summary.usage.costUsd,
        phormaCloudCostUsd: record.summary.usage.phormaCloudCostUsd,
        error: record.summary.error,
      }));
    return actionOk({ runs: rows, returned: rows.length });
  }

  private async read(args: ActionArgs): Promise<ActionResult> {
    const runId = argStr(args, 'runId');
    if (!runId) return actionFail('Missing the run id.');
    const record = await this.history.getRun(runId).catch(() => undefined);
    if (!record) return actionFail(`Run '${runId}' was not found in local history.`);
    const nodeNames = new Map(record.graph.nodes.map(node => [node.id, node.name]));
    return actionOk({
      id: record.summary.id,
      workflowName: record.summary.workflowName,
      status: record.summary.status,
      input: record.summary.input,
      output: record.summary.output,
      error: record.summary.error,
      startedAt: new Date(record.summary.startedAt).toISOString(),
      durationMs: record.summary.endedAt
        ? record.summary.endedAt - record.summary.startedAt
        : undefined,
      usage: record.summary.usage,
      nodes: [
        ...new Set(
          record.events
            .map(event => ('nodeId' in event && typeof event.nodeId === 'string' ? event.nodeId : ''))
            .filter(nodeId => nodeId.length > 0),
        ),
      ].map(nodeId => ({ nodeId, name: nodeNames.get(nodeId) ?? nodeId })),
      failures: record.events
        .filter(event => event.type === 'node-failed')
        .map(event => ({
          nodeId: event.nodeId,
          name: nodeNames.get(event.nodeId) ?? event.nodeId,
          error: event.error,
        })),
    });
  }

  private async loadHistorical(args: ActionArgs): Promise<ActionResult> {
    const runId = argStr(args, 'runId');
    if (!runId) return actionFail('Missing the run id.');
    const record = await this.history.getRun(runId).catch(() => undefined);
    if (!record) return actionFail(`Run '${runId}' was not found in local history.`);
    this.runs.loadHistoricalRun(record);
    return actionOk({ runId }, { revertable: false });
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private nodeName(nodeId: string): string {
    return this.workflow.graph().nodes.find(node => node.id === nodeId)?.name ?? nodeId;
  }

  private approvalName(requestId: string | undefined): string {
    const pending = this.runs.pendingApprovals().find(item => item.requestId === requestId);
    return pending?.nodeName ?? requestId ?? 'the run';
  }
}

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}
