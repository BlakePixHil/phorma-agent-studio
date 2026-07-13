/**
 * ── CanvasGraphRenderer ──────────────────────────────────────────────────────
 *
 * Framework-agnostic, immediate-mode Canvas 2D renderer for large node graphs.
 *
 * Responsibilities (pure rendering + geometry — NO app/Angular knowledge):
 *  - Hold a scene of nodes + edges in world coordinates.
 *  - Maintain a uniform spatial grid + per-node edge adjacency so every frame
 *    visits only what is visible (O(visible)), not the whole graph (O(total)).
 *  - Own the rAF draw loop, DPR scaling, resize handling, and FPS sampling.
 *  - Provide world<->screen mapping, node/port hit-testing, pan/zoom, and fit.
 *  - Apply level-of-detail (drop text/ports/wires as zoom decreases).
 *
 * Interaction *policy* (what a drag means, selection rules, committing moves to
 * app state) lives in the host component, which routes pointer events to this
 * engine's geometry/transform methods. That keeps the engine reusable.
 */

export interface RendererPort {
  /** Stable port id used to match edges (the app's connector id). */
  id: string;
  side: 'in' | 'out';
  /** Vertical offset of the port centre from the node's top edge (world px). */
  y: number;
  /** Dot colour. */
  color: string;
  /** Optional display label drawn in the row (defaults to the id). */
  label?: string;
  /** Optional group key — when it changes between consecutive ports on the
   * same side, the renderer draws a divider + group label. */
  group?: string;
  /** Whether this is a tools/capability port (rendered with a distinct
   * accent) or a message port (the default). */
  portKind?: 'message' | 'tools';
}

export interface RendererNode {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  title: string;
  kind: string;
  /** Header accent colour. */
  accent: string;
  ports: RendererPort[];
  /** Resolved icon glyph character (from the icon font's ::before content). */
  iconGlyph?: string;
  /** Icon font-family to paint the glyph with (e.g. 'tabler-icons'). */
  iconFont?: string;
  /** Body rows (one per visible property): name on the left, type on the right. */
  rows?: { y: number; name: string; type: string; typeColor: string }[];
  /** Group divider rows, drawn as a thin labelled separator between port
   * groups (e.g. between Inputs and Dependencies). The y is the vertical
   * offset of the divider centre from the node's top edge. When `line` is
   * false, only the label renders (no separator stroke) — used for the
   * first group on the node. */
  groupDividers?: { y: number; label: string; line?: boolean }[];
  /** Whether the node can be drilled into (shows an edit button in the header). */
  drillable?: boolean;
  /**
   * Whether the node has a configuration warning (e.g. an MCP server missing
   * credentials). Draws an amber warning badge in the header's top-right
   * corner; click opens a popover with details + a settings deep-link.
   */
  warning?: boolean;
}

export interface RendererEdge {
  id: string;
  fromNode: string;
  fromPort: string;
  toNode: string;
  toPort: string;
  /** Optional severity for colouring (e.g. broken references). */
  severity?: 'warning' | 'error';
  /** Dashed rendering — used for capability tool-links (not control flow). */
  dashed?: boolean;
}

export interface RendererTheme {
  background: string;
  nodeBody: string;
  nodeHeaderBg: string;
  nodeDivider: string;
  nodeBorder: string;
  nodeBorderSelected: string;
  nodeBorderEditing: string;
  nodeTitle: string;
  rowText: string;
  /** Fill for input port sockets (hollow rings). Contrasts with nodeBody so the colored ring is visible. */
  portSocketFill: string;
  /** Accent colour for tools/capability port dots/rings, distinguishing
   * them from message ports. */
  toolsPort: string;
  /** Label colour for group-divider rows (Inputs / Dependencies / Outputs / Provides). */
  groupLabel: string;
  wire: string;
  wireWarning: string;
  wireError: string;
  /** Colour of pulsing handoff wires during a run. */
  wireActive: string;
  gridDot: string;
  /** Run-state ring colours. */
  stateThinking: string;
  stateQueued: string;
  stateWaiting: string;
  stateDone: string;
  stateError: string;
}

export const DEFAULT_RENDERER_THEME: RendererTheme = {
  background: '#0b0e16',
  nodeBody: '#161b27',
  nodeHeaderBg: '#1b2130',
  nodeDivider: 'rgba(255,255,255,0.08)',
  nodeBorder: 'rgba(255,255,255,0.10)',
  nodeBorderSelected: '#60a5fa',
  nodeBorderEditing: '#a78bfa',
  nodeTitle: '#e2e8f0',
  rowText: '#94a3b8',
  portSocketFill: '#0d0e11',
  toolsPort: '#fbbf24',
  groupLabel: 'rgba(148,163,184,0.55)',
  wire: 'rgba(148,163,184,0.45)',
  wireWarning: '#f59e0b',
  wireError: '#ef4444',
  wireActive: '#818cf8',
  gridDot: 'rgba(148,163,184,0.18)',
  stateThinking: '#818cf8',
  stateQueued: '#94a3b8',
  stateWaiting: '#fbbf24',
  stateDone: '#34d399',
  stateError: '#ef4444',
};

/** Internal edge with resolved node indices + constant port offsets. */
interface ResolvedEdge {
  id: string;
  a: number;
  ay: number;
  b: number;
  by: number;
  severity?: 'warning' | 'error';
  dashed?: boolean;
}

export interface PortHit {
  node: RendererNode;
  port: RendererPort;
  /** Absolute world position of the port centre. */
  wx: number;
  wy: number;
}

const CELL_SIZE = 320;
const HEADER_H = 30;

/** Drill-in edit button geometry (world px, before scale). */
const EDIT_BTN_SIZE = 18;
const EDIT_BTN_MARGIN = 8;

/** Warning badge hit region (world px). Mirrors the DOM overlay badge that
 * sits at the node's top-right corner; used for pointer-cursor feedback. */
const WARN_BADGE_SIZE = 16;
const WARN_BADGE_MARGIN = 4;

/**
 * Zoom bounds. The 15% floor keeps users out of the unusable full-zoom-out
 * range (3–8fps on huge graphs); the minimap handles overview navigation.
 */
const MIN_SCALE = 0.15;
const MAX_SCALE = 4;

// Zoom thresholds for level-of-detail.
const LOD_DETAIL = 0.4; // below: drop ports
const LOD_TEXT = 0.5; // above: draw text
const LOD_WIRES = 0.18; // below: hide wires entirely
const LOD_BEZIER = 0.5; // above: bezier wires, below: straight lines

export class CanvasGraphRenderer {
  theme: RendererTheme;

  /** Called ~2×/sec with the measured framerate. */
  onFps?: (fps: number) => void;
  /** Called each frame with the number of nodes actually drawn. */
  onVisibleCount?: (count: number) => void;
  /** Called whenever the zoom scale changes. */
  onScaleChange?: (scale: number) => void;
  /** Called at the end of every rendered frame (for dependent overlays like the minimap). */
  onAfterDraw?: () => void;

  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private dpr = 1;
  private rafId = 0;
  private dirty = true;
  private resizeObs?: ResizeObserver;

  // Scene.
  private nodes: RendererNode[] = [];
  private nodeIndex = new Map<string, number>();
  private edges: ResolvedEdge[] = [];

  // Spatial index.
  private grid = new Map<number, number[]>();
  private adjacency: number[][] = [];
  private edgeStamp = new Int32Array(0);
  private frameId = 0;

  // World transform: screen = world * sc + (ox, oy).
  private sc = 1;
  private ox = 0;
  private oy = 0;

  /** Active transform tween (smooth pan/zoom), or null when idle. */
  private tween: {
    fromSc: number; fromOx: number; fromOy: number;
    toSc: number; toOx: number; toOy: number;
    start: number; dur: number;
  } | null = null;

  // FPS sampling.
  private frames = 0;
  private fpsAt = 0;

  // Selection / highlight sets (node ids).
  private selected = new Set<string>();
  private editing = new Set<string>();
  /** Per-node run state (thinking/queued/waiting-approval/done/error). */
  private nodeStates = new Map<string, string>();
  /** Connection ids currently pulsing with a handoff. */
  private activeEdges = new Set<string>();
  /** Node ids carrying a breakpoint badge. */
  private breakpointNodes = new Set<string>();
  /** Node ids carrying a configuration warning badge. */
  private warningNodes = new Set<string>();
  /** Selected connection (edge) ids — drawn highlighted. */
  private selectedEdges = new Set<string>();
  /** Edge id currently hovered (its wire is brightened). */
  private hoveredEdge: string | null = null;
  /** Live drag-to-connect wire, in world coords; null when not connecting. */
  private pendingWire: { fx: number; fy: number; tx: number; ty: number } | null = null;
  /** Live box-select rectangle in world coords; null when not box-selecting. */
  private selectionRect: { minX: number; minY: number; maxX: number; maxY: number } | null = null;
  /** Whether the dot grid is drawn (mirrors the app's grid-visible toggle). */
  private gridVisible = true;

  /** World-space grid cell size (matches the snap spacing setting). */
  private gridSpacing = 24;

  /** Cursor position in WORLD coords for grid distortion; null when off-canvas. */
  private cursorWorld: { x: number; y: number } | null = null;

  /**
   * Resolved icon glyphs for the connection severity badges (warning / error),
   * supplied by the host (which owns the live icon fonts). When unset, the
   * badge falls back to drawing a simple "!" / "×" symbol.
   */
  markerGlyphs: { warning?: string; error?: string; font?: string } = {};

  /**
   * Resolved glyph + font for the drill-in edit button (Tabler `ti ti-edit`).
   * Set by the host once per scene rebuild; when unset, drillable nodes draw
   * a fallback pencil glyph.
   */
  editGlyph?: string;
  editFont?: string;

  constructor(theme: RendererTheme = DEFAULT_RENDERER_THEME) {
    this.theme = theme;
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────
  attach(canvas: HTMLCanvasElement): void {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.resize();
    this.resizeObs = new ResizeObserver(() => this.resize());
    this.resizeObs.observe(canvas);
    this.startLoop();
  }

  detach(): void {
    cancelAnimationFrame(this.rafId);
    this.rafId = 0;
    this.resizeObs?.disconnect();
    this.resizeObs = undefined;
    this.ctx = null;
    this.canvas = null;
  }

  get scale(): number {
    return this.sc;
  }

  get offsetX(): number {
    return this.ox;
  }

  get offsetY(): number {
    return this.oy;
  }

  // ── Scene ─────────────────────────────────────────────────────────────────
  setScene(nodes: RendererNode[], edges: RendererEdge[]): void {
    this.nodes = nodes;
    this.nodeIndex.clear();
    for (let i = 0; i < nodes.length; i++) this.nodeIndex.set(nodes[i].id, i);

    // Resolve edges to node indices + constant port y-offsets once.
    this.edges = [];
    for (const e of edges) {
      const a = this.nodeIndex.get(e.fromNode);
      const b = this.nodeIndex.get(e.toNode);
      if (a === undefined || b === undefined) continue;
      const ay = nodes[a].ports.find(p => p.id === e.fromPort)?.y;
      const by = nodes[b].ports.find(p => p.id === e.toPort)?.y;
      if (ay === undefined || by === undefined) continue;
      this.edges.push({ id: e.id, a, ay, b, by, severity: e.severity, dashed: e.dashed });
    }

    this.buildIndex();
    this.dirty = true;
  }

  /** Fast path during a drag — moves a node and marks the frame dirty. */
  moveNode(id: string, x: number, y: number): void {
    const i = this.nodeIndex.get(id);
    if (i === undefined) return;
    this.nodes[i].x = x;
    this.nodes[i].y = y;
    this.dirty = true;
  }

  /** Rebuilds the spatial grid (call after drags that crossed cells). */
  reindex(): void {
    this.buildIndex();
    this.dirty = true;
  }

  setSelection(ids: Iterable<string>): void {
    this.selected = new Set(ids);
    this.dirty = true;
  }

  setEditing(ids: Iterable<string>): void {
    this.editing = new Set(ids);
    this.dirty = true;
  }

  /** Per-node run states for the execution rings. */
  setNodeStates(states: ReadonlyMap<string, string>): void {
    this.nodeStates = new Map(states);
    this.dirty = true;
  }

  /** Connection ids whose wires pulse with the handoff animation. */
  setActiveEdges(ids: Iterable<string>): void {
    this.activeEdges = new Set(ids);
    this.dirty = true;
  }

  /** Node ids showing a breakpoint badge. */
  setBreakpoints(ids: Iterable<string>): void {
    this.breakpointNodes = new Set(ids);
    this.dirty = true;
  }

  /** Node ids showing a configuration warning badge. */
  setWarningNodes(ids: Iterable<string>): void {
    this.warningNodes = new Set(ids);
    this.dirty = true;
  }

  setSelectedConnections(ids: Iterable<string>): void {
    this.selectedEdges = new Set(ids);
    this.dirty = true;
  }

  /**
   * Brightens the wire of `edgeId` on hover, or clears the highlight when
   * null. Used for connection hover feedback. Returns true if the hover state
   * changed (so the host can avoid redundant redraws).
   */
  setHoveredEdge(edgeId: string | null): boolean {
    if (this.hoveredEdge === edgeId) return false;
    this.hoveredEdge = edgeId;
    this.dirty = true;
    return true;
  }

  /** Sets (or clears, with null) the live drag-to-connect wire. */
  setPendingWire(from: { x: number; y: number } | null, to?: { x: number; y: number }): void {
    this.pendingWire = from && to ? { fx: from.x, fy: from.y, tx: to.x, ty: to.y } : null;
    this.dirty = true;
  }

  /** Sets (or clears, with null) the live box-select rectangle (world coords). */
  setSelectionRect(rect: { minX: number; minY: number; maxX: number; maxY: number } | null): void {
    this.selectionRect = rect;
    this.dirty = true;
  }

  setGridVisible(visible: boolean): void {
    this.gridVisible = visible;
    this.dirty = true;
  }

  /** Sets the world-space grid cell size (re-renders the dot grid). */
  setGridSpacing(spacing: number): void {
    const clamped = Math.min(64, Math.max(8, Math.round(spacing)));
    if (clamped === this.gridSpacing) return;
    this.gridSpacing = clamped;
    this.dirty = true;
  }

  /**
   * Updates the cursor position (client coords) used for grid distortion, or
   * clears it when the cursor leaves the canvas. Only marks dirty while the
   * grid is actually drawn so idle hovers don't force redraws.
   */
  setCursor(clientX: number | null, clientY: number | null): void {
    if (clientX === null || clientY === null) {
      if (this.cursorWorld) {
        this.cursorWorld = null;
        if (this.gridVisible && this.sc > 0.45) this.dirty = true;
      }
      return;
    }
    this.cursorWorld = this.screenToWorld(clientX, clientY);
    if (this.gridVisible && this.sc > 0.45) this.dirty = true;
  }

  requestDraw(): void {
    this.dirty = true;
  }

  // ── Transform ───────────────────────────────────────────────────────────
  panBy(dxScreen: number, dyScreen: number): void {
    this.tween = null;
    this.ox += dxScreen;
    this.oy += dyScreen;
    this.dirty = true;
  }

  /** Zoom anchored at a client point, keeping the world point under it fixed. */
  zoomAt(clientX: number, clientY: number, factor: number): void {
    this.tween = null;
    const rect = this.canvas?.getBoundingClientRect();
    if (!rect) return;
    const mx = clientX - rect.left;
    const my = clientY - rect.top;
    const newSc = Math.max(MIN_SCALE, Math.min(MAX_SCALE, this.sc * factor));
    this.ox = mx - (mx - this.ox) * (newSc / this.sc);
    this.oy = my - (my - this.oy) * (newSc / this.sc);
    this.sc = newSc;
    this.onScaleChange?.(newSc);
    this.dirty = true;
  }

  setTransform(sc: number, ox: number, oy: number): void {
    this.tween = null;
    this.sc = Math.max(MIN_SCALE, Math.min(MAX_SCALE, sc));
    this.ox = ox;
    this.oy = oy;
    this.onScaleChange?.(this.sc);
    this.dirty = true;
  }

  /**
   * Smoothly tweens the transform to the target scale/offset over `dur` ms.
   * The render loop steps this each frame until it settles. Any direct pan/zoom
   * cancels an in-flight tween.
   */
  animateTo(sc: number, ox: number, oy: number, dur = 280): void {
    const toSc = Math.max(MIN_SCALE, Math.min(MAX_SCALE, sc));
    this.tween = {
      fromSc: this.sc, fromOx: this.ox, fromOy: this.oy,
      toSc, toOx: ox, toOy: oy,
      start: performance.now(), dur: Math.max(1, dur),
    };
    this.dirty = true;
  }

  /** Advances the active tween. Returns true while still animating. */
  private stepTween(now: number): boolean {
    const tw = this.tween;
    if (!tw) return false;
    const t = Math.min(1, (now - tw.start) / tw.dur);
    // easeInOutCubic
    const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    this.sc = tw.fromSc + (tw.toSc - tw.fromSc) * e;
    this.ox = tw.fromOx + (tw.toOx - tw.fromOx) * e;
    this.oy = tw.fromOy + (tw.toOy - tw.fromOy) * e;
    this.onScaleChange?.(this.sc);
    this.dirty = true;
    if (t >= 1) {
      this.tween = null;
      return false;
    }
    return true;
  }

  /** Frames the whole graph with padding (screen px). */
  /**
   * Frames the whole graph with padding (screen px). The optional `inset`
   * rectangle (left/top/right/bottom in screen px) carves out the area
   * occupied by chrome (toolbar, tab bar, sidebars, footer, terminal) so the
   * framed graph centres inside the visible region instead of under the panels.
   */
  fit(padding = 0.9, inset?: { left: number; top: number; right: number; bottom: number }): void {
    const cv = this.canvas;
    if (!cv || this.nodes.length === 0) return;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const n of this.nodes) {
      if (n.x < minX) minX = n.x;
      if (n.y < minY) minY = n.y;
      if (n.x + n.w > maxX) maxX = n.x + n.w;
      if (n.y + n.h > maxY) maxY = n.y + n.h;
    }
    const vw = cv.clientWidth;
    const vh = cv.clientHeight;
    // Visible region after subtracting chrome insets (toolbar, tab bar,
    // sidebars, footer, terminal) so the framed graph centres inside the
    // visible area instead of under the panels.
    const il = inset?.left ?? 0;
    const it = inset?.top ?? 0;
    const ir = inset?.right ?? 0;
    const ib = inset?.bottom ?? 0;
    const visW = Math.max(1, vw - il - ir);
    const visH = Math.max(1, vh - it - ib);
    const gw = maxX - minX || 1;
    const gh = maxY - minY || 1;
    this.sc = Math.max(MIN_SCALE, Math.min(MAX_SCALE, Math.min(visW / gw, visH / gh) * padding));
    // Centre inside the visible region (not the full viewport).
    const visCx = il + visW / 2;
    const visCy = it + visH / 2;
    this.ox = visCx - (minX + gw / 2) * this.sc;
    this.oy = visCy - (minY + gh / 2) * this.sc;
    this.onScaleChange?.(this.sc);
    this.dirty = true;
  }

  screenToWorld(clientX: number, clientY: number): { x: number; y: number } {
    const rect = this.canvas?.getBoundingClientRect();
    const lx = clientX - (rect?.left ?? 0);
    const ly = clientY - (rect?.top ?? 0);
    return { x: (lx - this.ox) / this.sc, y: (ly - this.oy) / this.sc };
  }

  /** Centres the viewport on a node (by id), keeping the current zoom. */
  centerNode(id: string): void {
    const cv = this.canvas;
    const i = this.nodeIndex.get(id);
    if (!cv || i === undefined) return;
    const n = this.nodes[i];
    const cx = n.x + n.w / 2;
    const cy = n.y + n.h / 2;
    this.ox = cv.clientWidth / 2 - cx * this.sc;
    this.oy = cv.clientHeight / 2 - cy * this.sc;
    this.dirty = true;
  }

  /** World-space bounds for a node, or null when not in the scene. */
  nodeWorldBounds(id: string): { x: number; y: number; w: number; h: number } | null {
    const i = this.nodeIndex.get(id);
    if (i === undefined) return null;
    const n = this.nodes[i];
    return { x: n.x, y: n.y, w: n.w, h: n.h };
  }

  /** Smoothly pans to centre a node (by id), keeping the current zoom. */
  centerNodeSmooth(id: string, dur = 320): void {
    const cv = this.canvas;
    const i = this.nodeIndex.get(id);
    if (!cv || i === undefined) return;
    const n = this.nodes[i];
    const cx = n.x + n.w / 2;
    const cy = n.y + n.h / 2;
    this.animateTo(this.sc, cv.clientWidth / 2 - cx * this.sc, cv.clientHeight / 2 - cy * this.sc, dur);
  }

  // ── Minimap ───────────────────────────────────────────────────────────
  /** World-space bounds of every node (with a little padding), or null if empty. */
  graphBounds(): { minX: number; minY: number; maxX: number; maxY: number } | null {
    if (this.nodes.length === 0) return null;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const n of this.nodes) {
      if (n.x < minX) minX = n.x;
      if (n.y < minY) minY = n.y;
      if (n.x + n.w > maxX) maxX = n.x + n.w;
      if (n.y + n.h > maxY) maxY = n.y + n.h;
    }
    const padX = (maxX - minX) * 0.06 + 80;
    const padY = (maxY - minY) * 0.06 + 80;
    return { minX: minX - padX, minY: minY - padY, maxX: maxX + padX, maxY: maxY + padY };
  }

  /**
   * Draws an overview of the whole graph into `ctx` (a separate minimap canvas
   * of CSS size mw × mh), plus the current viewport rectangle. The provided
   * context is expected to already be DPR-scaled by the caller.
   */
  drawMinimap(ctx: CanvasRenderingContext2D, mw: number, mh: number): void {
    ctx.clearRect(0, 0, mw, mh);
    const cv = this.canvas;
    const bounds = this.graphBounds();
    if (!cv || !bounds) return;

    const gw = bounds.maxX - bounds.minX || 1;
    const gh = bounds.maxY - bounds.minY || 1;
    // Uniform scale so the whole graph fits, centred.
    const ms = Math.min(mw / gw, mh / gh);
    const offX = (mw - gw * ms) / 2;
    const offY = (mh - gh * ms) / 2;
    const toMiniX = (wx: number) => offX + (wx - bounds.minX) * ms;
    const toMiniY = (wy: number) => offY + (wy - bounds.minY) * ms;

    // Nodes as filled rects, accent-tinted, selection highlighted.
    for (const n of this.nodes) {
      const x = toMiniX(n.x);
      const y = toMiniY(n.y);
      const w = Math.max(1.5, n.w * ms);
      const h = Math.max(1.5, n.h * ms);
      const isSel = this.selected.has(n.id);
      const isEdit = this.editing.has(n.id);
      ctx.fillStyle = isEdit
        ? this.theme.nodeBorderEditing
        : isSel
          ? this.theme.nodeBorderSelected
          : n.accent || this.theme.nodeBody;
      ctx.globalAlpha = isSel || isEdit ? 1 : 0.85;
      ctx.fillRect(x, y, w, h);
    }
    ctx.globalAlpha = 1;

    // Current viewport rectangle (world rect of the visible canvas).
    const vw = cv.clientWidth;
    const vh = cv.clientHeight;
    const vMinX = -this.ox / this.sc;
    const vMinY = -this.oy / this.sc;
    const vMaxX = (vw - this.ox) / this.sc;
    const vMaxY = (vh - this.oy) / this.sc;
    const rx = toMiniX(vMinX);
    const ry = toMiniY(vMinY);
    const rw = (vMaxX - vMinX) * ms;
    const rh = (vMaxY - vMinY) * ms;
    ctx.strokeStyle = this.theme.nodeBorderSelected;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(rx, ry, rw, rh);
    ctx.fillStyle = this.theme.nodeBorderSelected;
    ctx.globalAlpha = 0.1;
    ctx.fillRect(rx, ry, rw, rh);
    ctx.globalAlpha = 1;
  }

  /**
   * Centres the viewport on the world point under a minimap click at
   * (mx, my) within a minimap of CSS size mw × mh.
   */
  navigateFromMinimap(mx: number, my: number, mw: number, mh: number): void {
    const cv = this.canvas;
    const bounds = this.graphBounds();
    if (!cv || !bounds) return;
    const gw = bounds.maxX - bounds.minX || 1;
    const gh = bounds.maxY - bounds.minY || 1;
    const ms = Math.min(mw / gw, mh / gh);
    const offX = (mw - gw * ms) / 2;
    const offY = (mh - gh * ms) / 2;
    // Inverse of toMini*: minimap px → world.
    const wx = (mx - offX) / ms + bounds.minX;
    const wy = (my - offY) / ms + bounds.minY;
    // Centre the viewport on (wx, wy) at the current zoom.
    this.ox = cv.clientWidth / 2 - wx * this.sc;
    this.oy = cv.clientHeight / 2 - wy * this.sc;
    this.dirty = true;
  }

  // ── Hit testing ─────────────────────────────────────────────────────────
  /** Topmost node containing the world point, or null. */
  hitTestNode(wx: number, wy: number): RendererNode | null {
    // Query only the cell under the point (cheap), then the few nodes in it.
    const candidates = this.queryNodes(wx, wy, wx, wy);
    let best: RendererNode | null = null;
    let bestIdx = -1;
    for (const i of candidates) {
      const n = this.nodes[i];
      if (wx >= n.x && wx <= n.x + n.w && wy >= n.y && wy <= n.y + n.h) {
        // Prefer the later-drawn (topmost) node.
        if (i > bestIdx) {
          best = n;
          bestIdx = i;
        }
      }
    }
    return best;
  }

  /**
   * Hit-tests the drill-in edit button on a drillable node. Returns the node
   * id when the point lands inside the button's header region, or null.
   */
  hitTestEditButton(wx: number, wy: number): string | null {
    const candidates = this.queryNodes(wx, wy, wx, wy);
    for (const i of candidates) {
      const n = this.nodes[i];
      if (!n.drillable) continue;
      if (!(wx >= n.x && wx <= n.x + n.w && wy >= n.y && wy <= n.y + n.h)) continue;
      const ebx = n.x + n.w - EDIT_BTN_MARGIN - EDIT_BTN_SIZE;
      const eby = n.y + (HEADER_H - EDIT_BTN_SIZE) / 2;
      if (wx >= ebx && wx <= ebx + EDIT_BTN_SIZE && wy >= eby && wy <= eby + EDIT_BTN_SIZE) {
        return n.id;
      }
    }
    return null;
  }

  /**
   * Hit-tests the configuration warning badge on a node. Returns the node id
   * when the point lands inside the badge's region (top-right corner), or
   * null. The badge is present only on nodes flagged via `setWarningNodes`.
   */
  hitTestWarningBadge(wx: number, wy: number): string | null {
    const candidates = this.queryNodes(wx, wy, wx, wy);
    for (const i of candidates) {
      const n = this.nodes[i];
      if (!this.warningNodes.has(n.id)) continue;
      if (!(wx >= n.x && wx <= n.x + n.w && wy >= n.y && wy <= n.y + n.h)) continue;
      const wbx = n.x + n.w - WARN_BADGE_MARGIN - WARN_BADGE_SIZE;
      const wby = n.y - WARN_BADGE_MARGIN;
      if (wx >= wbx && wx <= wbx + WARN_BADGE_SIZE && wy >= wby && wy <= wby + WARN_BADGE_SIZE) {
        return n.id;
      }
    }
    return null;
  }

  /** Nearest port within `radius` world px of the point, or null. */
  hitTestPort(wx: number, wy: number, radius = 10): PortHit | null {
    const candidates = this.queryNodes(wx - radius, wy - radius, wx + radius, wy + radius);
    let best: PortHit | null = null;
    let bestD = radius * radius;
    for (const i of candidates) {
      const n = this.nodes[i];
      for (const p of n.ports) {
        const px = p.side === 'in' ? n.x : n.x + n.w;
        const py = n.y + p.y;
        const dx = px - wx;
        const dy = py - wy;
        const d = dx * dx + dy * dy;
        if (d <= bestD) {
          bestD = d;
          best = { node: n, port: p, wx: px, wy: py };
        }
      }
    }
    return best;
  }

  /** Absolute world position of a port (by id), or null if unknown. */
  portPosition(portId: string): { x: number; y: number } | null {
    for (const n of this.nodes) {
      const p = n.ports.find(pp => pp.id === portId);
      if (p) return { x: p.side === 'in' ? n.x : n.x + n.w, y: n.y + p.y };
    }
    return null;
  }

  /** Nearest edge within `tol` world px of its straight chord, or null. */
  hitTestEdge(wx: number, wy: number, tol: number): string | null {
    let best: string | null = null;
    let bestD = tol * tol;
    for (const e of this.edges) {
      const a = this.nodes[e.a];
      const b = this.nodes[e.b];
      const d = distToSegmentSq(wx, wy, a.x + a.w, a.y + e.ay, b.x, b.y + e.by);
      if (d <= bestD) {
        bestD = d;
        best = e.id;
      }
    }
    return best;
  }

  /**
   * World-space midpoint of an edge's wire (the point where the severity badge
   * is drawn). Uses the bezier midpoint (t=0.5) so it sits on the curve, which
   * matches the straight-line midpoint too. Returns null for an unknown id.
   */
  edgeMidpoint(edgeId: string): { x: number; y: number } | null {
    const e = this.edges.find(ed => ed.id === edgeId);
    if (!e) return null;
    return this.edgeMidpointResolved(e);
  }

  private edgeMidpointResolved(e: ResolvedEdge): { x: number; y: number } {
    const a = this.nodes[e.a];
    const b = this.nodes[e.b];
    const x1 = a.x + a.w;
    const y1 = a.y + e.ay;
    const x2 = b.x;
    const y2 = b.y + e.by;
    // Bezier control points mirror tracePath; evaluate at t = 0.5.
    const dx = Math.max(40, Math.abs(x2 - x1) * 0.5);
    const cx1 = x1 + dx;
    const cx2 = x2 - dx;
    // Cubic bezier at t=0.5: 0.125*(p0 + 3*c1 + 3*c2 + p3).
    const mx = 0.125 * (x1 + 3 * cx1 + 3 * cx2 + x2);
    const my = 0.125 * (y1 + 3 * y1 + 3 * y2 + y2);
    return { x: mx, y: my };
  }

  /**
   * Returns the id of the severity edge whose midpoint badge contains the world
   * point, or null. `radius` is the badge hit radius in world px (caller scales
   * by 1/scale so it stays a constant screen size).
   */
  hitTestEdgeMarker(wx: number, wy: number, radius: number): string | null {
    const r2 = radius * radius;
    let best: string | null = null;
    let bestD = r2;
    for (const e of this.edges) {
      if (!e.severity) continue;
      const m = this.edgeMidpointResolved(e);
      const dx = m.x - wx;
      const dy = m.y - wy;
      const d = dx * dx + dy * dy;
      if (d <= bestD) {
        bestD = d;
        best = e.id;
      }
    }
    return best;
  }

  /** Nodes whose box intersects a world rect (uses the spatial grid). */
  nodesInRect(minX: number, minY: number, maxX: number, maxY: number): RendererNode[] {
    const out: RendererNode[] = [];
    for (const i of this.queryNodes(minX, minY, maxX, maxY)) {
      const n = this.nodes[i];
      if (n.x <= maxX && n.x + n.w >= minX && n.y <= maxY && n.y + n.h >= minY) out.push(n);
    }
    return out;
  }

  // ── Spatial index ─────────────────────────────────────────────────────────
  private cellKey(cx: number, cy: number): number {
    return (cx + 32768) * 65536 + (cy + 32768);
  }

  private buildIndex(): void {
    this.grid.clear();
    const cs = CELL_SIZE;
    for (let i = 0; i < this.nodes.length; i++) {
      const n = this.nodes[i];
      const c0x = Math.floor(n.x / cs);
      const c0y = Math.floor(n.y / cs);
      const c1x = Math.floor((n.x + n.w) / cs);
      const c1y = Math.floor((n.y + n.h) / cs);
      for (let cx = c0x; cx <= c1x; cx++) {
        for (let cy = c0y; cy <= c1y; cy++) {
          const key = this.cellKey(cx, cy);
          const bucket = this.grid.get(key);
          if (bucket) bucket.push(i);
          else this.grid.set(key, [i]);
        }
      }
    }
    this.adjacency = Array.from({ length: this.nodes.length }, () => [] as number[]);
    for (let e = 0; e < this.edges.length; e++) {
      this.adjacency[this.edges[e].a]?.push(e);
      this.adjacency[this.edges[e].b]?.push(e);
    }
    this.edgeStamp = new Int32Array(this.edges.length);
  }

  private queryNodes(minX: number, minY: number, maxX: number, maxY: number): number[] {
    const cs = CELL_SIZE;
    const c0x = Math.floor(minX / cs);
    const c0y = Math.floor(minY / cs);
    const c1x = Math.floor(maxX / cs);
    const c1y = Math.floor(maxY / cs);
    const out: number[] = [];
    const seen = new Set<number>();
    for (let cx = c0x; cx <= c1x; cx++) {
      for (let cy = c0y; cy <= c1y; cy++) {
        const bucket = this.grid.get(this.cellKey(cx, cy));
        if (!bucket) continue;
        for (const i of bucket) {
          if (seen.has(i)) continue;
          seen.add(i);
          out.push(i);
        }
      }
    }
    return out;
  }

  // ── Render loop ─────────────────────────────────────────────────────────
  private resize(): void {
    const cv = this.canvas;
    if (!cv) return;
    cv.width = Math.round(cv.clientWidth * this.dpr);
    cv.height = Math.round(cv.clientHeight * this.dpr);
    this.dirty = true;
  }

  private startLoop(): void {
    this.fpsAt = performance.now();
    const loop = (now: number): void => {
      this.rafId = requestAnimationFrame(loop);
      this.frames++;
      if (now - this.fpsAt >= 500) {
        this.onFps?.(Math.round((this.frames * 1000) / (now - this.fpsAt)));
        this.frames = 0;
        this.fpsAt = now;
      }
      if (this.tween) this.stepTween(now);
      // Run visuals (pulsing wires, thinking rings) animate continuously.
      if (this.hasLiveRunVisuals()) this.dirty = true;
      if (!this.dirty) return;
      this.dirty = false;
      this.draw();
    };
    this.rafId = requestAnimationFrame(loop);
  }

  /** True while any run visual needs per-frame animation. */
  private hasLiveRunVisuals(): boolean {
    if (this.activeEdges.size > 0) return true;
    for (const state of this.nodeStates.values()) {
      if (state === 'thinking' || state === 'waiting-approval') return true;
    }
    return false;
  }

  private draw(): void {
    const ctx = this.ctx;
    const cv = this.canvas;
    if (!ctx || !cv) return;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.fillStyle = this.theme.background;
    ctx.fillRect(0, 0, cv.width, cv.height);

    const s = this.sc * this.dpr;
    ctx.setTransform(s, 0, 0, s, this.ox * this.dpr, this.oy * this.dpr);

    const viewMinX = -this.ox / this.sc;
    const viewMinY = -this.oy / this.sc;
    const viewMaxX = (cv.clientWidth - this.ox) / this.sc;
    const viewMaxY = (cv.clientHeight - this.oy) / this.sc;

    // Dot grid (on, and fades out as zoom drops below 50%).
    if (this.gridVisible && this.sc > 0.35) {
      this.drawGrid(ctx, viewMinX, viewMinY, viewMaxX, viewMaxY);
    }

    const showPorts = this.sc >= LOD_DETAIL;
    const drawText = this.sc > LOD_TEXT;
    const showWires = this.sc > LOD_WIRES;
    const bezier = this.sc > LOD_BEZIER;

    const visible = this.queryNodes(viewMinX, viewMinY, viewMaxX, viewMaxY);

    // ── Wires (under nodes), collected from visible nodes' adjacency ──
    if (showWires) {
      const frame = ++this.frameId;
      ctx.lineWidth = 1.5 / this.sc;
      // Default wire colour; severity/dashed wires are drawn in later passes
      // so we don't thrash strokeStyle per segment.
      ctx.strokeStyle = this.theme.wire;
      ctx.beginPath();
      for (const ni of visible) {
        const incident = this.adjacency[ni];
        if (!incident) continue;
        for (const ei of incident) {
          if (this.edgeStamp[ei] === frame) continue;
          this.edgeStamp[ei] = frame;
          const e = this.edges[ei];
          if (e.severity || e.dashed) continue; // drawn in the passes below
          this.tracePath(ctx, e, bezier);
        }
      }
      ctx.stroke();

      // Dashed wires (tool-links) — capability edges, drawn with a dash
      // pattern so they read as declarations rather than control flow.
      {
        let started = false;
        const frameDashed = ++this.frameId;
        for (const ni of visible) {
          const incident = this.adjacency[ni];
          if (!incident) continue;
          for (const ei of incident) {
            if (this.edgeStamp[ei] === frameDashed) continue;
            this.edgeStamp[ei] = frameDashed;
            const e = this.edges[ei];
            if (!e.dashed || e.severity) continue;
            if (!started) {
              ctx.beginPath();
              started = true;
            }
            this.tracePath(ctx, e, bezier);
          }
        }
        if (started) {
          ctx.setLineDash([6 / this.sc, 5 / this.sc]);
          ctx.strokeStyle = this.theme.toolsPort;
          ctx.globalAlpha = 0.55;
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.globalAlpha = 1;
        }
      }

      // Severity wires (warning/error) — usually few, so per-colour strokes.
      for (const sev of ['warning', 'error'] as const) {
        let started = false;
        const frame2 = ++this.frameId;
        for (const ni of visible) {
          const incident = this.adjacency[ni];
          if (!incident) continue;
          for (const ei of incident) {
            if (this.edgeStamp[ei] === frame2) continue;
            this.edgeStamp[ei] = frame2;
            const e = this.edges[ei];
            if (e.severity !== sev) continue;
            if (!started) {
              ctx.beginPath();
              started = true;
            }
            this.tracePath(ctx, e, bezier);
          }
        }
        if (started) {
          ctx.strokeStyle = sev === 'warning' ? this.theme.wireWarning : this.theme.wireError;
          ctx.stroke();
        }
      }

      // Selected wires — highlighted on top, only if any are selected.
      if (this.selectedEdges.size > 0) {
        let started = false;
        const frame3 = ++this.frameId;
        for (const ni of visible) {
          const incident = this.adjacency[ni];
          if (!incident) continue;
          for (const ei of incident) {
            if (this.edgeStamp[ei] === frame3) continue;
            this.edgeStamp[ei] = frame3;
            const e = this.edges[ei];
            if (!this.selectedEdges.has(e.id)) continue;
            if (!started) {
              ctx.beginPath();
              started = true;
            }
            this.tracePath(ctx, e, bezier);
          }
        }
        if (started) {
          ctx.lineWidth = 2.5 / this.sc;
          ctx.strokeStyle = this.theme.nodeBorderEditing;
          ctx.stroke();
        }
      }

      // Hovered wire — brightened on top (not while a wire is selected over it).
      if (this.hoveredEdge && !this.selectedEdges.has(this.hoveredEdge)) {
        const e = this.edges.find(ed => ed.id === this.hoveredEdge);
        if (e) {
          ctx.beginPath();
          this.tracePath(ctx, e, bezier);
          ctx.lineWidth = 2.5 / this.sc;
          ctx.strokeStyle = e.severity
            ? e.severity === 'warning'
              ? this.theme.wireWarning
              : this.theme.wireError
            : this.theme.nodeBorderSelected;
          ctx.globalAlpha = 0.9;
          ctx.stroke();
          ctx.globalAlpha = 1;
        }
      }

      // Active handoff wires — the execution pulse. Drawn on top with an
      // animated dash marching from source to target, plus a soft glow.
      if (this.activeEdges.size > 0) {
        let started = false;
        const framePulse = ++this.frameId;
        for (const ni of visible) {
          const incident = this.adjacency[ni];
          if (!incident) continue;
          for (const ei of incident) {
            if (this.edgeStamp[ei] === framePulse) continue;
            this.edgeStamp[ei] = framePulse;
            const e = this.edges[ei];
            if (!this.activeEdges.has(e.id)) continue;
            if (!started) {
              ctx.beginPath();
              started = true;
            }
            this.tracePath(ctx, e, bezier);
          }
        }
        if (started) {
          const dash = 12 / this.sc;
          const gap = 9 / this.sc;
          ctx.save();
          ctx.setLineDash([dash, gap]);
          // Negative offset marches the dash along the flow direction.
          ctx.lineDashOffset = -((performance.now() * 0.035) % (dash + gap)) * 1;
          ctx.lineWidth = 2.75 / this.sc;
          ctx.strokeStyle = this.theme.wireActive;
          ctx.shadowColor = this.theme.wireActive;
          ctx.shadowBlur = 10;
          ctx.stroke();
          ctx.restore();
        }
      }
    }

    // Live drag-to-connect wire.
    if (this.pendingWire) {
      const p = this.pendingWire;
      ctx.lineWidth = 2 / this.sc;
      ctx.strokeStyle = this.theme.nodeBorderEditing;
      ctx.beginPath();
      ctx.moveTo(p.fx, p.fy);
      const dx = Math.max(40, Math.abs(p.tx - p.fx) * 0.5);
      ctx.bezierCurveTo(p.fx + dx, p.fy, p.tx - dx, p.ty, p.tx, p.ty);
      ctx.stroke();
    }

    // ── Nodes ──
    let drawn = 0;
    for (const ni of visible) {
      const n = this.nodes[ni];
      if (n.x > viewMaxX || n.x + n.w < viewMinX || n.y > viewMaxY || n.y + n.h < viewMinY) continue;
      drawn++;
      this.drawNode(ctx, n, showPorts, drawText);
    }

    // Box-select rectangle on top of everything.
    if (this.selectionRect) {
      const r = this.selectionRect;
      ctx.fillStyle = 'rgba(99,102,241,0.12)';
      ctx.strokeStyle = 'rgba(129,140,248,0.9)';
      ctx.lineWidth = 1 / this.sc;
      ctx.beginPath();
      ctx.rect(r.minX, r.minY, r.maxX - r.minX, r.maxY - r.minY);
      ctx.fill();
      ctx.stroke();
    }

    // Connection severity badges at wire midpoints (on top of nodes/wires).
    if (showWires) {
      this.drawEdgeMarkers(ctx, visible);
    }

    this.onVisibleCount?.(drawn);
    this.onAfterDraw?.();
  }

  /**
   * Draws a small circular badge at the midpoint of every visible severity
   * edge. Badge size is held constant on screen (scaled by 1/sc). Mirrors the
   * old DOM `.phorma-conn-badge`: amber for warnings, red for errors, with a
   * thin background-coloured ring and a centred glyph.
   */
  private drawEdgeMarkers(ctx: CanvasRenderingContext2D, visible: number[]): void {
    const frame = ++this.frameId;
    const r = 9 / this.sc; // ~18px diameter on screen
    for (const ni of visible) {
      const incident = this.adjacency[ni];
      if (!incident) continue;
      for (const ei of incident) {
        if (this.edgeStamp[ei] === frame) continue;
        this.edgeStamp[ei] = frame;
        const e = this.edges[ei];
        if (!e.severity) continue;
        const m = this.edgeMidpointResolved(e);
        const color = e.severity === 'warning' ? this.theme.wireWarning : this.theme.wireError;
        // Disc + ring.
        ctx.beginPath();
        ctx.arc(m.x, m.y, r, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
        ctx.lineWidth = 1.5 / this.sc;
        ctx.strokeStyle = this.theme.background;
        ctx.stroke();
        // Glyph.
        const glyph = e.severity === 'warning' ? this.markerGlyphs.warning : this.markerGlyphs.error;
        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        if (glyph && this.markerGlyphs.font) {
          ctx.font = `${9 / this.sc}px "${this.markerGlyphs.font}"`;
          ctx.fillText(glyph, m.x, m.y + 0.5 / this.sc);
        } else {
          ctx.font = `bold ${11 / this.sc}px sans-serif`;
          ctx.fillText(e.severity === 'warning' ? '!' : '×', m.x, m.y + 0.5 / this.sc);
        }
      }
    }
  }

  private tracePath(ctx: CanvasRenderingContext2D, e: ResolvedEdge, bezier: boolean): void {
    const a = this.nodes[e.a];
    const b = this.nodes[e.b];
    const x1 = a.x + a.w;
    const y1 = a.y + e.ay;
    const x2 = b.x;
    const y2 = b.y + e.by;
    ctx.moveTo(x1, y1);
    if (bezier) {
      const dx = Math.max(40, Math.abs(x2 - x1) * 0.5);
      ctx.bezierCurveTo(x1 + dx, y1, x2 - dx, y2, x2, y2);
    } else {
      ctx.lineTo(x2, y2);
    }
  }

  private drawNode(
    ctx: CanvasRenderingContext2D,
    n: RendererNode,
    showPorts: boolean,
    drawText: boolean,
  ): void {
    const sel = this.selected.has(n.id);
    const edit = this.editing.has(n.id);

    // Body.
    ctx.fillStyle = this.theme.nodeBody;
    this.roundRect(ctx, n.x, n.y, n.w, n.h, 8);
    ctx.fill();

    // Header strip (subtle), with a divider under it.
    ctx.save();
    this.roundRectTop(ctx, n.x, n.y, n.w, HEADER_H, 8);
    ctx.clip();
    ctx.fillStyle = this.theme.nodeHeaderBg;
    ctx.fillRect(n.x, n.y, n.w, HEADER_H);
    ctx.restore();
    ctx.strokeStyle = this.theme.nodeDivider;
    ctx.lineWidth = 1 / this.sc;
    ctx.beginPath();
    ctx.moveTo(n.x, n.y + HEADER_H);
    ctx.lineTo(n.x + n.w, n.y + HEADER_H);
    ctx.stroke();

    // Accent icon chip.
    const chip = 20;
    const chipX = n.x + 8;
    const chipY = n.y + (HEADER_H - chip) / 2;
    ctx.save();
    ctx.globalAlpha = 0.18;
    ctx.fillStyle = n.accent;
    this.roundRect(ctx, chipX, chipY, chip, chip, 5);
    ctx.fill();
    ctx.globalAlpha = 0.4;
    ctx.strokeStyle = n.accent;
    ctx.lineWidth = 1 / this.sc;
    this.roundRect(ctx, chipX, chipY, chip, chip, 5);
    ctx.stroke();
    ctx.restore();
    if (n.iconGlyph && n.iconFont) {
      ctx.fillStyle = n.accent;
      ctx.font = `12px ${n.iconFont}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(n.iconGlyph, chipX + chip / 2, chipY + chip / 2 + 0.5);
      ctx.textAlign = 'left';
    }

    if (drawText) {
      // Drill-in edit button (rightmost; only on drillable nodes). Drawn in
      // world units so it scales with the node — a subtle, rounded tool button
      // mirroring PrimeNG secondary buttons (neutral surface + muted glyph).
      if (n.drillable) {
        const ebx = n.x + n.w - EDIT_BTN_MARGIN - EDIT_BTN_SIZE;
        const eby = n.y + (HEADER_H - EDIT_BTN_SIZE) / 2;
        ctx.save();
        ctx.globalAlpha = 0.08;
        ctx.fillStyle = this.theme.nodeTitle;
        this.roundRect(ctx, ebx, eby, EDIT_BTN_SIZE, EDIT_BTN_SIZE, 5);
        ctx.fill();
        ctx.globalAlpha = 0.18;
        ctx.strokeStyle = this.theme.nodeTitle;
        ctx.lineWidth = 1 / this.sc;
        this.roundRect(ctx, ebx, eby, EDIT_BTN_SIZE, EDIT_BTN_SIZE, 5);
        ctx.stroke();
        ctx.restore();
        const glyph = this.editGlyph;
        const font = this.editFont || 'tabler-icons';
        if (glyph) {
          ctx.fillStyle = this.theme.rowText;
          ctx.font = `${EDIT_BTN_SIZE * 0.62}px "${font}"`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(glyph, ebx + EDIT_BTN_SIZE / 2, eby + EDIT_BTN_SIZE / 2 + 0.5);
          ctx.textAlign = 'left';
        }
      }

      // Kind badge (right-aligned pill; sits left of the edit button when present).
      ctx.font = '600 8px Nunito, system-ui, sans-serif';
      ctx.textBaseline = 'middle';
      const badgeText = n.kind;
      const bw = ctx.measureText(badgeText).width + 8;
      const bh = 13;
      const badgeRight = n.x + n.w - 8 - (n.drillable ? EDIT_BTN_SIZE + 6 : 0);
      const bx = badgeRight - bw;
      const by = n.y + (HEADER_H - bh) / 2;
      ctx.save();
      ctx.globalAlpha = 0.14;
      ctx.fillStyle = n.accent;
      this.roundRect(ctx, bx, by, bw, bh, 4);
      ctx.fill();
      ctx.restore();
      ctx.fillStyle = n.accent;
      ctx.textAlign = 'center';
      ctx.fillText(badgeText, bx + bw / 2, by + bh / 2 + 0.5);
      ctx.textAlign = 'left';

      // Title (clipped between chip and badge).
      ctx.fillStyle = this.theme.nodeTitle;
      ctx.font = '600 12px Nunito, system-ui, sans-serif';
      ctx.save();
      ctx.beginPath();
      const titleX = chipX + chip + 7;
      ctx.rect(titleX, n.y, bx - titleX - 6, HEADER_H);
      ctx.clip();
      ctx.fillText(n.title, titleX, n.y + HEADER_H / 2 + 0.5);
      ctx.restore();
    }

    // Border (selection/editing aware).
    ctx.lineWidth = (sel || edit ? 2 : 1) / this.sc;
    ctx.strokeStyle = edit
      ? this.theme.nodeBorderEditing
      : sel
        ? this.theme.nodeBorderSelected
        : this.theme.nodeBorder;
    this.roundRect(ctx, n.x, n.y, n.w, n.h, 8);
    ctx.stroke();

    // Configuration warning outline - a subtle amber dashed ring around
    // nodes flagged via setWarningNodes. Sits just outside the regular
    // border so it reads as a status indicator without obscuring selection.
    if (this.warningNodes.has(n.id) && !sel && !edit) {
      ctx.save();
      ctx.strokeStyle = this.theme.wireWarning;
      ctx.lineWidth = 1.5 / this.sc;
      ctx.setLineDash([5 / this.sc, 3 / this.sc]);
      this.roundRect(ctx, n.x - 2, n.y - 2, n.w + 4, n.h + 4, 9);
      ctx.stroke();
      ctx.restore();
    }

    // Run-state ring — the execution theatre. Sits just outside the border.
    const runState = this.nodeStates.get(n.id);
    if (runState && runState !== 'idle') {
      const color =
        runState === 'thinking'
          ? this.theme.stateThinking
          : runState === 'queued'
            ? this.theme.stateQueued
            : runState === 'waiting-approval'
              ? this.theme.stateWaiting
              : runState === 'error'
                ? this.theme.stateError
                : this.theme.stateDone;
      ctx.save();
      // Thinking + waiting states breathe; settled states hold steady.
      const breathing = runState === 'thinking' || runState === 'waiting-approval';
      const alpha = breathing ? 0.55 + 0.45 * Math.abs(Math.sin(performance.now() / 420)) : 0.9;
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = color;
      ctx.lineWidth = 2.5 / this.sc;
      ctx.shadowColor = color;
      ctx.shadowBlur = breathing ? 16 : 8;
      this.roundRect(ctx, n.x - 3, n.y - 3, n.w + 6, n.h + 6, 10);
      ctx.stroke();
      ctx.restore();
    }

    // Breakpoint badge - red dot hugging the header's left edge (VS Code style).
    if (this.breakpointNodes.has(n.id)) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(n.x - 9, n.y + HEADER_H / 2, 4.5, 0, Math.PI * 2);
      ctx.fillStyle = this.theme.stateError;
      ctx.fill();
      ctx.lineWidth = 1.5 / this.sc;
      ctx.strokeStyle = this.theme.background;
      ctx.stroke();
      ctx.restore();
    }

    if (showPorts) {
      for (const p of n.ports) {
        const px = p.side === 'in' ? n.x : n.x + n.w;
        const py = n.y + p.y;
        // Dependency ports use the dedicated accent so they read as injection
        // points rather than typed signal ports.
        const dotColor = p.portKind === 'tools' ? this.theme.toolsPort : p.color;
        ctx.beginPath();
        ctx.arc(px, py, 4.5, 0, Math.PI * 2);
        if (p.side === 'in') {
          // Input: hollow socket (socket-filled ring) so it reads as a target.
          ctx.fillStyle = this.theme.portSocketFill;
          ctx.fill();
          ctx.lineWidth = 1.5 / this.sc;
          ctx.strokeStyle = dotColor;
          ctx.stroke();
        } else {
          // Output: solid dot.
          ctx.fillStyle = dotColor;
          ctx.fill();
        }
      }
    }

    // Group-divider rows (labelled separators between Inputs/Dependencies/Outputs/Provides).
    if (drawText && n.groupDividers && n.groupDividers.length > 0) {
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      ctx.font = '600 9px Nunito, system-ui, sans-serif';
      ctx.fillStyle = this.theme.groupLabel;
      for (const divider of n.groupDividers) {
        const dy = n.y + divider.y;
        // Thin separator line across the node body, at the top of the divider
        // row. Skipped for the first group on the node (only the label shows).
        if (divider.line !== false) {
          ctx.beginPath();
          ctx.moveTo(n.x + 8, dy);
          ctx.lineTo(n.x + n.w - 8, dy);
          ctx.lineWidth = 1 / this.sc;
          ctx.strokeStyle = this.theme.nodeDivider;
          ctx.stroke();
        }
        // Label sits below the line with breathing room before the first port.
        ctx.fillText(divider.label.toUpperCase(), n.x + 10, dy + (divider.line !== false ? 16 : 11));
      }
      ctx.textAlign = 'left';
    }

    if (drawText && n.rows) {
      ctx.textBaseline = 'middle';
      for (const row of n.rows) {
        const ry = n.y + row.y;
        // Name (left, clipped to leave room for the type).
        ctx.textAlign = 'left';
        ctx.font = '12px Nunito, system-ui, sans-serif';
        ctx.fillStyle = this.theme.nodeTitle;
        ctx.save();
        ctx.beginPath();
        ctx.rect(n.x + 12, ry - 8, n.w - 24, 16);
        ctx.clip();
        ctx.fillText(row.name, n.x + 12, ry);
        ctx.restore();
        // Type (right, colour-coded by data type, monospace).
        ctx.textAlign = 'right';
        ctx.font = '11px Consolas, "Cascadia Code", "SF Mono", Menlo, monospace';
        ctx.fillStyle = row.typeColor;
        ctx.fillText(row.type, n.x + n.w - 12, ry);
      }
      ctx.textAlign = 'left';
    }
  }

  /** Draws the dot grid in world space across the visible rect. */
  private drawGrid(
    ctx: CanvasRenderingContext2D,
    minX: number,
    minY: number,
    maxX: number,
    maxY: number,
  ): void {
    const g = this.gridSpacing; // world-space cell size (matches snap spacing)
    const startX = Math.floor(minX / g) * g;
    const startY = Math.floor(minY / g) * g;
    // Keep dot size + distortion zone constant in SCREEN px by dividing by scale.
    const baseR = 1 / this.sc;
    const maxR = 2.2 / this.sc;
    const distR = 120 / this.sc; // distortion zone radius (120 screen px)
    const distR2 = distR * distR;
    ctx.fillStyle = this.theme.gridDot;
    // Fade dots out between 50% and 35% zoom.
    const fade = Math.min(1, Math.max(0, (this.sc - 0.35) / 0.15));
    ctx.globalAlpha = fade;

    const cursor = this.cursorWorld;
    if (!cursor) {
      // Fast path: one batched fill for all undistorted dots.
      ctx.beginPath();
      for (let x = startX; x <= maxX; x += g) {
        for (let y = startY; y <= maxY; y += g) {
          ctx.moveTo(x + baseR, y);
          ctx.arc(x, y, baseR, 0, Math.PI * 2);
        }
      }
      ctx.fill();
      ctx.globalAlpha = 1;
      return;
    }

    // Cursor present: batch undistorted dots; draw distorted ones individually.
    const cx = cursor.x;
    const cy = cursor.y;
    const batch = new Path2D();
    for (let x = startX; x <= maxX; x += g) {
      for (let y = startY; y <= maxY; y += g) {
        const dx = x - cx;
        const dy = y - cy;
        const dist2 = dx * dx + dy * dy;
        if (dist2 < distR2) {
          const dist = Math.sqrt(dist2) || 1;
          const t = 1 - dist / distR;
          const ease = t * t * (3 - 2 * t); // smoothstep
          const radius = baseR + (maxR - baseR) * ease;
          // Pull the dot toward the cursor by up to 18% of a cell.
          const pull = ease * g * 0.18;
          const px = x - (dx / dist) * pull;
          const py = y - (dy / dist) * pull;
          ctx.beginPath();
          ctx.arc(px, py, radius, 0, Math.PI * 2);
          ctx.fill();
        } else {
          batch.moveTo(x + baseR, y);
          batch.arc(x, y, baseR, 0, Math.PI * 2);
        }
      }
    }
    ctx.fill(batch);
    ctx.globalAlpha = 1;
  }

  private roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  private roundRectTop(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
    ctx.beginPath();
    ctx.moveTo(x, y + h);
    ctx.lineTo(x, y + r);
    ctx.arcTo(x, y, x + r, y, r);
    ctx.lineTo(x + w - r, y);
    ctx.arcTo(x + w, y, x + w, y + r, r);
    ctx.lineTo(x + w, y + h);
    ctx.closePath();
  }
}

/** Squared distance from point (px,py) to segment (x1,y1)-(x2,y2). */
function distToSegmentSq(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  let t = lenSq === 0 ? 0 : ((px - x1) * dx + (py - y1) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const cx = x1 + t * dx;
  const cy = y1 + t * dy;
  const ex = px - cx;
  const ey = py - cy;
  return ex * ex + ey * ey;
}
