import { Injectable, NgZone, inject, isDevMode } from '@angular/core';

import { CanvasStateService } from './canvas-state.service';
import { GraphLayoutService } from './graph-layout.service';
import { RunControllerService } from './run-controller.service';
import { SelectionService } from './selection.service';
import { TerminalOutputService, type RunPhase } from './terminal-output.service';
import { WorkflowService } from './workflow.service';
import { NODE_CATALOG, findCatalogEntry } from './node-catalog';
import type {
  GraphPosition,
  WorkflowGraph,
  WorkflowNode,
  WorkflowSettings,
} from './workflow.model';

/**
 * Declarative workflow blueprint consumed by {@link TestHarnessApi.buildWorkflow}.
 * `key` is a test-local alias; the harness returns the generated node ids.
 */
export interface TestWorkflowSpec {
  nodes: {
    /** Test-local alias used by `edges` (e.g. "trigger", "writer"). */
    key: string;
    /** Catalog entry id (e.g. `trigger-manual`, `agent-blank`, `flow-router`). */
    catalogId: string;
    /** Optional display name override. */
    name?: string;
    /** Merged into the node's kind-specific data (e.g. `{ provider, model }`). */
    data?: object;
    /** Optional explicit position; omit to auto-layout the whole graph. */
    position?: GraphPosition;
  }[];
  edges?: {
    /** Source node key. */
    from: string;
    /** Target node key. */
    to: string;
    /**
     * Source port NAME (case-insensitive, e.g. "Approved", "On error").
     * Defaults to the first message-out port (or the tools port when the
     * target is a tool node).
     */
    fromPort?: string;
    /** Target port NAME. Defaults to the first compatible in-port. */
    toPort?: string;
  }[];
  /** Workflow-level settings (e.g. `{ timeoutMinutes: 5 }`). */
  settings?: WorkflowSettings;
}

/**
 * The API surface installed at `window.__phormaTest` (dev builds only).
 * See docs/e2e-testing.md for usage guidance and examples.
 */
export interface TestHarnessApi {
  /** Lists every palette catalog id an agent can instantiate. */
  catalogIds(): { id: string; kind: string; label: string; category: string }[];
  /** Adds one node from the catalog. Returns the created node. */
  addNode(catalogId: string, opts?: { name?: string; data?: object; position?: GraphPosition }): WorkflowNode;
  /**
   * Connects two nodes by id, resolving ports automatically (or by NAME via
   * fromPort/toPort). Returns the connection id, or throws with a reason.
   */
  connect(fromNodeId: string, toNodeId: string, opts?: { fromPort?: string; toPort?: string }): string;
  /**
   * Builds a whole workflow in one declarative call: nodes, edges, settings,
   * auto-layout. Replaces the current graph. Returns key → nodeId.
   */
  buildWorkflow(spec: TestWorkflowSpec): Record<string, string>;
  /** Adds an "On error" out-port to an agent or Execute Workflow node. */
  enableErrorBranch(nodeId: string): string;
  /** Merges a patch into a node's kind-specific data. */
  updateNodeData(nodeId: string, patch: object): void;
  /** Merges a patch into the workflow-level settings. */
  updateSettings(patch: WorkflowSettings): void;
  /** Auto-arranges all nodes with the layered layout. */
  autoLayout(): void;
  /** Zooms the canvas viewport to frame the whole graph (do this before screenshots). */
  fitView(): void;
  /** Empties the active workflow's graph. */
  clearGraph(): void;
  /** JSON-safe snapshot of the active graph. */
  getGraph(): WorkflowGraph;
  /** Selects a node (drives the Prompt/Properties panels). */
  select(nodeId: string): void;
  /** Clears the selection (Properties panel shows workflow settings). */
  clearSelection(): void;
  /** Sets the run input and starts a run. */
  run(input?: string): void;
  /** Stops the in-flight run. */
  stop(): void;
  /** Current run phase (idle/running/paused/completed/failed/stopped/…). */
  phase(): RunPhase;
  /**
   * Resolves when the run reaches a terminal phase (completed/failed/
   * stopped). Rejects after `timeoutMs` (default 60s).
   */
  waitForRunEnd(timeoutMs?: number): Promise<RunPhase>;
  /** The Runs-panel trace entries for the current/most recent run. */
  trace(): { icon: string; label: string; detail?: string; tone: string }[];
  /** Per-node canvas ring states (nodeId → idle/thinking/done/error/…). */
  nodeStates(): Record<string, string>;
  /** Pending human approvals. */
  approvals(): { requestId: string; nodeId: string; nodeName: string; message: string }[];
  /** Resolves a pending approval. */
  approve(requestId: string, approved: boolean): void;
  /** Suspended Wait-for-Event nodes. */
  waits(): { nodeId: string; nodeName: string; correlationKey: string }[];
  /** Delivers an external event to a suspended Wait-for-Event node. */
  sendEvent(nodeId: string, payload: string): void;
}

declare global {
  interface Window {
    /** Dev-only programmatic test harness (absent in production builds). */
    __phormaTest?: TestHarnessApi;
  }
}

/**
 * Dev-only programmatic test harness — `window.__phormaTest`.
 *
 * WHY: the canvas is pure Canvas2D, so E2E agents (Playwright) cannot query
 * or manipulate nodes through the DOM. Synthetic drag-and-drop against
 * pixel coordinates is slow and brittle (drag thresholds, stacked nodes,
 * port hit-targets). This harness lets tests BUILD state through the same
 * `WorkflowService` mutations the UI uses, and reserve pixel interaction
 * for what is actually under test.
 *
 * Every method runs inside the Angular zone so signal writes trigger change
 * detection even when invoked from `page.evaluate(...)` (outside Angular).
 *
 * NEVER installed in production builds (`isDevMode()` guard).
 */
@Injectable({ providedIn: 'root' })
export class TestHarnessService {
  private readonly zone = inject(NgZone);
  private readonly workflow = inject(WorkflowService);
  private readonly selection = inject(SelectionService);
  private readonly runs = inject(RunControllerService);
  private readonly layout = inject(GraphLayoutService);
  private readonly terminal = inject(TerminalOutputService);
  private readonly canvasState = inject(CanvasStateService);

  /** Installs `window.__phormaTest` (no-op in production builds). */
  install(): void {
    if (!isDevMode() || typeof window === 'undefined') return;
    window.__phormaTest = this.buildApi();
  }

  private buildApi(): TestHarnessApi {
    // Wraps a method so callers from outside Angular (Playwright
    // page.evaluate) still trigger change detection.
    const zoned = <A extends unknown[], R>(fn: (...args: A) => R): ((...args: A) => R) =>
      (...args: A) => this.zone.run(() => fn(...args));

    return {
      catalogIds: () =>
        NODE_CATALOG.map(entry => ({
          id: entry.id,
          kind: entry.kind,
          label: entry.label,
          category: entry.category,
        })),

      addNode: zoned((catalogId, opts) => this.addNode(catalogId, opts)),

      connect: zoned((fromNodeId, toNodeId, opts) => this.connect(fromNodeId, toNodeId, opts)),

      buildWorkflow: zoned(spec => this.buildWorkflow(spec)),

      enableErrorBranch: zoned(nodeId => this.enableErrorBranch(nodeId)),

      updateNodeData: zoned((nodeId, patch) => {
        this.requireNode(nodeId);
        this.workflow.updateNodeData(nodeId, patch as Record<string, unknown>);
      }),

      updateSettings: zoned(patch => this.workflow.updateSettings(patch)),

      autoLayout: zoned(() => {
        const positions = this.layout.layeredLayout(this.workflow.graph());
        this.workflow.moveNodes(positions);
      }),

      fitView: zoned(() => this.canvasState.zoomCommand.set('fit')),

      clearGraph: zoned(() => this.workflow.replaceGraph({ nodes: [], connections: [] })),

      getGraph: () => structuredClone(this.workflow.graph()),

      select: zoned(nodeId => {
        this.requireNode(nodeId);
        this.selection.selectNode(nodeId);
      }),

      clearSelection: zoned(() => this.selection.clear()),

      run: zoned(input => {
        if (input !== undefined) this.runs.runInput.set(input);
        this.runs.start();
      }),

      stop: zoned(() => this.runs.stop()),

      phase: () => this.terminal.phase(),

      waitForRunEnd: (timeoutMs = 60_000) => this.waitForRunEnd(timeoutMs),

      trace: () =>
        this.runs.trace().map(entry => ({
          icon: entry.icon,
          label: entry.label,
          detail: entry.detail,
          tone: entry.tone,
        })),

      nodeStates: () => Object.fromEntries(this.runs.nodeStates()),

      approvals: () =>
        this.runs.pendingApprovals().map(item => ({
          requestId: item.requestId,
          nodeId: item.nodeId,
          nodeName: item.nodeName,
          message: item.message,
        })),

      approve: zoned((requestId, approved) => this.runs.resolveApproval(requestId, approved)),

      waits: () =>
        this.runs.pendingWaits().map(item => ({
          nodeId: item.nodeId,
          nodeName: item.nodeName,
          correlationKey: item.correlationKey,
        })),

      sendEvent: zoned((nodeId, payload) => this.runs.resolveWait(nodeId, payload)),
    };
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private requireNode(nodeId: string): WorkflowNode {
    const node = this.workflow.graph().nodes.find(item => item.id === nodeId);
    if (!node) {
      throw new Error(
        `Unknown node "${nodeId}". Known: ${this.workflow.graph().nodes.map(n => n.id).join(', ') || '(none)'}`,
      );
    }
    return node;
  }

  private addNode(
    catalogId: string,
    opts?: { name?: string; data?: object; position?: GraphPosition },
  ): WorkflowNode {
    const entry = findCatalogEntry(catalogId);
    if (!entry) {
      throw new Error(
        `Unknown catalog id "${catalogId}". Use __phormaTest.catalogIds() to list them.`,
      );
    }
    const position = opts?.position ?? this.nextFreePosition();
    const node = this.workflow.addNodeFromCatalog(catalogId, position);
    if (!node) throw new Error(`Failed to instantiate "${catalogId}".`);
    if (opts?.name) this.workflow.updateNode(node.id, { name: opts.name });
    if (opts?.data) this.workflow.updateNodeData(node.id, opts.data as Record<string, unknown>);
    // Return the post-patch node.
    return this.requireNode(node.id);
  }

  /** Staggers programmatic drops so stacked nodes never overlap. */
  private nextFreePosition(): GraphPosition {
    const count = this.workflow.graph().nodes.length;
    return { x: 120 + (count % 4) * 300, y: 120 + Math.floor(count / 4) * 200 };
  }

  private connect(
    fromNodeId: string,
    toNodeId: string,
    opts?: { fromPort?: string; toPort?: string },
  ): string {
    const from = this.requireNode(fromNodeId);
    const to = this.requireNode(toNodeId);

    const byName = (node: WorkflowNode, name: string) => {
      const port = node.ports.find(p => p.name.toLowerCase() === name.toLowerCase());
      if (!port) {
        throw new Error(
          `Node "${node.name}" has no port named "${name}". Ports: ${node.ports.map(p => `${p.name} (${p.role})`).join(', ')}`,
        );
      }
      return port;
    };

    // Tool wiring: agent tools port → tool node's tools port (dashed edge).
    const toolLink = to.category === 'tool';

    const outPort = opts?.fromPort
      ? byName(from, opts.fromPort)
      : toolLink
        ? from.ports.find(p => p.role === 'tools')
        : from.ports.find(p => p.role === 'message-out');
    const inPort = opts?.toPort
      ? byName(to, opts.toPort)
      : toolLink
        ? to.ports.find(p => p.role === 'tools')
        : to.ports.find(p => p.role === 'message-in');

    if (!outPort || !inPort) {
      throw new Error(
        `No compatible ports between "${from.name}" and "${to.name}". ` +
          `Source ports: ${from.ports.map(p => `${p.name} (${p.role})`).join(', ')}; ` +
          `target ports: ${to.ports.map(p => `${p.name} (${p.role})`).join(', ')}.`,
      );
    }

    const connection = this.workflow.addConnection(`${outPort.id}-out`, `${inPort.id}-in`);
    if (!connection) {
      throw new Error(
        `Connection rejected: "${from.name}".${outPort.name} → "${to.name}".${inPort.name} ` +
          '(incompatible roles or duplicate edge).',
      );
    }
    return connection.id;
  }

  private buildWorkflow(spec: TestWorkflowSpec): Record<string, string> {
    if (!spec?.nodes?.length) throw new Error('buildWorkflow: spec.nodes is required.');
    this.workflow.replaceGraph({ nodes: [], connections: [] });

    const ids: Record<string, string> = {};
    let anyExplicitPosition = false;
    for (const item of spec.nodes) {
      if (ids[item.key]) throw new Error(`buildWorkflow: duplicate node key "${item.key}".`);
      const node = this.addNode(item.catalogId, {
        name: item.name,
        data: item.data,
        position: item.position,
      });
      if (item.position) anyExplicitPosition = true;
      ids[item.key] = node.id;
    }

    for (const item of spec.edges ?? []) {
      const fromId = ids[item.from];
      const toId = ids[item.to];
      if (!fromId) throw new Error(`buildWorkflow: edge references unknown key "${item.from}".`);
      if (!toId) throw new Error(`buildWorkflow: edge references unknown key "${item.to}".`);
      this.connect(fromId, toId, { fromPort: item.fromPort, toPort: item.toPort });
    }

    if (spec.settings) this.workflow.updateSettings(spec.settings);

    // Auto-layout unless the test placed nodes deliberately, and frame the
    // result so screenshots show the built workflow.
    if (!anyExplicitPosition) {
      const positions = this.layout.layeredLayout(this.workflow.graph());
      this.workflow.moveNodes(positions);
    }
    this.canvasState.zoomCommand.set('fit');
    return ids;
  }

  /** Mirrors the Agent/Execute Workflow "On-error output" toggle. */
  private enableErrorBranch(nodeId: string): string {
    const node = this.requireNode(nodeId);
    if (node.kind !== 'agent' && node.kind !== 'execute-workflow') {
      throw new Error(`enableErrorBranch: "${node.name}" does not support an error branch.`);
    }
    const existing = (node.data as { errorPortId?: string }).errorPortId;
    if (existing && node.ports.some(port => port.id === existing)) return existing;
    const port = {
      id: `${node.id}-err${Date.now().toString(36)}`,
      name: 'On error',
      role: 'message-out' as const,
    };
    this.workflow.updateNodePorts(node.id, [...node.ports, port]);
    this.workflow.updateNodeData(node.id, { errorPortId: port.id });
    return port.id;
  }

  private waitForRunEnd(timeoutMs: number): Promise<RunPhase> {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + timeoutMs;
      const poll = (): void => {
        const phase = this.terminal.phase();
        if (phase === 'completed' || phase === 'failed' || phase === 'stopped') {
          resolve(phase);
          return;
        }
        if (Date.now() > deadline) {
          reject(new Error(`Run did not settle within ${timeoutMs}ms (phase: ${phase}).`));
          return;
        }
        setTimeout(poll, 100);
      };
      poll();
    });
  }
}
