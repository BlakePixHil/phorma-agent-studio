import { Injectable, inject } from '@angular/core';

import { NotificationCenterService } from '../notification-center.service';
import { NotificationsService } from '../notifications.service';
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
 *
 * Declared minimums (multi-organisation-phorma Requirement 8.1): every action
 * here is at the operator level, and this surface is the reason that level
 * exists. `run.trigger`, `run.monitor` and `run.answer_gate` are all operator
 * capabilities, as are `read.runs`, `read.traces` and `read.notifications`.
 * Answering a gate is the one WRITE an operator holds, and it stays confirm-tier:
 * a capability is not a confirmation (Requirement 8.6).
 */
@Injectable({ providedIn: 'root' })
export class RunActionsService {
  private readonly runs = inject(RunControllerService);
  private readonly history = inject(RunHistoryService);
  private readonly workflow = inject(WorkflowService);
  // The account-wide view. Safe here: the registry sits DOWNSTREAM of the builder
  // and the chat, and `NotificationCenterService` reaches neither - it injects the
  // run controller, the poll, the deployment list and the toast, all of which this
  // service or its siblings already sit beside.
  private readonly centre = inject(NotificationCenterService);
  private readonly notifications = inject(NotificationsService);

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
        minLevel: 'operator',
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
        minLevel: 'operator',
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
        minLevel: 'operator',
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
        minLevel: 'operator',
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
        minLevel: 'operator',
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
        minLevel: 'operator',
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
        minLevel: 'operator',
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
        minLevel: 'operator',
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
        minLevel: 'operator',
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
        minLevel: 'operator',
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
        minLevel: 'operator',
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
        minLevel: 'operator',
        params: { runId: { type: 'string', description: 'Run id.', required: true } },
        activity: () => 'Loading a past run onto the canvas',
        run: args => this.loadHistorical(args),
      },
      // ── The notification centre ──────────────────────────────────────────
      //
      // On the `runs` surface rather than a new one, because everything the bell
      // reports is a run outcome or a gate on a run - and revealing the Runs panel
      // is the right reveal for both. A `notifications` surface would need its own
      // panel mapping for a surface that is a dropdown.
      //
      // Read ON DEMAND, never embedded in a prompt: the feed grows and a system
      // prompt that carried it would grow with it.
      {
        id: 'notifications_read',
        label: 'Read notifications',
        description:
          'Returns everything waiting on a human across every workflow - approval gates, questions and suspended waits - plus recent run outcomes from deployed and local runs. Use this to answer "is anything wrong" or "what needs me".',
        surface: 'runs',
        access: 'read',
        risk: 'silent',
        minLevel: 'operator',
        activity: () => 'Reading notifications',
        run: () => this.readNotifications(),
      },
      {
        id: 'notifications_resolve_approval',
        label: 'Resolve an approval anywhere',
        description:
          'Approves or rejects an approval gate on ANY workflow, including one deployed to the cloud that is not open locally. Read the gates with notifications_read first. Use run_resolve_approval only for the workflow on screen.',
        surface: 'runs',
        access: 'write',
        // Confirm-tier, and it must stay so: this releases a decision on a run the
        // user may not be looking at, in a workflow they may not have open, with
        // effects (a payment, an email, a filing) the studio cannot undo.
        risk: 'confirm',
        minLevel: 'operator',
        params: {
          requestId: {
            type: 'string',
            description: 'Gate id, from notifications_read.',
            required: true,
          },
          approved: {
            type: 'boolean',
            description: 'True to approve, false to reject.',
            required: true,
          },
        },
        confirmSummary: args => this.confirmNotificationApproval(args),
        activity: args =>
          `${argBool(args, 'approved') ? 'Approving' : 'Rejecting'} a gate from notifications`,
        run: args => this.resolveNotificationApproval(args),
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

  /**
   * The bell's contents, as data.
   *
   * `run_read_state` already reports the gates on the OPEN workflow's live run.
   * This is the account-wide answer: gates on any deployment, plus the recent
   * outcome feed. The two overlap on purpose - the model should be able to answer
   * "what needs me" without first working out which workflow is on screen.
   */
  private readNotifications(): ActionResult {
    return actionOk({
      pending: this.centre.pendingActions().map(row => ({
        requestId: row.id,
        kind: row.kind,
        nodeName: row.nodeName,
        message: row.message,
        workflowId: row.workflowId,
        workflowName: row.workflowName,
        runId: row.runId,
        waitingSince: new Date(row.since).toISOString(),
        origin: row.origin,
        // So the model can tell the user whether this is a yes/no it can settle or
        // something needing the run opened.
        resolvableInline: row.resolvableInline,
      })),
      recent: this.centre.recent().map(entry => ({
        kind: entry.kind,
        title: entry.title,
        detail: entry.detail,
        workflowId: entry.workflowId,
        workflowName: entry.workflowName,
        runId: entry.runId,
        at: new Date(entry.at).toISOString(),
        origin: entry.origin,
        remedy: entry.remedy,
      })),
      unread: this.notifications.unreadCount(),
      // Partial answers are reported rather than smoothed over: a model that says
      // "nothing is wrong" while two deployments could not be reached is worse
      // than one that says it could not check.
      deploymentsUnreachable: this.centre.unreachable(),
      truncated: this.centre.truncated(),
    });
  }

  /** Confirm copy for an account-wide approval. Names the workflow, not just the gate. */
  private confirmNotificationApproval(args: ActionArgs): string {
    const requestId = argStr(args, 'requestId');
    const row = this.centre.pendingActions().find(entry => entry.id === requestId);
    const verb = argBool(args, 'approved') ? 'Approve' : 'Reject';
    if (!row) return `${verb} approval gate '${requestId ?? 'unknown'}'?`;
    const where = row.origin === 'deployed' ? 'running in the cloud' : 'running locally';
    return (
      `${verb} "${row.nodeName}" in "${row.workflowName}" (${where})?\n\n${row.message}` +
      (row.hasPayload
        ? '\n\nThis gate carries a payload. Open the run to read it before deciding.'
        : '')
    );
  }

  private async resolveNotificationApproval(args: ActionArgs): Promise<ActionResult> {
    const requestId = argStr(args, 'requestId');
    const approved = argBool(args, 'approved');
    if (!requestId) return actionFail('Missing the approval request id.');
    if (approved === undefined) return actionFail("Missing 'approved'.");
    const row = this.centre.pendingActions().find(entry => entry.id === requestId);
    if (!row) {
      return actionFail(
        `Nothing is waiting for gate '${requestId}'. Read notifications_read again - it may have been answered elsewhere.`,
      );
    }
    if (row.kind !== 'approval') {
      return actionFail(
        `Gate '${requestId}' is a ${row.kind}, not an approval. Open the run to answer it.`,
      );
    }
    const delivered = await this.centre.resolve(row, approved);
    if (!delivered) {
      return actionFail(
        `The decision could not be delivered - "${row.nodeName}" is no longer waiting.`,
      );
    }
    return actionOk({ requestId, approved, workflowId: row.workflowId }, { revertable: false });
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
