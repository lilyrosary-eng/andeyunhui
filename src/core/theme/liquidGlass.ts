/**
 * 液态玻璃 —— Calcite（gnome-liquid-glass）着色器数学的 Web 移植。
 *
 * 原版是 GNOME Shell 的 Cogl fragment shader（合成器级捕获桌面背景）。
 * Web 端拿不到合成器背景，改用引擎自己的 backdrop-filter 取背：
 * 把 shader 的「SDF 圆角矩形 + 超椭圆剖面高度场 + Snell 折射」烘焙成
 * feDisplacementMap 位移图（R/G 通道编码位移向量），每个毛玻璃元素按
 * 实际尺寸/圆角生成一个 userSpaceOnUse 的 SVG filter，以内联
 * `backdrop-filter: url(#lg-N) blur(2px) saturate(1.5) !important` 附着。
 *
 * 只有 Chromium（Windows WebView2 / Chrome / 新 Android WebView）支持
 * backdrop-filter 引用 SVG filter；WebKitGTK/Firefox 不支持，且 Linux
 * WebKitGTK 有 backdrop-filter 打爆显存的前科（见 platform/isLinux.ts），
 * 那里只启用 CSS 光照层（index.css 的 html.liquid-glass），不做折射。
 *
 * 内联写 !important 是刻意的：要压过 index.css 里两条 author !important ——
 * Linux 全局兜底（html.is-linux *）与壁纸态 hover 的 blur(12px)!important。
 *
 * Shader math: ryohsuke1231/liquid-glass (MIT),
 * Copyright (c) 2026 Ryosuke Watanabe; via Calcite (calcite@rosary, MIT).
 */

// Calcite DEFAULT_PARAMS 与 shader 常量，原值照抄
const MAX_Z = 32;
const DISPLACEMENT_SCALE = 120;
const PROFILE_N = 3.2;
const IOR = 1.15;
const EDGE_SMOOTHING = 1.5;
const CORNER_SMOOTHING = 0.6;
const EDGE_LENS_FALLOFF = 2.4;
const EDGE_LENS_REACH = 96;
const EDGE_LENS_BAND = 22;
// feDisplacementMap 的 scale：通道值 = 0.5 + 位移px / MAP_SCALE。
// 位移上限 96px，取 200 留出余量；8bit 通道量化步长 ≈0.78px，可接受。
const MAP_SCALE = 200;
// 超大面板（全屏浮层）按此上限生成再拉伸，避免 4K 画布吃内存
const MAP_MAX_DIM = 2048;
const CACHE_LIMIT = 32;

const GLASS_SELECTOR = '.glass-panel, [class*="backdrop-blur"], [style*="backdrop-filter"]';
const SVG_NS = 'http://www.w3.org/2000/svg';

/** 折射引擎是否可用：Chromium 系（WebView2/Chrome/Android WebView）。WebKitGTK 的 UA 不含 Chrome token。 */
export const LIQUID_GLASS_REFRACTION =
  typeof navigator !== 'undefined' &&
  /\b(?:Chrome|Chromium|Edg|EdgA|EdgiOS)\/\d+/.test(navigator.userAgent) &&
  typeof CSS !== 'undefined' &&
  CSS.supports('backdrop-filter', 'url(#lg)');

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function smoothstep(a: number, b: number, x: number): number {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

/** 超椭圆角（Calcite cornerShape，corner_smoothing=0.6 常开）：返回 [半径, 指数] */
function cornerShape(bx: number, by: number, r: number): [number, number] {
  r = Math.min(r, Math.min(bx, by));
  const k = Math.min(1 + CORNER_SMOOTHING, Math.max(Math.min(bx, by) / Math.max(r, 1e-3), 1));
  const n = -1 / Math.log2(1 - 0.29289322 / k);
  return [r * k, n];
}

function superLength(qx: number, qy: number, n: number): number {
  const m = Math.max(qx, qy);
  if (m <= 0) return 0;
  const ux = qx / m;
  const uy = qy / m;
  return m * Math.pow(Math.pow(ux, n) + Math.pow(uy, n), 1 / n);
}

/** 超椭圆角圆角矩形的 SDF（Calcite sdRoundRect） */
function sdRoundRect(px: number, py: number, bx: number, by: number, cr: number, cn: number): number {
  const dx = Math.abs(px) - bx + cr;
  const dy = Math.abs(py) - by + cr;
  const qx = Math.max(dx, 0);
  const qy = Math.max(dy, 0);
  const len = superLength(qx, qy, cn);
  if (len <= 0) return Math.max(dx, dy) - cr;
  const gx = Math.pow(qx / len, cn - 1);
  const gy = Math.pow(qy / len, cn - 1);
  const gradLen = 1 + (Math.hypot(gx, gy) - 1) * clamp(len / Math.max(cr, 1e-3), 0, 1);
  return (len - cr) / Math.max(gradLen, 0.5);
}

/** SDF 外法线方向（Calcite sdRoundRectDir） */
function sdRoundRectDir(px: number, py: number, bx: number, by: number, cr: number, cn: number): [number, number] {
  const qx = Math.abs(px) - bx + cr;
  const qy = Math.abs(py) - by + cr;
  if (Math.max(qx, qy) < 0) {
    return qx > qy ? [Math.sign(px), 0] : [0, Math.sign(py)];
  }
  const m = Math.max(Math.max(qx, qy), 1e-6);
  const ux = Math.max(qx, 0) / m;
  const uy = Math.max(qy, 0) / m;
  const gx = Math.pow(ux, cn - 1) + 1e-6;
  const gy = Math.pow(uy, cn - 1) + 1e-6;
  const l = Math.hypot(gx, gy);
  return [Math.sign(px) * gx / l, Math.sign(py) * gy / l];
}

/** 剖面高度（Calcite getHeight：超椭圆剖面 × 边缘淡出） */
function profileHeight(px: number, py: number, bx: number, by: number, cr: number, cn: number, band: number, zScale: number): number {
  const d = sdRoundRect(px, py, bx, by, cr, cn);
  if (d > EDGE_SMOOTHING) return 0;
  const t = clamp(Math.max(-d, 0) / Math.max(band, 1), 0, 1);
  const h = Math.pow(Math.max(1 - Math.pow(1 - t, PROFILE_N), 0), 1 / PROFILE_N) * zScale;
  return h * (1 - smoothstep(-EDGE_SMOOTHING, EDGE_SMOOTHING, d));
}

/**
 * 生成一张位移图（PNG data URL）。只计算边缘 band 内的像素：
 * 剖面在深度 ≥ band 后高度恒定 → 梯度为 0 → 位移为 0，直接写中值。
 */
function generateDisplacementMap(w: number, h: number, radius: number): string {
  const scale = Math.min(1, MAP_MAX_DIM / Math.max(w, h));
  const mw = Math.max(2, Math.round(w * scale));
  const mh = Math.max(2, Math.round(h * scale));
  const canvas = document.createElement('canvas');
  canvas.width = mw;
  canvas.height = mh;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(mw, mh);
  const data = img.data;

  const bx = mw / 2;
  const by = mh / 2;
  const [cr, cn] = cornerShape(bx, by, radius * scale);
  const band = Math.max(Math.min(EDGE_LENS_BAND, Math.min(bx, by)), 1);
  const lensScale = band / EDGE_LENS_BAND;
  const zScale = MAX_Z * lensScale;
  const e = clamp(Math.min(mw, mh) / 560, 0.45, 1.2);
  const eta = 1 / Math.max(IOR, 1.001);
  const maxDispPx = Math.max(0.3 * Math.min(mw, mh), 26);

  for (let y = 0; y < mh; y++) {
    const py = y + 0.5 - by;
    for (let x = 0; x < mw; x++) {
      const px = x + 0.5 - bx;
      const i = (y * mw + x) * 4;
      data[i + 2] = 128;
      data[i + 3] = 255;
      const d = sdRoundRect(px, py, bx, by, cr, cn);
      const depth = Math.max(-d, 0);
      // 带外（形状外 / 剖面已平顶）位移为零
      if (d > EDGE_SMOOTHING || depth >= band) {
        data[i] = 128;
        data[i + 1] = 128;
        continue;
      }
      const [dx, dy] = sdRoundRectDir(px, py, bx, by, cr, cn);
      const hOut = profileHeight(px + dx * e, py + dy * e, bx, by, cr, cn, band, zScale);
      const hIn = profileHeight(px - dx * e, py - dy * e, bx, by, cr, cn, band, zScale);
      const g = (hOut - hIn) / (2 * e);
      // 法线 = normalize(-gradH, 1)
      const nx = -dx * g;
      const ny = -dy * g;
      const nl = Math.hypot(nx, ny, 1);
      const nz = 1 / nl;
      // Snell 折射：refract(viewDir=(0,0,-1), N, eta)
      const dotNI = -nz;
      const k = 1 - eta * eta * (1 - dotNI * dotNI);
      let dispX = 0;
      let dispY = 0;
      if (k >= 0) {
        const f = eta * dotNI + Math.sqrt(k);
        const rx = -f * (nx / nl);
        const ry = -f * (ny / nl);
        const rz = -eta - f * nz;
        const safeZ = Math.max(-rz, 0.15);
        dispX = (rx / safeZ) * (DISPLACEMENT_SCALE / Math.max(mw, 1));
        dispY = (ry / safeZ) * (DISPLACEMENT_SCALE / Math.max(mh, 1));
        const dl = Math.hypot(dispX * mw, dispY * mh);
        if (dl > maxDispPx) {
          dispX *= maxDispPx / dl;
          dispY *= maxDispPx / dl;
        }
      }
      // 边缘透镜衰减（Calcite lensShape），把位移集中到边缘带
      const edgeT = clamp(1 - depth / band, 0, 1);
      const lensShape = Math.pow(edgeT, EDGE_LENS_FALLOFF);
      let dispPxX = dispX * mw * lensShape * lensScale;
      let dispPxY = dispY * mh * lensShape * lensScale;
      const pl = Math.hypot(dispPxX, dispPxY);
      if (pl > EDGE_LENS_REACH) {
        dispPxX *= EDGE_LENS_REACH / pl;
        dispPxY *= EDGE_LENS_REACH / pl;
      }
      data[i] = Math.round(clamp(0.5 + dispPxX / MAP_SCALE, 0, 1) * 255);
      data[i + 1] = Math.round(clamp(0.5 + dispPxY / MAP_SCALE, 0, 1) * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas.toDataURL('image/png');
}

interface CacheEntry {
  filterId: string;
  refs: number;
}

interface Attached {
  key: string;
  value: string;
  original: string;
  originalPriority: string;
  ro: ResizeObserver;
}

let running = false;
let svgRoot: SVGSVGElement | null = null;
let nextFilterId = 0;
let mutationObserver: MutationObserver | null = null;
let mutationScheduled = false;
let pendingRecords: MutationRecord[] = [];
const cache = new Map<string, CacheEntry>();
const attached = new Map<Element, Attached>();

function acquireFilter(w: number, h: number, r: number): CacheEntry {
  const key = `${w}|${h}|${r}`;
  let entry = cache.get(key);
  if (entry) {
    entry.refs++;
    return entry;
  }
  const url = generateDisplacementMap(w, h, r);
  const filterId = `lg-${nextFilterId++}`;
  const filter = document.createElementNS(SVG_NS, 'filter');
  filter.setAttribute('id', filterId);
  filter.setAttribute('filterUnits', 'userSpaceOnUse');
  filter.setAttribute('x', '0');
  filter.setAttribute('y', '0');
  filter.setAttribute('width', String(w));
  filter.setAttribute('height', String(h));
  filter.setAttribute('color-interpolation-filters', 'sRGB');
  const feImage = document.createElementNS(SVG_NS, 'feImage');
  feImage.setAttribute('href', url);
  feImage.setAttribute('x', '0');
  feImage.setAttribute('y', '0');
  feImage.setAttribute('width', String(w));
  feImage.setAttribute('height', String(h));
  feImage.setAttribute('preserveAspectRatio', 'none');
  feImage.setAttribute('result', 'map');
  const feDisp = document.createElementNS(SVG_NS, 'feDisplacementMap');
  feDisp.setAttribute('in', 'SourceGraphic');
  feDisp.setAttribute('in2', 'map');
  feDisp.setAttribute('scale', String(MAP_SCALE));
  feDisp.setAttribute('xChannelSelector', 'R');
  feDisp.setAttribute('yChannelSelector', 'G');
  filter.appendChild(feImage);
  filter.appendChild(feDisp);
  svgRoot!.appendChild(filter);
  entry = { filterId, refs: 1 };
  cache.set(key, entry);
  evictCache();
  return entry;
}

function evictCache(): void {
  if (cache.size <= CACHE_LIMIT) return;
  for (const [key, entry] of cache) {
    if (cache.size <= CACHE_LIMIT) break;
    if (entry.refs > 0) continue;
    document.getElementById(entry.filterId)?.remove();
    cache.delete(key);
  }
}

function releaseFilter(key: string): void {
  const entry = cache.get(key);
  if (entry) entry.refs = Math.max(0, entry.refs - 1);
}

function measure(el: Element): { w: number; h: number; r: number } | null {
  // offsetWidth/Height 是布局像素，不受外层 CSS zoom 影响（主窗口有 zoom 包裹层），
  // 与 SVG userSpaceOnUse 的局部坐标系一致。getBoundingClientRect 会被 zoom 缩放。
  const w = Math.round((el as HTMLElement).offsetWidth || el.getBoundingClientRect().width);
  const h = Math.round((el as HTMLElement).offsetHeight || el.getBoundingClientRect().height);
  if (w < 8 || h < 8) return null;
  const cs = getComputedStyle(el);
  const r = Math.max(0, parseFloat(cs.borderTopLeftRadius) || 0);
  return { w, h, r: Math.round(Math.min(r, Math.min(w, h) / 2)) };
}

function attach(el: Element): void {
  if (!running || attached.has(el)) return;
  const m = measure(el);
  if (!m) return;
  const key = `${m.w}|${m.h}|${m.r}`;
  const entry = acquireFilter(m.w, m.h, m.r);
  const value = `url(#${entry.filterId}) blur(2px) saturate(1.5)`;
  const style = (el as HTMLElement).style;
  const original = style.getPropertyValue('backdrop-filter');
  const originalPriority = style.getPropertyPriority('backdrop-filter');
  style.setProperty('backdrop-filter', value, 'important');
  const ro = new ResizeObserver(() => {
    if (!attached.has(el)) return;
    const cur = attached.get(el)!;
    const nm = measure(el);
    const nk = nm ? `${nm.w}|${nm.h}|${nm.r}` : null;
    if (nk === cur.key) return;
    detach(el);
    if (nk) attach(el);
  });
  ro.observe(el);
  attached.set(el, { key, value, original, originalPriority, ro });
}

function detach(el: Element): void {
  const cur = attached.get(el);
  if (!cur) return;
  cur.ro.disconnect();
  releaseFilter(cur.key);
  const style = (el as HTMLElement).style;
  if (style.getPropertyValue('backdrop-filter') === cur.value) {
    if (cur.original) style.setProperty('backdrop-filter', cur.original, cur.originalPriority);
    else style.removeProperty('backdrop-filter');
  }
  attached.delete(el);
}

function matchesGlass(el: Element): boolean {
  return el.matches(GLASS_SELECTOR);
}

function scanSubtree(root: Element | Document): void {
  if (root instanceof Element && matchesGlass(root)) attach(root);
  root.querySelectorAll(GLASS_SELECTOR).forEach(attach);
}

function flushMutations(records: MutationRecord[]): void {
  for (const rec of records) {
    if (rec.type === 'childList') {
      rec.addedNodes.forEach((n) => {
        if (n instanceof Element) scanSubtree(n);
      });
      if (rec.removedNodes.length) {
        for (const el of attached.keys()) {
          if (!el.isConnected) detach(el);
        }
      }
    } else {
      const el = rec.target as Element;
      if (matchesGlass(el)) {
        const cur = attached.get(el);
        // 自己写入的 style 变更也会触发记录：值没变就跳过，避免循环
        if (cur && (el as HTMLElement).style.getPropertyValue('backdrop-filter') === cur.value) {
          const m = measure(el);
          if (m && `${m.w}|${m.h}|${m.r}` === cur.key) continue;
        }
        detach(el);
        attach(el);
      } else if (attached.has(el)) {
        detach(el);
      }
    }
  }
}

/** 启动折射管理器（幂等）。仅在 LIQUID_GLASS_REFRACTION 为 true 时调用。 */
export function startLiquidGlass(): void {
  if (running || !LIQUID_GLASS_REFRACTION) return;
  running = true;
  // 不能用 display:none —— 部分引擎会因此断开 filter 引用
  svgRoot = document.createElementNS(SVG_NS, 'svg');
  svgRoot.setAttribute('width', '0');
  svgRoot.setAttribute('height', '0');
  svgRoot.setAttribute('aria-hidden', 'true');
  svgRoot.style.position = 'absolute';
  svgRoot.style.pointerEvents = 'none';
  document.body.appendChild(svgRoot);
  scanSubtree(document.body);
  mutationObserver = new MutationObserver((records) => {
    pendingRecords.push(...records);
    if (mutationScheduled) return;
    mutationScheduled = true;
    requestAnimationFrame(() => {
      mutationScheduled = false;
      const batch = pendingRecords;
      pendingRecords = [];
      if (running) flushMutations(batch);
    });
  });
  mutationObserver.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class', 'style'],
  });
}

/** 停止并还原所有被附着元素的内联 backdrop-filter（幂等）。 */
export function stopLiquidGlass(): void {
  if (!running) return;
  running = false;
  mutationObserver?.disconnect();
  mutationObserver = null;
  for (const el of [...attached.keys()]) detach(el);
  svgRoot?.remove();
  svgRoot = null;
  cache.clear();
}