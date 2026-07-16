// <reference path="../../global.d.ts" />
// 茑萝 · 绘画 子插件（专业画板）
// 功能（不引第三方库，纯 Canvas）：
//  图层（增删/选层/显隐/透明度/排序）、画笔（压感·硬度·透明度）、橡皮、
//  形状（矩形·椭圆·直线·箭头）、油漆桶填充、吸管取色、
//  图片导入为图层、导出 PNG/JPEG/透明（带缩放）、画布缩放与平移、多步撤销重做。
// 布局参考 SAI2（左「图层」子目录导航 / 中画布 / 右工具+调色板），采用现代 UI 风格。
const React = window.__HOST_REACT__;
const hostApi = window.__HOST_API__;
const { useState, useEffect, useRef, useCallback } = React;

// 调色板：基础 + SAI 风格常用色（6 列网格）
const PALETTE = [
  '#000000', '#434343', '#838383', '#bcbcbc', '#ffffff', '#f5f5f0',
  '#7f7f7f', '#9d3a3a', '#ed1c24', '#ff7f27', '#fff200', '#22b14c',
  '#00a2e8', '#3f48cc', '#a349a9', '#b97a57', '#ffaec9', '#ffc90e',
  '#efe4b0', '#b5e61d', '#99d9ea', '#7092be', '#c8bfe7', '#6d3d1b',
  '#1c1917', '#451f1e', '#7d1d1d', '#cc4e3c', '#e8a0a0', '#f6c6c6',
];
type Tool = 'pen' | 'eraser' | 'rect' | 'ellipse' | 'line' | 'arrow' | 'fill' | 'pick';
type ColorMode = 'wheel' | 'rgb' | 'hsv' | 'palette';
const UNDO_LIMIT = 20;
const RECENT_MAX = 10;

// ============ 颜色空间转换工具（hex / rgb / hsv）============
function clamp255(v: number) { return Math.max(0, Math.min(255, Math.round(v))); }
function hexToRgb(hex: string): [number, number, number] {
  const m = hex.replace('#', '');
  return [parseInt(m.slice(0, 2), 16), parseInt(m.slice(2, 4), 16), parseInt(m.slice(4, 6), 16)];
}
function rgbToHex(r: number, g: number, b: number): string {
  return '#' + [clamp255(r), clamp255(g), clamp255(b)].map((v) => v.toString(16).padStart(2, '0')).join('');
}
function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const d = max - min;
  const v = max;
  const s = max === 0 ? 0 : d / max;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return [h, s * 100, v * 100];
}
function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  h = ((h % 360) + 360) % 360;
  s = Math.max(0, Math.min(100, s)) / 100;
  v = Math.max(0, Math.min(100, v)) / 100;
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let r = 0, g = 0, b = 0;
  if (h < 60) { r = c; g = x; b = 0; }
  else if (h < 120) { r = x; g = c; b = 0; }
  else if (h < 180) { r = 0; g = c; b = x; }
  else if (h < 240) { r = 0; g = x; b = c; }
  else if (h < 300) { r = x; g = 0; b = c; }
  else { r = c; g = 0; b = x; }
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}

interface Layer {
  id: string;
  name: string;
  visible: boolean;
  opacity: number;
  canvas: HTMLCanvasElement;
}

function makeLayer(id: string, name: string, w: number, h: number, white: boolean): Layer {
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  if (white) { ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, w, h); }
  return { id, name, visible: true, opacity: 1, canvas };
}

// ============ 跨组件共享：画布(HuihuaBoard) 与左侧「图层」子目录(HuihuaSidebar) 共用同一份图层状态 ============
// 画布在挂载时把真实图层操作注册进 layerOps，并每次变更后调用 publishLayers()；
// 侧栏订阅 layerSnapshot，渲染「图层」列表，操作回调转发给画布执行。
let layerSnapshot = { layers: [] as { id: string; name: string; visible: boolean; opacity: number }[], activeId: '' };
const layerListeners = new Set<() => void>();
const layerOps: {
  add: () => void;
  del: (id: string) => void;
  toggle: (id: string) => void;
  setOpacity: (id: string, v: number) => void;
  select: (id: string) => void;
  move: (id: string, dir: -1 | 1) => void;
  clear: () => void;
} = {
  add: () => {}, del: () => {}, toggle: () => {}, setOpacity: () => {}, select: () => {}, move: () => {}, clear: () => {},
};

function publishLayers(layers: Layer[], activeId: string) {
  layerSnapshot = {
    layers: layers.map((l) => ({ id: l.id, name: l.name, visible: l.visible, opacity: l.opacity })),
    activeId,
  };
  layerListeners.forEach((fn) => fn());
}

// ============ 跨组件共享：工具/调色板/笔刷状态（画布与侧栏共用）============
let toolSnapshot = {
  tool: 'pen' as Tool, color: '#111827', size: 4, opacity: 1, hardness: 1,
  zoom: 1, transparent: false, canUndo: false, canRedo: false,
  status: '图层化画板：选择工具开始绘制',
  recentColors: [] as string[],   // 最近使用色（去重 + LIFO，最多 10）
  colorMode: 'wheel' as ColorMode, // 当前颜色模式 tab
};
const toolListeners = new Set<() => void>();
function publishTools(partial: Partial<typeof toolSnapshot>) {
  Object.assign(toolSnapshot, partial);
  toolListeners.forEach((fn) => fn());
}
// 把 hex 推入最近使用（去重 + 最新在前，最多 10）
function pushRecentColor(hex: string) {
  const norm = hex.toLowerCase();
  const cur = toolSnapshot.recentColors;
  const next = [norm, ...cur.filter((c) => c !== norm)].slice(0, RECENT_MAX);
  if (next.length !== cur.length || next.some((c, i) => c !== cur[i])) {
    publishTools({ recentColors: next });
  }
}
// 由画布在挂载时注册；侧栏调用这些来修改绘图参数
const toolOps = {
  setTool: (_t: Tool) => {},
  setColor: (_c: string) => {},
  setSize: (_s: number) => {},
  setOpacity: (_v: number) => {},
  setHardness: (_h: number) => {},
  setTransparent: (_v: boolean) => {},
  undo: () => {},
  redo: () => {},
  fitView: () => {},
  exportPng: () => {},
  exportJpeg: () => {},
  importImage: () => {},
  clearLayer: () => {},
  addLayer: () => {},
};

// 工具定义（模块级，画布与侧边栏共用）
const TOOLS: { id: Tool; label: string }[] = [
  { id: 'pen', label: '画笔' },
  { id: 'eraser', label: '橡皮' },
  { id: 'rect', label: '矩形' },
  { id: 'ellipse', label: '椭圆' },
  { id: 'line', label: '直线' },
  { id: 'arrow', label: '箭头' },
  { id: 'fill', label: '填充' },
  { id: 'pick', label: '吸管' },
];

function HuihuaBoard() {
  const displayRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const dctxRef = useRef<CanvasRenderingContext2D | null>(null);

  const [tool, setTool] = useState<Tool>('pen');
  const [color, setColor] = useState<string>('#111827');
  const [size, setSize] = useState<number>(4);
  const [opacity, setOpacity] = useState<number>(1);
  const [hardness, setHardness] = useState<number>(1);
  const [zoom, setZoom] = useState<number>(1);
  const [status, setStatus] = useState<string>('图层化画板：选择工具开始绘制');
  const [canUndo, setCanUndo] = useState<boolean>(false);
  const [canRedo, setCanRedo] = useState<boolean>(false);
  const [transparent, setTransparent] = useState<boolean>(false);
  const [, force] = useState<number>(0);
  const refresh = useCallback(() => force((n) => n + 1), []);

  const docRef = useRef<{ w: number; h: number }>({ w: 1, h: 1 });
  const layersRef = useRef<Layer[]>([]);
  const activeIdRef = useRef<string>('');
  const panRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const drawRef = useRef<{ active: boolean; x: number; y: number; pressure: number; space: boolean }>(
    { active: false, x: 0, y: 0, pressure: 0, space: false },
  );
  const baseRef = useRef<ImageData | null>(null);
  const layerSnapRef = useRef<HTMLCanvasElement | null>(null);
  const undoRef = useRef<Layer[][]>([]);
  const redoRef = useRef<Layer[][]>([]);

  const dpr = window.devicePixelRatio || 1;

  // ---- 合成渲染 ----
  const render = useCallback(() => {
    const c = displayRef.current;
    const ctx = dctxRef.current;
    if (!c || !ctx) return;
    const DW = c.clientWidth, DH = c.clientHeight;
    if (c.width !== DW * dpr || c.height !== DH * dpr) { c.width = DW * dpr; c.height = DH * dpr; }
    const { x: px, y: py } = panRef.current;
    const z = zoom;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, DW, DH);
    ctx.save();
    ctx.translate(px, py);
    ctx.scale(z, z);
    for (const l of layersRef.current) {
      if (!l.visible) continue;
      ctx.globalAlpha = l.opacity;
      ctx.drawImage(l.canvas, 0, 0);
    }
    ctx.restore();
    ctx.globalAlpha = 1;
  }, [zoom]);

  // ---- 坐标换算：屏幕(CSS px) → 文档像素 ----
  const toDoc = useCallback((clientX: number, clientY: number) => {
    const c = displayRef.current!;
    const rect = c.getBoundingClientRect();
    const sx = clientX - rect.left;
    const sy = clientY - rect.top;
    const { x: px, y: py } = panRef.current;
    return { x: (sx - px) / zoom, y: (sy - py) / zoom };
  }, [zoom]);

  const activeLayer = (): Layer | null => layersRef.current.find((l) => l.id === activeIdRef.current) || null;
  const activeCtx = (): CanvasRenderingContext2D | null => {
    const l = activeLayer();
    return l ? l.canvas.getContext('2d') : null;
  };

  // ---- 撤销/重做（整图快照克隆）----
  const cloneLayers = (): Layer[] => layersRef.current.map((l) => ({
    ...l,
    canvas: (() => { const n = document.createElement('canvas'); n.width = l.canvas.width; n.height = l.canvas.height; n.getContext('2d')!.drawImage(l.canvas, 0, 0); return n; })(),
  }));
  const pushUndo = useCallback(() => {
    undoRef.current.push(cloneLayers());
    if (undoRef.current.length > UNDO_LIMIT) undoRef.current.shift();
    redoRef.current = [];
    setCanUndo(undoRef.current.length > 1);
    setCanRedo(false);
  }, []);
  const applyLayers = (snap: Layer[]) => {
    layersRef.current = snap.map((l) => ({
      ...l,
      canvas: (() => { const n = document.createElement('canvas'); n.width = l.canvas.width; n.height = l.canvas.height; n.getContext('2d')!.drawImage(l.canvas, 0, 0); return n; })(),
    }));
    const a = activeLayer();
    if (!a && layersRef.current.length) activeIdRef.current = layersRef.current[0].id;
  };
  const undo = useCallback(() => {
    if (undoRef.current.length > 1) {
      redoRef.current.push(cloneLayers());
      const prev = undoRef.current.pop()!;
      applyLayers(prev);
      setCanUndo(undoRef.current.length > 1);
      setCanRedo(true);
      render(); refresh(); setStatus('已撤销');
    }
  }, [render, refresh]);
  const redo = useCallback(() => {
    if (redoRef.current.length > 0) {
      const s = redoRef.current.pop()!;
      undoRef.current.push(cloneLayers());
      applyLayers(s);
      setCanUndo(true);
      setCanRedo(redoRef.current.length > 0);
      render(); refresh(); setStatus('已重做');
    }
  }, [render, refresh]);

  // ---- 初始化文档（容器尺寸）----
  const initDoc = useCallback(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const w = Math.max(64, Math.floor(wrap.clientWidth));
    const h = Math.max(64, Math.floor(wrap.clientHeight));
    docRef.current = { w, h };
    layersRef.current = [makeLayer('L0', '图层 1', w, h, true)];
    activeIdRef.current = 'L0';
    panRef.current = { x: 0, y: 0 };
    setZoom(1);
    undoRef.current = []; redoRef.current = [];
    setCanUndo(false); setCanRedo(false);
  }, []);

  useEffect(() => {
    const c = displayRef.current;
    if (!c) return;
    dctxRef.current = c.getContext('2d');
    initDoc();
    render();
    // 注册图层面板操作 + 发布初始快照给左侧「图层」子目录
    layerOps.add = addLayer;
    layerOps.del = delLayer;
    layerOps.toggle = toggleVisible;
    layerOps.setOpacity = setLayerOpacity;
    layerOps.select = selectLayer;
    layerOps.move = moveLayer;
    layerOps.clear = clearLayer;
    publishLayers(layersRef.current, activeIdRef.current);
    // 注册工具/颜色/笔刷状态操作（侧栏调用 → 画布 setter）
    toolOps.setTool = (t) => { setTool(t); publishTools({ tool: t }); };
    toolOps.setColor = (c) => { setColor(c); pushRecentColor(c); publishTools({ color: c }); };
    toolOps.setSize = (s) => { setSize(s); publishTools({ size: s }); };
    toolOps.setOpacity = (v) => { setOpacity(v); publishTools({ opacity: v }); };
    toolOps.setHardness = (h) => { setHardness(h); publishTools({ hardness: h }); };
    toolOps.setTransparent = (v) => { setTransparent(v); publishTools({ transparent: v }); };
    toolOps.undo = () => undo();
    toolOps.redo = () => redo();
    toolOps.fitView = () => fitView();
    toolOps.exportPng = () => { void exportImg('png'); };
    toolOps.exportJpeg = () => { void exportImg('jpeg'); };
    toolOps.importImage = () => importImage();
    toolOps.clearLayer = () => clearLayer();
    toolOps.addLayer = () => addLayer();
    publishTools({ tool: 'pen', color: '#111827', size: 4, opacity: 1, hardness: 1, zoom: 1, transparent: false, canUndo: false, canRedo: false });
    const onResize = () => render();
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'Space') drawRef.current.space = true;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); }
    };
    const onKeyUp = (e: KeyboardEvent) => { if (e.code === 'Space') drawRef.current.space = false; };
    window.addEventListener('resize', onResize);
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKeyUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- 笔触样式 ----
  const applyStroke = (ctx: CanvasRenderingContext2D, w: number) => {
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = w;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
  };

  // ---- 油漆桶填充 ----
  const floodFill = (cx: number, cy: number) => {
    const l = activeLayer(); if (!l) return;
    const w = l.canvas.width, h = l.canvas.height;
    const ctx = l.canvas.getContext('2d')!;
    const img = ctx.getImageData(0, 0, w, h);
    const d = img.data;
    const x0 = Math.floor(cx), y0 = Math.floor(cy);
    if (x0 < 0 || y0 < 0 || x0 >= w || y0 >= h) return;
    const idx = (y0 * w + x0) * 4;
    const tr = d[idx], tg = d[idx + 1], tb = d[idx + 2], ta = d[idx + 3];
    const [fr, fg, fb] = hexToRgb(color);
    const fa = Math.round(opacity * 255);
    if (tr === fr && tg === fg && tb === fb && ta === fa) return;
    const match = (i: number) => d[i] === tr && d[i + 1] === tg && d[i + 2] === tb && d[i + 3] === ta;
    const stack: number[] = [idx];
    while (stack.length) {
      const p = stack.pop()!;
      if (!match(p)) continue;
      d[p] = fr; d[p + 1] = fg; d[p + 2] = fb; d[p + 3] = fa;
      const px = (p / 4) % w;
      const py = Math.floor(p / 4 / w);
      if (px > 0) stack.push(p - 4);
      if (px < w - 1) stack.push(p + 4);
      if (py > 0) stack.push(p - w * 4);
      if (py < h - 1) stack.push(p + w * 4);
    }
    ctx.putImageData(img, 0, 0);
  };

  const hexToRgb = (hex: string): [number, number, number] => {
    const m = hex.replace('#', '');
    return [parseInt(m.slice(0, 2), 16), parseInt(m.slice(2, 4), 16), parseInt(m.slice(4, 6), 16)];
  };

  // ---- 指针事件 ----
  const onPointerDown = (e: React.PointerEvent) => {
    const d = drawRef.current;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const { x, y } = toDoc(e.clientX, e.clientY);
    d.x = x; d.y = y; d.pressure = e.pressure;
    if (d.space || e.button === 1) { d.active = true; return; }
    const ctx = activeCtx();
    const l = activeLayer();
    if (!ctx || !l) return;
    d.active = true;
    if (tool === 'pick') {
      const px = Math.max(0, Math.min(l.canvas.width - 1, Math.floor(x)));
      const py = Math.max(0, Math.min(l.canvas.height - 1, Math.floor(y)));
      const data = ctx.getImageData(px, py, 1, 1).data;
      setColor(rgbToHex(data[0], data[1], data[2]));
      d.active = false; setStatus('已取色');
      return;
    }
    if (tool === 'fill') { pushUndo(); floodFill(x, y); d.active = false; render(); setStatus('已填充'); return; }
    if (tool === 'pen' || tool === 'eraser') {
      pushUndo();
      ctx.globalCompositeOperation = tool === 'eraser' ? 'destination-out' : 'source-over';
      const w = size * (d.pressure > 0 ? d.pressure : 1);
      paintDot(ctx, x, y, w);
    } else {
      pushUndo();
      layerSnapRef.current = (() => { const n = document.createElement('canvas'); n.width = l.canvas.width; n.height = l.canvas.height; n.getContext('2d')!.drawImage(l.canvas, 0, 0); return n; })();
    }
  };

  const paintDot = (ctx: CanvasRenderingContext2D, x: number, y: number, w: number) => {
    ctx.globalAlpha = tool === 'eraser' ? 1 : opacity;
    if (hardness >= 1) {
      applyStroke(ctx, w);
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + 0.1, y + 0.1); ctx.stroke();
    } else {
      const r = w / 2;
      const [cr, cg, cb] = hexToRgb(color);
      const g = ctx.createRadialGradient(x, y, r * hardness, x, y, r);
      g.addColorStop(0, `rgba(${cr},${cg},${cb},${opacity})`);
      g.addColorStop(1, `rgba(${cr},${cg},${cb},0)`);
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drawRef.current;
    if (!d.active) return;
    const { x, y } = toDoc(e.clientX, e.clientY);
    d.pressure = e.pressure;
    if (d.space || (e.buttons & 4) === 4) {
      panRef.current.x += e.movementX; panRef.current.y += e.movementY;
      render(); return;
    }
    const ctx = activeCtx();
    const l = activeLayer();
    if (!ctx || !l) return;
    if (tool === 'pen' || tool === 'eraser') {
      ctx.globalCompositeOperation = tool === 'eraser' ? 'destination-out' : 'source-over';
      const w = size * (d.pressure > 0 ? d.pressure : 1);
      ctx.globalAlpha = tool === 'eraser' ? 1 : opacity;
      if (hardness >= 1) {
        applyStroke(ctx, w);
        ctx.beginPath(); ctx.moveTo(d.x, d.y); ctx.lineTo(x, y); ctx.stroke();
      } else {
        const [cr, cg, cb] = hexToRgb(color);
        const r = w / 2;
        const g = ctx.createRadialGradient(x, y, r * hardness, x, y, r);
        g.addColorStop(0, `rgba(${cr},${cg},${cb},${opacity})`);
        g.addColorStop(1, `rgba(${cr},${cg},${cb},0)`);
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
      }
      ctx.globalAlpha = 1;
      d.x = x; d.y = y; render();
    } else if (layerSnapRef.current) {
      const nctx = l.canvas.getContext('2d')!;
      nctx.clearRect(0, 0, l.canvas.width, l.canvas.height);
      nctx.drawImage(layerSnapRef.current, 0, 0);
      const w = size * (d.pressure > 0 ? d.pressure : 1);
      drawShape(nctx, tool, d.x, d.y, x, y, w);
      render();
    }
  };

  const onPointerUp = () => {
    const d = drawRef.current;
    if (!d.active) return;
    d.active = false;
    layerSnapRef.current = null;
  };

  const drawShape = (
    ctx: CanvasRenderingContext2D, t: Tool,
    x0: number, y0: number, x1: number, y1: number, w: number,
  ) => {
    ctx.globalAlpha = opacity;
    applyStroke(ctx, w);
    if (t === 'rect') {
      ctx.strokeRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
    } else if (t === 'ellipse') {
      ctx.beginPath();
      ctx.ellipse((x0 + x1) / 2, (y0 + y1) / 2, Math.abs(x1 - x0) / 2, Math.abs(y1 - y0) / 2, 0, 0, Math.PI * 2);
      ctx.stroke();
    } else if (t === 'line') {
      ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
    } else if (t === 'arrow') {
      ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
      const ang = Math.atan2(y1 - y0, x1 - x0);
      const head = Math.max(8, w * 3);
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x1 - head * Math.cos(ang - Math.PI / 7), y1 - head * Math.sin(ang - Math.PI / 7));
      ctx.moveTo(x1, y1);
      ctx.lineTo(x1 - head * Math.cos(ang + Math.PI / 7), y1 - head * Math.sin(ang + Math.PI / 7));
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  };

  const rgbToHex = (r: number, g: number, b: number): string =>
    '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');

  // ---- 图层操作 ----
  const addLayer = () => {
    const { w, h } = docRef.current;
    const id = 'L' + Date.now().toString(36);
    const layer = makeLayer(id, '图层 ' + (layersRef.current.length + 1), w, h, false);
    pushUndo();
    layersRef.current.push(layer);
    activeIdRef.current = id;
    render(); refresh(); publishLayers(layersRef.current, activeIdRef.current); setStatus('已新建图层');
  };
  const delLayer = (id: string) => {
    if (layersRef.current.length <= 1) { setStatus('至少保留一个图层'); return; }
    pushUndo();
    layersRef.current = layersRef.current.filter((l) => l.id !== id);
    if (activeIdRef.current === id) activeIdRef.current = layersRef.current[layersRef.current.length - 1].id;
    render(); refresh(); publishLayers(layersRef.current, activeIdRef.current); setStatus('已删除图层');
  };
  const toggleVisible = (id: string) => {
    const l = layersRef.current.find((x) => x.id === id); if (!l) return;
    l.visible = !l.visible; render(); refresh(); publishLayers(layersRef.current, activeIdRef.current);
  };
  const setLayerOpacity = (id: string, v: number) => {
    const l = layersRef.current.find((x) => x.id === id); if (!l) return;
    l.opacity = v; render(); refresh(); publishLayers(layersRef.current, activeIdRef.current);
  };
  const selectLayer = (id: string) => { activeIdRef.current = id; refresh(); publishLayers(layersRef.current, activeIdRef.current); };
  const moveLayer = (id: string, dir: -1 | 1) => {
    const arr = layersRef.current;
    const i = arr.findIndex((l) => l.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= arr.length) return;
    [arr[i], arr[j]] = [arr[j], arr[i]];
    render(); refresh(); publishLayers(layersRef.current, activeIdRef.current);
  };

  // ---- 导入图片为图层 ----
  const importImage = () => {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = 'image/*';
    input.onchange = () => {
      const file = input.files && input.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const img = new Image();
        img.onload = () => {
          const { w, h } = docRef.current;
          const id = 'L' + Date.now().toString(36);
          const layer = makeLayer(id, file.name.slice(0, 12) || '图片', w, h, false);
          layer.canvas.getContext('2d')!.drawImage(img, 0, 0, img.width, img.height);
          pushUndo();
          layersRef.current.push(layer);
          activeIdRef.current = id;
          render(); refresh(); setStatus('已导入图片为图层');
        };
        img.src = reader.result as string;
      };
      reader.readAsDataURL(file);
    };
    input.click();
  };

  // ---- 清空当前图层 / 全部 ----
  const clearLayer = () => {
    const l = activeLayer(); if (!l) return;
    pushUndo();
    l.canvas.getContext('2d')!.clearRect(0, 0, l.canvas.width, l.canvas.height);
    render(); setStatus('已清空当前图层');
  };

  // ---- 缩放 / 平移 ----
  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    setZoom((z) => Math.max(0.1, Math.min(8, z * factor)));
  };
  const fitView = () => { panRef.current = { x: 0, y: 0 }; setZoom(1); render(); };

  // ---- 导出 ----
  const exportImg = async (fmt: 'png' | 'jpeg') => {
    const { w, h } = docRef.current;
    const scale = 1;
    const ex = document.createElement('canvas');
    ex.width = Math.max(1, Math.floor(w * scale)); ex.height = Math.max(1, Math.floor(h * scale));
    const exctx = ex.getContext('2d')!;
    if (!(fmt === 'png' && transparent)) { exctx.fillStyle = '#ffffff'; exctx.fillRect(0, 0, ex.width, ex.height); }
    for (const l of layersRef.current) {
      if (!l.visible) continue;
      exctx.globalAlpha = l.opacity;
      exctx.drawImage(l.canvas, 0, 0, ex.width, ex.height);
    }
    const url = ex.toDataURL(fmt === 'png' ? 'image/png' : 'image/jpeg', 0.92);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const name = `绘画_${stamp}.${fmt === 'png' ? 'png' : 'jpg'}`;
    try {
      await hostApi.invoke('clipboard_write_image', { base64Png: url });
      await hostApi.invoke('add_bytes_to_dropzone', { base64: url, originalName: name });
      setStatus(`已导出 ${fmt.toUpperCase()}${transparent ? '（透明）' : ''} 并存入中转站`);
    } catch (err) {
      setStatus('导出失败：' + (err as Error).message);
    }
  };

  const btnGhost = 'btn-press px-2.5 py-1 rounded-lg text-xs transition-colors text-neutral-500 dark:text-stone-400 hover:bg-black/5 dark:hover:bg-white/5';
  const btnSolid = 'btn-press px-2.5 py-1 rounded-lg text-xs text-white transition-colors bg-[#37373d] dark:bg-stone-700 hover:bg-[#45454d]';

  return (
    <div className="flex-1 flex h-full flex-col bg-[#f5f5f0] dark:bg-[#1c1917]">
      {/* 顶栏：面包屑 + 文件操作 */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-white/80 dark:border-stone-700/50 shrink-0">
        <span className="text-xs text-neutral-400 dark:text-stone-500">茑萝</span>
        <span className="text-xs text-neutral-300 dark:text-stone-600">/</span>
        <span className="text-sm font-medium text-neutral-700 dark:text-stone-200">绘画</span>
        <span className="flex-1" />
        <button onClick={importImage} className={btnSolid}>导入图</button>
        <button onClick={clearLayer} className={btnSolid}>清层</button>
        <button onClick={undo} disabled={!canUndo} className={canUndo ? btnSolid : `${btnGhost} opacity-50 cursor-not-allowed`}>撤销</button>
        <button onClick={redo} disabled={!canRedo} className={canRedo ? btnSolid : `${btnGhost} opacity-50 cursor-not-allowed`}>重做</button>
        <span className="w-px h-5 bg-black/10 dark:bg-white/10 mx-1" />
        <span className="text-xs text-neutral-400 dark:text-stone-500 tabular-nums">{Math.round(zoom * 100)}%</span>
        <button onClick={fitView} className={btnGhost}>适应</button>
        <button onClick={() => exportImg('png')} className="btn-press px-3 py-1 rounded-lg text-xs font-medium bg-emerald-500 hover:bg-emerald-400 text-white">导出 PNG</button>
        <button onClick={() => exportImg('jpeg')} className={btnSolid}>导出 JPG</button>
      </div>

      <div className="flex-1 flex min-h-0">
        {/* 中央画布（图层子目录已移至左侧主侧栏，此处画布占满） */}
        <div ref={wrapRef} className="flex-1 overflow-hidden relative"
          style={{ backgroundImage: 'linear-gradient(45deg,#e5e5e5 25%,transparent 25%),linear-gradient(-45deg,#e5e5e5 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#e5e5e5 75%),linear-gradient(-45deg,transparent 75%,#e5e5e5 75%)', backgroundSize: '16px 16px', backgroundPosition: '0 0,0 8px,8px -8px,-8px 0' }}>
          <canvas
            ref={displayRef}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerLeave={onPointerUp}
            onWheel={onWheel}
            className="absolute inset-0 w-full h-full touch-none"
            style={{ cursor: tool === 'pick' ? 'crosshair' : tool === 'fill' ? 'cell' : 'crosshair' }}
          />
        </div>

      </div>
    </div>
  );
}

// ============ 4 个 tab 按钮的内嵌 SVG 图标（不依赖宿主 lucide 表，体积更小）============
function IconWheel({ active }: { active: boolean }) {
  const stroke = active ? '#fff' : 'currentColor';
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <defs>
        <linearGradient id="wh-grad" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#ff5252" /><stop offset=".17" stopColor="#ffd24a" />
          <stop offset=".34" stopColor="#7cf06a" /><stop offset=".5" stopColor="#3ad6ff" />
          <stop offset=".67" stopColor="#5b6cff" /><stop offset=".84" stopColor="#c64cff" />
          <stop offset="1" stopColor="#ff4ea1" />
        </linearGradient>
      </defs>
      <circle cx="8" cy="8" r="6" stroke={`url(#wh-grad)`} strokeWidth="2" fill="none" />
      <circle cx="8" cy="8" r="2" fill={stroke} />
    </svg>
  );
}
function IconRgb({ active }: { active: boolean }) {
  const stroke = active ? '#fff' : 'currentColor';
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <rect x="2"  y="3" width="12" height="2.4" rx=".6" fill="#ef4444" />
      <rect x="2"  y="6.8" width="12" height="2.4" rx=".6" fill="#22c55e" />
      <rect x="2"  y="10.6" width="12" height="2.4" rx=".6" fill="#3b82f6" />
      <line x1="13.5" y1="3" x2="13.5" y2="5.4" stroke={stroke} strokeWidth=".6" />
    </svg>
  );
}
function IconHsv({ active }: { active: boolean }) {
  const stroke = active ? '#fff' : 'currentColor';
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <defs>
        <linearGradient id="hsg-h" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#fff" /><stop offset="1" stopColor="#ff5252" />
        </linearGradient>
        <linearGradient id="hsg-s" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#fff" /><stop offset="1" stopColor="#22c55e" />
        </linearGradient>
      </defs>
      <rect x="3"    y="2" width="2.4" height="12" rx=".6" fill="url(#hsg-h)" />
      <rect x="6.8"  y="2" width="2.4" height="12" rx=".6" fill="url(#hsg-s)" />
      <rect x="10.6" y="2" width="2.4" height="12" rx=".6" fill={stroke} />
    </svg>
  );
}
function IconPalette({ active }: { active: boolean }) {
  const stroke = active ? '#fff' : 'currentColor';
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <rect x="2"  y="2"  width="5" height="5" rx="1" fill="#ef4444" />
      <rect x="9"  y="2"  width="5" height="5" rx="1" fill="#22c55e" />
      <rect x="2"  y="9"  width="5" height="5" rx="1" fill="#3b82f6" />
      <rect x="9"  y="9"  width="5" height="5" rx="1" fill="#facc15" />
      <circle cx="12.5" cy="12.5" r="0" />
      <path d="M2 14 L14 14" stroke={stroke} strokeWidth=".4" opacity=".4" />
    </svg>
  );
}

// ============ 共用：色条（带渐变背景的水平滑块）============
function ColorSlider(props: {
  label: string;
  min: number; max: number; step?: number; value: number;
  onChange: (v: number) => void;
  bgGradient: string;  // CSS background, e.g. 'linear-gradient(90deg, #000, #fff)'
  width?: number;      // CSS px, default 160
  showValue?: boolean; // default true
}) {
  const { label, min, max, step = 1, value, onChange, bgGradient, showValue = true } = props;
  return (
    <div className="flex items-center gap-1.5 text-[11px]">
      <span className="w-3.5 text-neutral-500 dark:text-stone-400 font-medium tabular-nums">{label}</span>
      <div
        className="relative flex-1 h-3 rounded-full border border-black/10 dark:border-white/10 overflow-hidden"
        style={{ background: bgGradient }}
      >
        <input
          type="range" min={min} max={max} step={step} value={value}
          onChange={(e) => onChange(parseFloat(e.target.value))}
          className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
        />
        {/* 三角游标（SAI 风格） */}
        <div
          className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-0 h-0 pointer-events-none"
          style={{
            left: `${((value - min) / (max - min)) * 100}%`,
            borderLeft: '4px solid transparent',
            borderRight: '4px solid transparent',
            borderTop: '6px solid #fff',
            filter: 'drop-shadow(0 0 1px rgba(0,0,0,.8))',
          }}
        />
      </div>
      {showValue && (
        <span className="w-7 text-right text-neutral-500 dark:text-stone-400 tabular-nums">{Math.round(value)}</span>
      )}
    </div>
  );
}

// ============ 视图 1：色轮（Hue 环 + 中心 SV 方块）============
function ColorWheelView({ color, onChange }: { color: string; onChange: (c: string) => void }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const dragRef = useRef<'ring' | 'square' | null>(null);
  const SIZE = 184; // CSS px
  const RING_THICK = 22;
  const getHsv = (h: string) => { const [r, g, b] = hexToRgb(h); return rgbToHsv(r, g, b); };
  const [hue, sat, val] = getHsv(color);

  // 绘制色轮 + SV 方块 + 当前色指示
  useEffect(() => {
    const c = canvasRef.current; if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    const W = SIZE, H = SIZE;
    if (c.width !== W * dpr) c.width = W * dpr;
    if (c.height !== H * dpr) c.height = H * dpr;
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const cx = W / 2, cy = H / 2;
    const outerR = W / 2 - 4;
    const innerR = outerR - RING_THICK;

    // Hue 环（conic gradient 描边 + 内圆 destination-out 挖空）
    const conic = ctx.createConicGradient(-Math.PI / 2, cx, cy);
    for (let i = 0; i <= 12; i++) conic.addColorStop(i / 12, `hsl(${i * 30}, 100%, 50%)`);
    ctx.save();
    ctx.fillStyle = conic;
    ctx.beginPath();
    ctx.arc(cx, cy, outerR, 0, Math.PI * 2);
    ctx.arc(cx, cy, innerR, 0, Math.PI * 2, true);
    ctx.fill('evenodd');
    ctx.restore();

    // 中心 SV 方块
    const sq = innerR * 1.35; // 撑满内圈
    const sqX = cx - sq / 2, sqY = cy - sq / 2;
    // 底色：当前 hue
    ctx.fillStyle = `hsl(${hue}, 100%, 50%)`;
    ctx.fillRect(sqX, sqY, sq, sq);
    // 白色 → 透明（饱和度）
    const g1 = ctx.createLinearGradient(sqX, sqY, sqX + sq, sqY);
    g1.addColorStop(0, 'rgba(255,255,255,1)');
    g1.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g1; ctx.fillRect(sqX, sqY, sq, sq);
    // 透明 → 黑色（明度）
    const g2 = ctx.createLinearGradient(sqX, sqY, sqX, sqY + sq);
    g2.addColorStop(0, 'rgba(0,0,0,0)');
    g2.addColorStop(1, 'rgba(0,0,0,1)');
    ctx.fillStyle = g2; ctx.fillRect(sqX, sqY, sq, sq);
    // 边框
    ctx.strokeStyle = 'rgba(0,0,0,.25)';
    ctx.lineWidth = 1;
    ctx.strokeRect(sqX + .5, sqY + .5, sq - 1, sq - 1);

    // Hue 指示圈（环上）
    const hueAng = ((hue - 90) * Math.PI) / 180;
    const hueR = (outerR + innerR) / 2;
    const hx = cx + Math.cos(hueAng) * hueR;
    const hy = cy + Math.sin(hueAng) * hueR;
    ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(hx, hy, 5, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#000'; ctx.lineWidth = 1.5; ctx.stroke();

    // SV 指示圈（方块内）
    const svX = sqX + (sat / 100) * sq;
    const svY = sqY + (1 - val / 100) * sq;
    ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(svX, svY, 4, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#000'; ctx.lineWidth = 1.5; ctx.stroke();
  }, [hue, sat, val]);

  // 通用：把客户端坐标转画布数学坐标
  const ptToXY = (clientX: number, clientY: number) => {
    const c = canvasRef.current!; const rect = c.getBoundingClientRect();
    return { x: clientX - rect.left - SIZE / 2, y: clientY - rect.top - SIZE / 2 };
  };

  const apply = (mx: number, my: number, region: 'ring' | 'square') => {
    const sq = (SIZE / 2 - 4 - RING_THICK) * 1.35;
    if (region === 'ring') {
      let ang = (Math.atan2(my, mx) * 180) / Math.PI + 90;
      if (ang < 0) ang += 360; if (ang >= 360) ang -= 360;
      const [r, g, b] = hsvToRgb(ang, sat, val);
      onChange(rgbToHex(r, g, b));
    } else {
      const sx = Math.max(0, Math.min(sq, mx + sq / 2));
      const sy = Math.max(0, Math.min(sq, my + sq / 2));
      const newS = (sx / sq) * 100;
      const newV = (1 - sy / sq) * 100;
      const [r, g, b] = hsvToRgb(hue, newS, newV);
      onChange(rgbToHex(r, g, b));
    }
  };

  const onPointerDown = (e: React.PointerEvent) => {
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const { x, y } = ptToXY(e.clientX, e.clientY);
    const d = Math.sqrt(x * x + y * y);
    const outerR = SIZE / 2 - 4, innerR = outerR - RING_THICK;
    const sqHalf = innerR * 1.35 / 2;
    if (d <= sqHalf) { dragRef.current = 'square'; apply(x, y, 'square'); }
    else if (d <= outerR && d >= innerR) { dragRef.current = 'ring'; apply(x, y, 'ring'); }
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragRef.current) return;
    const { x, y } = ptToXY(e.clientX, e.clientY);
    apply(x, y, dragRef.current);
  };
  const onPointerUp = () => { dragRef.current = null; };

  return (
    <div className="flex flex-col items-center gap-1.5">
      <canvas
        ref={canvasRef}
        width={SIZE} height={SIZE}
        style={{ width: SIZE, height: SIZE }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerUp}
        className="touch-none select-none rounded-full"
      />
      <HexRow color={color} onChange={onChange} />
    </div>
  );
}

// ============ 视图 2：RGB 滑块（R/G/B 各自带渐变背景）============
function RgbSliders({ color, onChange }: { color: string; onChange: (c: string) => void }) {
  const [r, g, b] = hexToRgb(color);
  const set = (nr: number, ng: number, nb: number) => onChange(rgbToHex(nr, ng, nb));
  return (
    <div className="space-y-1.5">
      <ColorSlider label="R" min={0} max={255} value={r} onChange={(v) => set(v, g, b)}
        bgGradient={`linear-gradient(90deg, rgb(0,${g},${b}), rgb(255,${g},${b}))`} />
      <ColorSlider label="G" min={0} max={255} value={g} onChange={(v) => set(r, v, b)}
        bgGradient={`linear-gradient(90deg, rgb(${r},0,${b}), rgb(${r},255,${b}))`} />
      <ColorSlider label="B" min={0} max={255} value={b} onChange={(v) => set(r, g, v)}
        bgGradient={`linear-gradient(90deg, rgb(${r},${g},0), rgb(${r},${g},255))`} />
      <HexRow color={color} onChange={onChange} />
    </div>
  );
}

// ============ 视图 3：HSV 滑块（色相 / 饱和度 / 明度）============
function HsvSliders({ color, onChange }: { color: string; onChange: (c: string) => void }) {
  const [r, g, b] = hexToRgb(color);
  const [h, s, v] = rgbToHsv(r, g, b);
  const set = (nh: number, ns: number, nv: number) => {
    const [nr, ng, nb] = hsvToRgb(nh, ns, nv);
    onChange(rgbToHex(nr, ng, nb));
  };
  // 渐变端点（用 HSL/HSV 字符串做色）
  const hueStops = (() => { let s = 'linear-gradient(90deg'; for (let i = 0; i <= 12; i++) s += `, hsl(${i * 30} 100% 50%)`; return s + ')'; })();
  const satStops = `linear-gradient(90deg, hsl(${h}, 0%, ${v / 2}%), hsl(${h}, 100%, 50%))`;
  const valStops = `linear-gradient(90deg, #000, hsl(${h}, ${s}%, 50%))`;
  return (
    <div className="space-y-1.5">
      <ColorSlider label="H" min={0} max={360} step={1} value={h} onChange={(x) => set(x, s, v)} bgGradient={hueStops} />
      <ColorSlider label="S" min={0} max={100} step={1} value={s} onChange={(x) => set(h, x, v)} bgGradient={satStops} />
      <ColorSlider label="V" min={0} max={100} step={1} value={v} onChange={(x) => set(h, s, x)} bgGradient={valStops} />
      <HexRow color={color} onChange={onChange} />
    </div>
  );
}

// ============ 视图 4：色板（30 色预设 + 最近 10 色）============
function PaletteView({
  color, recent, onPick,
}: { color: string; recent: string[]; onPick: (c: string) => void }) {
  const cur = color.toLowerCase();
  return (
    <div className="space-y-2">
      {/* 当前色 + HEX 输入 */}
      <HexRow color={color} onChange={onPick} />
      {/* 最近使用 */}
      <div>
        <div className="text-[10px] font-medium text-neutral-400 dark:text-stone-500 mb-1">最近使用</div>
        <div className="grid grid-cols-10 gap-[3px]">
          {Array.from({ length: RECENT_MAX }).map((_, i) => {
            const c = recent[i];
            if (!c) return <div key={i} className="w-full aspect-square rounded-sm border border-dashed border-black/10 dark:border-white/10" />;
            return (
              <button key={i} onClick={() => onPick(c)} title={c}
                className={`w-full aspect-square rounded-sm transition-transform hover:scale-110 ${cur === c ? 'ring-1 ring-offset-1 ring-[var(--element-bg)]' : ''}`}
                style={{ backgroundColor: c, borderColor: c === '#ffffff' ? '#cbd5e1' : 'transparent' }}
              />
            );
          })}
        </div>
      </div>
      {/* 预设色板 */}
      <div>
        <div className="text-[10px] font-medium text-neutral-400 dark:text-stone-500 mb-1">色板</div>
        <div className="grid grid-cols-10 gap-[3px]">
          {PALETTE.map((c) => (
            <button key={c} onClick={() => onPick(c)} title={c}
              className={`w-full aspect-square rounded-sm transition-transform hover:scale-110 ${cur === c.toLowerCase() ? 'ring-1 ring-offset-1 ring-[var(--element-bg)]' : ''}`}
              style={{ backgroundColor: c, border: c.toLowerCase() === '#ffffff' ? '1px solid #cbd5e1' : '1px solid transparent' }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

// ============ 共用：当前色块 + HEX 文本输入 + 系统拾色器 ============
function HexRow({ color, onChange }: { color: string; onChange: (c: string) => void }) {
  return (
    <div className="flex items-center gap-1 w-full">
      <span className="w-7 h-7 rounded-md border border-black/10 dark:border-white/10 shrink-0 shadow-inner" style={{ backgroundColor: color }} />
      <input
        type="text" value={color.toUpperCase()}
        onChange={(e) => {
          const v = e.target.value.trim();
          if (/^#?[0-9a-fA-F]{6}$/.test(v)) onChange((v.startsWith('#') ? v : '#' + v).toLowerCase());
        }}
        className="flex-1 min-w-0 px-1.5 py-0.5 text-[11px] rounded border border-black/10 dark:border-white/10 bg-white/60 dark:bg-black/20 text-neutral-700 dark:text-stone-200 tabular-nums font-mono"
        maxLength={7}
      />
      <label className="w-7 h-7 rounded-md border border-black/10 dark:border-white/10 cursor-pointer overflow-hidden relative shrink-0" title="系统拾色器">
        <input type="color" value={color} onChange={(e) => onChange(e.target.value)}
          className="absolute -top-2 -left-2 w-12 h-12 cursor-pointer border-0 p-0" />
      </label>
    </div>
  );
}

// ============ 左侧「图层」子目录（母目录+子目录范式） ============
// 作为 def.sidebar 由宿主渲染在左侧主侧栏；与画布共享 layerBus 状态。
function HuihuaSidebar() {
  // 图层状态
  const [snap, setSnap] = useState(() => layerSnapshot);
  useEffect(() => {
    const fn = () => setSnap(layerSnapshot);
    layerListeners.add(fn);
    return () => { layerListeners.delete(fn); };
  }, []);
  const layers = [...snap.layers].reverse();
  const activeId = snap.activeId;

  // 工具/调色板/笔刷状态
  const [ts, setTs] = useState(() => ({ ...toolSnapshot }));
  useEffect(() => {
    const fn = () => setTs({ ...toolSnapshot });
    toolListeners.add(fn);
    return () => { toolListeners.delete(fn); };
  }, []);

  // 颜色模式 tab 状态（默认「色轮」）
  const [colorMode, setColorMode] = useState<ColorMode>(toolSnapshot.colorMode);
  useEffect(() => { setColorMode(toolSnapshot.colorMode); }, [ts.colorMode]);
  const switchMode = (m: ColorMode) => { setColorMode(m); publishTools({ colorMode: m }); };

  // 颜色变更包装：setColor 已自动 pushRecent
  const pickColor = useCallback((c: string) => { toolOps.setColor(c); }, []);

  const tabBtn = (mode: ColorMode, label: string, Icon: (p: { active: boolean }) => any) => {
    const active = colorMode === mode;
    return (
      <button onClick={() => switchMode(mode)} title={label}
        className={`flex-1 flex flex-col items-center gap-0.5 py-1 rounded-md transition-colors ${
          active
            ? 'bg-[var(--element-bg)] text-white shadow-sm'
            : 'text-neutral-500 dark:text-stone-400 hover:bg-black/5 dark:hover:bg-white/5'
        }`}>
        <Icon active={active} />
        <span className="text-[9px] leading-none">{label}</span>
      </button>
    );
  };

  return (
    <div className="flex flex-col h-full">
      {/* 图层 — 限高 38%，独立滚动 */}
      <div className="overflow-auto shrink-0 px-1 pt-1" style={{ maxHeight: '38%' }}>
        <div className="space-y-1">
          <div className="flex items-center justify-between mb-1">
            <span className="text-[11px] font-medium text-neutral-400 dark:text-stone-500">图层</span>
            <button onClick={() => layerOps.add()} className="btn-press px-2 py-0.5 rounded text-xs bg-[var(--element-bg)] text-white" title="新建图层">
              ＋
            </button>
          </div>
          {layers.map((l) => (
            <div key={l.id}
              onClick={() => layerOps.select(l.id)}
              className={`flex items-center gap-2 px-2 py-1.5 rounded-lg cursor-pointer ${
                l.id === activeId
                  ? 'bg-[var(--element-bg)]/10 ring-1 ring-[var(--element-border)]'
                  : 'hover:bg-black/5 dark:hover:bg-white/5'
              }`}>
              <button onClick={(e) => { e.stopPropagation(); layerOps.toggle(l.id); }}
                className="text-xs w-4 text-center" title={l.visible ? '隐藏' : '显示'}>
                {l.visible ? '👁' : '🚫'}
              </button>
              <div className="flex-1 min-w-0">
                <div className="text-xs truncate text-neutral-700 dark:text-stone-200">{l.name}</div>
                <input type="range" min={0} max={1} step={0.05} value={l.opacity}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => layerOps.setOpacity(l.id, parseFloat(e.target.value))}
                  className="w-full accent-emerald-500 mt-0.5" />
              </div>
              <div className="flex flex-col">
                <button onClick={(e) => { e.stopPropagation(); layerOps.move(l.id, 1); }} className="text-[10px] leading-none px-1 text-neutral-400 hover:text-neutral-700 dark:hover:text-stone-200">▲</button>
                <button onClick={(e) => { e.stopPropagation(); layerOps.move(l.id, -1); }} className="text-[10px] leading-none px-1 text-neutral-400 hover:text-neutral-700 dark:hover:text-stone-200">▼</button>
              </div>
              <button onClick={(e) => { e.stopPropagation(); layerOps.del(l.id); }} className="text-xs text-neutral-400 hover:text-red-500">✕</button>
            </div>
          ))}
        </div>
      </div>

      {/* 分隔 */}
      <div className="border-t border-neutral-200/60 dark:border-stone-700/40 my-0.5 shrink-0" />

      {/* 颜色 / 工具 / 笔刷 — flex-1 占剩余高度，独立滚动 */}
      <div className="flex-1 overflow-auto min-h-0">
        <div className="px-1.5 py-1.5 space-y-2">
          {/* 4-tab 颜色模式（SAI2 风） */}
          <div className="flex items-center gap-1 p-0.5 rounded-lg bg-black/[.04] dark:bg-white/[.04]">
            {tabBtn('wheel',   '色轮', IconWheel)}
            {tabBtn('rgb',     'RGB',  IconRgb)}
            {tabBtn('hsv',     'HSV',  IconHsv)}
            {tabBtn('palette', '色板', IconPalette)}
          </div>

          {/* 当前颜色模式对应的视图 */}
          {colorMode === 'wheel'   && <ColorWheelView color={ts.color} onChange={pickColor} />}
          {colorMode === 'rgb'     && <RgbSliders    color={ts.color} onChange={pickColor} />}
          {colorMode === 'hsv'     && <HsvSliders    color={ts.color} onChange={pickColor} />}
          {colorMode === 'palette' && <PaletteView   color={ts.color} recent={ts.recentColors} onPick={pickColor} />}

          {/* 工具 */}
          <div>
            <div className="text-[10px] font-medium text-neutral-400 dark:text-stone-500 mb-1 mt-1">工具</div>
            <div className="grid grid-cols-4 gap-1">
              {TOOLS.map((t) => (
                <button key={t.id} onClick={() => toolOps.setTool(t.id)}
                  className={`py-1 rounded-md text-[10px] font-medium transition-all ${
                    ts.tool === t.id
                      ? 'bg-[var(--element-bg)] text-white shadow-sm'
                      : 'bg-black/5 dark:bg-white/5 text-neutral-600 dark:text-stone-300 hover:bg-black/10 dark:hover:bg-white/10'
                  }`}>
                  {t.label}
                </button>
              ))}
            </div>
          </div>

          {/* 笔刷 */}
          <div>
            <div className="text-[10px] font-medium text-neutral-400 dark:text-stone-500 mb-1">笔刷</div>
            <div className="space-y-1">
              <div className="flex items-center gap-1.5">
                <label className="text-[10px] text-neutral-500 dark:text-stone-400 w-7 shrink-0">粗细</label>
                <input type="range" min={1} max={60} value={ts.size}
                  onChange={(e) => toolOps.setSize(parseInt(e.target.value, 10))}
                  className="flex-1 accent-emerald-500" />
                <span className="text-[10px] text-neutral-400 w-5 text-right tabular-nums">{ts.size}</span>
              </div>
              <div className="flex items-center gap-1.5">
                <label className="text-[10px] text-neutral-500 dark:text-stone-400 w-7 shrink-0">透明</label>
                <input type="range" min={0.1} max={1} step={0.05} value={ts.opacity}
                  onChange={(e) => toolOps.setOpacity(parseFloat(e.target.value))}
                  className="flex-1 accent-emerald-500" />
                <span className="text-[10px] text-neutral-400 w-5 text-right tabular-nums">{Math.round(ts.opacity * 100)}</span>
              </div>
              <div className="flex items-center gap-1.5">
                <label className="text-[10px] text-neutral-500 dark:text-stone-400 w-7 shrink-0">硬度</label>
                <input type="range" min={0} max={1} step={0.05} value={ts.hardness}
                  onChange={(e) => toolOps.setHardness(parseFloat(e.target.value))}
                  className="flex-1 accent-emerald-500" />
                <span className="text-[10px] text-neutral-400 w-5 text-right tabular-nums">{Math.round(ts.hardness * 100)}</span>
              </div>
            </div>
            <label className="flex items-center gap-1.5 cursor-pointer text-[10px] text-neutral-500 dark:text-stone-400 mt-1">
              <input type="checkbox" checked={ts.transparent}
                onChange={(e) => toolOps.setTransparent(e.target.checked)} className="accent-emerald-500" />
              透明背景
            </label>
          </div>
        </div>
      </div>
    </div>
  );
}

window.__PLUGIN_REGISTRY__.register({
  id: 'huihua',
  name: '绘画',
  iconName: 'Paintbrush',
  kind: 'module',
  visible: false,
  parent: 'niaoluo',
  category: '创作',
  desc: '图层化画板：多图层 / 画笔压感硬度 / 填充吸管 / 图片导入 / 缩放平移 / 导出',
  component: HuihuaBoard,
  sidebar: HuihuaSidebar,
});
