import { hexToRgb, rgbToHex } from './color';
import { normalizeBezier, sampleBezier } from './curve';
import type { Bezier4 } from './curve';
import type {
  BlendMode,
  BrushPreset,
  ColorMode,
  ColorTarget,
  CursorInfo,
  EditorState,
  Layer,
  LayerMeta,
  Tool,
} from './types';
import { BLEND_MODES } from './types';
import { loadAutosave, saveAutosave, clearAutosave, loadImage, bytesToBase64, base64ToBytes, PROJECT_MAGIC, PROJECT_HEADER_OFFSET } from './project';
import type { HuihuaProject, HuihuaProjectV2, HuihuaProjectV2Layer } from './project';

const UNDO_LIMIT = 20;
const RECENT_MAX = 10;
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 8;
const TILE = 256;
const DOCK_MIN = 224;
const DOCK_MAX = 420;
const LS = {
  dockWidth: 'huihua.dock.width',
  dockCollapsed: 'huihua.dock.collapsed',
  quickbar: 'huihua.quickbar',
  size: 'huihua.brush.size',
  opacity: 'huihua.brush.opacity',
  hardness: 'huihua.brush.hardness',
  flow: 'huihua.brush.flow',
  spacing: 'huihua.brush.spacing',
  curve: 'huihua.brush.curve',
  bezier: 'huihua.brush.curveBezier',
  stabilizer: 'huihua.brush.stabilizer',
  presets: 'huihua.brush.presets',
  feather: 'huihua.selection.feather',
} as const;

function clampNum(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

const DEFAULT_PRESETS: BrushPreset[] = [
  { name: '硬圆', size: 8, opacity: 1, hardness: 1, flow: 1, spacing: 0.15, pressureCurve: 1, pressureBezier: null, stabilizer: 0 },
  { name: '软笔', size: 24, opacity: 0.75, hardness: 0.15, flow: 0.8, spacing: 0.1, pressureCurve: 1, pressureBezier: null, stabilizer: 0.2 },
  { name: '铅笔', size: 3, opacity: 0.9, hardness: 0.85, flow: 0.7, spacing: 0.12, pressureCurve: 1.4, pressureBezier: null, stabilizer: 0.3 },
];

function loadPresets(): BrushPreset[] {
  try {
    const raw = localStorage.getItem(LS.presets);
    if (raw == null) return DEFAULT_PRESETS.map((p) => ({ ...p }));
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return DEFAULT_PRESETS.map((p) => ({ ...p }));
    const out: BrushPreset[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue;
      const v = item as Record<string, unknown>;
      if (typeof v.name !== 'string' || !v.name.trim()) continue;
      out.push({
        name: v.name.trim(),
        size: Math.round(clampNum(Number(v.size), 1, 60)),
        opacity: clampNum(Number(v.opacity), 0.05, 1),
        hardness: clampNum(Number(v.hardness), 0, 1),
        flow: clampNum(Number(v.flow), 0.02, 1),
        spacing: clampNum(Number(v.spacing), 0.05, 2),
        pressureCurve: clampNum(Number(v.pressureCurve), 0.3, 2.5),
        pressureBezier: normalizeBezier(v.pressureBezier),
        stabilizer: clampNum(Number(v.stabilizer), 0, 1),
      });
    }
    return out;
  } catch {
    return DEFAULT_PRESETS.map((p) => ({ ...p }));
  }
}

function storeJson(key: string, value: unknown): void {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* 忽略存储失败 */ }
}

function storedNum(key: string, fallback: number): number {
  try {
    const raw = localStorage.getItem(key);
    const n = raw == null ? NaN : Number.parseFloat(raw);
    return Number.isFinite(n) ? n : fallback;
  } catch {
    return fallback;
  }
}

function storedBool(key: string, fallback: boolean): boolean {
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? fallback : raw === '1';
  } catch {
    return fallback;
  }
}

function storeBool(key: string, value: boolean): void {
  try { localStorage.setItem(key, value ? '1' : '0'); } catch { /* 忽略存储失败 */ }
}

function storeNum(key: string, value: number): void {
  try { localStorage.setItem(key, String(value)); } catch { /* 忽略存储失败 */ }
}

function storedBezier(key: string): Bezier4 | null {
  try {
    const raw = localStorage.getItem(key);
    if (raw == null) return null;
    return normalizeBezier(JSON.parse(raw));
  } catch {
    return null;
  }
}

function makeLayer(id: string, name: string, w: number, h: number, white: boolean): Layer {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  if (white) {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
  }
  return { id, name, visible: true, opacity: 1, blend: 'source-over', canvas };
}

function cloneCanvas(src: HTMLCanvasElement): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = src.width;
  canvas.height = src.height;
  canvas.getContext('2d')!.drawImage(src, 0, 0);
  return canvas;
}

interface DrawState {
  active: boolean;
  tool: Tool;
  x: number;
  y: number;
  pressure: number;
  lastClientX: number;
  lastClientY: number;
  panning: boolean;
  touched: boolean;
  isPen: boolean;
  smoothX: number;
  smoothY: number;
  targetX: number;
  targetY: number;
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

type Point = { x: number; y: number };

interface SelectionState {
  path: Path2D;
  maskCanvas: HTMLCanvasElement;
  maskData: Uint8Array;
  bounds: Rect;
  evenodd: boolean;
  feather: number;
}

interface SelectionDraft {
  tool: 'selectRect' | 'selectLasso';
  start: Point;
  points: Point[];
}

interface MoveState {
  layerId: string;
  preview: HTMLCanvasElement;
  floating: HTMLCanvasElement;
  sourceBounds: Rect;
  startX: number;
  startY: number;
  offsetX: number;
  offsetY: number;
  moved: boolean;
  mode: 'move' | 'scale' | 'rotate';
  scale: number;
  rotation: number;
  startDist: number;
  startAngle: number;
  pivotX: number;
  pivotY: number;
}

type TileMap = Map<string, ImageData>;

interface SelectionSnapshot {
  path: Path2D;
  bounds: Rect;
  evenodd: boolean;
  feather: number;
}

type HistoryEntry =
  | {
      kind: 'tiles';
      layerId: string;
      before: TileMap;
      after?: TileMap;
      bounds: Rect;
    }
  | {
      kind: 'moveSelection';
      layerId: string;
      before: TileMap;
      after?: TileMap;
      bounds: Rect;
      selBefore: SelectionSnapshot | null;
      selAfter: SelectionSnapshot | null;
    }
  | {
      kind: 'addLayer';
      layer: Layer;
      index: number;
      activeBefore: string;
      activeAfter: string;
    }
  | {
      kind: 'deleteLayer';
      layer: Layer;
      index: number;
      activeBefore: string;
      activeAfter: string;
    }
  | {
      kind: 'moveLayer';
      from: number;
      to: number;
    }
  | {
      kind: 'renameLayer';
      id: string;
      before: string;
      after: string;
    }
  | {
      kind: 'setLayerBlend';
      id: string;
      before: BlendMode;
      after: BlendMode;
    }
  | {
      kind: 'mergeDown';
      src: Layer;
      srcIndex: number;
      belowId: string;
      belowBefore: HTMLCanvasElement;
      activeBefore: string;
      activeAfter: string;
    };

export interface ViewInfo {
  panX: number;
  panY: number;
  zoom: number;
  stageW: number;
  stageH: number;
  docW: number;
  docH: number;
}

class EditorStore {
  private state: EditorState = {
    ready: false,
    doc: { w: 1, h: 1, name: '未命名-1', dirty: false },
    layers: [],
    activeId: '',
    tool: 'pen',
    color: '#111827',
    bgColor: '#ffffff',
    size: Math.round(clampNum(storedNum(LS.size, 4), 1, 60)),
    opacity: clampNum(storedNum(LS.opacity, 1), 0.05, 1),
    hardness: clampNum(storedNum(LS.hardness, 1), 0, 1),
    flow: clampNum(storedNum(LS.flow, 1), 0.02, 1),
    spacing: clampNum(storedNum(LS.spacing, 0.15), 0.05, 2),
    pressureCurve: clampNum(storedNum(LS.curve, 1), 0.3, 2.5),
    pressureBezier: storedBezier(LS.bezier),
    stabilizer: clampNum(storedNum(LS.stabilizer, 0), 0, 1),
    zoom: 1,
    transparent: false,
    colorMode: 'wheel',
    recentColors: [],
    status: '准备就绪',
    canUndo: false,
    canRedo: false,
    revision: 0,
    rightDockWidth: Math.max(DOCK_MIN, Math.min(DOCK_MAX, storedNum(LS.dockWidth, 288))),
    rightDockCollapsed: storedBool(LS.dockCollapsed, typeof window !== 'undefined' && window.innerWidth < 1180),
    quickbarVisible: storedBool(LS.quickbar, true),
    chromeVisible: true,
    contextMenu: null,
    selectionVersion: 0,
    hasSelection: false,
    selectionW: 0,
    selectionH: 0,
    hasClipboard: false,
    presets: loadPresets(),
    feather: clampNum(storedNum(LS.feather, 0), 0, 50),
  };

  private listeners = new Set<() => void>();
  private cursorListeners = new Set<() => void>();
  private viewListeners = new Set<() => void>();
  private cursor: CursorInfo = { x: 0, y: 0, inside: false, pressure: 0 };
  private view: ViewInfo = { panX: 0, panY: 0, zoom: 1, stageW: 1, stageH: 1, docW: 1, docH: 1 };
  private cursorRaf = 0;
  private viewRaf = 0;
  private statusTimer = 0;
  private docSeq = 1;
  private revision = 0;
  private docW = 1;
  private docH = 1;
  private layers: Layer[] = [];
  private activeId = '';
  private pan = { x: 0, y: 0 };
  private space = false;
  private draw: DrawState = {
    active: false, tool: 'pen', x: 0, y: 0, pressure: 1,
    lastClientX: 0, lastClientY: 0, panning: false, touched: false,
    isPen: false, smoothX: 0, smoothY: 0, targetX: 0, targetY: 0,
  };
  private strokeMasked: HTMLCanvasElement | null = null;
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];
  private strokePreview: HTMLCanvasElement | null = null;
  private strokeBuf: HTMLCanvasElement | null = null;
  private strokeLayerId = '';
  private strokeBounds: Rect | null = null;
  private strokeResidual = 0;
  private lastMoveRect: Rect | null = null;
  private selection: SelectionState | null = null;
  private selectionDraft: SelectionDraft | null = null;
  private selectionVersion = 0;
  private moveState: MoveState | null = null;
  private clipboard: HTMLCanvasElement | null = null;
  private display: HTMLCanvasElement | null = null;
  private wrap: HTMLElement | null = null;
  private dctx: CanvasRenderingContext2D | null = null;
  private dpr = 1;
  private resizeObserver: ResizeObserver | null = null;
  private attached = false;
  private autosaveTimer = 0;
  private autosaveBusy = false;
  private restoreAttempted = false;

  // ---------- 订阅 ----------
  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  };

  getState = (): EditorState => this.state;

  subscribeCursor = (fn: () => void): (() => void) => {
    this.cursorListeners.add(fn);
    return () => { this.cursorListeners.delete(fn); };
  };

  getCursor = (): CursorInfo => this.cursor;

  subscribeView = (fn: () => void): (() => void) => {
    this.viewListeners.add(fn);
    return () => { this.viewListeners.delete(fn); };
  };

  getView = (): ViewInfo => this.view;

  private emit(patch: Partial<EditorState>): void {
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn();
  }

  private layerMeta(): LayerMeta[] {
    return this.layers.map(({ id, name, visible, opacity, blend }) => ({ id, name, visible, opacity, blend }));
  }

  private syncLayers(patch: Partial<EditorState> = {}): void {
    this.emit({
      layers: this.layerMeta(),
      activeId: this.activeId,
      revision: this.revision,
      canUndo: this.undoStack.length > 0,
      canRedo: this.redoStack.length > 0,
      ...patch,
    });
  }

  private notifyCursor(): void {
    if (this.cursorRaf) return;
    this.cursorRaf = requestAnimationFrame(() => {
      this.cursorRaf = 0;
      for (const fn of this.cursorListeners) fn();
    });
  }

  private notifyView(): void {
    if (this.viewRaf) return;
    this.viewRaf = requestAnimationFrame(() => {
      this.viewRaf = 0;
      this.view = {
        panX: this.pan.x,
        panY: this.pan.y,
        zoom: this.state.zoom,
        stageW: this.display?.clientWidth ?? 0,
        stageH: this.display?.clientHeight ?? 0,
        docW: this.docW,
        docH: this.docH,
      };
      for (const fn of this.viewListeners) fn();
    });
  }

  setStatus(message: string): void {
    this.emit({ status: message });
    if (this.statusTimer) window.clearTimeout(this.statusTimer);
    this.statusTimer = window.setTimeout(() => {
      this.statusTimer = 0;
      this.emit({ status: '' });
    }, 2600);
  }

  // ---------- 生命周期 ----------
  attach(display: HTMLCanvasElement, wrap: HTMLElement): void {
    this.display = display;
    this.wrap = wrap;
    this.dctx = display.getContext('2d');
    this.dpr = window.devicePixelRatio || 1;
    if (this.layers.length === 0) {
      this.initDoc();
    } else {
      this.emit({ ready: true, zoom: this.state.zoom, doc: { ...this.state.doc } });
      this.render();
      this.notifyView();
    }
    if (!this.attached) {
      this.attached = true;
      window.addEventListener('resize', this.onWindowResize);
      document.addEventListener('visibilitychange', this.onVisibilityChange);
    }
    this.resizeObserver?.disconnect();
    this.resizeObserver = new ResizeObserver(() => {
      this.render();
      this.notifyView();
    });
    this.resizeObserver.observe(wrap);
    void this.tryRestoreAutosave();
  }

  detach(): void {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    if (this.attached) {
      this.attached = false;
      window.removeEventListener('resize', this.onWindowResize);
      document.removeEventListener('visibilitychange', this.onVisibilityChange);
    }
    if (this.autosaveTimer) {
      window.clearTimeout(this.autosaveTimer);
      this.autosaveTimer = 0;
      void this.saveAutosaveNow();
    }
    this.display = null;
    this.wrap = null;
    this.dctx = null;
    this.draw.active = false;
    this.strokeMasked = null;
  }

  private onVisibilityChange = (): void => {
    if (document.visibilityState === 'hidden' && this.state.doc.dirty) {
      void this.saveAutosaveNow();
    }
  };

  destroy = (): void => {
    this.detach();
    if (this.statusTimer) window.clearTimeout(this.statusTimer);
    if (this.autosaveTimer) window.clearTimeout(this.autosaveTimer);
    if (this.cursorRaf) cancelAnimationFrame(this.cursorRaf);
    if (this.viewRaf) cancelAnimationFrame(this.viewRaf);
    this.listeners.clear();
    this.cursorListeners.clear();
    this.viewListeners.clear();
  };

  private onWindowResize = (): void => {
    const next = window.devicePixelRatio || 1;
    if (next !== this.dpr) this.dpr = next;
    this.render();
    this.notifyView();
  };

  // ---------- 文档 ----------
  private initDoc(): void {
    const w = Math.max(64, Math.floor(this.wrap?.clientWidth ?? 1024));
    const h = Math.max(64, Math.floor(this.wrap?.clientHeight ?? 768));
    this.docW = w;
    this.docH = h;
    const layer = makeLayer('L' + Date.now().toString(36), '图层 1', w, h, true);
    this.layers = [layer];
    this.activeId = layer.id;
    this.pan = { x: 0, y: 0 };
    this.undoStack = [];
    this.redoStack = [];
    this.revision += 1;
    this.selection = null;
    this.selectionDraft = null;
    this.moveState = null;
    this.selectionVersion += 1;
    this.emit({
      ready: true,
      doc: { w, h, name: `未命名-${this.docSeq}`, dirty: false },
      layers: this.layerMeta(),
      activeId: this.activeId,
      zoom: 1,
      canUndo: false,
      canRedo: false,
      revision: this.revision,
      selectionVersion: this.selectionVersion,
      hasSelection: false,
      selectionW: 0,
      selectionH: 0,
      status: '新建画布',
    });
    this.render();
    this.notifyView();
  }

  newDocument = (): void => {
    if (this.state.doc.dirty && !window.confirm('当前画布尚未保存，确定新建吗？')) return;
    this.restoreAttempted = true;
    void clearAutosave();
    this.docSeq += 1;
    this.initDoc();
  };

  // ---------- 渲染 ----------
  render = (rect?: Rect): void => {
    const c = this.display;
    const ctx = this.dctx;
    if (!c || !ctx) return;
    const dw = Math.max(1, c.clientWidth);
    const dh = Math.max(1, c.clientHeight);
    const targetW = Math.round(dw * this.dpr);
    const targetH = Math.round(dh * this.dpr);
    if (c.width !== targetW || c.height !== targetH) {
      c.width = targetW;
      c.height = targetH;
    }
    const z = this.state.zoom;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    let clip: { x: number; y: number; w: number; h: number } | null = null;
    if (rect) {
      const rx = this.pan.x + rect.x * z;
      const ry = this.pan.y + rect.y * z;
      const rw = rect.w * z;
      const rh = rect.h * z;
      const pad = 2;
      const x = Math.max(0, rx - pad);
      const y = Math.max(0, ry - pad);
      const w = Math.min(dw, rx + rw + pad) - x;
      const h = Math.min(dh, ry + rh + pad) - y;
      if (w <= 0 || h <= 0) return;
      clip = { x, y, w, h };
      ctx.clearRect(x, y, w, h);
    } else {
      ctx.clearRect(0, 0, dw, dh);
    }

    ctx.save();
    if (clip) {
      ctx.beginPath();
      ctx.rect(clip.x, clip.y, clip.w, clip.h);
      ctx.clip();
    }
    ctx.translate(this.pan.x, this.pan.y);
    ctx.scale(z, z);
    const previewActive = this.draw.active
      && (this.draw.tool === 'pen' || this.draw.tool === 'eraser')
      && this.strokePreview !== null;
    for (const layer of this.layers) {
      if (!layer.visible) continue;
      ctx.globalCompositeOperation = layer.blend;
      ctx.globalAlpha = layer.opacity;
      const moving = this.moveState && this.moveState.layerId === layer.id ? this.moveState : null;
      const src = moving
        ? moving.preview
        : previewActive && layer.id === this.strokeLayerId
          ? this.strokePreview!
          : layer.canvas;
      ctx.drawImage(src, 0, 0);
      if (moving && moving.moved) {
        const mm = this.stateMatrix(moving);
        ctx.save();
        ctx.transform(mm.a, mm.b, mm.c, mm.d, mm.e, mm.f);
        ctx.drawImage(moving.floating, moving.sourceBounds.x, moving.sourceBounds.y);
        ctx.restore();
      }
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.restore();
    ctx.globalAlpha = 1;

    if (rect) return;

    // 画布边界：SAI 式纸面有明确的边界感
    const bx = this.pan.x;
    const by = this.pan.y;
    const bw = this.docW * z;
    const bh = this.docH * z;
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,.18)';
    ctx.shadowBlur = 10;
    ctx.strokeStyle = 'rgba(0,0,0,.22)';
    ctx.lineWidth = 1;
    ctx.strokeRect(bx + 0.5, by + 0.5, bw - 1, bh - 1);
    ctx.restore();
  };

  // ---------- 坐标 / 相机 ----------
  private toDoc(clientX: number, clientY: number): { x: number; y: number } {
    const c = this.display;
    if (!c) return { x: 0, y: 0 };
    const rect = c.getBoundingClientRect();
    const sx = clientX - rect.left;
    const sy = clientY - rect.top;
    return { x: (sx - this.pan.x) / this.state.zoom, y: (sy - this.pan.y) / this.state.zoom };
  }

  private stageSize(): { w: number; h: number } {
    return { w: this.display?.clientWidth ?? 1, h: this.display?.clientHeight ?? 1 };
  }

  private clampZoom(z: number): number {
    return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));
  }

  wheel = (deltaY: number, clientX: number, clientY: number): void => {
    const c = this.display;
    if (!c) return;
    const factor = deltaY < 0 ? 1.1 : 1 / 1.1;
    const next = this.clampZoom(this.state.zoom * factor);
    if (next === this.state.zoom) return;
    const rect = c.getBoundingClientRect();
    const sx = clientX - rect.left;
    const sy = clientY - rect.top;
    const docX = (sx - this.pan.x) / this.state.zoom;
    const docY = (sy - this.pan.y) / this.state.zoom;
    this.pan = { x: sx - docX * next, y: sy - docY * next };
    this.emit({ zoom: next });
    this.render();
    this.notifyView();
  };

  zoomBy = (factor: number): void => {
    const z = this.clampZoom(this.state.zoom * factor);
    if (z === this.state.zoom) return;
    const { w, h } = this.stageSize();
    const docX = (w / 2 - this.pan.x) / this.state.zoom;
    const docY = (h / 2 - this.pan.y) / this.state.zoom;
    this.pan = { x: w / 2 - docX * z, y: h / 2 - docY * z };
    this.emit({ zoom: z });
    this.render();
    this.notifyView();
  };

  zoomTo = (z: number): void => {
    const next = this.clampZoom(z);
    this.zoomBy(next / this.state.zoom);
  };

  fitView = (): void => {
    const { w, h } = this.stageSize();
    const z = this.clampZoom(Math.min((w - 56) / this.docW, (h - 56) / this.docH));
    this.emit({ zoom: z });
    this.pan = { x: (w - this.docW * z) / 2, y: (h - this.docH * z) / 2 };
    this.render();
    this.notifyView();
  };

  centerOnDocPoint = (x: number, y: number): void => {
    const { w, h } = this.stageSize();
    this.pan = { x: w / 2 - x * this.state.zoom, y: h / 2 - y * this.state.zoom };
    this.render();
    this.notifyView();
  };

  setSpace = (down: boolean): void => { this.space = down; };

  // ---------- 光标 ----------
  updateCursor(clientX: number, clientY: number, pressure: number): void {
    const p = this.toDoc(clientX, clientY);
    this.cursor = { x: p.x, y: p.y, inside: true, pressure };
    this.notifyCursor();
  }

  clearCursor = (): void => {
    this.cursor = { ...this.cursor, inside: false, pressure: 0 };
    this.notifyCursor();
  };

  // ---------- 选区 ----------
  getSelectionPath = (): Path2D | null => this.selection?.path ?? null;

  getSelectionDraft = (): SelectionDraft | null => this.selectionDraft;

  getSelectionTransform = (): {
    dx: number;
    dy: number;
    scale: number;
    rotation: number;
    pivotX: number;
    pivotY: number;
    active: boolean;
  } => {
    const m = this.moveState;
    if (!m) return { dx: 0, dy: 0, scale: 1, rotation: 0, pivotX: 0, pivotY: 0, active: false };
    if (m.mode === 'move') {
      return { dx: m.offsetX, dy: m.offsetY, scale: 1, rotation: 0, pivotX: 0, pivotY: 0, active: true };
    }
    return {
      dx: 0,
      dy: 0,
      scale: m.scale,
      rotation: m.rotation,
      pivotX: m.pivotX,
      pivotY: m.pivotY,
      active: true,
    };
  };

  getSelectionDisplayBounds = (): Rect | null => {
    const sel = this.selection;
    if (!sel) return null;
    const t = this.getSelectionTransform();
    if (!t.active) return { ...sel.bounds };
    return this.transformBounds(sel.bounds, this.matrixFor(t.dx, t.dy, t.scale, t.rotation, t.pivotX, t.pivotY));
  };

  private syncSelection(status?: string): void {
    this.selectionVersion += 1;
    const b = this.selection?.bounds;
    this.emit({
      selectionVersion: this.selectionVersion,
      hasSelection: !!this.selection,
      selectionW: b ? Math.round(b.w) : 0,
      selectionH: b ? Math.round(b.h) : 0,
    });
    if (status) this.setStatus(status);
  }

  private buildSelection(
    path: Path2D,
    bounds: Rect,
    evenodd = false,
    feather = this.state.feather,
  ): SelectionState {
    const radius = Math.max(0, Math.min(50, Math.round(feather)));
    const mask = document.createElement('canvas');
    mask.width = this.docW;
    mask.height = this.docH;
    const mctx = mask.getContext('2d', { willReadFrequently: true })!;
    const rule = evenodd ? 'evenodd' : 'nonzero';
    if (radius > 0) {
      const tmp = document.createElement('canvas');
      tmp.width = this.docW;
      tmp.height = this.docH;
      const tctx = tmp.getContext('2d')!;
      tctx.fillStyle = '#ffffff';
      tctx.fill(path, rule);
      // blur 的参数是高斯 σ，可见过渡带约 ±3σ；滑杆按「边界两侧各 N 像素」标称，故 σ = N/3。
      mctx.filter = `blur(${(radius / 3).toFixed(2)}px)`;
      mctx.drawImage(tmp, 0, 0);
      mctx.filter = 'none';
    } else {
      mctx.fillStyle = '#ffffff';
      mctx.fill(path, rule);
    }
    const img = mctx.getImageData(0, 0, this.docW, this.docH).data;
    const maskData = new Uint8Array(this.docW * this.docH);
    const total = this.docW * this.docH;
    for (let i = 0; i < total; i++) maskData[i] = img[i * 4 + 3] >= 128 ? 1 : 0;
    return { path, maskCanvas: mask, maskData, bounds, evenodd, feather: radius };
  }

  private clipSelection(ctx: CanvasRenderingContext2D): void {
    if (!this.selection) return;
    ctx.clip(this.selection.path, this.selection.evenodd ? 'evenodd' : 'nonzero');
  }

  private selectionContains(x: number, y: number): boolean {
    if (!this.selection) return true;
    const px = Math.floor(x);
    const py = Math.floor(y);
    if (px < 0 || py < 0 || px >= this.docW || py >= this.docH) return false;
    return this.selection.maskData[py * this.docW + px] === 1;
  }

  selectionDown = (x: number, y: number, tool: 'selectRect' | 'selectLasso'): void => {
    const px = Math.max(0, Math.min(this.docW, x));
    const py = Math.max(0, Math.min(this.docH, y));
    this.selectionDraft = { tool, start: { x: px, y: py }, points: [{ x: px, y: py }] };
  };

  selectionMove = (x: number, y: number): void => {
    const draft = this.selectionDraft;
    if (!draft) return;
    const px = Math.max(0, Math.min(this.docW, x));
    const py = Math.max(0, Math.min(this.docH, y));
    if (draft.tool === 'selectRect') {
      draft.points[1] = { x: px, y: py };
    } else {
      const last = draft.points[draft.points.length - 1];
      if (Math.hypot(px - last.x, py - last.y) >= 1.5) draft.points.push({ x: px, y: py });
    }
  };

  selectionUp = (): void => {
    const draft = this.selectionDraft;
    this.selectionDraft = null;
    if (!draft) return;
    let path: Path2D | null = null;
    let bounds: Rect | null = null;
    if (draft.tool === 'selectRect') {
      const end = draft.points[1] ?? draft.points[0];
      const x = Math.min(draft.start.x, end.x);
      const y = Math.min(draft.start.y, end.y);
      const w = Math.abs(end.x - draft.start.x);
      const h = Math.abs(end.y - draft.start.y);
      if (w >= 2 && h >= 2) {
        path = new Path2D();
        path.rect(x, y, w, h);
        bounds = { x, y, w, h };
      }
    } else if (draft.points.length >= 3) {
      const p = new Path2D();
      p.moveTo(draft.points[0].x, draft.points[0].y);
      for (let i = 1; i < draft.points.length; i++) {
        p.lineTo(draft.points[i].x, draft.points[i].y);
      }
      p.closePath();
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const pt of draft.points) {
        minX = Math.min(minX, pt.x); minY = Math.min(minY, pt.y);
        maxX = Math.max(maxX, pt.x); maxY = Math.max(maxY, pt.y);
      }
      path = p;
      bounds = { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
    }
    if (!path || !bounds) {
      this.selection = null;
      this.syncSelection('已取消选区');
      return;
    }
    this.selection = this.buildSelection(path, bounds);
    this.syncSelection(`选区 ${Math.round(bounds.w)} × ${Math.round(bounds.h)}`);
  };

  clearSelection = (): void => {
    if (!this.selection && !this.selectionDraft) return;
    this.selection = null;
    this.selectionDraft = null;
    this.syncSelection('已取消选区');
  };

  selectAll = (): void => {
    const path = new Path2D();
    path.rect(0, 0, this.docW, this.docH);
    const bounds = { x: 0, y: 0, w: this.docW, h: this.docH };
    this.selection = this.buildSelection(path, bounds);
    this.syncSelection('已全选');
  };

  invertSelection = (): void => {
    if (!this.selection) {
      this.selectAll();
      return;
    }
    const path = new Path2D();
    path.rect(0, 0, this.docW, this.docH);
    path.addPath(this.selection.path);
    const bounds = { x: 0, y: 0, w: this.docW, h: this.docH };
    this.selection = this.buildSelection(path, bounds, true);
    this.syncSelection('已反选');
  };

  deleteSelection = (): void => {
    const layer = this.activeLayer();
    if (!layer || !this.selection) return;
    const sel = this.selection;
    const pad = sel.feather;
    const bounds = this.clampRect({
      x: sel.bounds.x - pad,
      y: sel.bounds.y - pad,
      w: sel.bounds.w + pad * 2,
      h: sel.bounds.h + pad * 2,
    });
    if (bounds.w <= 0 || bounds.h <= 0) return;
    const before = this.captureTiles(layer.canvas, bounds);
    const ctx = layer.canvas.getContext('2d')!;
    ctx.save();
    if (sel.feather > 0) {
      ctx.globalCompositeOperation = 'destination-out';
      ctx.drawImage(sel.maskCanvas, 0, 0);
      ctx.globalCompositeOperation = 'source-over';
    } else {
      this.clipSelection(ctx);
      ctx.clearRect(bounds.x, bounds.y, bounds.w, bounds.h);
    }
    ctx.restore();
    this.pushTileHistory(layer.id, before, bounds);
    this.revision += 1;
    this.syncLayers({ doc: { ...this.state.doc, dirty: true }, revision: this.revision });
    this.render();
    this.notifyView();
    this.scheduleAutosave();
    this.setStatus('已删除选区内容');
  };

  cutSelection = (): void => {
    if (!this.selection) return;
    this.copySelection();
    this.deleteSelection();
    this.setStatus('已剪切选区内容');
  };

  copySelection = (): void => {
    const layer = this.activeLayer();
    if (!layer) return;
    const sel = this.selection;
    const pad = sel ? sel.feather : 0;
    const raw = sel
      ? { x: sel.bounds.x - pad, y: sel.bounds.y - pad, w: sel.bounds.w + pad * 2, h: sel.bounds.h + pad * 2 }
      : { x: 0, y: 0, w: this.docW, h: this.docH };
    const bounds = this.clampRect(raw);
    if (bounds.w <= 0 || bounds.h <= 0) return;
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bounds.w));
    canvas.height = Math.max(1, Math.round(bounds.h));
    const ctx = canvas.getContext('2d')!;
    ctx.save();
    if (sel) {
      ctx.translate(-bounds.x, -bounds.y);
      if (sel.feather > 0) {
        ctx.drawImage(layer.canvas, 0, 0);
        ctx.globalCompositeOperation = 'destination-in';
        ctx.drawImage(sel.maskCanvas, 0, 0);
        ctx.globalCompositeOperation = 'source-over';
      } else {
        ctx.clip(sel.path, sel.evenodd ? 'evenodd' : 'nonzero');
        ctx.drawImage(layer.canvas, 0, 0);
      }
    } else {
      ctx.drawImage(layer.canvas, 0, 0);
    }
    ctx.restore();
    this.clipboard = canvas;
    this.emit({ hasClipboard: true });
    this.setStatus(sel ? `已复制选区 ${Math.round(bounds.w)} × ${Math.round(bounds.h)}` : '已复制当前图层');
  };

  pasteClipboard = (): void => {
    const clip = this.clipboard;
    const layer = this.activeLayer();
    if (!clip || !layer) {
      this.setStatus('剪贴板为空');
      return;
    }
    const v = this.getView();
    const z = v.zoom || 1;
    const cx = (v.stageW / 2 - v.panX) / z;
    const cy = (v.stageH / 2 - v.panY) / z;
    const x = Math.max(0, Math.min(Math.max(0, this.docW - clip.width), Math.round(cx - clip.width / 2)));
    const y = Math.max(0, Math.min(Math.max(0, this.docH - clip.height), Math.round(cy - clip.height / 2)));
    const dest = { x, y, w: clip.width, h: clip.height };
    const destClip = this.clampRect(dest);
    if (destClip.w <= 0 || destClip.h <= 0) return;
    const selBefore = this.snapshotSelection();
    const before = this.captureTiles(layer.canvas, destClip);
    const ctx = layer.canvas.getContext('2d')!;
    ctx.drawImage(clip, dest.x, dest.y);
    const path = new Path2D();
    path.rect(destClip.x, destClip.y, destClip.w, destClip.h);
    this.selection = this.buildSelection(path, destClip);
    const selAfter = this.snapshotSelection();
    this.pushCommand({
      kind: 'moveSelection',
      layerId: layer.id,
      before,
      bounds: destClip,
      selBefore,
      selAfter,
    });
    this.syncSelection();
    this.revision += 1;
    this.syncLayers({ doc: { ...this.state.doc, dirty: true }, revision: this.revision });
    this.render();
    this.notifyView();
    this.scheduleAutosave();
    this.setStatus('已粘贴');
  };

  private matrixFor(
    dx: number, dy: number, scale: number, rotation: number, pivotX: number, pivotY: number,
  ): DOMMatrix {
    const m = new DOMMatrix();
    if (scale !== 1 || rotation !== 0) {
      m.translateSelf(pivotX, pivotY);
      m.rotateSelf((rotation * 180) / Math.PI);
      m.scaleSelf(scale, scale);
      m.translateSelf(-pivotX, -pivotY);
    }
    m.translateSelf(dx, dy);
    return m;
  }

  private transformBounds(bounds: Rect, matrix: DOMMatrix): Rect {
    const pts = [
      [bounds.x, bounds.y],
      [bounds.x + bounds.w, bounds.y],
      [bounds.x + bounds.w, bounds.y + bounds.h],
      [bounds.x, bounds.y + bounds.h],
    ].map(([px, py]) => matrix.transformPoint(new DOMPoint(px, py)));
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    return { x: minX, y: minY, w: Math.max(...xs) - minX, h: Math.max(...ys) - minY };
  }

  private stateMatrix(m: MoveState): DOMMatrix {
    if (m.mode === 'move') return this.matrixFor(m.offsetX, m.offsetY, 1, 0, 0, 0);
    return this.matrixFor(0, 0, m.scale, m.rotation, m.pivotX, m.pivotY);
  }

  private snapshotSelection(): SelectionSnapshot | null {
    return this.selection
      ? {
          path: this.selection.path,
          bounds: { ...this.selection.bounds },
          evenodd: this.selection.evenodd,
          feather: this.selection.feather,
        }
      : null;
  }

  private applySelectionSnapshot(snap: SelectionSnapshot | null): void {
    if (!snap) {
      if (this.selection) {
        this.selection = null;
        this.syncSelection();
      }
      return;
    }
    this.state = { ...this.state, feather: snap.feather };
    this.selection = this.buildSelection(snap.path, snap.bounds, snap.evenodd, snap.feather);
    this.syncSelection();
    this.emit({ feather: snap.feather });
  }

  setFeather = (value: number): void => {
    const next = Math.max(0, Math.min(50, Math.round(value)));
    storeNum(LS.feather, next);
    this.emit({ feather: next });
    if (this.selection) {
      const s = this.selection;
      this.selection = this.buildSelection(s.path, s.bounds, s.evenodd, next);
      this.syncSelection();
    }
  };

  // ---------- 移动 / 缩放 / 旋转 ----------
  private createFloating(layer: Layer): {
    preview: HTMLCanvasElement;
    floating: HTMLCanvasElement;
    sourceBounds: Rect;
  } | null {
    const sel = this.selection;
    const pad = sel ? sel.feather : 0;
    const sourceBounds = sel
      ? this.clampRect({
          x: sel.bounds.x - pad,
          y: sel.bounds.y - pad,
          w: sel.bounds.w + pad * 2,
          h: sel.bounds.h + pad * 2,
        })
      : { x: 0, y: 0, w: this.docW, h: this.docH };
    if (sourceBounds.w < 1 || sourceBounds.h < 1) return null;
    const floating = document.createElement('canvas');
    floating.width = Math.max(1, Math.round(sourceBounds.w));
    floating.height = Math.max(1, Math.round(sourceBounds.h));
    const fctx = floating.getContext('2d')!;
    fctx.save();
    if (sel) {
      fctx.translate(-sourceBounds.x, -sourceBounds.y);
      if (sel.feather > 0) {
        fctx.drawImage(layer.canvas, 0, 0);
        fctx.globalCompositeOperation = 'destination-in';
        fctx.drawImage(sel.maskCanvas, 0, 0);
        fctx.globalCompositeOperation = 'source-over';
      } else {
        fctx.clip(sel.path, sel.evenodd ? 'evenodd' : 'nonzero');
        fctx.drawImage(layer.canvas, 0, 0);
      }
    } else {
      fctx.drawImage(layer.canvas, 0, 0);
    }
    fctx.restore();

    const preview = cloneCanvas(layer.canvas);
    const pctx = preview.getContext('2d')!;
    pctx.save();
    if (sel && sel.feather > 0) {
      pctx.globalCompositeOperation = 'destination-out';
      pctx.drawImage(sel.maskCanvas, 0, 0);
      pctx.globalCompositeOperation = 'source-over';
    } else {
      if (sel) pctx.clip(sel.path, sel.evenodd ? 'evenodd' : 'nonzero');
      pctx.clearRect(sourceBounds.x, sourceBounds.y, sourceBounds.w, sourceBounds.h);
    }
    pctx.restore();
    return { preview, floating, sourceBounds };
  }

  private beginMove(layer: Layer, x: number, y: number): void {
    const f = this.createFloating(layer);
    if (!f) return;
    const pivotX = f.sourceBounds.x + f.sourceBounds.w / 2;
    const pivotY = f.sourceBounds.y + f.sourceBounds.h / 2;
    this.moveState = {
      layerId: layer.id,
      preview: f.preview,
      floating: f.floating,
      sourceBounds: f.sourceBounds,
      startX: x,
      startY: y,
      offsetX: 0,
      offsetY: 0,
      moved: false,
      mode: 'move',
      scale: 1,
      rotation: 0,
      startDist: 0,
      startAngle: 0,
      pivotX,
      pivotY,
    };
    this.render();
  }

  private hitTransformHandle(x: number, y: number): 'scale' | 'rotate' | null {
    if (!this.selection) return null;
    const b = this.selection.bounds;
    const z = this.state.zoom || 1;
    const th = 9 / z;
    const cx = b.x + b.w / 2;
    const cy = b.y + b.h / 2;
    const rot = { x: cx, y: b.y - 24 / z };
    if (Math.hypot(x - rot.x, y - rot.y) <= th) return 'rotate';
    const handles: Array<[number, number]> = [
      [b.x, b.y], [cx, b.y], [b.x + b.w, b.y],
      [b.x, cy], [b.x + b.w, cy],
      [b.x, b.y + b.h], [cx, b.y + b.h], [b.x + b.w, b.y + b.h],
    ];
    for (const [hx, hy] of handles) {
      if (Math.hypot(x - hx, y - hy) <= th) return 'scale';
    }
    return null;
  }

  private beginTransform(layer: Layer, mode: 'scale' | 'rotate', x: number, y: number): void {
    const f = this.createFloating(layer);
    if (!f) return;
    const pivotX = f.sourceBounds.x + f.sourceBounds.w / 2;
    const pivotY = f.sourceBounds.y + f.sourceBounds.h / 2;
    this.moveState = {
      layerId: layer.id,
      preview: f.preview,
      floating: f.floating,
      sourceBounds: f.sourceBounds,
      startX: x,
      startY: y,
      offsetX: 0,
      offsetY: 0,
      moved: false,
      mode,
      scale: 1,
      rotation: 0,
      startDist: Math.max(1, Math.hypot(x - pivotX, y - pivotY)),
      startAngle: Math.atan2(y - pivotY, x - pivotX),
      pivotX,
      pivotY,
    };
    this.render();
  }

  private moveTo(x: number, y: number): void {
    const m = this.moveState;
    if (!m) return;
    m.offsetX = x - m.startX;
    m.offsetY = y - m.startY;
    m.moved = Math.hypot(m.offsetX, m.offsetY) > 0.5;
    this.render();
  }

  private transformTo(x: number, y: number, shiftKey: boolean): void {
    const m = this.moveState;
    if (!m) return;
    if (m.mode === 'scale') {
      const dist = Math.hypot(x - m.pivotX, y - m.pivotY);
      m.scale = Math.max(0.05, Math.min(20, dist / m.startDist));
      m.moved = Math.abs(m.scale - 1) > 0.01;
    } else if (m.mode === 'rotate') {
      let rotation = Math.atan2(y - m.pivotY, x - m.pivotX) - m.startAngle;
      if (shiftKey) rotation = Math.round(rotation / (Math.PI / 12)) * (Math.PI / 12);
      m.rotation = rotation;
      m.moved = Math.abs(rotation) > 0.001;
    }
    this.render();
  }

  private endMove(): void {
    const m = this.moveState;
    if (!m) {
      this.render();
      return;
    }
    if (!m.moved) {
      this.moveState = null;
      this.render();
      return;
    }
    const layer = this.layers.find((l) => l.id === m.layerId);
    if (!layer) {
      this.moveState = null;
      this.render();
      return;
    }
    const matrix = this.stateMatrix(m);
    const dest = this.transformBounds(m.sourceBounds, matrix);
    const union = this.clampRect(this.unionRect(m.sourceBounds, dest));
    if (union.w <= 0 || union.h <= 0) {
      this.moveState = null;
      this.render();
      return;
    }
    const selBefore = this.snapshotSelection();
    const before = this.captureTiles(layer.canvas, union);
    const ctx = layer.canvas.getContext('2d')!;
    ctx.clearRect(0, 0, layer.canvas.width, layer.canvas.height);
    ctx.drawImage(m.preview, 0, 0);
    ctx.save();
    ctx.transform(matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f);
    ctx.drawImage(m.floating, m.sourceBounds.x, m.sourceBounds.y);
    ctx.restore();
    if (selBefore) {
      const selBounds = this.transformBounds(selBefore.bounds, matrix);
      const path = new Path2D();
      path.addPath(selBefore.path, matrix);
      this.selection = this.buildSelection(path, selBounds, selBefore.evenodd, selBefore.feather);
      this.syncSelection();
    }
    const selAfter = this.snapshotSelection();
    this.moveState = null;
    this.pushCommand({
      kind: 'moveSelection',
      layerId: layer.id,
      before,
      bounds: union,
      selBefore,
      selAfter,
    });
    this.revision += 1;
    this.syncLayers({ doc: { ...this.state.doc, dirty: true }, revision: this.revision });
    this.render();
    this.notifyView();
    this.scheduleAutosave();
    this.setStatus(m.mode === 'move' ? '已移动' : '已变换');
  };

  // ---------- 绘制 ----------
  private activeLayer(): Layer | null {
    return this.layers.find((l) => l.id === this.activeId) ?? null;
  }

  private dabWidth(pressure: number, isPen: boolean): number {
    const raw = isPen && pressure > 0 ? Math.min(1, pressure) : 1;
    const curved = this.state.pressureBezier
      ? sampleBezier(this.state.pressureBezier, raw)
      : Math.pow(raw, this.state.pressureCurve);
    return Math.max(0.5, this.state.size * curved);
  }

  private applyStroke(ctx: CanvasRenderingContext2D, width: number): void {
    ctx.strokeStyle = this.state.color;
    ctx.fillStyle = this.state.color;
    ctx.lineWidth = width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
  }

  private dabRect(x: number, y: number, width: number): Rect {
    const r = width / 2 + 2;
    return { x: x - r, y: y - r, w: r * 2, h: r * 2 };
  }

  private unionRect(a: Rect | null, b: Rect): Rect {
    if (!a) return b;
    const x = Math.min(a.x, b.x);
    const y = Math.min(a.y, b.y);
    const x2 = Math.max(a.x + a.w, b.x + b.w);
    const y2 = Math.max(a.y + a.h, b.y + b.h);
    return { x, y, w: x2 - x, h: y2 - y };
  }

  private clampRect(rect: Rect): Rect {
    const x = Math.max(0, Math.floor(rect.x));
    const y = Math.max(0, Math.floor(rect.y));
    const x2 = Math.min(this.docW, Math.ceil(rect.x + rect.w));
    const y2 = Math.min(this.docH, Math.ceil(rect.y + rect.h));
    return { x, y, w: Math.max(0, x2 - x), h: Math.max(0, y2 - y) };
  }

  private clipForPaint(ctx: CanvasRenderingContext2D): void {
    if (this.selection && this.selection.feather === 0) this.clipSelection(ctx);
  }

  private stampDab(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, eraser: boolean): void {
    const alpha = eraser ? this.state.flow * this.state.opacity : this.state.flow;
    const color = eraser ? '#000000' : this.state.color;
    ctx.globalCompositeOperation = 'source-over';
    const r = Math.max(0.5, width / 2);
    if (this.state.hardness >= 1) {
      ctx.globalAlpha = alpha;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.globalAlpha = 1;
      const [cr, cg, cb] = hexToRgb(color);
      const g = ctx.createRadialGradient(x, y, r * this.state.hardness, x, y, r);
      g.addColorStop(0, `rgba(${cr},${cg},${cb},${alpha})`);
      g.addColorStop(1, `rgba(${cr},${cg},${cb},0)`);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  private stampSegment(
    ctx: CanvasRenderingContext2D, eraser: boolean,
    x0: number, y0: number, x1: number, y1: number, width: number,
  ): Rect | null {
    const dist = Math.hypot(x1 - x0, y1 - y0);
    if (dist <= 0.0001) return null;
    const step = Math.max(0.75, width * this.state.spacing);
    let t = step - this.strokeResidual;
    if (t <= 0) t = step;
    let last = 0;
    let bounds: Rect | null = null;
    ctx.save();
    this.clipForPaint(ctx);
    while (t <= dist) {
      const ratio = t / dist;
      const x = x0 + (x1 - x0) * ratio;
      const y = y0 + (y1 - y0) * ratio;
      this.stampDab(ctx, x, y, width, eraser);
      bounds = this.unionRect(bounds, this.dabRect(x, y, width));
      last = t;
      t += step;
    }
    ctx.restore();
    this.strokeResidual = last > 0 ? dist - last : this.strokeResidual + dist;
    if (this.strokeResidual > step) this.strokeResidual = step;
    return bounds;
  }

  private refreshStrokePreview(layer: Layer, rect: Rect): void {
    if (!this.strokePreview || !this.strokeBuf) return;
    const r = this.clampRect(rect);
    if (r.w <= 0 || r.h <= 0) return;
    const pctx = this.strokePreview.getContext('2d')!;
    pctx.save();
    pctx.beginPath();
    pctx.rect(r.x, r.y, r.w, r.h);
    pctx.clip();
    pctx.clearRect(r.x, r.y, r.w, r.h);
    pctx.drawImage(layer.canvas, r.x, r.y, r.w, r.h, r.x, r.y, r.w, r.h);

    let source = this.strokeBuf;
    if (this.selection && this.selection.feather > 0) {
      if (!this.strokeMasked) {
        this.strokeMasked = makeLayer('masked', 'masked', this.docW, this.docH, false).canvas;
      }
      const mctx = this.strokeMasked.getContext('2d')!;
      mctx.clearRect(r.x, r.y, r.w, r.h);
      mctx.drawImage(this.strokeBuf, r.x, r.y, r.w, r.h, r.x, r.y, r.w, r.h);
      mctx.globalCompositeOperation = 'destination-in';
      mctx.drawImage(this.selection.maskCanvas, r.x, r.y, r.w, r.h, r.x, r.y, r.w, r.h);
      mctx.globalCompositeOperation = 'source-over';
      source = this.strokeMasked;
    }

    if (this.draw.tool === 'eraser') {
      pctx.globalCompositeOperation = 'destination-out';
      pctx.drawImage(source, r.x, r.y, r.w, r.h, r.x, r.y, r.w, r.h);
      pctx.globalCompositeOperation = 'source-over';
    } else {
      pctx.globalAlpha = this.state.opacity;
      pctx.drawImage(source, r.x, r.y, r.w, r.h, r.x, r.y, r.w, r.h);
      pctx.globalAlpha = 1;
    }
    pctx.restore();
  }

  private beginStroke(layer: Layer, x: number, y: number, width: number, eraser: boolean): void {
    this.draw.touched = true;
    this.strokeLayerId = layer.id;
    this.strokePreview = cloneCanvas(layer.canvas);
    this.strokeBuf = makeLayer('buf', 'buf', this.docW, this.docH, false).canvas;
    this.strokeMasked = null;
    this.strokeBounds = null;
    this.strokeResidual = 0;
    this.lastMoveRect = null;
    const target = this.strokeBuf.getContext('2d')!;
    target.save();
    this.clipForPaint(target);
    this.stampDab(target, x, y, width, eraser);
    target.restore();
    this.lastMoveRect = this.dabRect(x, y, width);
    this.strokeBounds = this.lastMoveRect;
    this.refreshStrokePreview(layer, this.lastMoveRect);
    this.render(this.lastMoveRect);
  }

  private finishStabilizedStroke(): void {
    const d = this.draw;
    if ((d.tool !== 'pen' && d.tool !== 'eraser') || this.state.stabilizer <= 0) return;
    const layer = this.activeLayer();
    if (!layer) return;
    const eraser = d.tool === 'eraser';
    const target = this.strokeBuf?.getContext('2d') ?? null;
    if (!target) return;
    const width = this.dabWidth(d.pressure, d.isPen);
    for (let i = 0; i < 16; i++) {
      const dx = d.targetX - d.smoothX;
      const dy = d.targetY - d.smoothY;
      if (Math.hypot(dx, dy) < 0.5) break;
      d.smoothX += dx * 0.35;
      d.smoothY += dy * 0.35;
      const move = this.stampSegment(target, eraser, d.x, d.y, d.smoothX, d.smoothY, width);
      d.x = d.smoothX;
      d.y = d.smoothY;
      if (move) {
        this.refreshStrokePreview(layer, move);
        this.strokeBounds = this.unionRect(this.strokeBounds, move);
        this.render(move);
      }
    }
  }

  private beginShape(layer: Layer, x: number, y: number, width: number): void {
    this.draw.touched = true;
    this.strokeLayerId = layer.id;
    this.strokePreview = cloneCanvas(layer.canvas);
    this.strokeBuf = makeLayer('buf', 'buf', this.docW, this.docH, false).canvas;
    this.strokeMasked = null;
    this.strokeBounds = null;
    this.lastMoveRect = null;
    this.renderShape(layer, x, y, x, y, width);
  }

  private renderShape(
    layer: Layer, x0: number, y0: number, x1: number, y1: number, width: number,
  ): void {
    if (!this.strokeBuf) return;
    const buf = this.strokeBuf.getContext('2d')!;
    const prev = this.lastMoveRect;
    if (prev) {
      const p = this.clampRect(prev);
      buf.clearRect(p.x, p.y, p.w, p.h);
    }
    const pad = Math.max(width * 3, 8) + 2;
    const bounds = this.clampRect({
      x: Math.min(x0, x1) - pad,
      y: Math.min(y0, y1) - pad,
      w: Math.abs(x1 - x0) + pad * 2,
      h: Math.abs(y1 - y0) + pad * 2,
    });
    buf.save();
    this.clipForPaint(buf);
    this.drawShapeRaw(buf, this.draw.tool, x0, y0, x1, y1, width);
    buf.restore();
    this.lastMoveRect = bounds;
    this.strokeBounds = this.unionRect(this.strokeBounds, bounds);
    const dirty = prev ? this.unionRect(prev, bounds) : bounds;
    this.refreshStrokePreview(layer, dirty);
    this.render(dirty);
  }

  private endStroke(): void {
    if (this.strokeBounds && this.strokePreview && this.strokeLayerId) {
      const layer = this.layers.find((l) => l.id === this.strokeLayerId) ?? null;
      if (layer) {
        const bounds = this.strokeBounds;
        const before = this.captureTiles(layer.canvas, bounds);
        const lctx = layer.canvas.getContext('2d')!;
        lctx.clearRect(0, 0, layer.canvas.width, layer.canvas.height);
        lctx.drawImage(this.strokePreview, 0, 0);
        this.pushTileHistory(layer.id, before, bounds);
      }
    }
    this.strokePreview = null;
    this.strokeBuf = null;
    this.strokeMasked = null;
    this.strokeLayerId = '';
    this.strokeBounds = null;
    this.strokeResidual = 0;
    this.lastMoveRect = null;
  }

  pointerDown = (clientX: number, clientY: number, pressure: number, button: number, isPen: boolean): void => {
    if (button === 2) return;
    const p = this.toDoc(clientX, clientY);
    this.updateCursor(clientX, clientY, pressure);
    this.draw = {
      active: true,
      tool: this.state.tool,
      x: p.x,
      y: p.y,
      pressure,
      lastClientX: clientX,
      lastClientY: clientY,
      panning: false,
      touched: false,
      isPen,
      smoothX: p.x,
      smoothY: p.y,
      targetX: p.x,
      targetY: p.y,
    };
    if (this.space || button === 1) {
      this.draw.panning = true;
      return;
    }
    const layer = this.activeLayer();
    if (!layer) return;

    if (this.state.tool === 'selectRect' || this.state.tool === 'selectLasso') {
      this.selectionDown(p.x, p.y, this.state.tool);
      return;
    }

    if (this.state.tool === 'move') {
      const handle = this.hitTransformHandle(p.x, p.y);
      if (handle) {
        this.beginTransform(layer, handle, p.x, p.y);
      } else if (!this.selection || this.selectionContains(p.x, p.y)) {
        this.beginMove(layer, p.x, p.y);
      }
      return;
    }

    if (this.state.tool === 'pick') {
      const picked = this.sampleComposite(p.x, p.y);
      if (picked) this.setColor(picked);
      this.setStatus(picked ? '已取色' : '该位置为空');
      this.draw.active = false;
      return;
    }

    if (this.state.tool === 'fill') {
      const full = { x: 0, y: 0, w: this.docW, h: this.docH };
      const before = this.captureTiles(layer.canvas, full);
      const changed = this.floodFill(p.x, p.y);
      if (changed) {
        this.pushTileHistory(layer.id, before, full);
        this.markDirty('已填充');
      } else {
        this.setStatus('填充区域没有变化');
      }
      this.draw.active = false;
      return;
    }

    if (this.state.tool === 'pen' || this.state.tool === 'eraser') {
      this.beginStroke(layer, p.x, p.y, this.dabWidth(pressure, isPen), this.state.tool === 'eraser');
      return;
    }

    this.beginShape(layer, p.x, p.y, this.dabWidth(pressure, isPen));
  };

  pointerMove = (clientX: number, clientY: number, pressure: number, isPen: boolean, shiftKey = false): void => {
    this.updateCursor(clientX, clientY, pressure);
    const d = this.draw;
    if (!d.active) return;

    if (d.panning) {
      this.pan.x += clientX - d.lastClientX;
      this.pan.y += clientY - d.lastClientY;
      d.lastClientX = clientX;
      d.lastClientY = clientY;
      this.render();
      this.notifyView();
      return;
    }

    const layer = this.activeLayer();
    const ctx = layer?.canvas.getContext('2d') ?? null;
    if (!layer || !ctx) return;
    const p = this.toDoc(clientX, clientY);

    if (d.tool === 'selectRect' || d.tool === 'selectLasso') {
      this.selectionMove(p.x, p.y);
      return;
    }

    if (d.tool === 'move') {
      const m = this.moveState;
      if (!m) return;
      if (m.mode === 'move') this.moveTo(p.x, p.y);
      else this.transformTo(p.x, p.y, shiftKey);
      return;
    }

    if (d.tool === 'pen' || d.tool === 'eraser') {
      const eraser = d.tool === 'eraser';
      const target = this.strokeBuf?.getContext('2d') ?? null;
      if (!target) return;
      d.isPen = isPen;
      d.pressure = pressure;
      d.targetX = p.x;
      d.targetY = p.y;
      const factor = 1 - Math.min(0.95, this.state.stabilizer * 0.95);
      if (factor >= 1) {
        d.smoothX = p.x;
        d.smoothY = p.y;
      } else {
        d.smoothX += (p.x - d.smoothX) * factor;
        d.smoothY += (p.y - d.smoothY) * factor;
      }
      const move = this.stampSegment(target, eraser, d.x, d.y, d.smoothX, d.smoothY, this.dabWidth(pressure, isPen));
      d.x = d.smoothX;
      d.y = d.smoothY;
      if (move) {
        this.refreshStrokePreview(layer, move);
        this.strokeBounds = this.unionRect(this.strokeBounds, move);
        this.lastMoveRect = move;
        this.render(move);
      }
      return;
    }

    this.renderShape(layer, d.x, d.y, p.x, p.y, this.dabWidth(pressure, isPen));
  };

  pointerUp = (): void => {
    const d = this.draw;
    if (!d.active) return;
    if (d.tool === 'selectRect' || d.tool === 'selectLasso') {
      d.active = false;
      this.selectionUp();
      return;
    }
    if (d.tool === 'move') {
      d.active = false;
      this.endMove();
      return;
    }
    d.active = false;
    if (d.touched) {
      if (d.tool === 'pen' || d.tool === 'eraser') this.finishStabilizedStroke();
      if (d.tool !== 'fill' && d.tool !== 'pick') this.endStroke();
      this.revision += 1;
      this.syncLayers({ doc: { ...this.state.doc, dirty: true }, revision: this.revision });
      this.render();
      this.notifyView();
      this.scheduleAutosave();
    }
  };

  private markDirty(status?: string): void {
    this.revision += 1;
    this.syncLayers({ doc: { ...this.state.doc, dirty: true }, revision: this.revision });
    this.render();
    this.notifyView();
    this.scheduleAutosave();
    if (status) this.setStatus(status);
  }

  private drawShapeRaw(
    ctx: CanvasRenderingContext2D, t: Tool,
    x0: number, y0: number, x1: number, y1: number, width: number,
  ): void {
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    this.applyStroke(ctx, width);
    if (t === 'rect') {
      ctx.strokeRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
    } else if (t === 'ellipse') {
      ctx.beginPath();
      ctx.ellipse((x0 + x1) / 2, (y0 + y1) / 2, Math.abs(x1 - x0) / 2, Math.abs(y1 - y0) / 2, 0, 0, Math.PI * 2);
      ctx.stroke();
    } else if (t === 'line') {
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.stroke();
    } else if (t === 'arrow') {
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.stroke();
      const ang = Math.atan2(y1 - y0, x1 - x0);
      const head = Math.max(8, width * 3);
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x1 - head * Math.cos(ang - Math.PI / 7), y1 - head * Math.sin(ang - Math.PI / 7));
      ctx.moveTo(x1, y1);
      ctx.lineTo(x1 - head * Math.cos(ang + Math.PI / 7), y1 - head * Math.sin(ang + Math.PI / 7));
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  // ---------- 撤销 ----------
  private pushCommand(entry: HistoryEntry): void {
    this.undoStack.push(entry);
    if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
    this.redoStack = [];
  }

  private captureTiles(canvas: HTMLCanvasElement, rect: Rect): TileMap {
    const map: TileMap = new Map();
    const ctx = canvas.getContext('2d')!;
    const r = this.clampRect(rect);
    if (r.w <= 0 || r.h <= 0) return map;
    const tx0 = Math.floor(r.x / TILE);
    const ty0 = Math.floor(r.y / TILE);
    const tx1 = Math.ceil((r.x + r.w) / TILE);
    const ty1 = Math.ceil((r.y + r.h) / TILE);
    for (let ty = ty0; ty < ty1; ty++) {
      for (let tx = tx0; tx < tx1; tx++) {
        const px = tx * TILE;
        const py = ty * TILE;
        const w = Math.min(TILE, canvas.width - px);
        const h = Math.min(TILE, canvas.height - py);
        if (w <= 0 || h <= 0) continue;
        map.set(`${tx},${ty}`, ctx.getImageData(px, py, w, h));
      }
    }
    return map;
  }

  private captureCurrentTiles(layer: Layer, keys: TileMap): TileMap {
    const map: TileMap = new Map();
    const ctx = layer.canvas.getContext('2d')!;
    for (const key of keys.keys()) {
      const [tx, ty] = key.split(',').map(Number);
      const px = tx * TILE;
      const py = ty * TILE;
      const w = Math.min(TILE, layer.canvas.width - px);
      const h = Math.min(TILE, layer.canvas.height - py);
      if (w <= 0 || h <= 0) continue;
      map.set(key, ctx.getImageData(px, py, w, h));
    }
    return map;
  }

  private restoreTiles(layer: Layer, map: TileMap): void {
    const ctx = layer.canvas.getContext('2d')!;
    for (const [key, data] of map) {
      const [tx, ty] = key.split(',').map(Number);
      ctx.putImageData(data, tx * TILE, ty * TILE);
    }
  }

  private pushTileHistory(layerId: string, before: TileMap, bounds: Rect): void {
    this.pushCommand({ kind: 'tiles', layerId, before, bounds });
  }

  private moveIndex(from: number, to: number): void {
    if (from === to || from < 0 || to < 0 || from >= this.layers.length || to >= this.layers.length) return;
    const [layer] = this.layers.splice(from, 1);
    this.layers.splice(to, 0, layer);
  }

  private setActiveIfExists(id: string): void {
    this.activeId = this.layers.some((l) => l.id === id)
      ? id
      : this.layers[this.layers.length - 1]?.id ?? '';
  }

  private finishHistory(label: string): void {
    this.revision += 1;
    this.syncLayers({ doc: { ...this.state.doc, dirty: true }, revision: this.revision });
    this.render();
    this.notifyView();
    this.scheduleAutosave();
    this.setStatus(label);
  }

  undo = (): void => {
    if (this.draw.active) return;
    const entry = this.undoStack.pop();
    if (!entry) return;
    switch (entry.kind) {
      case 'tiles': {
        const layer = this.layers.find((l) => l.id === entry.layerId);
        if (layer) {
          entry.after = this.captureCurrentTiles(layer, entry.before);
          this.restoreTiles(layer, entry.before);
        }
        break;
      }
      case 'moveSelection': {
        const layer = this.layers.find((l) => l.id === entry.layerId);
        if (layer) {
          entry.after = this.captureCurrentTiles(layer, entry.before);
          this.restoreTiles(layer, entry.before);
        }
        this.applySelectionSnapshot(entry.selBefore);
        break;
      }
      case 'addLayer': {
        this.layers = this.layers.filter((l) => l !== entry.layer);
        this.setActiveIfExists(entry.activeBefore);
        break;
      }
      case 'deleteLayer': {
        if (!this.layers.includes(entry.layer)) {
          this.layers.splice(Math.min(entry.index, this.layers.length), 0, entry.layer);
        }
        this.setActiveIfExists(entry.activeBefore);
        break;
      }
      case 'moveLayer': {
        this.moveIndex(entry.to, entry.from);
        break;
      }
      case 'renameLayer': {
        const layer = this.layers.find((l) => l.id === entry.id);
        if (layer) layer.name = entry.before;
        break;
      }
      case 'setLayerBlend': {
        const layer = this.layers.find((l) => l.id === entry.id);
        if (layer) layer.blend = entry.before;
        break;
      }
      case 'mergeDown': {
        const below = this.layers.find((l) => l.id === entry.belowId);
        if (below) {
          const ctx = below.canvas.getContext('2d')!;
          ctx.clearRect(0, 0, below.canvas.width, below.canvas.height);
          ctx.drawImage(entry.belowBefore, 0, 0);
        }
        if (!this.layers.includes(entry.src)) {
          this.layers.splice(Math.min(entry.srcIndex, this.layers.length), 0, entry.src);
        }
        this.setActiveIfExists(entry.activeBefore);
        break;
      }
      default:
        break;
    }
    this.redoStack.push(entry);
    this.finishHistory('已撤销');
  };

  redo = (): void => {
    if (this.draw.active) return;
    const entry = this.redoStack.pop();
    if (!entry) return;
    switch (entry.kind) {
      case 'tiles': {
        const layer = this.layers.find((l) => l.id === entry.layerId);
        if (layer && entry.after) this.restoreTiles(layer, entry.after);
        break;
      }
      case 'moveSelection': {
        const layer = this.layers.find((l) => l.id === entry.layerId);
        if (layer && entry.after) this.restoreTiles(layer, entry.after);
        this.applySelectionSnapshot(entry.selAfter);
        break;
      }
      case 'addLayer': {
        if (!this.layers.includes(entry.layer)) {
          this.layers.splice(Math.min(entry.index, this.layers.length), 0, entry.layer);
        }
        this.setActiveIfExists(entry.activeAfter);
        break;
      }
      case 'deleteLayer': {
        this.layers = this.layers.filter((l) => l !== entry.layer);
        this.setActiveIfExists(entry.activeAfter);
        break;
      }
      case 'moveLayer': {
        this.moveIndex(entry.from, entry.to);
        break;
      }
      case 'renameLayer': {
        const layer = this.layers.find((l) => l.id === entry.id);
        if (layer) layer.name = entry.after;
        break;
      }
      case 'setLayerBlend': {
        const layer = this.layers.find((l) => l.id === entry.id);
        if (layer) layer.blend = entry.after;
        break;
      }
      case 'mergeDown': {
        const below = this.layers.find((l) => l.id === entry.belowId);
        if (below) {
          const ctx = below.canvas.getContext('2d')!;
          ctx.save();
          ctx.globalCompositeOperation = entry.src.blend;
          ctx.globalAlpha = entry.src.opacity;
          ctx.drawImage(entry.src.canvas, 0, 0);
          ctx.restore();
          this.layers = this.layers.filter((l) => l !== entry.src);
          this.setActiveIfExists(entry.activeAfter);
        }
        break;
      }
      default:
        break;
    }
    this.undoStack.push(entry);
    this.finishHistory('已重做');
  };

  // ---------- 工具 / 笔刷 / 颜色 ----------
  setTool = (tool: Tool): void => { this.emit({ tool }); };

  setColor = (color: string, target: ColorTarget = 'fg'): void => {
    if (target === 'bg') {
      this.emit({ bgColor: color });
      return;
    }
    const norm = color.toLowerCase();
    const recent = [norm, ...this.state.recentColors.filter((c) => c !== norm)].slice(0, RECENT_MAX);
    this.emit({ color: norm, recentColors: recent });
  };

  swapColors = (): void => {
    this.emit({ color: this.state.bgColor, bgColor: this.state.color });
  };

  setSize = (size: number): void => {
    const next = Math.max(1, Math.min(60, Math.round(size)));
    storeNum(LS.size, next);
    this.emit({ size: next });
  };

  setOpacity = (opacity: number): void => {
    const next = Math.max(0.05, Math.min(1, opacity));
    storeNum(LS.opacity, next);
    this.emit({ opacity: next });
  };

  setHardness = (hardness: number): void => {
    const next = Math.max(0, Math.min(1, hardness));
    storeNum(LS.hardness, next);
    this.emit({ hardness: next });
  };

  setFlow = (flow: number): void => {
    const next = Math.max(0.02, Math.min(1, flow));
    storeNum(LS.flow, next);
    this.emit({ flow: next });
  };

  setSpacing = (spacing: number): void => {
    const next = Math.max(0.05, Math.min(2, spacing));
    storeNum(LS.spacing, next);
    this.emit({ spacing: next });
  };

  setPressureCurve = (curve: number): void => {
    const next = Math.max(0.3, Math.min(2.5, curve));
    storeNum(LS.curve, next);
    if (this.state.pressureBezier) {
      storeJson(LS.bezier, null);
      this.emit({ pressureCurve: next, pressureBezier: null });
    } else {
      this.emit({ pressureCurve: next });
    }
  };

  /** 传入 null 回到 gamma 简单模式（UI 的「线性」预设即走这条） */
  setPressureBezier = (bezier: Bezier4 | null): void => {
    const next = bezier ? normalizeBezier(bezier) : null;
    storeJson(LS.bezier, next);
    this.emit({ pressureBezier: next });
  };

  setStabilizer = (stabilizer: number): void => {
    const next = Math.max(0, Math.min(1, stabilizer));
    storeNum(LS.stabilizer, next);
    this.emit({ stabilizer: next });
  };

  private persistPresets(presets: BrushPreset[]): void {
    storeJson(LS.presets, presets);
  }

  savePreset = (name: string): void => {
    const n = name.trim();
    if (!n) return;
    const preset: BrushPreset = {
      name: n,
      size: this.state.size,
      opacity: this.state.opacity,
      hardness: this.state.hardness,
      flow: this.state.flow,
      spacing: this.state.spacing,
      pressureCurve: this.state.pressureCurve,
      pressureBezier: this.state.pressureBezier,
      stabilizer: this.state.stabilizer,
    };
    const exists = this.state.presets.some((p) => p.name === n);
    const presets = exists
      ? this.state.presets.map((p) => (p.name === n ? preset : p))
      : [...this.state.presets, preset];
    this.persistPresets(presets);
    this.emit({ presets });
    this.setStatus(`已保存预设「${n}」`);
  };

  applyPreset = (name: string): void => {
    const p = this.state.presets.find((item) => item.name === name);
    if (!p) return;
    storeNum(LS.size, p.size);
    storeNum(LS.opacity, p.opacity);
    storeNum(LS.hardness, p.hardness);
    storeNum(LS.flow, p.flow);
    storeNum(LS.spacing, p.spacing);
    storeNum(LS.curve, p.pressureCurve);
    storeJson(LS.bezier, p.pressureBezier);
    storeNum(LS.stabilizer, p.stabilizer);
    this.emit({
      size: p.size,
      opacity: p.opacity,
      hardness: p.hardness,
      flow: p.flow,
      spacing: p.spacing,
      pressureCurve: p.pressureCurve,
      pressureBezier: p.pressureBezier,
      stabilizer: p.stabilizer,
    });
    this.setStatus(`已应用预设「${name}」`);
  };

  deletePreset = (name: string): void => {
    const presets = this.state.presets.filter((p) => p.name !== name);
    if (presets.length === this.state.presets.length) return;
    this.persistPresets(presets);
    this.emit({ presets });
    this.setStatus(`已删除预设「${name}」`);
  };

  setTransparent = (transparent: boolean): void => { this.emit({ transparent }); };

  setColorMode = (colorMode: ColorMode): void => { this.emit({ colorMode }); };

  // ---------- 图层 ----------
  private touchAndRender(status?: string): void {
    this.revision += 1;
    this.syncLayers({ doc: { ...this.state.doc, dirty: true }, revision: this.revision });
    this.render();
    this.notifyView();
    this.scheduleAutosave();
    if (status) this.setStatus(status);
  }

  addLayer = (): void => {
    const activeBefore = this.activeId;
    const layer = makeLayer('L' + Date.now().toString(36), `图层 ${this.layers.length + 1}`, this.docW, this.docH, false);
    const index = this.layers.length;
    this.layers.push(layer);
    this.activeId = layer.id;
    this.pushCommand({ kind: 'addLayer', layer, index, activeBefore, activeAfter: layer.id });
    this.touchAndRender('已新建图层');
  };

  deleteLayer = (id: string): void => {
    if (this.layers.length <= 1) { this.setStatus('至少保留一个图层'); return; }
    const index = this.layers.findIndex((l) => l.id === id);
    if (index < 0) return;
    const layer = this.layers[index];
    const activeBefore = this.activeId;
    this.layers.splice(index, 1);
    if (this.activeId === id) this.activeId = this.layers[this.layers.length - 1].id;
    this.pushCommand({ kind: 'deleteLayer', layer, index, activeBefore, activeAfter: this.activeId });
    this.touchAndRender('已删除图层');
  };

  toggleVisible = (id: string): void => {
    const layer = this.layers.find((l) => l.id === id);
    if (!layer) return;
    layer.visible = !layer.visible;
    this.touchAndRender();
  };

  setLayerOpacity = (id: string, opacity: number): void => {
    const layer = this.layers.find((l) => l.id === id);
    if (!layer) return;
    layer.opacity = Math.max(0, Math.min(1, opacity));
    this.touchAndRender();
  };

  setLayerBlend = (id: string, blend: BlendMode): void => {
    const layer = this.layers.find((l) => l.id === id);
    if (!layer || layer.blend === blend) return;
    const before = layer.blend;
    layer.blend = blend;
    this.pushCommand({ kind: 'setLayerBlend', id, before, after: blend });
    this.touchAndRender('已切换混合模式');
  };

  selectLayer = (id: string): void => {
    if (!this.layers.some((l) => l.id === id)) return;
    this.activeId = id;
    this.syncLayers();
  };

  moveLayer = (id: string, dir: -1 | 1): void => {
    const i = this.layers.findIndex((l) => l.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= this.layers.length) return;
    this.moveIndex(i, j);
    this.pushCommand({ kind: 'moveLayer', from: i, to: j });
    this.touchAndRender();
  };

  renameLayer = (id: string, name: string): void => {
    const layer = this.layers.find((l) => l.id === id);
    const next = name.trim();
    if (!layer || !next || next === layer.name) return;
    const before = layer.name;
    layer.name = next;
    this.pushCommand({ kind: 'renameLayer', id, before, after: next });
    this.touchAndRender();
  };

  duplicateLayer = (id: string): void => {
    const i = this.layers.findIndex((l) => l.id === id);
    if (i < 0) return;
    const src = this.layers[i];
    const activeBefore = this.activeId;
    const copy = makeLayer('L' + Date.now().toString(36), `${src.name} 副本`, this.docW, this.docH, false);
    copy.canvas.getContext('2d')!.drawImage(src.canvas, 0, 0);
    copy.opacity = src.opacity;
    copy.visible = src.visible;
    copy.blend = src.blend;
    const index = i + 1;
    this.layers.splice(index, 0, copy);
    this.activeId = copy.id;
    this.pushCommand({ kind: 'addLayer', layer: copy, index, activeBefore, activeAfter: copy.id });
    this.touchAndRender('已复制图层');
  };

  mergeDown = (id: string): void => {
    const i = this.layers.findIndex((l) => l.id === id);
    if (i <= 0) { this.setStatus('下方没有可合并的图层'); return; }
    const src = this.layers[i];
    const below = this.layers[i - 1];
    if (!src.visible) { this.setStatus('隐藏图层无法向下合并'); return; }
    const activeBefore = this.activeId;
    const belowBefore = cloneCanvas(below.canvas);
    const ctx = below.canvas.getContext('2d')!;
    ctx.save();
    ctx.globalCompositeOperation = src.blend;
    ctx.globalAlpha = src.opacity;
    ctx.drawImage(src.canvas, 0, 0);
    ctx.restore();
    this.layers.splice(i, 1);
    this.activeId = below.id;
    this.pushCommand({
      kind: 'mergeDown',
      src,
      srcIndex: i,
      belowId: below.id,
      belowBefore,
      activeBefore,
      activeAfter: below.id,
    });
    this.touchAndRender('已向下合并');
  };

  clearLayer = (): void => {
    const layer = this.activeLayer();
    if (!layer) return;
    const full = { x: 0, y: 0, w: this.docW, h: this.docH };
    const before = this.captureTiles(layer.canvas, full);
    layer.canvas.getContext('2d')!.clearRect(0, 0, layer.canvas.width, layer.canvas.height);
    this.pushTileHistory(layer.id, before, full);
    this.touchAndRender('已清空当前图层');
  };

  getLayerCanvas = (id: string): HTMLCanvasElement | null => {
    return this.layers.find((l) => l.id === id)?.canvas ?? null;
  };

  // ---------- 取色 / 填充 ----------
  private sampleComposite(x: number, y: number): string | null {
    const px = Math.floor(x);
    const py = Math.floor(y);
    if (px < 0 || py < 0 || px >= this.docW || py >= this.docH) return null;
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const ctx = canvas.getContext('2d')!;
    for (const layer of this.layers) {
      if (!layer.visible) continue;
      ctx.globalCompositeOperation = layer.blend;
      ctx.globalAlpha = layer.opacity;
      ctx.drawImage(layer.canvas, -px, -py);
    }
    ctx.globalCompositeOperation = 'source-over';
    const data = ctx.getImageData(0, 0, 1, 1).data;
    if (data[3] === 0) return null;
    return rgbToHex(data[0], data[1], data[2]);
  }

  private floodFill(cx: number, cy: number): boolean {
    const layer = this.activeLayer();
    if (!layer) return false;
    const w = layer.canvas.width;
    const h = layer.canvas.height;
    const ctx = layer.canvas.getContext('2d')!;
    const img = ctx.getImageData(0, 0, w, h);
    const d = img.data;
    const x0 = Math.floor(cx);
    const y0 = Math.floor(cy);
    if (x0 < 0 || y0 < 0 || x0 >= w || y0 >= h) return false;
    if (!this.selectionContains(x0 + 0.5, y0 + 0.5)) return false;
    const idx = (y0 * w + x0) * 4;
    const tr = d[idx], tg = d[idx + 1], tb = d[idx + 2], ta = d[idx + 3];
    const [fr, fg, fb] = hexToRgb(this.state.color);
    const fa = Math.round(this.state.opacity * 255);
    if (tr === fr && tg === fg && tb === fb && ta === fa) return false;
    const match = (i: number): boolean => d[i] === tr && d[i + 1] === tg && d[i + 2] === tb && d[i + 3] === ta;
    const stack: number[] = [idx];
    let painted = 0;
    while (stack.length) {
      const p = stack.pop()!;
      if (!match(p)) continue;
      const px = (p / 4) % w;
      const py = Math.floor(p / 4 / w);
      if (!this.selectionContains(px + 0.5, py + 0.5)) continue;
      d[p] = fr; d[p + 1] = fg; d[p + 2] = fb; d[p + 3] = fa;
      painted += 1;
      if (px > 0) stack.push(p - 4);
      if (px < w - 1) stack.push(p + 4);
      if (py > 0) stack.push(p - w * 4);
      if (py < h - 1) stack.push(p + w * 4);
    }
    if (!painted) return false;
    ctx.putImageData(img, 0, 0);
    return true;
  }

  // ---------- 导入 / 导出 ----------
  importImage = (): void => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const img = new Image();
        img.onload = () => {
          const scale = Math.min(1, this.docW / img.width, this.docH / img.height);
          const dw = Math.max(1, Math.round(img.width * scale));
          const dh = Math.max(1, Math.round(img.height * scale));
          const layer = makeLayer('L' + Date.now().toString(36), file.name.slice(0, 16) || '图片', this.docW, this.docH, false);
          const ctx = layer.canvas.getContext('2d')!;
          ctx.drawImage(img, (this.docW - dw) / 2, (this.docH - dh) / 2, dw, dh);
          const activeBefore = this.activeId;
          const index = this.layers.length;
          this.layers.push(layer);
          this.activeId = layer.id;
          this.pushCommand({ kind: 'addLayer', layer, index, activeBefore, activeAfter: layer.id });
          this.touchAndRender('已导入图片为图层');
        };
        img.src = reader.result as string;
      };
      reader.readAsDataURL(file);
    };
    input.click();
  };

  exportImg = async (fmt: 'png' | 'jpeg'): Promise<void> => {
    const ex = document.createElement('canvas');
    ex.width = this.docW;
    ex.height = this.docH;
    const ctx = ex.getContext('2d')!;
    const transparent = fmt === 'png' && this.state.transparent;
    if (!transparent) {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, ex.width, ex.height);
    }
    for (const layer of this.layers) {
      if (!layer.visible) continue;
      ctx.globalCompositeOperation = layer.blend;
      ctx.globalAlpha = layer.opacity;
      ctx.drawImage(layer.canvas, 0, 0);
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    const url = ex.toDataURL(fmt === 'png' ? 'image/png' : 'image/jpeg', 0.92);
    // 宿主的剪贴板把收到的字节原样挂到注册名为 "PNG" 的格式上，因此剪贴板那一路只能给 PNG
    const clipUrl = fmt === 'png' ? url : ex.toDataURL('image/png');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const name = `绘画_${stamp}.${fmt === 'png' ? 'png' : 'jpg'}`;
    try {
      await window.__HOST_API__.invoke('clipboard_write_image', { base64Png: clipUrl });
      await window.__HOST_API__.invoke('add_bytes_to_dropzone', { base64: url, originalName: name });
      this.setStatus(`已导出 ${fmt.toUpperCase()}${transparent ? '（透明）' : ''} 并存入中转站`);
    } catch (err) {
      this.setStatus('导出失败：' + (err as Error).message);
    }
  };

  // ---------- 项目 / 自动保存 ----------
  private canvasToPng(canvas: HTMLCanvasElement): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (!blob) {
          reject(new Error('PNG 编码失败'));
          return;
        }
        void blob.arrayBuffer().then(
          (buf) => resolve(new Uint8Array(buf)),
          (err) => reject(err),
        );
      }, 'image/png');
    });
  }

  private async projectToBinary(): Promise<ArrayBuffer> {
    const layerList = this.layers.slice();
    const doc = { w: this.docW, h: this.docH, name: this.state.doc.name };
    const activeId = this.activeId;
    const blobs: Uint8Array[] = [];
    const metas: HuihuaProjectV2Layer[] = [];
    let offset = 0;
    for (const l of layerList) {
      const png = await this.canvasToPng(l.canvas);
      metas.push({
        id: l.id,
        name: l.name,
        visible: l.visible,
        opacity: l.opacity,
        blend: l.blend,
        offset,
        length: png.length,
      });
      blobs.push(png);
      offset += png.length;
    }
    const header: HuihuaProjectV2 = {
      format: 'huihua-project-binary',
      version: 2,
      doc,
      activeId,
      layers: metas,
      savedAt: Date.now(),
    };
    const headerBytes = new TextEncoder().encode(JSON.stringify(header));
    const total = PROJECT_HEADER_OFFSET + headerBytes.length + offset;
    const out = new Uint8Array(total);
    out.set(new TextEncoder().encode(PROJECT_MAGIC), 0);
    new DataView(out.buffer).setUint32(8, headerBytes.length, true);
    out.set(headerBytes, PROJECT_HEADER_OFFSET);
    let p = PROJECT_HEADER_OFFSET + headerBytes.length;
    for (const b of blobs) {
      out.set(b, p);
      p += b.length;
    }
    return out.buffer;
  }

  private scheduleAutosave(): void {
    if (!this.state.ready || this.layers.length === 0) return;
    if (this.autosaveTimer) window.clearTimeout(this.autosaveTimer);
    this.autosaveTimer = window.setTimeout(() => {
      this.autosaveTimer = 0;
      void this.saveAutosaveNow();
    }, 1800);
  }

  private async saveAutosaveNow(): Promise<void> {
    if (this.autosaveBusy || !this.state.ready || this.layers.length === 0) return;
    this.autosaveBusy = true;
    try {
      const bytes = await this.projectToBinary();
      await saveAutosave(bytes);
    } catch {
      /* 自动保存失败不打断绘制 */
    } finally {
      this.autosaveBusy = false;
    }
  }

  private async tryRestoreAutosave(): Promise<void> {
    if (this.restoreAttempted) return;
    this.restoreAttempted = true;
    if (!this.state.ready || this.state.doc.dirty || this.undoStack.length > 0) return;
    const buf = await loadAutosave();
    if (!buf) return;
    if (this.state.doc.dirty || this.undoStack.length > 0) return;
    try {
      await this.loadProjectBytes(new Uint8Array(buf));
      this.setStatus('已恢复自动保存');
    } catch {
      this.setStatus('自动保存恢复失败');
    }
  }

  private normalizeBlend(blend: unknown): BlendMode {
    return BLEND_MODES.some((m) => m.id === blend) ? (blend as BlendMode) : 'source-over';
  }

  private applyLoadedProject(w: number, h: number, name: string, activeId: string, layers: Layer[]): void {
    this.docW = w;
    this.docH = h;
    this.layers = layers;
    this.activeId = layers.some((l) => l.id === activeId) ? activeId : layers[layers.length - 1].id;
    this.pan = { x: 0, y: 0 };
    this.undoStack = [];
    this.redoStack = [];
    this.revision += 1;
    this.selection = null;
    this.selectionDraft = null;
    this.moveState = null;
    this.selectionVersion += 1;
    this.emit({
      ready: true,
      doc: { w, h, name: (name || '未命名').trim() || '未命名', dirty: false },
      layers: this.layerMeta(),
      activeId: this.activeId,
      zoom: 1,
      canUndo: false,
      canRedo: false,
      revision: this.revision,
      selectionVersion: this.selectionVersion,
      hasSelection: false,
      selectionW: 0,
      selectionH: 0,
      contextMenu: null,
    });
    this.render();
    this.notifyView();
  }

  private validateDocSize(p: { w?: unknown; h?: unknown }): { w: number; h: number } {
    const w = Math.floor(Number(p.w));
    const h = Math.floor(Number(p.h));
    if (!Number.isFinite(w) || !Number.isFinite(h) || w < 1 || h < 1 || w > 8192 || h > 8192) {
      throw new Error('画布尺寸不支持');
    }
    return { w, h };
  }

  private async loadProjectJson(json: string): Promise<void> {
    const p = JSON.parse(json.replace(/^\uFEFF/, '')) as HuihuaProject;
    if (!p || p.format !== 'huihua-project' || p.version !== 1) {
      throw new Error('不是有效的绘画项目');
    }
    const { w, h } = this.validateDocSize(p.doc ?? {});
    if (!Array.isArray(p.layers) || p.layers.length === 0) {
      throw new Error('项目中没有图层');
    }
    const layers: Layer[] = [];
    for (let i = 0; i < p.layers.length; i++) {
      const src = p.layers[i];
      if (!src || typeof src.dataUrl !== 'string') throw new Error('图层数据损坏');
      const img = await loadImage(src.dataUrl);
      const layer = makeLayer(src.id || `L${Date.now().toString(36)}${i}`, src.name || `图层 ${i + 1}`, w, h, false);
      layer.canvas.getContext('2d')!.drawImage(img, 0, 0, w, h);
      layer.visible = src.visible !== false;
      const opacity = Number(src.opacity);
      layer.opacity = Number.isFinite(opacity) ? Math.max(0, Math.min(1, opacity)) : 1;
      layer.blend = this.normalizeBlend(src.blend);
      layers.push(layer);
    }
    this.applyLoadedProject(w, h, p.doc?.name || '未命名', p.activeId, layers);
  }

  private async loadProjectBinary(bytes: Uint8Array): Promise<void> {
    if (bytes.length < PROJECT_HEADER_OFFSET) throw new Error('项目文件过短');
    const magic = new TextDecoder().decode(bytes.subarray(0, 8));
    if (magic !== PROJECT_MAGIC) throw new Error('不是有效的绘画项目');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const headerLen = view.getUint32(8, true);
    const headerEnd = PROJECT_HEADER_OFFSET + headerLen;
    if (headerLen <= 0 || headerEnd > bytes.length) throw new Error('项目头损坏');
    const header = JSON.parse(new TextDecoder().decode(bytes.subarray(PROJECT_HEADER_OFFSET, headerEnd))) as HuihuaProjectV2;
    if (!header || header.format !== 'huihua-project-binary' || header.version !== 2) {
      throw new Error('项目版本不支持');
    }
    const { w, h } = this.validateDocSize(header.doc ?? {});
    if (!Array.isArray(header.layers) || header.layers.length === 0) {
      throw new Error('项目中没有图层');
    }
    const layers: Layer[] = [];
    for (let i = 0; i < header.layers.length; i++) {
      const meta = header.layers[i];
      const start = headerEnd + meta.offset;
      const end = start + meta.length;
      if (!Number.isFinite(start) || !Number.isFinite(end) || start < headerEnd || end > bytes.length || end <= start) {
        throw new Error('图层数据损坏');
      }
      const blob = new Blob([bytes.slice(start, end)], { type: 'image/png' });
      let source: CanvasImageSource;
      let bitmap: ImageBitmap | null = null;
      if (typeof createImageBitmap === 'function') {
        bitmap = await createImageBitmap(blob);
        source = bitmap;
      } else {
        const url = URL.createObjectURL(blob);
        source = await new Promise<HTMLImageElement>((resolve, reject) => {
          const img = new Image();
          img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
          img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('图层图片解码失败')); };
          img.src = url;
        });
      }
      const layer = makeLayer(
        meta.id || `L${Date.now().toString(36)}${i}`,
        meta.name || `图层 ${i + 1}`,
        w,
        h,
        false,
      );
      layer.canvas.getContext('2d')!.drawImage(source, 0, 0, w, h);
      if (bitmap) bitmap.close();
      layer.visible = meta.visible !== false;
      const opacity = Number(meta.opacity);
      layer.opacity = Number.isFinite(opacity) ? Math.max(0, Math.min(1, opacity)) : 1;
      layer.blend = this.normalizeBlend(meta.blend);
      layers.push(layer);
    }
    this.applyLoadedProject(w, h, header.doc?.name || '未命名', header.activeId, layers);
  }

  private async loadProjectBytes(bytes: Uint8Array): Promise<void> {
    if (bytes.length >= 8 && new TextDecoder().decode(bytes.subarray(0, 8)) === PROJECT_MAGIC) {
      await this.loadProjectBinary(bytes);
      return;
    }
    await this.loadProjectJson(new TextDecoder().decode(bytes));
  }

  saveProject = async (): Promise<void> => {
    if (!this.state.ready) return;
    const safe = (this.state.doc.name || '未命名').replace(/[\\/:*?"<>|]/g, '_').trim() || '未命名';
    try {
      const picked = await window.__HOST_API__.invoke<string | null>('pick_save_file', {
        defaultName: `${safe}.huihua`,
      });
      if (!picked) return;
      const target = /\.[^\\/]+$/.test(picked) ? picked : `${picked}.huihua`;
      this.setStatus('正在保存…');
      const bytes = await this.projectToBinary();
      await window.__HOST_API__.invoke('write_file_bytes', {
        path: target,
        contentBase64: bytesToBase64(new Uint8Array(bytes)),
      });
      this.emit({ doc: { ...this.state.doc, dirty: false } });
      this.setStatus('已保存：' + target);
    } catch (err) {
      this.setStatus('保存失败：' + (err as Error).message);
    }
  };

  openProject = async (): Promise<void> => {
    if (this.state.doc.dirty && !window.confirm('当前画布有未保存修改，确定打开其他项目吗？')) return;
    try {
      const files = await window.__HOST_API__.invoke<string[]>('pick_file', {
        title: '打开绘画项目',
        multiple: false,
        filters: [{ name: '绘画项目', extensions: ['huihua', 'json'] }],
      });
      if (!files || files.length === 0) return;
      const dataUrl = await window.__HOST_API__.invoke<string>('read_file_base64', { filePath: files[0] });
      await this.loadProjectBytes(base64ToBytes(dataUrl));
      this.restoreAttempted = true;
      this.setStatus('已打开：' + files[0]);
      this.scheduleAutosave();
    } catch (err) {
      this.setStatus('打开失败：' + (err as Error).message);
    }
  };

  renameDocument = (name: string): void => {
    const next = name.trim();
    if (!next || next === this.state.doc.name) return;
    this.emit({ doc: { ...this.state.doc, name: next } });
    this.scheduleAutosave();
  };

  // ---------- 导航 / 缩略图 ----------
  drawCompositeTo(canvas: HTMLCanvasElement, width: number, height: number): void {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const scale = Math.min(width / this.docW, height / this.docH);
    const ox = (width - this.docW * scale) / 2;
    const oy = (height - this.docH * scale) / 2;
    ctx.save();
    ctx.translate(ox, oy);
    ctx.scale(scale, scale);
    for (const layer of this.layers) {
      if (!layer.visible) continue;
      ctx.globalCompositeOperation = layer.blend;
      ctx.globalAlpha = layer.opacity;
      ctx.drawImage(layer.canvas, 0, 0);
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.restore();
  }

  getMemoryMb(): number {
    const perLayer = this.docW * this.docH * 4;
    const canvases = new Set<HTMLCanvasElement>();
    for (const layer of this.layers) canvases.add(layer.canvas);
    let tileBytes = 0;
    for (const entry of [...this.undoStack, ...this.redoStack]) {
      if (entry.kind === 'tiles' || entry.kind === 'moveSelection') {
        for (const data of entry.before.values()) tileBytes += data.data.byteLength;
        if (entry.after) {
          for (const data of entry.after.values()) tileBytes += data.data.byteLength;
        }
      } else if (entry.kind === 'addLayer' || entry.kind === 'deleteLayer') {
        canvases.add(entry.layer.canvas);
      } else if (entry.kind === 'mergeDown') {
        canvases.add(entry.belowBefore);
        canvases.add(entry.src.canvas);
      }
    }
    return (canvases.size * perLayer + tileBytes) / (1024 * 1024);
  }

  // ---------- 面板 / 菜单 ----------
  setRightDockWidth = (width: number): void => {
    const w = Math.max(DOCK_MIN, Math.min(DOCK_MAX, Math.round(width)));
    storeNum(LS.dockWidth, w);
    this.emit({ rightDockWidth: w });
  };

  toggleRightDock = (): void => {
    const collapsed = !this.state.rightDockCollapsed;
    storeBool(LS.dockCollapsed, collapsed);
    this.emit({ rightDockCollapsed: collapsed });
  };

  toggleQuickbar = (): void => {
    const visible = !this.state.quickbarVisible;
    storeBool(LS.quickbar, visible);
    this.emit({ quickbarVisible: visible });
  };

  toggleChrome = (): void => { this.emit({ chromeVisible: !this.state.chromeVisible }); };

  openContextMenu = (x: number, y: number): void => { this.emit({ contextMenu: { x, y } }); };

  closeContextMenu = (): void => { if (this.state.contextMenu) this.emit({ contextMenu: null }); };
}

export const editor = new EditorStore();
