import { Injectable, computed, inject, signal } from '@angular/core';

import { startRun, type RunEvent, type RunHandle, type RunNodeState } from '@phorma/engine';

import { AgentStreamService } from './agent-stream.service';
import { ModelTransportService } from './model-transport.service';
import { SettingsService } from './settings.service';
import { TerminalOutputService } from './terminal-output.service';
import { ToolHostService } from './tool-host.service';
import { WorkflowService } from './workflow.service';
import { ToastService } from '../shared/toast/toast.service';
import { portBaseId } from './workflow.model';

/** One entry in the Runs panel trace timeline. */
export interface TraceEntry {
  id: number;
  at: number;
  icon: string;
  label: string;
  /** Expandable payload (markdown/plain text). */
  detail?: string;
  tone: 'info' | 'success' | 'warning' | 'error';
}

/** A pending human approval, surfaced in the Runs panel. */
export interface PendingApproval {
  nodeId: string;
  nodeName: string;
  message: string;
  payload: string;
  resolve: (approved: boolean) => void;
}

/** How long a handoff edge stays lit after the pulse (ms). */
const EDGE_PULSE_MS = 1400;
/** Trace buffer cap. */
const MAX_TRACE_ENTRIES = 500;

function truncateArgs(value: string): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > 80 ? `${flat.slice(0, 80)}…` : flat;
}

function firstLine(value: string): string {
  const line = value.split('\n', 1)[0] ?? '';
  return line.length > 120 ? `${line.slice(0, 120)}…` : line;
}

/**
 * The run controller — bridges the engine's RunEvent stream to the studio:
 * node glow states + edge pulses on the canvas, console lines, the Runs
 * trace timeline, approval gates, and the toolbar's run/pause/step/stop
 * controls. Cloud monitoring (Phase 4) feeds the SAME `apply()` path, which
 * is what gives local and deployed runs identical visualization.
 */
@Injectable({ providedIn: 'root' })
export class RunControllerService {
  private readonly workflow = inject(WorkflowService);
  private readonly transport = inject(ModelTransportService);
  private readonly settings = inject(SettingsService);
  private readonly terminal = inject(TerminalOutputService);
  private readonly agentStream = inject(AgentStreamService);
  private readonly toolHost = inject(ToolHostService);
  private readonly toast = inject(ToastService);

  private handle: RunHandle | null = null;
  private traceCounter = 0;
  private runCounter = 0;
  private readonly edgeTimers = new Map<string, ReturnType<typeof setTimeout>>();

  // ── Reactive state the UI consumes ─────────────────────────────────────────

  /** Per-node run state for canvas rings. */
  readonly nodeStates = signal<ReadonlyMap<string, RunNodeState>>(new Map());
  /** Connection ids currently pulsing. */
  readonly activeEdges = signal<ReadonlySet<string>>(new Set());
  /** Node ids with breakpoints. */
  readonly breakpoints = signal<ReadonlySet<string>>(new Set());
  /** The Runs panel timeline for the current/most recent run. */
  readonly trace = signal<TraceEntry[]>([]);
  /** Approval requests awaiting a human. */
  readonly pendingApprovals = signal<PendingApproval[]>([]);
  /** Task input used for the next run (bound to the Runs panel textarea). */
  readonly runInput = signal('');
  /** Total streamed characters this run (cheap progress proxy). */
  readonly streamedChars = signal(0);
  /**
   * Per-node reasoning/thinking text captured during a run. Not persisted to
   * the DB — dumped on restart or when a node is removed from the canvas.
   * `streaming` is true while the node is still emitting thinking tokens;
   * the canvas overlay uses it to drive the shimmer and auto-collapse.
   */
  readonly nodeThinking = signal<ReadonlyMap<string, { text: string; streaming: boolean }>>(new Map());

  /**
   * Set by CloudService while a monitor is connected: routes approval
   * resolutions for REMOTE runs over the WebSocket. Local runs create their
   * own pending entries via the engine callback and ignore this.
   */
  remoteApprovalSender: ((nodeId: string, approved: boolean) => void) | null = null;

  readonly running = computed(() => {
    const phase = this.terminal.phase();
    return (
      phase === 'starting' || phase === 'running' || phase === 'paused' || phase === 'waiting-approval'
    );
  });
  readonly paused = computed(() => this.terminal.phase() === 'paused');

  // ── Controls (toolbar + Runs panel) ────────────────────────────────────────

  /** Starts a run of the active workflow. */
  start(): void {
    if (this.running()) return;
    const graph = this.workflow.graph();
    if (graph.nodes.length === 0) {
      this.toast.warning('Nothing to run', 'Drop some agents onto the canvas first.');
      return;
    }
    if (!graph.nodes.some(node => node.category === 'trigger')) {
      this.toast.warning('No trigger', 'Add a Manual trigger so the run knows where to start.');
      return;
    }

    this.resetRunState();
    this.runCounter += 1;
    const runId = `run-${Date.now().toString(36)}-${this.runCounter}`;

    const handle = startRun({
      runId,
      graph: structuredClone(graph),
      input: this.runInput().trim(),
      model: this.transport.create(),
      ollamaBaseUrl: this.settings.ollamaBaseUrl(),
      tools: this.toolHost,
      emit: event => this.apply(event),
      requestApproval: (nodeId, message, payload) =>
        new Promise<boolean>(resolve => {
          const nodeName =
            this.workflow.graph().nodes.find(node => node.id === nodeId)?.name ?? nodeId;
          this.pendingApprovals.update(list => [
            ...list,
            { nodeId, nodeName, message, payload, resolve },
          ]);
        }),
    });
    for (const nodeId of this.breakpoints()) handle.gate.breakpoints.add(nodeId);
    this.handle = handle;
    void handle.done.finally(() => {
      if (this.handle === handle) this.handle = null;
    });
  }

  pauseOrResume(): void {
    if (!this.handle) return;
    if (this.paused()) this.handle.resume();
    else this.handle.pause();
  }

  step(): void {
    this.handle?.step();
  }

  stop(): void {
    if (!this.handle) return;
    this.handle.stop();
    // Unblock any pending approvals so the run can unwind.
    for (const approval of this.pendingApprovals()) approval.resolve(false);
    this.pendingApprovals.set([]);
  }

  /** Resolves a pending approval from the Runs panel. */
  resolveApproval(nodeId: string, approved: boolean): void {
    const approval = this.pendingApprovals().find(item => item.nodeId === nodeId);
    if (!approval) return;
    this.pendingApprovals.update(list => list.filter(item => item.nodeId !== nodeId));
    approval.resolve(approved);
  }

  /** Toggles a breakpoint on a node (context menu). */
  toggleBreakpoint(nodeId: string): void {
    this.breakpoints.update(current => {
      const next = new Set(current);
      if (next.has(nodeId)) next.delete(nodeId);
      else next.add(nodeId);
      return next;
    });
    // Live-sync into an in-flight run.
    if (this.handle) {
      if (this.breakpoints().has(nodeId)) this.handle.gate.breakpoints.add(nodeId);
      else this.handle.gate.breakpoints.delete(nodeId);
    }
  }

  // ── RunEvent application (local engine AND cloud monitor feed this) ────────

  apply(event: RunEvent): void {
    switch (event.type) {
      case 'run-started':
        this.terminal.setPhase('running');
        this.terminal.open('run');
        this.console('run', 'info', `Run started${event.input ? ` — "${event.input}"` : ''}.`);
        this.pushTrace('ti ti-player-play', 'Run started', event.input || undefined, 'info');
        // A new run dumps any prior thinking text (per the persistence rule:
        // thinking survives until node removal OR a restart).
        this.nodeThinking.set(new Map());
        break;

      case 'node-started':
        this.setNodeState(event.nodeId, 'thinking');
        this.agentStream.markEditing(event.nodeId);
        this.console('run', 'info', `→ ${event.nodeName}`);
        this.pushTrace('ti ti-loader-2', `${event.nodeName} started`, undefined, 'info');
        break;

      case 'node-token':
        this.streamedChars.update(count => count + event.token.length);
        this.appendStreaming(event.nodeId, event.token);
        break;

      case 'node-thinking':
        this.appendThinking(event.nodeId, event.token);
        break;

      case 'node-completed':
        this.flushStreaming(event.nodeId);
        this.finishThinking(event.nodeId);
        this.setNodeState(event.nodeId, 'done');
        this.agentStream.clearEditing(event.nodeId);
        this.pushTrace(
          'ti ti-circle-check',
          `${event.nodeName} completed`,
          event.output || undefined,
          'success',
        );
        break;

      case 'node-failed':
        this.flushStreaming(event.nodeId);
        this.finishThinking(event.nodeId);
        this.setNodeState(event.nodeId, 'error');
        this.agentStream.clearEditing(event.nodeId);
        this.console('problems', 'error', `${event.nodeName}: ${event.error}`);
        this.pushTrace('ti ti-circle-x', `${event.nodeName} failed`, event.error, 'error');
        break;

      case 'handoff': {
        this.pulseEdge(event.connectionId);
        const from = this.nodeName(event.fromNodeId);
        const to = this.nodeName(event.toNodeId);
        this.setNodeState(event.toNodeId, 'queued');
        this.console('run', 'info', `${from} ⇢ ${to}`);
        this.pushTrace('ti ti-arrow-narrow-right', `${from} → ${to}`, undefined, 'info');
        break;
      }

      case 'tool-call': {
        // Light up the tool-link edge and the tool node while it executes.
        const edge = this.toolLinkConnection(event.nodeId, event.toolNodeId);
        if (edge) this.pulseEdge(edge);
        if (event.toolNodeId) this.setNodeState(event.toolNodeId, 'thinking');
        this.console('tools', 'info', `${this.nodeName(event.nodeId)} → ${event.name}(${truncateArgs(event.arguments)})`);
        this.pushTrace('ti ti-tool', `Tool call: ${event.name}`, event.arguments, 'info');
        break;
      }

      case 'tool-result':
        if (event.toolNodeId) this.setNodeState(event.toolNodeId, event.isError ? 'error' : 'done');
        this.console('tools', event.isError ? 'error' : 'info', `${event.name} → ${firstLine(event.result)}`);
        this.pushTrace(
          event.isError ? 'ti ti-alert-triangle' : 'ti ti-tool',
          `Tool ${event.isError ? 'error' : 'result'}: ${event.name}`,
          event.result,
          event.isError ? 'error' : 'success',
        );
        break;

      case 'approval-required':
        this.terminal.setPhase('waiting-approval');
        this.setNodeState(event.nodeId, 'waiting-approval');
        this.console('run', 'warning', `Approval required: ${event.message}`);
        this.pushTrace('ti ti-user-check', 'Approval required', event.message, 'warning');
        // Remote runs: the engine callback lives in the cloud, so synthesize
        // the pending entry here and resolve it over the monitor socket.
        if (
          this.remoteApprovalSender &&
          !this.pendingApprovals().some(item => item.nodeId === event.nodeId)
        ) {
          const send = this.remoteApprovalSender;
          this.pendingApprovals.update(list => [
            ...list,
            {
              nodeId: event.nodeId,
              nodeName: this.nodeName(event.nodeId),
              message: event.message,
              payload: event.payload,
              resolve: approved => send(event.nodeId, approved),
            },
          ]);
        }
        break;

      case 'approval-resolved':
        this.terminal.setPhase('running');
        this.setNodeState(event.nodeId, event.approved ? 'done' : 'idle');
        // Remote monitors may still hold a synthetic pending card — clear it.
        this.pendingApprovals.update(list => list.filter(item => item.nodeId !== event.nodeId));
        this.pushTrace(
          event.approved ? 'ti ti-thumb-up' : 'ti ti-thumb-down',
          event.approved ? 'Approved' : 'Rejected',
          undefined,
          event.approved ? 'success' : 'warning',
        );
        break;

      case 'run-paused':
        this.terminal.setPhase('paused');
        this.console('run', 'warning', event.nodeId ? `Paused at breakpoint (${this.nodeName(event.nodeId)}).` : 'Paused.');
        break;

      case 'run-resumed':
        this.terminal.setPhase('running');
        this.console('run', 'info', 'Resumed.');
        break;

      case 'run-completed':
        this.terminal.setPhase('completed');
        this.console('run', 'success', 'Run completed.');
        this.pushTrace('ti ti-flag-check', 'Run completed', event.output || undefined, 'success');
        this.finishRun();
        break;

      case 'run-failed':
        this.terminal.setPhase('failed');
        this.console('problems', 'error', event.error);
        this.pushTrace('ti ti-flag-x', 'Run failed', event.error, 'error');
        this.finishRun();
        break;

      case 'run-stopped':
        this.terminal.setPhase('stopped');
        this.console('run', 'warning', 'Run stopped.');
        this.pushTrace('ti ti-player-stop', 'Run stopped', undefined, 'warning');
        this.finishRun();
        break;
    }
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  /** Streaming console buffers: one console line per node per flush. */
  private readonly streamBuffers = new Map<string, string>();

  private appendStreaming(nodeId: string, token: string): void {
    const buffer = (this.streamBuffers.get(nodeId) ?? '') + token;
    // Flush on newlines so the Agents channel reads as it streams.
    const lines = buffer.split('\n');
    const remainder = lines.pop() ?? '';
    for (const line of lines) {
      if (line.trim()) this.console('agents', 'info', `${this.nodeName(nodeId)}: ${line}`);
    }
    this.streamBuffers.set(nodeId, remainder);
  }

  private flushStreaming(nodeId: string): void {
    const remainder = this.streamBuffers.get(nodeId);
    if (remainder?.trim()) {
      this.console('agents', 'info', `${this.nodeName(nodeId)}: ${remainder}`);
    }
    this.streamBuffers.delete(nodeId);
  }

  /** Appends a reasoning/thinking token to the node's thinking buffer. */
  private appendThinking(nodeId: string, token: string): void {
    this.nodeThinking.update(current => {
      const next = new Map(current);
      const entry = next.get(nodeId) ?? { text: '', streaming: false };
      next.set(nodeId, { text: entry.text + token, streaming: true });
      return next;
    });
  }

  /** Marks a node's thinking stream as finished (keeps the text for review). */
  private finishThinking(nodeId: string): void {
    this.nodeThinking.update(current => {
      const entry = current.get(nodeId);
      if (!entry) return current;
      const next = new Map(current);
      next.set(nodeId, { text: entry.text, streaming: false });
      return next;
    });
  }

  /** Drops a single node's thinking text (called when the node is removed). */
  clearThinking(nodeId: string): void {
    this.nodeThinking.update(current => {
      if (!current.has(nodeId)) return current;
      const next = new Map(current);
      next.delete(nodeId);
      return next;
    });
  }

  private setNodeState(nodeId: string, state: RunNodeState): void {
    this.nodeStates.update(current => {
      const next = new Map(current);
      next.set(nodeId, state);
      return next;
    });
  }

  private pulseEdge(connectionId: string): void {
    this.activeEdges.update(current => {
      const next = new Set(current);
      next.add(connectionId);
      return next;
    });
    const existing = this.edgeTimers.get(connectionId);
    if (existing) clearTimeout(existing);
    this.edgeTimers.set(
      connectionId,
      setTimeout(() => {
        this.activeEdges.update(current => {
          const next = new Set(current);
          next.delete(connectionId);
          return next;
        });
        this.edgeTimers.delete(connectionId);
      }, EDGE_PULSE_MS),
    );
  }

  private pushTrace(icon: string, label: string, detail: string | undefined, tone: TraceEntry['tone']): void {
    this.traceCounter += 1;
    this.trace.update(entries => {
      const next = [
        ...entries,
        { id: this.traceCounter, at: Date.now(), icon, label, detail, tone },
      ];
      return next.length > MAX_TRACE_ENTRIES ? next.slice(next.length - MAX_TRACE_ENTRIES) : next;
    });
  }

  private console(
    channel: 'run' | 'agents' | 'tools' | 'problems',
    level: 'info' | 'success' | 'warning' | 'error',
    message: string,
  ): void {
    this.terminal.append(channel, level, message);
  }

  private nodeName(nodeId: string): string {
    return this.workflow.graph().nodes.find(node => node.id === nodeId)?.name ?? nodeId;
  }

  /** Finds the tool-link connection between an agent and a tool node. */
  private toolLinkConnection(agentNodeId: string, toolNodeId: string): string | null {
    if (!toolNodeId) return null;
    const graph = this.workflow.graph();
    const agent = graph.nodes.find(node => node.id === agentNodeId);
    const tool = graph.nodes.find(node => node.id === toolNodeId);
    if (!agent || !tool) return null;
    const agentPorts = new Set(agent.ports.map(port => port.id));
    const toolPorts = new Set(tool.ports.map(port => port.id));
    return (
      graph.connections.find(
        conn =>
          conn.kind === 'tool-link' &&
          agentPorts.has(portBaseId(conn.outputId)) &&
          toolPorts.has(portBaseId(conn.inputId)),
      )?.id ?? null
    );
  }

  private resetRunState(): void {
    this.trace.set([]);
    this.nodeStates.set(new Map());
    this.activeEdges.set(new Set());
    this.pendingApprovals.set([]);
    this.streamedChars.set(0);
    this.streamBuffers.clear();
    for (const timer of this.edgeTimers.values()) clearTimeout(timer);
    this.edgeTimers.clear();
    this.terminal.clearAll();
  }

  /** Clears transient glow state a beat after the run ends (rings persist). */
  private finishRun(): void {
    this.agentStream.clearAll();
    for (const approval of this.pendingApprovals()) approval.resolve(false);
    this.pendingApprovals.set([]);
  }
}
