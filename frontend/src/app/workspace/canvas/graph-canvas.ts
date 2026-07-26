import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  NgZone,
  OnDestroy,
  ViewChild,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { ContextMenuModule } from 'primeng/contextmenu';
import { type MenuItem } from 'primeng/api';

import { CanvasStateService } from '../../core/canvas-state.service';
import { SettingsService } from '../../core/settings.service';
import { WorkflowService } from '../../core/workflow.service';
import { SelectionService } from '../../core/selection.service';
import { ThemeService } from '../../core/theme.service';
import { AgentStreamService } from '../../core/agent-stream.service';
import { PanelRegistryService } from '../../core/panel-registry.service';
import { TerminalOutputService } from '../../core/terminal-output.service';
import { NodeDragService } from '../../core/node-drag.service';
import { RunControllerService } from '../../core/run-controller.service';
import { NODE_CATALOG, NODE_CATEGORY_SECTIONS, PHORMA_NODE_MIME, findMcpPreset } from '../../core/node-catalog';
import { ToastService } from '../../shared/toast/toast.service';
import { McpOAuthService } from '../../core/mcp-oauth.service';
import { HistoryService } from '../../core/history.service';
import { ConfirmDialogService } from '../../shared/confirm-dialog/confirm-dialog.service';
import { extractSubWorkflow } from '../../core/subworkflow-extract';
import { CanvasGraphRenderer, type RendererTheme } from './engine/canvas-graph-renderer';
import { graphToScene } from './engine/graph-to-scene';
import { ThinkingOverlay } from './thinking-overlay/thinking-overlay';
import { McpWarningOverlay } from './mcp-warning-overlay/mcp-warning-overlay';
import { AskUserOverlay } from './ask-user-overlay/ask-user-overlay';
import { canConnectPorts, findNodeForConnector } from '../../core/workflow.model';
import type { GraphPosition, WorkflowGraph, WorkflowNode } from '../../core/workflow.model';

/**
 * ── GraphCanvas ─────────────────────────────────────────────────────────────
 *
 * Canvas 2D graph renderer. Drives {@link CanvasGraphRenderer} from the real
 * project / builder graph and bridges the engine to app state:
 *  - graph signal → renderer scene (re-mapped on graph or theme change)
 *  - SelectionService ↔ renderer selection (nodes + connections)
 *  - select, drag-move, drag-to-connect, wire-select, delete, palette/library
 *    drag-drop, pan, wheel-zoom, toolbar zoom commands, box-select, context
 *    menu, double-click drill-in, dot grid, minimap
 */
@Component({
  selector: 'app-graph-canvas',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ContextMenuModule, ThinkingOverlay, McpWarningOverlay, AskUserOverlay],
  template: `
    <canvas
      #cv
      class="phorma-graph-canvas"
      (dragover)="onDragOver($event)"
      (drop)="onDrop($event)"
      (dblclick)="onDblClick($event)"
      (contextmenu)="onCanvasContextMenu($event)"
    ></canvas>

    <!-- Cursor spotlight glow (CSS-driven by --x/--y/--spotlight-opacity). -->
    <div class="phorma-spotlight" aria-hidden="true"></div>

    @if (minimapVisible()) {
      <canvas
        #mini
        class="phorma-canvas-minimap"
        [style.right.px]="minimapRight()"
        [style.left.px]="minimapLeft()"
        [style.bottom.px]="minimapBottom()"
        [style.top.px]="minimapTop()"
        (pointerdown)="onMinimapPointerDown($event)"
        (pointermove)="onMinimapPointerMove($event)"
        (pointerup)="onMinimapPointerUp($event)"
      ></canvas>
    }

    <!-- Shift-drag box-select hint (bottom-left, clears sidebar + console). -->
    @if (shiftHeld()) {
      <div
        class="phorma-shift-hint"
        role="status"
        aria-live="polite"
        [style.left.px]="hintLeft()"
        [style.bottom.px]="hintBottom()"
      >
        <i class="ti ti-marquee-2" aria-hidden="true"></i>
        Shift-drag to box-select
      </div>
    }

    <!-- Reasoning/thinking overlays: one per node that has captured thinking
         text. Positioned in screen space every frame via transformTick so
         they track pan/zoom. Container is pointer-events:none so empty canvas
         areas stay draggable; each overlay re-enables pointer events. -->
    <div class="phorma-thinking-layer" aria-hidden="false">
      @for (item of thinkingOverlays(); track item.nodeId) {
        <app-thinking-overlay
          [nodeId]="item.nodeId"
          [screenX]="item.screenX"
          [screenY]="item.screenY"
          [screenW]="item.screenW"
          [text]="item.text"
          [streaming]="item.streaming"
        />
      }
    </div>

    <!-- MCP configuration-warning overlays: one per MCP node missing
         credentials or OAuth connection. Each renders a clickable amber
         badge at the node's top-right corner; clicking opens a frosted-glass
         popover with a deep-link to Settings -> Integrations. -->
    <div class="phorma-mcp-warn-layer" aria-hidden="false">
      @for (item of mcpWarningOverlays(); track item.nodeId) {
        <app-mcp-warning-overlay
          [nodeId]="item.nodeId"
          [warning]="item.warning"
          [presetId]="item.presetId"
          [style.left.px]="item.screenX"
          [style.top.px]="item.screenY"
          [style.width.px]="item.screenW"
          [style.height.px]="item.screenH"
        />
      }
    </div>

    <!-- Ask User answer cards: one per suspended ask-user node on THIS graph.
         The run cannot advance without the operator, so the input sits under
         the pulsing node instead of only in the Runs panel. Nodes inside
         sub-workflows have no bounds here and stay panel-only. -->
    <div class="phorma-ask-layer" aria-hidden="false">
      @for (item of askUserOverlays(); track item.requestId) {
        <app-ask-user-overlay
          [requestId]="item.requestId"
          [nodeName]="item.nodeName"
          [question]="item.question"
          [screenX]="item.screenX"
          [screenY]="item.screenY"
          [screenW]="item.screenW"
          [draft]="item.draft"
          (draftChange)="runController.setQuestionDraft(item.requestId, $event)"
          (answered)="runController.resolveQuestion(item.requestId, $event)"
        />
      }
    </div>

    <p-contextmenu [target]="cv" [model]="contextMenuItems()" />
  `,
  styles: [
    `
      :host {
        display: block;
        position: absolute;
        inset: 0;
        overflow: hidden;
        /* Spotlight defaults — hidden until first move; dimmed over a node. */
        --x: 50%;
        --y: 50%;
        --spotlight-opacity: 0;
        --spotlight-node-dim: 1;
      }
      .phorma-spotlight {
        pointer-events: none;
        position: absolute;
        inset: 0;
        z-index: 5;
        opacity: calc(var(--spotlight-opacity) * var(--spotlight-node-dim));
        transition:
          opacity 0.35s ease,
          --spotlight-node-dim 0.2s ease;
        background: radial-gradient(
          380px circle at var(--x) var(--y),
          var(--phorma-spotlight-color, rgba(129, 140, 248, 0.12)),
          transparent 65%
        );
        will-change: opacity;
      }
      .phorma-shift-hint {
        position: absolute;
        z-index: 20;
        display: inline-flex;
        align-items: center;
        gap: 0.4rem;
        padding: 0.3rem 0.6rem;
        border-radius: 0.55rem;
        font-size: 0.7rem;
        font-weight: 500;
        color: var(--p-text-muted-color);
        background: var(--phorma-card-bg);
        border: 1px solid var(--phorma-card-border);
        backdrop-filter: blur(10px);
        box-shadow: 0 4px 14px rgb(0 0 0 / 0.18);
        pointer-events: none;
        user-select: none;
      }
      .phorma-shift-hint i {
        font-size: 0.72rem;
        color: var(--p-primary-color, #818cf8);
      }
      .phorma-graph-canvas {
        display: block;
        width: 100%;
        height: 100%;
        cursor: grab;
        touch-action: none;
      }
      .phorma-graph-canvas:active {
        cursor: grabbing;
      }
      .phorma-canvas-minimap {
        position: absolute;
        z-index: 20;
        width: 200px;
        height: 140px;
        border-radius: 0.6rem;
        background: color-mix(in srgb, var(--phorma-card-bg) 88%, transparent);
        border: 1px solid var(--phorma-card-border);
        backdrop-filter: blur(8px);
        box-shadow: 0 8px 24px rgb(0 0 0 / 0.22);
        cursor: pointer;
        touch-action: none;
        transition:
          right 150ms cubic-bezier(0.4, 0, 0.2, 1),
          left 150ms cubic-bezier(0.4, 0, 0.2, 1),
          bottom 150ms cubic-bezier(0.4, 0, 0.2, 1),
          top 150ms cubic-bezier(0.4, 0, 0.2, 1);
      }
      .phorma-thinking-layer {
        position: absolute;
        inset: 0;
        z-index: 15;
        pointer-events: none;
      }
      .phorma-mcp-warn-layer {
        position: absolute;
        inset: 0;
        z-index: 16;
        pointer-events: none;
      }
      .phorma-ask-layer {
        position: absolute;
        inset: 0;
        z-index: 17;
        pointer-events: none;
      }
    `,
  ],
})
export class GraphCanvas implements AfterViewInit, OnDestroy {
  private readonly el = inject(ElementRef<HTMLElement>);
  private readonly zone = inject(NgZone);
  private readonly canvasState = inject(CanvasStateService);
  private readonly workflow = inject(WorkflowService);
  private readonly selection = inject(SelectionService);
  private readonly theme = inject(ThemeService);
  private readonly agentStream = inject(AgentStreamService);
  private readonly nodeDrag = inject(NodeDragService);
  protected readonly runController = inject(RunControllerService);
  private readonly panels = inject(PanelRegistryService);
  private readonly terminal = inject(TerminalOutputService);
  private readonly toast = inject(ToastService);
  private readonly settings = inject(SettingsService);
  private readonly oauth = inject(McpOAuthService);
  private readonly history = inject(HistoryService);
  private readonly confirmDialog = inject(ConfirmDialogService);

  @ViewChild('cv', { static: true }) private cvRef!: ElementRef<HTMLCanvasElement>;
  @ViewChild('mini') private miniRef?: ElementRef<HTMLCanvasElement>;

  private readonly engine = new CanvasGraphRenderer();

  /**
   * Bumped every animation frame from the renderer's `onAfterDraw` hook so the
   * thinking overlays re-project their screen-space position from the live
   * world transform (pan/zoom). Kept outside Angular's zone to avoid CD
   * thrash — the overlays read it via a computed that the template consumes.
   */
  private readonly transformTick = signal(0);

  /** Minimap overlay visibility + placement (mirrors the legacy canvas). */
  protected readonly minimapVisible = computed(() => this.canvasState.minimapVisible());
  protected readonly minimapAnchor = computed(() => this.canvasState.minimapAnchor());

  /**
   * Inline corner offsets so the minimap clears the chrome. Because the canvas
   * host spans the full viewport (absolute inset-0, beneath the panels), the
   * minimap must inset itself past the right/left sidebars and the bottom
   * terminal dock + status bar. Each binding returns null when the anchor isn't
   * on that edge so it doesn't fight the opposite-edge offset.
   */
  protected readonly minimapRight = computed(() => {
    if (!this.minimapAnchor().endsWith('right')) return null;
    const gap = 12;
    return this.panels.collapsedRight() ? gap : this.panels.rightWidth() + gap;
  });
  protected readonly minimapLeft = computed(() => {
    if (!this.minimapAnchor().endsWith('left')) return null;
    const gap = 12;
    return this.panels.collapsedLeft() ? gap : this.panels.leftWidth() + gap;
  });
  protected readonly minimapBottom = computed(() => {
    if (!this.minimapAnchor().startsWith('bottom')) return null;
    const statusBarHeight = 21;
    const gap = 12;
    return this.terminal.collapsed()
      ? statusBarHeight + gap
      : this.terminal.height() + statusBarHeight + gap;
  });
  protected readonly minimapTop = computed(() => {
    if (!this.minimapAnchor().startsWith('top')) return null;
    const toolbarHeight = 44;
    const tabBarHeight = 36; // document tab bar sits directly below the toolbar
    const gap = 12;
    return toolbarHeight + tabBarHeight + gap;
  });

  /**
   * Whether Shift is currently held — drives the bottom-left "Shift-drag to
   * box-select" hint. The hint clears the left sidebar + bottom terminal dock.
   */
  protected readonly shiftHeld = signal(false);
  protected readonly hintBottom = computed(() => {
    const statusBarHeight = 21;
    const gap = 10;
    return this.terminal.collapsed()
      ? statusBarHeight + gap
      : this.terminal.height() + statusBarHeight + gap;
  });
  protected readonly hintLeft = computed(() => {
    const gap = 10;
    return this.panels.collapsedLeft() ? gap : this.panels.leftWidth() + gap;
  });

  /**
   * Per-node thinking overlays projected into screen space. Reads the live
   * transform (via `transformTick`) so the overlays track pan/zoom. Only nodes
   * with non-empty thinking text are emitted — non-reasoning models render
   * nothing.
   */
  protected readonly thinkingOverlays = computed(() => {
    const thinking = this.runController.nodeThinking();
    if (thinking.size === 0) return [];
    // Touch the tick so this recomputes every frame the renderer paints.
    this.transformTick();
    const sc = this.engine.scale;
    const ox = this.engine.offsetX;
    const oy = this.engine.offsetY;
    const out: {
      nodeId: string;
      screenX: number;
      screenY: number;
      screenW: number;
      text: string;
      streaming: boolean;
    }[] = [];
    for (const [nodeId, entry] of thinking) {
      if (!entry.text) continue;
      const bounds = this.engine.nodeWorldBounds(nodeId);
      if (!bounds) continue;
      out.push({
        nodeId,
        screenX: bounds.x * sc + ox,
        screenY: bounds.y * sc + oy + bounds.h * sc + 6,
        screenW: bounds.w * sc,
        text: entry.text,
        streaming: entry.streaming,
      });
    }
    return out;
  });

  /**
   * Answer cards for suspended Ask-User nodes, projected into screen space.
   * Anchored below the node like the thinking overlay, but offset further so
   * the two never collide when a reasoning agent feeds the question.
   *
   * Questions raised inside a sub-workflow have no node on the active graph,
   * so `nodeWorldBounds` returns null and they are skipped — those stay
   * answerable in the Runs panel.
   */
  protected readonly askUserOverlays = computed(() => {
    const questions = this.runController.pendingQuestions();
    if (questions.length === 0) return [];
    const drafts = this.runController.questionDrafts();
    const thinking = this.runController.nodeThinking();
    // Touch the tick so this recomputes every frame the renderer paints.
    this.transformTick();
    const sc = this.engine.scale;
    const ox = this.engine.offsetX;
    const oy = this.engine.offsetY;
    const out: {
      requestId: string;
      nodeName: string;
      question: string;
      screenX: number;
      screenY: number;
      screenW: number;
      draft: string;
    }[] = [];
    for (const question of questions) {
      const bounds = this.engine.nodeWorldBounds(question.nodeId);
      if (!bounds) continue;
      // Clear the thinking overlay's label row when both are on the node.
      const stacked = (thinking.get(question.nodeId)?.text.length ?? 0) > 0 ? 28 : 0;
      out.push({
        requestId: question.requestId,
        nodeName: question.nodeName,
        question: question.question,
        screenX: bounds.x * sc + ox,
        screenY: bounds.y * sc + oy + bounds.h * sc + 6 + stacked,
        screenW: bounds.w * sc,
        draft: drafts[question.requestId] ?? '',
      });
    }
    return out;
  });

  /**
   * OAuth connection state per node id (`true` when the node has a stored
   * session). Refreshed asynchronously by {@link mcpCredentialRefresher}.
   * Kept as a signal so {@link mcpWarningOverlays} reacts when a connection
   * completes.
   */
  private readonly oauthConnected = signal<ReadonlyMap<string, boolean>>(new Map());

  /**
   * Node ids of MCP nodes that currently carry a configuration warning.
   * Computed from the graph + credential flags + OAuth state WITHOUT reading
   * `transformTick`, so it can feed the renderer's `setWarningNodes` without
   * creating a per-frame feedback loop.
   */
  protected readonly mcpWarningNodeIds = computed<Set<string>>(() => {
    const g = this.graph();
    const flags = this.settings.mcpSecretsConfigured();
    const oauthConnected = this.oauthConnected();
    const out = new Set<string>();
    for (const node of g.nodes) {
      if (node.kind !== 'mcp-tool') continue;
      const warning = this.mcpNodeWarning(node, flags, oauthConnected);
      if (warning) out.add(node.id);
    }
    return out;
  });

  /**
   * Per-node MCP configuration-warning overlays projected into screen space.
   * Emits one entry per MCP node that is missing credentials or not yet
   * connected via OAuth. Reads the live transform (via `transformTick`) so
   * the badges track pan/zoom, mirroring the thinking-overlay pattern.
   */
  protected readonly mcpWarningOverlays = computed(() => {
    const warningIds = this.mcpWarningNodeIds();
    if (warningIds.size === 0) return [];
    const g = this.graph();
    // Touch the tick so this recomputes every frame the renderer paints.
    this.transformTick();
    const sc = this.engine.scale;
    const ox = this.engine.offsetX;
    const oy = this.engine.offsetY;
    const flags = this.settings.mcpSecretsConfigured();
    const oauthConnected = this.oauthConnected();
    const out: { nodeId: string; screenX: number; screenY: number; screenW: number; screenH: number; warning: string; presetId: string | null }[] = [];
    for (const node of g.nodes) {
      if (!warningIds.has(node.id)) continue;
      const warning = this.mcpNodeWarning(node, flags, oauthConnected);
      if (!warning) continue;
      const bounds = this.engine.nodeWorldBounds(node.id);
      if (!bounds) continue;
      const data = node.data as { presetId?: string };
      out.push({
        nodeId: node.id,
        screenX: bounds.x * sc + ox, // left edge
        screenY: bounds.y * sc + oy, // top edge
        screenW: bounds.w * sc,
        screenH: bounds.h * sc,
        warning,
        presetId: data.presetId ?? null,
      });
    }
    return out;
  });

  /**
   * Determines the warning text for an MCP node, or `null` when fully
   * configured. Mirrors the logic in `PropertiesPanel.presetFullyConfigured`
   * but also covers OAuth nodes and generic (non-preset) MCP servers.
   */
  private mcpNodeWarning(
    node: WorkflowNode,
    flags: Record<string, boolean>,
    oauthConnected: ReadonlyMap<string, boolean>,
  ): string | null {
    const data = node.data as { transport?: string; envKeys?: string[]; authMode?: string; authKey?: string; presetId?: string; command?: string; url?: string };
    if (!data) return null;

    // OAuth nodes: warn when not yet connected.
    if (data.authMode === 'oauth') {
      if (!oauthConnected.get(node.id)) {
        const preset = data.presetId ? findMcpPreset(data.presetId) : null;
        const name = preset?.label ?? node.name;
        return `"${name}" is not connected. Select the node and click Connect to authorize.`;
      }
      return null;
    }

    // Bearer / env-var nodes: warn when any declared env key is missing.
    const envKeys = data.envKeys ?? [];
    if (envKeys.length === 0) {
      // Generic stdio MCP with no command configured.
      if (data.transport === 'stdio' && !data.command) {
        return `"${node.name}" has no command configured. Open Settings to set it up.`;
      }
      // Generic SSE MCP with no URL configured.
      if (data.transport === 'sse' && !data.url) {
        return `"${node.name}" has no server URL configured. Open Settings to set it up.`;
      }
      return null;
    }

    const preset = data.presetId ? findMcpPreset(data.presetId) : null;
    const missing = envKeys.filter(
      key => !flags[`${node.id}:${key}`] && !flags[`preset:${data.presetId}:${key}`],
    );
    if (missing.length === 0) return null;

    const name = preset?.label ?? node.name;
    if (preset) {
      const missingLabels = missing
        .map(key => preset.envSchema.find(f => f.name === key)?.label ?? key)
        .join(', ');
      return `"${name}" is missing credentials (${missingLabels}). Set application defaults in Settings -> Integrations.`;
    }
    return `"${name}" is missing credentials. Configure them in Settings -> Integrations.`;
  }

  /**
   * Refreshes MCP secret flags + OAuth connection state for every MCP node in
   * the graph whenever the graph changes. This keeps the canvas warning badges
   * accurate as nodes are added/removed. Runs untracked for the refresh calls
   * to avoid feedback loops: the refreshes write to `mcpSecretsConfigured`
   * asynchronously, and reading that signal here would retrigger this effect.
   * The {@link mcpWarningNodeIds} computed reads `mcpSecretsConfigured`
   * reactively, so badge state updates once the refresh completes.
   */
  protected readonly mcpCredentialRefresher = effect(() => {
    const g = this.graph();
    untracked(() => {
      const mcpNodes = g.nodes.filter(n => n.kind === 'mcp-tool');
      // Refresh secret flags for each MCP node (node scope + preset scope).
      for (const node of mcpNodes) {
        const data = node.data as { envKeys?: string[]; presetId?: string; authMode?: string };
        if (data.envKeys?.length) {
          void this.settings.refreshMcpSecretFlags(node.id, data.envKeys);
          if (data.presetId) {
            void this.settings.refreshPresetSecretFlags(data.presetId, data.envKeys);
          }
        }
      }
      // Refresh OAuth connection state for OAuth nodes.
      const oauthNodes = mcpNodes.filter(n => (n.data as { authMode?: string }).authMode === 'oauth');
      if (oauthNodes.length === 0) {
        if (this.oauthConnected().size > 0) this.oauthConnected.set(new Map());
        return;
      }
      Promise.all(oauthNodes.map(n => this.oauth.isConnected(n.id).then(c => [n.id, c] as const))).then(
        results => {
          const next = new Map<string, boolean>();
          for (const [id, connected] of results) next.set(id, connected);
          this.oauthConnected.set(next);
        },
      );
    });
  });

  /** Minimap backing-store device-pixel size, kept in sync with its CSS box. */
  private miniDpr = 1;

  /** Whether any MCP node currently carries a warning (for the onAfterDraw hook). */
  private hasMcpWarnings(): boolean {
    return this.mcpWarningNodeIds().size > 0;
  }
  private draggingMinimap = false;

  /** The active workflow graph. */
  private readonly graph = computed<WorkflowGraph>(() => this.workflow.graph());

  // Colour resolution probe (resolves CSS-variable colours to paintable rgb).
  private probe?: HTMLElement;
  private readonly colorCache = new Map<string, string>();
  // Icon glyph probe (resolves icon-font ::before glyph + font-family).
  private iconProbe?: HTMLElement;
  private readonly iconCache = new Map<string, { glyph: string; font: string } | null>();

  // Drag-move state.
  private dragSet: string[] = [];
  private dragStart = new Map<string, GraphPosition>();
  private dragPointerWorld = { x: 0, y: 0 };
  private dragLatest = new Map<string, GraphPosition>();
  private moved = false;
  private panning = false;
  /** Tracks whether a pan gesture has exceeded the click-vs-drag threshold. */
  private panMoved = false;
  /** Screen-space pointer position at the start of a pan, for threshold test. */
  private panStartX = 0;
  private panStartY = 0;
  /**
   * Pixel distance a pointer must travel before a pan is treated as a drag
   * rather than a click. Below this, pointer-up clears the selection (a
   * "click away"); at or above, the selection is preserved so panning to
   * reframe a selected node does not deselect it.
   */
  private static readonly PAN_CLICK_THRESHOLD_PX = 4;
  private lastX = 0;
  private lastY = 0;

  // Drag-to-connect state.
  private connectFrom: { id: string; wx: number; wy: number } | null = null;
  /**
   * Reassign state: dragging an existing connection's endpoint to a new port.
   * `connectionId` is removed and recreated on drop. `anchorId` is the fixed
   * endpoint (stays put); `endpoint` says which side is being dragged.
   */
  private reassign: {
    connectionId: string;
    anchorId: string;
    anchorWx: number;
    anchorWy: number;
    endpoint: 'source' | 'target';
  } | null = null;

  // Box-select state (shift-drag on empty canvas).
  private boxStart: { x: number; y: number } | null = null;

  /** World position of the most recent right-click (context-menu adds). */
  private contextWorld: GraphPosition | null = null;

  /** Node under the most recent right-click, for node-scoped menu actions. */
  private readonly contextNodeId = signal<string | null>(null);

  /**
   * Right-click context menu: node actions when a node is under the cursor,
   * plus an "Add" submenu built from the node catalog and canvas actions.
   */
  protected readonly contextMenuItems = computed<MenuItem[]>(() => {
    const nodeId = this.contextNodeId();
    const readOnly = !!this.workflow.activeDoc()?.readOnly;
    const nodeItems: MenuItem[] = nodeId
      ? [
        {
          label: this.runController.breakpoints().has(nodeId)
            ? 'Remove Breakpoint'
            : 'Add Breakpoint',
          icon: this.runController.breakpoints().has(nodeId)
            ? 'ti ti-target-off'
            : 'ti ti-target',
          command: () => this.runController.toggleBreakpoint(nodeId),
        },
        {
          label: 'Extract to Sub-Workflow',
          icon: 'ti ti-stack-push',
          disabled: readOnly,
          command: () => void this.extractContextSelection(nodeId),
        },
        {
          label: 'Delete Node',
          icon: 'ti ti-trash',
          disabled: readOnly,
          command: () => {
            this.removeNode(nodeId);
            this.selection.clear();
          },
        },
        { separator: true },
      ]
      : [];
    return [
      ...nodeItems,
      {
        label: 'Add',
        icon: 'ti ti-plus',
        disabled: readOnly,
        items: NODE_CATEGORY_SECTIONS.map(section => ({
          label: section.label,
          items: NODE_CATALOG.filter(entry => entry.category === section.category).map(entry => ({
            label: entry.label,
            icon: entry.icon,
            command: () => this.addNodeAtContext(entry.id),
          })),
        })),
      },
      { separator: true },
      { label: 'Arrange Nodes', icon: 'ti ti-layout-distribute-horizontal', disabled: readOnly, command: () => this.selection.arrangeNodes() },
    ];
  });

  constructor() {
    // Re-map the scene on graph or theme/palette change.
    effect(() => {
      const g = this.graph();
      this.theme.mode();
      this.theme.palette();
      untracked(() => this.rebuildScene(g));
    });

    // Mirror node + connection selection into the renderer.
    effect(() => {
      const ids = this.selection.selectedNodeIds();
      untracked(() => this.engine.setSelection(ids));
    });
    effect(() => {
      const ids = this.selection.selectedConnectionIds();
      untracked(() => this.engine.setSelectedConnections(ids));
    });
    // Agent-editing glow.
    effect(() => {
      const ids = this.agentStream.editingNodes();
      untracked(() => this.engine.setEditing(ids));
    });
    // Run visualization: node state rings, pulsing handoff wires, breakpoints.
    effect(() => {
      const states = this.runController.nodeStates();
      untracked(() => this.engine.setNodeStates(states));
    });
    effect(() => {
      const edges = this.runController.activeEdges();
      untracked(() => this.engine.setActiveEdges(edges));
    });
    effect(() => {
      const breakpoints = this.runController.breakpoints();
      untracked(() => this.engine.setBreakpoints(breakpoints));
    });
    // MCP configuration warnings: dashed amber outline on unconfigured nodes.
    effect(() => {
      const ids = this.mcpWarningNodeIds();
      untracked(() => this.engine.setWarningNodes(ids));
    });
    // Click-to-add from the palette: place at the viewport centre, cascading
    // successive adds so they don't stack exactly.
    effect(() => {
      const request = this.nodeDrag.addRequest();
      if (!request) return;
      untracked(() => {
        const center = this.viewportCenterWorld();
        const offset = (request.nonce % 5) * 28;
        let position = { x: center.x - 110 + offset, y: center.y - 40 + offset };
        if (this.canvasState.gridSnap()) position = this.canvasState.snapPosition(position);
        const node = this.workflow.addNodeFromCatalog(request.entryId, position);
        if (node) this.selection.selectNode(node.id);
      });
    });
    // Dot-grid visibility toggle.
    effect(() => {
      const visible = this.canvasState.gridVisible();
      untracked(() => this.engine.setGridVisible(visible));
    });
    // Grid spacing: re-renders the dot grid to match the snap setting.
    effect(() => {
      const spacing = this.settings.gridSnapSize();
      untracked(() => this.engine.setGridSpacing(spacing));
    });

    // Toolbar / View-menu zoom commands.
    effect(() => {
      const cmd = this.canvasState.zoomCommand();
      if (!cmd) return;
      untracked(() => {
        this.applyZoomCommand(cmd);
        this.canvasState.zoomCommand.set(null);
      });
    });

    // Redraw the minimap when it becomes visible or its anchor changes.
    effect(() => {
      this.canvasState.minimapVisible();
      this.canvasState.minimapAnchor();
      untracked(() => queueMicrotask(() => this.drawMinimap()));
    });
  }

  ngAfterViewInit(): void {
    const cv = this.cvRef.nativeElement;

    this.probe = document.createElement('span');
    this.probe.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none;';
    this.el.nativeElement.appendChild(this.probe);

    this.iconProbe = document.createElement('i');
    this.iconProbe.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none;';
    this.el.nativeElement.appendChild(this.iconProbe);

    this.engine.theme = this.buildTheme();
    this.engine.setGridVisible(this.canvasState.gridVisible());
    this.engine.onScaleChange = s =>
      this.zone.run(() => this.canvasState.zoomScale.set(Math.round(s * 100)));
    this.engine.onAfterDraw = () => {
      this.drawMinimap();
      // Bump the overlay transform tick so they re-project from the live
      // pan/zoom. Only run inside Angular's zone when there are overlays to
      // reposition (avoids CD thrash on every idle frame).
      if (
        this.runController.nodeThinking().size > 0 ||
        this.runController.pendingQuestions().length > 0 ||
        this.hasMcpWarnings()
      ) {
        this.zone.run(() => this.transformTick.update(v => v + 1));
      }
    };
    this.engine.attach(cv);

    this.rebuildScene(this.graph());
    this.engine.setSelection(this.selection.selectedNodeIds());
    this.engine.setSelectedConnections(this.selection.selectedConnectionIds());

    this.zone.runOutsideAngular(() => {
      cv.addEventListener('wheel', this.onWheel, { passive: false });
      cv.addEventListener('pointerdown', this.onPointerDown);
      cv.addEventListener('pointerleave', this.onPointerLeave);
      window.addEventListener('pointermove', this.onPointerMove);
      window.addEventListener('pointerup', this.onPointerUp);
      window.addEventListener('keydown', this.onKeyDown);
      window.addEventListener('keydown', this.onShiftDown);
      window.addEventListener('keyup', this.onShiftUp);
      window.addEventListener('blur', this.onWindowBlur);
    });

    queueMicrotask(() => {
      const saved = this.canvasState.getCanvasTransform(this.viewKey());
      if (saved) {
        this.engine.setTransform(saved.sc, saved.ox, saved.oy);
      } else {
        this.engine.fit(0.9, this.visibleInset());
      }
    });
  }

  /** Stable key for the current view's transform (the active document id). */
  private viewKey(): string {
    return this.workflow.activeDocId() ?? 'workflow';
  }

  ngOnDestroy(): void {
    this.canvasState.saveCanvasTransform(this.viewKey(), {
      sc: this.engine.scale,
      ox: this.engine.offsetX,
      oy: this.engine.offsetY,
    });
    const cv = this.cvRef?.nativeElement;
    cv?.removeEventListener('wheel', this.onWheel);
    cv?.removeEventListener('pointerdown', this.onPointerDown);
    cv?.removeEventListener('pointerleave', this.onPointerLeave);
    window.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerup', this.onPointerUp);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keydown', this.onShiftDown);
    window.removeEventListener('keyup', this.onShiftUp);
    window.removeEventListener('blur', this.onWindowBlur);
    this.engine.detach();
    this.probe?.remove();
    this.iconProbe?.remove();
  }

  // ── Scene + theme ─────────────────────────────────────────────────────────
  private rebuildScene(g: WorkflowGraph): void {
    this.colorCache.clear();
    this.iconCache.clear();
    this.engine.theme = this.buildTheme();
    const scene = graphToScene(
      g,
      raw => this.resolveColor(raw),
      icon => this.resolveIcon(icon),
    );
    this.engine.setScene(scene.nodes, scene.edges);
  }

  private buildTheme(): RendererTheme {
    return {
      background: this.resolveColor('var(--phorma-canvas-bg, #0b0e16)'),
      nodeBody: this.resolveColor('var(--phorma-node-bg, #161b27)'),
      nodeHeaderBg: this.resolveColor('var(--phorma-node-header-bg, #1b2130)'),
      nodeDivider: this.resolveColor('var(--phorma-node-divider, rgba(255,255,255,0.08))'),
      nodeBorder: this.resolveColor('var(--phorma-node-border, rgba(255,255,255,0.10))'),
      nodeBorderSelected: this.resolveColor('var(--phorma-accent-blue, #60a5fa)'),
      nodeBorderEditing: this.resolveColor('var(--p-primary-color, #a78bfa)'),
      nodeTitle: this.resolveColor('var(--p-text-color, #e2e8f0)'),
      rowText: this.resolveColor('var(--p-text-muted-color, #94a3b8)'),
      portSocketFill: this.resolveColor('var(--phorma-node-header-bg, #1b2130)'),
      toolsPort: this.resolveColor('var(--phorma-port-tools, #fbbf24)'),
      groupLabel: this.resolveColor('var(--p-text-muted-color, rgba(148,163,184,0.55))'),
      wire: this.resolveColor('var(--phorma-wire-color, rgba(148,163,184,0.45))'),
      wireWarning: this.resolveColor('var(--phorma-accent-amber, #f59e0b)'),
      wireError: this.resolveColor('var(--phorma-accent-red, #ef4444)'),
      wireActive: this.resolveColor('var(--p-primary-color, #818cf8)'),
      gridDot: this.resolveColor('var(--phorma-dot-color, rgba(148,163,184,0.18))'),
      stateThinking: this.resolveColor('var(--p-primary-color, #818cf8)'),
      stateQueued: this.resolveColor('var(--p-text-muted-color, #94a3b8)'),
      stateWaiting: this.resolveColor('var(--phorma-port-tools, #fbbf24)'),
      stateDone: this.resolveColor('var(--phorma-accent-green, #34d399)'),
      stateError: this.resolveColor('var(--phorma-accent-red, #ef4444)'),
    };
  }

  /** Resolves an icon class (e.g. 'ti ti-robot') to its glyph char + font. */
  private resolveIcon(iconClass: string): { glyph: string; font: string } | null {
    if (!iconClass) return null;
    if (this.iconCache.has(iconClass)) return this.iconCache.get(iconClass) ?? null;
    let result: { glyph: string; font: string } | null = null;
    if (this.iconProbe) {
      this.iconProbe.className = iconClass;
      const before = getComputedStyle(this.iconProbe, '::before');
      const content = before.content;
      if (content && content !== 'none' && content !== 'normal') {
        const glyph = content.replace(/^["']|["']$/g, '');
        const font = before.fontFamily || 'tabler-icons';
        if (glyph) result = { glyph, font };
      }
    }
    this.iconCache.set(iconClass, result);
    return result;
  }

  private resolveColor(raw: string): string {
    const cached = this.colorCache.get(raw);
    if (cached) return cached;
    let resolved = raw;
    if (this.probe && raw.includes('var(')) {
      this.probe.style.color = '';
      this.probe.style.color = raw;
      const computed = getComputedStyle(this.probe).color;
      if (computed) resolved = computed;
    }
    this.colorCache.set(raw, resolved);
    return resolved;
  }

  // ── Zoom commands ─────────────────────────────────────────────────────────

  /**
   * Computes the screen-space inset (left/top/right/bottom in px) occupied by
   * chrome — toolbar + tab bar on top, sidebars on the sides, footer + terminal
   * dock at the bottom. Used by `fit()` so the framed graph centres inside the
   * visible region instead of under the panels.
   */
  private visibleInset(): { left: number; top: number; right: number; bottom: number } {
    const toolbarHeight = 44;
    const tabBarHeight = 36;
    const footerHeight = 24;
    const left = this.panels.collapsedLeft() ? 0 : this.panels.leftWidth();
    const right = this.panels.collapsedRight() ? 0 : this.panels.rightWidth();
    const bottom = footerHeight + (this.terminal.collapsed() ? 0 : this.terminal.height());
    return { left, top: toolbarHeight + tabBarHeight, right, bottom };
  }

  private applyZoomCommand(cmd: 'in' | 'out' | 'reset' | 'fit'): void {
    const cv = this.cvRef.nativeElement;
    const rect = cv.getBoundingClientRect();
    const cx = rect.left + cv.clientWidth / 2;
    const cy = rect.top + cv.clientHeight / 2;
    switch (cmd) {
      case 'in':
        this.engine.zoomAt(cx, cy, 1.2);
        break;
      case 'out':
        this.engine.zoomAt(cx, cy, 1 / 1.2);
        break;
      case 'reset':
      case 'fit':
        this.engine.fit(0.9, this.visibleInset());
        break;
    }
  }

  // ── Pointer input ───────────────────────────────────────────────────────────
  private readonly onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    // 0.0015 is the baseline wheel→zoom factor; the settings multiplier
    // (Settings → Canvas → Zoom sensitivity) scales it 0.25×–3×.
    const factor = 0.0015 * this.settings.zoomSensitivity();
    this.engine.zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * factor));
  };

  private readonly onPointerDown = (e: PointerEvent): void => {
    if (e.button !== 0) return;
    const w = this.engine.screenToWorld(e.clientX, e.clientY);
    const sc = this.engine.scale;

    // 1) Output port → start a drag-to-connect (connections originate at outputs).
    const port = this.engine.hitTestPort(w.x, w.y, 12 / sc);
    if (port && port.port.side === 'out') {
      this.connectFrom = { id: port.port.id, wx: port.wx, wy: port.wy };
      this.engine.setPendingWire({ x: port.wx, y: port.wy }, w);
      return;
    }

    // 1a) Input port that already has a wire → grab it to reassign the target.
    if (port && port.port.side === 'in') {
      const conn = this.graph().connections.find(c => c.inputId === port.port.id);
      if (conn) {
        const anchor = this.engine.portPosition(conn.outputId);
        if (anchor) {
          this.reassign = {
            connectionId: conn.id,
            anchorId: conn.outputId,
            anchorWx: anchor.x,
            anchorWy: anchor.y,
            endpoint: 'target',
          };
          this.engine.setPendingWire({ x: anchor.x, y: anchor.y }, w);
          if (this.cvRef) this.cvRef.nativeElement.style.cursor = 'crosshair';
          return;
        }
      }
    }

    // 1b) Connection wire → nothing special at pointer-down beyond selection
    //     (handled below by hitTestEdge).

    // 2) Node → select + start a drag-move.
    const hit = this.engine.hitTestNode(w.x, w.y);
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    this.moved = false;
    if (hit) {
      if (!this.selection.selectedNodeIds().has(hit.id)) {
        this.selection.selectNode(hit.id, e.shiftKey);
      }
      const ids = new Set(this.selection.selectedNodeIds());
      ids.add(hit.id);
      this.dragSet = [...ids];
      this.dragStart.clear();
      const positions = this.nodePositions();
      for (const id of this.dragSet) {
        const p = positions.get(id);
        if (p) this.dragStart.set(id, p);
      }
      this.dragPointerWorld = w;
      return;
    }

    // 3) Wire → select the connection.
    const edgeId = this.engine.hitTestEdge(w.x, w.y, 6 / sc);
    if (edgeId) {
      this.selection.selectConnections([edgeId]);
      return;
    }

    // 4) Empty → shift starts a box-select, otherwise pan. Deselection is
    //    deferred to pointer-up so that a pan (drag to reframe) does NOT
    //    clear the current selection; only a true click on empty canvas does.
    if (e.shiftKey) {
      this.boxStart = w;
      this.engine.setSelectionRect({ minX: w.x, minY: w.y, maxX: w.x, maxY: w.y });
    } else {
      this.panning = true;
      this.panMoved = false;
      this.panStartX = e.clientX;
      this.panStartY = e.clientY;
      if (this.cvRef) this.cvRef.nativeElement.style.cursor = 'grabbing';
    }
  };

  private readonly onPointerMove = (e: PointerEvent): void => {
    if (this.connectFrom) {
      const w = this.engine.screenToWorld(e.clientX, e.clientY);
      this.engine.setPendingWire({ x: this.connectFrom.wx, y: this.connectFrom.wy }, w);
      return;
    }
    if (this.reassign) {
      const w = this.engine.screenToWorld(e.clientX, e.clientY);
      this.engine.setPendingWire({ x: this.reassign.anchorWx, y: this.reassign.anchorWy }, w);
      return;
    }
    if (this.boxStart) {
      const w = this.engine.screenToWorld(e.clientX, e.clientY);
      const rect = {
        minX: Math.min(this.boxStart.x, w.x),
        minY: Math.min(this.boxStart.y, w.y),
        maxX: Math.max(this.boxStart.x, w.x),
        maxY: Math.max(this.boxStart.y, w.y),
      };
      this.engine.setSelectionRect(rect);
      this.engine.setSelection(
        this.engine.nodesInRect(rect.minX, rect.minY, rect.maxX, rect.maxY).map(n => n.id),
      );
      return;
    }
    if (this.dragSet.length > 0) {
      const w = this.engine.screenToWorld(e.clientX, e.clientY);
      const dx = w.x - this.dragPointerWorld.x;
      const dy = w.y - this.dragPointerWorld.y;
      this.moved = true;
      this.dragLatest.clear();
      for (const id of this.dragSet) {
        const start = this.dragStart.get(id);
        if (!start) continue;
        const nx = start.x + dx;
        const ny = start.y + dy;
        this.engine.moveNode(id, nx, ny);
        this.dragLatest.set(id, { x: nx, y: ny });
      }
    } else if (this.panning) {
      const dx = e.clientX - this.lastX;
      const dy = e.clientY - this.lastY;
      this.engine.panBy(dx, dy);
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      // Mark as a real drag once the cumulative movement from the press
      // point exceeds the click threshold. This is what suppresses the
      // "click away to deselect" behaviour during a pan.
      if (!this.panMoved) {
        const totalDx = e.clientX - this.panStartX;
        const totalDy = e.clientY - this.panStartY;
        if (
          totalDx * totalDx + totalDy * totalDy >=
          GraphCanvas.PAN_CLICK_THRESHOLD_PX * GraphCanvas.PAN_CLICK_THRESHOLD_PX
        ) {
          this.panMoved = true;
        }
      }
    } else {
      this.updateHoverCursor(e.clientX, e.clientY);
    }
    // Spotlight glow + grid distortion follow the cursor on every move.
    this.updateSpotlight(e.clientX, e.clientY);
    this.engine.setCursor(e.clientX, e.clientY);
  };

  /**
   * Updates the cursor-spotlight CSS vars on the host. The glow dims to 0 when
   * the cursor is over a node (so node chrome stays crisp) and back to 1 over
   * the open canvas.
   */
  private updateSpotlight(clientX: number, clientY: number): void {
    const cv = this.cvRef?.nativeElement;
    const host = this.el.nativeElement;
    if (!cv) return;
    const rect = cv.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    host.style.setProperty('--x', `${x}px`);
    host.style.setProperty('--y', `${y}px`);
    host.style.setProperty('--spotlight-opacity', '1');
    const w = this.engine.screenToWorld(clientX, clientY);
    host.style.setProperty('--spotlight-node-dim', this.engine.hitTestNode(w.x, w.y) ? '0' : '1');
  }

  /** Cursor left the canvas: fade out the spotlight and clear grid distortion. */
  private readonly onPointerLeave = (): void => {
    this.el.nativeElement.style.setProperty('--spotlight-opacity', '0');
    this.engine.setCursor(null, null);
    if (this.engine.setHoveredEdge(null)) this.engine.requestDraw();
  };

  /** Shift pressed/released → toggle the box-select hint (inside the zone). */
  private readonly onShiftDown = (e: KeyboardEvent): void => {
    if (e.key === 'Shift' && !this.shiftHeld()) this.zone.run(() => this.shiftHeld.set(true));
  };
  private readonly onShiftUp = (e: KeyboardEvent): void => {
    if (e.key === 'Shift' && this.shiftHeld()) this.zone.run(() => this.shiftHeld.set(false));
  };
  /** Clear the stuck hint if focus is lost while Shift is down (alt-tab). */
  private readonly onWindowBlur = (): void => {
    if (this.shiftHeld()) this.zone.run(() => this.shiftHeld.set(false));
  };

  /** Idle cursor feedback: move over a node, crosshair over an output port. */
  private updateHoverCursor(clientX: number, clientY: number): void {
    const cv = this.cvRef?.nativeElement;
    if (!cv) return;
    const w = this.engine.screenToWorld(clientX, clientY);
    const sc = this.engine.scale;
    const port = this.engine.hitTestPort(w.x, w.y, 12 / sc);
    const edgeId = this.engine.hitTestEdge(w.x, w.y, 6 / sc);
    if (port && port.port.side === 'out') {
      cv.style.cursor = 'crosshair';
      if (this.engine.setHoveredEdge(null)) this.engine.requestDraw();
    } else if (port && port.port.side === 'in' && edgeId) {
      // Reassignable wire end.
      cv.style.cursor = 'crosshair';
      if (this.engine.setHoveredEdge(edgeId)) this.engine.requestDraw();
    } else if (edgeId) {
      cv.style.cursor = 'default';
      if (this.engine.setHoveredEdge(edgeId)) this.engine.requestDraw();
    } else if (this.engine.hitTestNode(w.x, w.y)) {
      cv.style.cursor = 'move';
      if (this.engine.setHoveredEdge(null)) this.engine.requestDraw();
    } else {
      cv.style.cursor = 'grab';
      if (this.engine.setHoveredEdge(null)) this.engine.requestDraw();
    }
  }

  private readonly onPointerUp = (e: PointerEvent): void => {
    // Finish a drag-to-connect.
    if (this.connectFrom) {
      const w = this.engine.screenToWorld(e.clientX, e.clientY);
      const target = this.engine.hitTestPort(w.x, w.y, 14 / this.engine.scale);
      if (target && target.port.id !== this.connectFrom.id) {
        const norm = this.normalizeConnection(this.connectFrom.id, target.port.id);
        if (norm) this.addConnection(norm.outputId, norm.inputId);
      }
      this.connectFrom = null;
      this.engine.setPendingWire(null);
      return;
    }

    // Finish a connection reassign: drop on a new input port to re-target.
    if (this.reassign) {
      const r = this.reassign;
      const w = this.engine.screenToWorld(e.clientX, e.clientY);
      const target = this.engine.hitTestPort(w.x, w.y, 14 / this.engine.scale);
      if (target && target.port.side === 'in') {
        const norm = this.normalizeConnection(r.anchorId, target.port.id);
        if (norm) {
          this.zone.run(() => {
            this.removeConnection(r.connectionId);
            this.addConnection(norm.outputId, norm.inputId);
          });
        }
      }
      this.reassign = null;
      this.engine.setPendingWire(null);
      this.updateHoverCursor(e.clientX, e.clientY);
      return;
    }

    // Finish a box-select.
    if (this.boxStart) {
      const w = this.engine.screenToWorld(e.clientX, e.clientY);
      const ids = this.engine
        .nodesInRect(
          Math.min(this.boxStart.x, w.x),
          Math.min(this.boxStart.y, w.y),
          Math.max(this.boxStart.x, w.x),
          Math.max(this.boxStart.y, w.y),
        )
        .map(n => n.id);
      this.selection.setNodes(ids);
      this.engine.setSelectionRect(null);
      this.boxStart = null;
      return;
    }

    // Commit a drag-move.
    if (this.dragSet.length > 0 && this.moved) {
      const snap = this.canvasState.gridSnap();
      const updates = new Map<string, GraphPosition>();
      for (const [id, pos] of this.dragLatest) {
        updates.set(id, snap ? this.canvasState.snapPosition(pos) : pos);
      }
      this.selection.moveNodes(updates);
    }
    this.dragSet = [];
    this.dragStart.clear();
    this.dragLatest.clear();
    this.moved = false;
    if (this.panning) {
      // A pan that never exceeded the click threshold is treated as a
      // "click away" on empty canvas → clear the selection. A real pan
      // (drag to reframe) preserves the selection so the user can pan a
      // selected node into view before editing its properties.
      if (!this.panMoved) this.selection.deselect();
      this.panning = false;
      this.panMoved = false;
      this.updateHoverCursor(e.clientX, e.clientY);
    }
  };

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (e.key !== 'Delete' && e.key !== 'Backspace') return;
    if (this.isTextEditingTarget(e.target)) return;
    if (
      this.selection.selectedNodeIds().size === 0 &&
      this.selection.selectedConnectionIds().size === 0
    ) {
      return;
    }
    e.preventDefault();
    this.zone.run(() => void this.deleteSelection());
  };

  // ── Editing operations ──────────────────────────────────────────────────────
  /** Double-click a node to jump to its Prompt panel (agents) / Properties. */
  protected onDblClick(e: MouseEvent): void {
    const w = this.engine.screenToWorld(e.clientX, e.clientY);
    const hit = this.engine.hitTestNode(w.x, w.y);
    if (!hit) return;
    const node = this.graph().nodes.find(n => n.id === hit.id);
    if (!node) return;
    this.selection.selectNode(node.id);
    // Agents open the Prompt editor; everything else opens Properties.
    const tabId = node.kind === 'agent' ? 'prompt' : 'properties';
    const tab = this.panels.tabs().find(t => t.id === tabId);
    if (!tab) return;
    this.panels.setActive(tab.side, tabId);
    if (tab.side === 'right') this.panels.expandRight();
    else this.panels.expandLeft();
  }

  // ── Minimap ───────────────────────────────────────────────────────────────
  /** Renders the overview into the minimap canvas (called after each frame). */
  private drawMinimap(): void {
    const mini = this.miniRef?.nativeElement;
    if (!mini) return;
    const cssW = mini.clientWidth;
    const cssH = mini.clientHeight;
    if (cssW === 0 || cssH === 0) return;

    // Keep the backing store in sync with the CSS box at device resolution.
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const needW = Math.round(cssW * dpr);
    const needH = Math.round(cssH * dpr);
    if (mini.width !== needW || mini.height !== needH || this.miniDpr !== dpr) {
      mini.width = needW;
      mini.height = needH;
      this.miniDpr = dpr;
    }

    const ctx = mini.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.engine.drawMinimap(ctx, cssW, cssH);
  }

  /** Pointer-down on the minimap: jump there, then track drag to pan. */
  protected onMinimapPointerDown(e: PointerEvent): void {
    e.preventDefault();
    e.stopPropagation();
    const mini = this.miniRef?.nativeElement;
    if (!mini) return;
    this.draggingMinimap = true;
    mini.setPointerCapture(e.pointerId);
    this.navigateMinimap(e);
  }

  protected readonly onMinimapPointerMove = (e: PointerEvent): void => {
    if (!this.draggingMinimap) return;
    this.navigateMinimap(e);
  };

  protected readonly onMinimapPointerUp = (e: PointerEvent): void => {
    if (!this.draggingMinimap) return;
    this.draggingMinimap = false;
    this.miniRef?.nativeElement.releasePointerCapture?.(e.pointerId);
  };

  /** Converts a minimap pointer event to a viewport recentre. */
  private navigateMinimap(e: PointerEvent): void {
    const mini = this.miniRef?.nativeElement;
    if (!mini) return;
    const rect = mini.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    this.engine.navigateFromMinimap(mx, my, rect.width, rect.height);
    this.engine.requestDraw();
  }

  /** Remembers where the user right-clicked so "Add" drops the node there. */
  protected onCanvasContextMenu(e: MouseEvent): void {
    this.contextWorld = this.engine.screenToWorld(e.clientX, e.clientY);
    const hit = this.engine.hitTestNode(this.contextWorld.x, this.contextWorld.y);
    this.contextNodeId.set(hit?.id ?? null);
  }

  /** Extracts the current multi-selection, or only the right-clicked node. */
  private async extractContextSelection(contextNodeId: string): Promise<void> {
    if (this.workflow.activeDoc()?.readOnly) return;
    const currentSelection = this.selection.selectedNodeIds();
    const selectedIds = currentSelection.has(contextNodeId)
      ? new Set(currentSelection)
      : new Set([contextNodeId]);

    const name = await this.confirmDialog.prompt(
      {
        title: 'Extract to Sub-Workflow',
        message: 'Name the reusable workflow created from this selection.',
        confirmLabel: 'Extract',
        cancelLabel: 'Cancel',
      },
      {
        initialValue: 'Extracted Workflow',
        placeholder: 'Extracted Workflow',
        label: 'Workflow name',
        maxLength: 80,
      },
    );
    if (name === null) return;

    const sourceDocId = this.workflow.activeDoc()?.docId;
    const sourceGraph = this.graph();
    if (!sourceDocId) return;
    const stamp = Date.now().toString(36);
    const workflowId = `wf-${stamp}`;
    const extraction = extractSubWorkflow(sourceGraph, selectedIds, {
      workflowId,
      workflowName: name,
      savedAt: new Date().toISOString(),
      subWorkflows: this.workflow.exportActiveSpec()?.subWorkflows,
    });
    if (!extraction.ok) {
      this.toast.error('Cannot extract selection', extraction.error);
      return;
    }

    const saved = await this.workflow.saveNewSpecToLibrary(extraction.value.childSpec);
    if (!saved) return;

    // Saving the child is asynchronous. Never apply a replacement computed
    // from stale source state if the user switched tabs or edited the graph
    // while IndexedDB/version history was being written.
    const currentDoc = this.workflow.activeDoc();
    if (currentDoc?.docId !== sourceDocId || currentDoc.graph !== sourceGraph) {
      this.toast.warning(
        'Parent workflow changed',
        `Saved "${saved.name}", but left the parent untouched because its source changed during extraction.`,
      );
      return;
    }

    const replacement = extraction.value.replacementNode;
    const parentGraph = saved.id === workflowId
      ? extraction.value.parentGraph
      : {
        ...extraction.value.parentGraph,
        nodes: extraction.value.parentGraph.nodes.map(node =>
          node.id === replacement.id
            ? {
              ...node,
              data: { ...node.data, workflowId: saved.id, workflowName: saved.name },
            }
            : node,
        ),
      };
    this.history.boundaryOnce();
    this.workflow.replaceGraph(parentGraph);
    this.selection.setNodes([replacement.id]);
    this.toast.success(
      'Sub-workflow extracted',
      `Saved "${saved.name}" and replaced ${extraction.value.movedNodeIds.length} selected node${extraction.value.movedNodeIds.length === 1 ? '' : 's'}.`,
    );
  }

  /** Adds a catalog node at the last right-click position (context menu). */
  private addNodeAtContext(entryId: string): void {
    let position = this.contextWorld ?? this.viewportCenterWorld();
    if (this.canvasState.gridSnap()) position = this.canvasState.snapPosition(position);
    const node = this.workflow.addNodeFromCatalog(entryId, position);
    if (node) this.selection.selectNode(node.id);
  }

  /** World coordinates of the visible viewport centre (fallback add position). */
  private viewportCenterWorld(): GraphPosition {
    const cv = this.cvRef.nativeElement;
    const rect = cv.getBoundingClientRect();
    return this.engine.screenToWorld(rect.left + rect.width / 2, rect.top + rect.height / 2);
  }

  /** Accept a connection started from either side; store output → input. */
  private normalizeConnection(aId: string, bId: string): { outputId: string; inputId: string } | null {
    if (aId.endsWith('-out') && bId.endsWith('-in')) return { outputId: aId, inputId: bId };
    if (aId.endsWith('-in') && bId.endsWith('-out')) return { outputId: bId, inputId: aId };
    return null;
  }

  /**
   * Validates a prospective connection against the workflow port-role rules
   * (handoffs run message-out to message-in; tool links join tools ports).
   * Returns `null` when valid, or a short reason string for a toast.
   */
  private validateConnection(outputId: string, inputId: string): string | null {
    const graph = this.graph();
    const source = findNodeForConnector(graph, outputId);
    const target = findNodeForConnector(graph, inputId);
    if (!source || !target) return 'One of the ports no longer exists.';
    if (source.node.id === target.node.id) {
      return 'A node cannot connect to itself.';
    }
    if (!canConnectPorts(source.port.role, target.port.role)) {
      if (source.port.role === 'tools' || target.port.role === 'tools') {
        return 'Tools ports only connect to other tools ports.';
      }
      return 'Handoffs flow from a Result port into a Task port.';
    }
    return null;
  }

  private addConnection(outputId: string, inputId: string): void {
    const reason = this.validateConnection(outputId, inputId);
    if (reason) {
      this.toast.warning('Connection rejected', reason);
      return;
    }
    this.zone.run(() => {
      this.workflow.addConnection(outputId, inputId);
    });
  }

  private removeConnection(connectionId: string): void {
    this.workflow.removeConnection(connectionId);
  }

  private removeNode(nodeId: string): void {
    this.workflow.removeNode(nodeId);
    this.runController.clearThinking(nodeId);
  }

  private deleteSelection(): void {
    const connectionIds = [...this.selection.selectedConnectionIds()];
    if (connectionIds.length > 0) {
      for (const id of connectionIds) this.removeConnection(id);
      this.selection.clear();
      return;
    }
    const nodes = this.selection.selectedNodes();
    if (nodes.length === 0) return;
    for (const node of nodes) this.removeNode(node.id);
    this.selection.clear();
  }

  // ── Drag & drop from the Agents palette ─────────────────────────────────────
  protected onDragOver(event: DragEvent): void {
    if (!this.dragContainsDroppable(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  }

  protected onDrop(event: DragEvent): void {
    const world = this.engine.screenToWorld(event.clientX, event.clientY);
    let position: GraphPosition = { x: world.x, y: world.y };
    if (this.canvasState.gridSnap()) position = this.canvasState.snapPosition(position);

    const entryId = event.dataTransfer?.getData(PHORMA_NODE_MIME) || this.nodeDrag.activeId();
    if (!entryId) return;
    event.preventDefault();
    event.stopPropagation();
    const node = this.workflow.addNodeFromCatalog(entryId, position);
    if (node) this.selection.selectNode(node.id);
    this.nodeDrag.stop();
  }

  private dragContainsDroppable(event: DragEvent): boolean {
    if (this.nodeDrag.activeId()) return true;
    return !!event.dataTransfer?.types.includes(PHORMA_NODE_MIME);
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────
  private isTextEditingTarget(target: EventTarget | null): boolean {
    const element = target as HTMLElement | null;
    return !!element?.closest('input, textarea, select, [contenteditable="true"]');
  }

  private nodePositions(): Map<string, GraphPosition> {
    const map = new Map<string, GraphPosition>();
    for (const n of this.graph().nodes) map.set(n.id, n.position);
    return map;
  }
}
