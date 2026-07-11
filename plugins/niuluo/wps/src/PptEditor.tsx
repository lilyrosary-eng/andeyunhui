// <reference path="../../global.d.ts" />
// 茑萝 · 办公 → 演示文件（PPT）编辑器 MVP
// 自研轻画布：逻辑坐标 960×540（16:9），元素为绝对定位 DOM，自绘缩放手柄。
// 不引入第三方库，复用宿主 React 实例。
const React = window.__HOST_REACT__;
const hostApi = window.__HOST_API__;
const { useState, useEffect, useRef, useCallback } = React;

import {
  loadDoc,
  newId,
  type PptSlide,
  type PptElement,
  type PptContent,
  type PptSection,
  type PptShapeKind,
} from './docStore';
import { open, save } from '@tauri-apps/plugin-dialog';

const LOGICAL_W = 960;
const LOGICAL_H = 540;
const SNAP = 6; // 吸附阈值（逻辑像素）

type Box = { x: number; y: number; w: number; h: number };
type Guide = { axis: 'x' | 'y'; pos: number };

// 移动吸附：把元素的左/中/右、上/中/下锚点对齐到其它元素或画布边界，返回修正后的位置与参考线。
function snapMove(box: Box, others: PptElement[], thr: number): { box: Box; guides: Guide[] } {
  const tx = [0, LOGICAL_W / 2, LOGICAL_W];
  const ty = [0, LOGICAL_H / 2, LOGICAL_H];
  for (const o of others) {
    tx.push(o.x, o.x + o.w / 2, o.x + o.w);
    ty.push(o.y, o.y + o.h / 2, o.y + o.h);
  }
  let { x, y, w, h } = box;
  const ax = [x, x + w / 2, x + w];
  const ay = [y, y + h / 2, y + h];
  let gx: number | null = null;
  let gy: number | null = null;
  let bd = thr;
  let bdy = thr;
  for (const a of ax) for (const t of tx) {
    const diff = Math.abs(a - t);
    if (diff <= bd) {
      bd = diff; gx = t;
      if (a === x) x = t;
      else if (a === x + w / 2) x = t - w / 2;
      else x = t - w;
    }
  }
  for (const a of ay) for (const t of ty) {
    const diff = Math.abs(a - t);
    if (diff <= bdy) {
      bdy = diff; gy = t;
      if (a === y) y = t;
      else if (a === y + h / 2) y = t - h / 2;
      else y = t - h;
    }
  }
  const guides: Guide[] = [];
  if (gx !== null) guides.push({ axis: 'x', pos: gx });
  if (gy !== null) guides.push({ axis: 'y', pos: gy });
  return { box: { x, y, w, h }, guides };
}

// 缩放吸附（右下角手柄）：固定左上角，仅让右/下边对齐目标。
function snapResize(box: Box, others: PptElement[], thr: number): { box: Box; guides: Guide[] } {
  const { x, y } = box;
  let { w, h } = box;
  const right = x + w;
  const bottom = y + h;
  const rightTargets = [LOGICAL_W, ...others.map((o) => o.x + o.w), ...others.map((o) => o.x + o.w / 2), ...others.map((o) => o.x)];
  const bottomTargets = [LOGICAL_H, ...others.map((o) => o.y + o.h), ...others.map((o) => o.y + o.h / 2), ...others.map((o) => o.y)];
  let gx: number | null = null;
  let gy: number | null = null;
  let bd = thr;
  let bdy = thr;
  for (const t of rightTargets) {
    const diff = Math.abs(right - t);
    if (diff <= bd) { bd = diff; gx = t; w = t - x; }
  }
  for (const t of bottomTargets) {
    const diff = Math.abs(bottom - t);
    if (diff <= bdy) { bdy = diff; gy = t; h = t - y; }
  }
  const guides: Guide[] = [];
  if (gx !== null) guides.push({ axis: 'x', pos: gx });
  if (gy !== null) guides.push({ axis: 'y', pos: gy });
  return { box: { x, y, w, h }, guides };
}

function blankSlide(): PptSlide {
  return { id: newId(), background: '#ffffff', elements: [] };
}

// 形状顺序与中文标签（工具栏 / 属性面板共用）
const SHAPE_KINDS: PptShapeKind[] = ['rect', 'roundRect', 'ellipse', 'triangle', 'arrow', 'line'];
const SHAPE_LABEL: Record<PptShapeKind, string> = {
  rect: '矩形',
  roundRect: '圆角',
  ellipse: '椭圆',
  triangle: '三角',
  arrow: '箭头',
  line: '直线',
};

// 统一以 SVG 渲染形状：画布、缩略图、属性面板视觉一致，并支持圆角矩形 / 三角 / 箭头。
function ShapeSvg({ el, scale }: { el: PptElement; scale: number }) {
  const w = el.w * scale;
  const h = el.h * scale;
  const sw = Math.max(0.5, (el.strokeWidth ?? 2) * scale);
  const stroke = el.stroke ?? '#000';
  const fill = el.fill && el.fill !== 'transparent' ? el.fill : 'none';
  if (el.shape === 'line') {
    return (
      <svg width={w} height={h} className="pointer-events-none block">
        <line x1={0} y1={h / 2} x2={w} y2={h / 2} stroke={stroke} strokeWidth={sw} />
      </svg>
    );
  }
  let geom: React.ReactNode;
  if (el.shape === 'ellipse') {
    geom = (
      <ellipse
        cx={w / 2}
        cy={h / 2}
        rx={Math.max(0, w / 2 - sw / 2)}
        ry={Math.max(0, h / 2 - sw / 2)}
        fill={fill}
        stroke={stroke}
        strokeWidth={sw}
      />
    );
  } else if (el.shape === 'roundRect') {
    const r = Math.min(w, h) * 0.18;
    geom = (
      <rect
        x={sw / 2}
        y={sw / 2}
        width={Math.max(0, w - sw)}
        height={Math.max(0, h - sw)}
        rx={r}
        ry={r}
        fill={fill}
        stroke={stroke}
        strokeWidth={sw}
      />
    );
  } else if (el.shape === 'triangle') {
    geom = (
      <polygon
        points={`0,${h} ${w / 2},0 ${w},${h}`}
        fill={fill}
        stroke={stroke}
        strokeWidth={sw}
        strokeLinejoin="round"
      />
    );
  } else if (el.shape === 'arrow') {
    const aw = Math.min(w * 0.45, h);
    const sh = h * 0.28;
    const d = [
      `M0,${(h - sh) / 2}`,
      `L${w - aw},${(h - sh) / 2}`,
      `L${w - aw},0`,
      `L${w},${h / 2}`,
      `L${w - aw},${h}`,
      `L${w - aw},${(h + sh) / 2}`,
      'Z',
    ].join(' ');
    geom = <path d={d} fill={fill} stroke={stroke} strokeWidth={sw} strokeLinejoin="round" />;
  } else {
    geom = (
      <rect
        x={sw / 2}
        y={sw / 2}
        width={Math.max(0, w - sw)}
        height={Math.max(0, h - sw)}
        fill={fill}
        stroke={stroke}
        strokeWidth={sw}
      />
    );
  }
  return (
    <svg width={w} height={h} className="pointer-events-none block">
      {geom}
    </svg>
  );
}

function PptThumb({ slide, scale, active, onClick }: {
  slide: PptSlide;
  scale: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`relative w-full rounded-md overflow-hidden border transition-colors
        ${active ? 'border-[var(--element-bg)] ring-1 ring-[var(--element-bg)]' : 'border-black/10 dark:border-white/10 hover:border-black/30 dark:hover:border-white/30'}`}
      style={{ aspectRatio: '16 / 9', background: slide.background }}
    >
      {slide.elements.map((el) => {
        if (el.type !== 'shape') return null;
        return (
          <div
            key={el.id}
            style={{
              position: 'absolute',
              left: el.x * scale,
              top: el.y * scale,
              width: el.w * scale,
              height: el.h * scale,
            }}
          >
            <ShapeSvg el={el} scale={scale} />
          </div>
        );
      })}
    </button>
  );
}

// 只读渲染一张幻灯片（编辑画布与放映模式共用视觉），scale 为「逻辑像素→屏幕像素」倍数。
function SlideView({ slide, scale }: { slide: PptSlide; scale: number }) {
  return (
    <div
      className="relative overflow-hidden"
      style={{ width: LOGICAL_W * scale, height: LOGICAL_H * scale, background: slide.background }}
    >
      {slide.elements
        .slice()
        .sort((a, b) => a.z - b.z)
        .map((el) => {
          const base: React.CSSProperties = {
            position: 'absolute',
            left: el.x * scale,
            top: el.y * scale,
            width: el.w * scale,
            height: el.h * scale,
          };
          if (el.type === 'text') {
            const st = el.style || { fontSize: 24, color: '#000' };
            return (
              <div
                key={el.id}
                style={{
                  ...base,
                  fontSize: st.fontSize * scale,
                  color: st.color,
                  fontWeight: st.bold ? 700 : 400,
                  fontStyle: st.italic ? 'italic' : 'normal',
                  textDecoration: st.underline ? 'underline' : 'none',
                  textAlign: st.align,
                  display: 'flex',
                  alignItems: st.align === 'center' ? 'center' : st.align === 'right' ? 'flex-end' : 'flex-start',
                  lineHeight: 1.3,
                  overflow: 'hidden',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  padding: 4 * scale,
                }}
              >
                {el.text}
              </div>
            );
          }
          if (el.type === 'image') {
            return <img key={el.id} src={el.src} draggable={false} className="pointer-events-none" style={{ ...base, objectFit: 'fill' }} alt="" />;
          }
          // shape（矩形 / 圆角矩形 / 椭圆 / 直线 / 三角 / 箭头），统一用 SVG 渲染
          return (
            <div key={el.id} style={base} className="pointer-events-none">
              <ShapeSvg el={el} scale={scale} />
            </div>
          );
        })}
    </div>
  );
}

// 放映模式：全屏逐页，方向键/空格/点击翻页，Esc 退出。
function PresentMode({ slides, start, onExit }: { slides: PptSlide[]; start: number; onExit: () => void }) {
  const [idx, setIdx] = useState(start);
  const [stage, setStage] = useState({ w: 960, h: 540 });

  useEffect(() => {
    const fit = () => {
      const pad = 0;
      const vw = window.innerWidth - pad;
      const vh = window.innerHeight - pad;
      const w = Math.min(vw, (vh * LOGICAL_W) / LOGICAL_H);
      const h = (w * LOGICAL_H) / LOGICAL_W;
      setStage({ w, h });
    };
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onExit();
      else if (e.key === 'ArrowRight' || e.key === ' ' || e.key === 'PageDown') setIdx((i) => Math.min(slides.length - 1, i + 1));
      else if (e.key === 'ArrowLeft' || e.key === 'PageUp') setIdx((i) => Math.max(0, i - 1));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [slides.length, onExit]);

  const scale = stage.w / LOGICAL_W;
  const go = (d: number) => setIdx((i) => Math.max(0, Math.min(slides.length - 1, i + d)));
  const trans = slides[idx]?.transition || 'fade';
  const animClass = trans === 'fade' ? 'ppt-anim-fade' : trans === 'slide' ? 'ppt-anim-slide' : '';

  return (
    <>
    <style>{'@keyframes pptFade{from{opacity:0}to{opacity:1}}@keyframes pptSlide{from{transform:translateX(40px);opacity:0}to{transform:translateX(0);opacity:1}}.ppt-anim-fade{animation:pptFade .35s ease}.ppt-anim-slide{animation:pptSlide .35s ease}'}</style>
    <div
      className="fixed inset-0 z-[9999] bg-black flex items-center justify-center select-none"
      onDoubleClick={onExit}
    >
      <div key={idx} style={{ width: stage.w, height: stage.h, position: 'relative' }} className={`shadow-2xl ${animClass}`}>
        {slides[idx] && <SlideView slide={slides[idx]} scale={scale} />}
      </div>
      {/* 上栏：页码 + 退出 */}
      <div className="absolute top-0 left-0 right-0 flex items-center justify-between px-4 py-2 text-white/80 text-sm">
        <span className="tabular-nums">{idx + 1} / {slides.length}</span>
        <button onClick={onExit} className="px-3 py-1 rounded bg-white/10 hover:bg-white/20">退出 (Esc)</button>
      </div>
      {/* 左右半屏翻页热区 */}
      <button className="absolute left-0 top-0 bottom-0 w-1/3 bg-transparent cursor-pointer" onClick={() => go(-1)} aria-label="上一页" />
      <button className="absolute right-0 top-0 bottom-0 w-1/3 bg-transparent cursor-pointer" onClick={() => go(1)} aria-label="下一页" />
    </div>
    </>
  );
}

// ===================== 导出 PDF（前端逐页渲染为 JPEG 再合成 PDF，零依赖） =====================
function preloadImages(srcs: string[]): Promise<Map<string, HTMLImageElement>> {
  const map = new Map<string, HTMLImageElement>();
  return Promise.all(
    srcs.map(
      (src) =>
        new Promise<[string, HTMLImageElement | null]>((resolve) => {
          if (!src || src.startsWith('http://') || src.startsWith('https://')) {
            // 跨域图片无法写回 canvas（CORS），跳过占位
            resolve([src, null]);
            return;
          }
          const img = new Image();
          img.onload = () => resolve([src, img]);
          img.onerror = () => resolve([src, null]);
          img.src = src;
        }),
    ),
  ).then((pairs) => {
    for (const [src, img] of pairs) if (img) map.set(src, img);
    return map;
  });
}

// 在 canvas 上绘制一张幻灯片（逻辑坐标 960×540 → 以 scale 放大），返回 JPEG Blob。
async function renderSlideToJpeg(slide: PptSlide, scale: number, imgs: Map<string, HTMLImageElement>): Promise<Blob> {
  const W = Math.round(LOGICAL_W * scale);
  const H = Math.round(LOGICAL_H * scale);
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = slide.background || '#ffffff';
  ctx.fillRect(0, 0, W, H);

  const els = slide.elements.slice().sort((a, b) => a.z - b.z);
  for (const el of els) {
    const x = el.x * scale;
    const y = el.y * scale;
    const w = el.w * scale;
    const h = el.h * scale;
    if (el.type === 'text') {
      const st = el.style || { fontSize: 24, color: '#000' };
      ctx.fillStyle = st.color || '#000000';
      ctx.font = `${st.italic ? 'italic ' : ''}${st.bold ? 'bold ' : ''}${Math.round(st.fontSize * scale)}px sans-serif`;
      ctx.textBaseline = 'top';
      ctx.textAlign = (st.align as CanvasTextAlign) || 'left';
      const pad = 4 * scale;
      const tx = st.align === 'center' ? x + w / 2 : st.align === 'right' ? x + w - pad : x + pad;
      // 简单按字符换行，支持中文与英文混排
      const lines: string[] = [];
      const paragraphs = (el.text || '').split('\n');
      for (const para of paragraphs) {
        let line = '';
        for (const ch of para) {
          if (ctx.measureText(line + ch).width > w - pad * 2 && line) {
            lines.push(line);
            line = ch;
          } else {
            line += ch;
          }
        }
        lines.push(line);
      }
      const lh = st.fontSize * scale * 1.3;
      lines.forEach((line, i) => ctx.fillText(line, tx, y + pad + i * lh));
    } else if (el.type === 'image') {
      const img = imgs.get(el.src || '');
      if (img) {
        try {
          ctx.drawImage(img, x, y, w, h);
        } catch {
          /* 跨域污染，跳过 */
        }
      } else {
        ctx.fillStyle = '#e5e7eb';
        ctx.fillRect(x, y, w, h);
      }
    } else {
      // shape
      if (el.shape === 'line') {
        ctx.fillStyle = el.stroke || '#000';
        ctx.fillRect(x, y, w, Math.max(1, (el.strokeWidth ?? 2) * scale));
      } else {
        ctx.strokeStyle = el.stroke || '#000';
        ctx.lineWidth = (el.strokeWidth ?? 2) * scale;
        const hasFill = !!el.fill && el.fill !== 'transparent';
        if (hasFill) ctx.fillStyle = el.fill!;
        if (el.shape === 'ellipse') {
          ctx.beginPath();
          ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
          if (hasFill) ctx.fill();
          ctx.stroke();
        } else if (el.shape === 'triangle') {
          ctx.beginPath();
          ctx.moveTo(x, y + h);
          ctx.lineTo(x + w / 2, y);
          ctx.lineTo(x + w, y + h);
          ctx.closePath();
          if (hasFill) ctx.fill();
          ctx.stroke();
        } else if (el.shape === 'arrow') {
          const aw = Math.min(w * 0.45, h);
          const sh = h * 0.28;
          ctx.beginPath();
          ctx.moveTo(x, y + (h - sh) / 2);
          ctx.lineTo(x + (w - aw), y + (h - sh) / 2);
          ctx.lineTo(x + (w - aw), y);
          ctx.lineTo(x + w, y + h / 2);
          ctx.lineTo(x + (w - aw), y + h);
          ctx.lineTo(x + (w - aw), y + (h + sh) / 2);
          ctx.closePath();
          if (hasFill) ctx.fill();
          ctx.stroke();
        } else {
          // rect / roundRect（canvas 描边矩形近似）
          if (hasFill) ctx.fillRect(x, y, w, h);
          ctx.strokeRect(x, y, w, h);
        }
      }
    }
  }
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('canvas 导出失败'))), 'image/jpeg', 0.92);
  });
}

// 最简 PDF 装配（DCTDecode/JPEG），一页一图铺满整页。
function buildPdf(pages: { jpeg: Uint8Array; w: number; h: number }[]): Uint8Array {
  const enc = (s: string) => new TextEncoder().encode(s);
  const objects: Uint8Array[] = [];
  const addObj = (data: Uint8Array) => {
    objects.push(data);
    return objects.length; // 1-based id
  };

  // 每个 page 对应一个 image xobject + content stream
  const pageIds: number[] = [];
  const imgIds: number[] = [];
  const contentIds: number[] = [];
  for (const p of pages) {
    const imgId = addObj(p.jpeg);
    imgIds.push(imgId);
    const content = enc(`q\n${p.w} 0 0 ${p.h} 0 0 cm\n/Im1 Do\nQ\n`);
    const contentId = addObj(content);
    contentIds.push(contentId);
    pageIds.push(0); // 占位，下面回填
  }
  // pages 树与 catalog
  const pagesId = objects.length + 1;
  // 先写 image/content，再写 pages 与 page（page 需引用 content/image）
  // 重排：objects 已含 image(1..) 与 content。现在追加 pages 节点、page 节点、catalog。
  // 为简单起见，page 节点 id = 当前 objects.length + 1 起。
  const firstPageId = objects.length + 1;
  const pageRefs: string[] = [];
  for (let i = 0; i < pageIds.length; i++) {
    const pid = firstPageId + i;
    pageRefs.push(`${pid} 0 R`);
  }
  // 写入 pages 节点
  const pagesNode = enc(
    `<< /Type /Pages /Kids [${pageRefs.join(' ')}] /Count ${pageIds.length} >>`,
  );
  const pagesNodeId = addObj(pagesNode); // == pagesId
  // 写入每个 page 节点
  for (let i = 0; i < pageIds.length; i++) {
    const node = enc(
      `<< /Type /Page /Parent ${pagesNodeId} 0 R /MediaBox [0 0 ${pages[i].w} ${pages[i].h}] ` +
        `/Resources << /XObject << /Im1 ${imgIds[i]} 0 R >> >> /Contents ${contentIds[i]} 0 R >>`,
    );
    addObj(node);
  }
  // catalog（须在 page 节点之后写入，故此刻 id 才是真实根对象号）
  const catalogId = objects.length + 1;
  addObj(enc(`<< /Type /Catalog /Pages ${pagesNodeId} 0 R >>`));

  // 组装文件
  const header = enc('%PDF-1.4\n');
  const parts: Uint8Array[] = [header];
  let offset = header.length;
  const offsets: number[] = [];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(offset);
    const objStr = enc(`${i + 1} 0 obj\n`);
    parts.push(objStr);
    offset += objStr.length;
    parts.push(objects[i]);
    offset += objects[i].length;
    const end = enc('\nendobj\n');
    parts.push(end);
    offset += end.length;
  }
  // xref
  const xref = enc(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`);
  const xrefStart = offset;
  parts.push(xref);
  offset += xref.length;
  for (let i = 0; i < objects.length; i++) {
    const o = enc(`${String(offsets[i]).padStart(10, '0')} 00000 n \n`);
    parts.push(o);
    offset += o.length;
  }
  const trailer = enc(`trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xrefStart}\n%%EOF`);
  parts.push(trailer);

  // 拼接
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let pos = 0;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}

async function exportPdf(slides: PptSlide[], title: string) {
  const srcs = Array.from(
    new Set(
      slides.flatMap((s) => s.elements.filter((e) => e.type === 'image').map((e) => (e as PptElement & { src?: string }).src || '')),
    ),
  ).filter(Boolean);
  const imgs = await preloadImages(srcs);
  const W = 1280;
  const H = 720;
  const scale = W / LOGICAL_W;
  const pages: { jpeg: Uint8Array; w: number; h: number }[] = [];
  for (const s of slides) {
    const blob = await renderSlideToJpeg(s, scale, imgs);
    const buf = new Uint8Array(await blob.arrayBuffer());
    // 去掉 data URL 头：直接是 JPEG 字节（含 FF D8 头），PDF DCTDecode 可直接用
    pages.push({ jpeg: buf, w: W, h: H });
  }
  const pdf = buildPdf(pages);
  const blob = new Blob([pdf as unknown as BlobPart], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${title || '演示文件'}.pdf`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function PptEditor({
  activeId,
  title,
  onPersist,
}: {
  activeId: string;
  title: string;
  onPersist: (id: string, slides: PptSlide[], sections?: PptSection[]) => void;
}) {
  const [slides, setSlides] = useState<PptSlide[]>([]);
  const [sections, setSections] = useState<PptSection[]>([]);
  const [activeSlide, setActiveSlide] = useState(0);
  const [selId, setSelId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [scale, setScale] = useState(0.6);
  const [presenting, setPresenting] = useState(false);
  const [presentIndex, setPresentIndex] = useState(0);
  const [guides, setGuides] = useState<Guide[]>([]);

  const slidesRef = useRef<PptSlide[]>(slides);
  slidesRef.current = slides;
  const sectionsRef = useRef<PptSection[]>(sections);
  sectionsRef.current = sections;
  const editingRef = useRef(editingId);
  editingRef.current = editingId;
  // 锁定自身文件 id，避免切换文件时把内容误存到其它 id
  const idRef = useRef(activeId);
  idRef.current = activeId;

  const areaRef = useRef<HTMLDivElement>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dragRef = useRef<{
    mode: 'move' | 'resize';
    id: string;
    sx: number;
    sy: number;
    ox: number;
    oy: number;
    ow: number;
    oh: number;
  } | null>(null);

  // ---- 载入（按 activeId）----
  useEffect(() => {
    const d = loadDoc(activeId);
    const content = d?.content as PptContent | undefined;
    const rawSlides =
      content?.slides && Array.isArray(content.slides) && content.slides.length
        ? content.slides
        : [blankSlide()];
    const secs = Array.isArray(content?.sections) ? content!.sections! : [];
    const validIds = new Set(secs.map((s) => s.id));
    // 丢弃指向已不存在章节的 sectionId，保证分组一致
    const sls = rawSlides.map((s) =>
      s.sectionId && validIds.has(s.sectionId) ? s : { ...s, sectionId: null },
    );
    setSlides(sls);
    setSections(secs);
    setActiveSlide(0);
    setSelId(null);
    setEditingId(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  // ---- 画布区域尺寸 → 计算缩放（保持 16:9 适配）----
  useEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    const update = () => {
      const pad = 32;
      const aw = el.clientWidth - pad;
      const ah = el.clientHeight - pad;
      const s = Math.max(0.1, Math.min(aw / LOGICAL_W, ah / LOGICAL_H));
      setScale(s);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ---- 卸载时落盘 ----
  useEffect(() => {
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      onPersist(idRef.current, slidesRef.current, sectionsRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 统一的持久化提交：同时写入 slides 与 sections（章节为扁平 slides 的嵌套元数据）
  const commit = useCallback(
    (nextSlides: PptSlide[], nextSections: PptSection[]) => {
      slidesRef.current = nextSlides;
      sectionsRef.current = nextSections;
      setSlides(nextSlides);
      setSections(nextSections);
      if (saveTimer.current) clearTimeout(saveTimer.current);
      const id = idRef.current;
      saveTimer.current = setTimeout(() => onPersist(id, nextSlides, nextSections), 600);
    },
    [onPersist],
  );

  const scheduleSave = useCallback(
    (nextSlides?: PptSlide[], nextSections?: PptSection[]) => {
      const s = nextSlides ?? slidesRef.current;
      const sec = nextSections ?? sectionsRef.current;
      commit(s, sec);
    },
    [commit],
  );

  const curSlide = slides[activeSlide];

  // 缩略图分块：按连续 sectionId 归组（类比「茑萝」母目录/子目录），形成可折叠的章节块。
  const sectionsById = new Map(sections.map((s) => [s.id, s]));
  const slideBlocks: { section: PptSection | null; slides: { slide: PptSlide; idx: number }[] }[] = [];
  slides.forEach((s, i) => {
    const sid = s.sectionId || null;
    const last = slideBlocks[slideBlocks.length - 1];
    if (last && (last.section?.id ?? null) === sid) {
      last.slides.push({ slide: s, idx: i });
    } else {
      slideBlocks.push({ section: sid ? sectionsById.get(sid) || null : null, slides: [{ slide: s, idx: i }] });
    }
  });

  const updateSlide = (mut: (s: PptSlide) => PptSlide) => {
    const next = slides.map((s, i) => (i === activeSlide ? mut(s) : s));
    scheduleSave(next);
  };
  const updateElement = (id: string, patch: Partial<PptElement>) => {
    updateSlide((s) => ({
      ...s,
      elements: s.elements.map((e) => (e.id === id ? { ...e, ...patch } : e)),
    }));
  };

  // ---- 幻灯片操作 ----
  const addSlide = () => {
    const idx = activeSlide + 1;
    const sec = curSlide?.sectionId ?? null;
    const next = [...slides];
    next.splice(idx, 0, { ...blankSlide(), sectionId: sec });
    setSlides(next);
    setActiveSlide(idx);
    setSelId(null);
    scheduleSave(next);
  };
  const deleteSlide = (i: number) => {
    if (slides.length <= 1) return;
    const next = slides.filter((_, j) => j !== i);
    // 清理已无任何幻灯片引用的空章节
    const used = new Set(next.map((s) => s.sectionId).filter(Boolean) as string[]);
    const nextSec = sections.filter((s) => used.has(s.id));
    setActiveSlide(Math.min(i, next.length - 1));
    setSelId(null);
    scheduleSave(next, nextSec);
  };
  const duplicateSlide = (i: number) => {
    const src = slides[i];
    const copy: PptSlide = {
      id: newId(),
      background: src.background,
      elements: src.elements.map((e) => ({ ...e, id: newId() })),
      sectionId: src.sectionId ?? null,
    };
    const next = [...slides];
    next.splice(i + 1, 0, copy);
    setSlides(next);
    setActiveSlide(i + 1);
    scheduleSave(next);
  };

  // ---- 章节（幻灯片栏一层嵌套，类比「茑萝」母目录/子目录）----
  const addSection = () => {
    const sec: PptSection = { id: newId(), title: `章节 ${sections.length + 1}` };
    const nextSec = [...sections, sec];
    // 把当前页及之后的幻灯片归入新章节（PPT「添加章节」语义：选中页起算）
    const next = slides.map((s, i) => (i >= activeSlide ? { ...s, sectionId: sec.id } : s));
    scheduleSave(next, nextSec);
  };
  const renameSection = (id: string) => {
    const cur = sections.find((s) => s.id === id);
    const name = window.prompt('章节名称', cur?.title || '');
    if (name == null) return;
    const t = name.trim() || '未命名章节';
    scheduleSave(slides, sections.map((s) => (s.id === id ? { ...s, title: t } : s)));
  };
  const deleteSection = (id: string) => {
    // 删除章节并把其幻灯片移出分组（sectionId 置空）
    const nextSec = sections.filter((s) => s.id !== id);
    const next = slides.map((s) => (s.sectionId === id ? { ...s, sectionId: null } : s));
    scheduleSave(next, nextSec);
  };
  const toggleSection = (id: string) => {
    scheduleSave(slides, sections.map((s) => (s.id === id ? { ...s, collapsed: !s.collapsed } : s)));
  };

  // ---- 元素操作 ----
  const addText = () => {
    const z = (curSlide?.elements.at(-1)?.z ?? 0) + 1;
    const el: PptElement = {
      id: newId(), type: 'text', x: 320, y: 220, w: 320, h: 100, z,
      text: '双击编辑文本', style: { fontSize: 28, color: '#1f2328', bold: false, italic: false, underline: false, align: 'left' },
    };
    updateSlide((s) => ({ ...s, elements: [...s.elements, el] }));
    setSelId(el.id);
  };
  const addImage = () => {
    const url = window.prompt('图片地址（http(s):// 或 data: 内嵌）', '');
    if (!url) return;
    const z = (curSlide?.elements.at(-1)?.z ?? 0) + 1;
    const el: PptElement = { id: newId(), type: 'image', x: 300, y: 160, w: 360, h: 220, z, src: url };
    updateSlide((s) => ({ ...s, elements: [...s.elements, el] }));
    setSelId(el.id);
  };
  const addShape = (shape: PptShapeKind) => {
    const z = (curSlide?.elements.at(-1)?.z ?? 0) + 1;
    const el: PptElement = {
      id: newId(), type: 'shape', shape, x: 360, y: 200, w: 240, h: shape === 'line' ? 0 : 140, z,
      fill: '#dbeafe', stroke: '#3b82f6', strokeWidth: 2,
    };
    updateSlide((s) => ({ ...s, elements: [...s.elements, el] }));
    setSelId(el.id);
  };
  const deleteElement = (id: string) => {
    updateSlide((s) => ({ ...s, elements: s.elements.filter((e) => e.id !== id) }));
    if (selId === id) setSelId(null);
  };
  const reorderElement = (id: string, dir: -1 | 1) => {
    updateSlide((s) => {
      const els = [...s.elements];
      const i = els.findIndex((e) => e.id === id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= els.length) return s;
      [els[i], els[j]] = [els[j], els[i]];
      return { ...s, elements: els };
    });
  };

  // ---- 导出 ----
  const exportPptx = async () => {
    try {
      const p = await save({
        defaultPath: title || '演示文件',
        filters: [{ name: 'PowerPoint 演示文稿', extensions: ['pptx'] }],
      });
      if (!p) return;
      const json = JSON.stringify({ slides });
      await hostApi.invoke('wps_export_pptx', { path: p, json });
      window.alert('已导出为 ' + p);
    } catch (e) {
      window.alert('导出失败：' + (e instanceof Error ? e.message : String(e)));
    }
  };
  const exportPdfLocal = async () => {
    try {
      await exportPdf(slides, title);
    } catch (e) {
      window.alert('PDF 导出失败：' + (e instanceof Error ? e.message : String(e)));
    }
  };
  const startPresent = () => {
    setPresentIndex(activeSlide);
    setPresenting(true);
  };

  // 导入 .pptx：调用原生 wps_import_pptx 解析为 JSON，载入到当前文件。
  const importPptx = async () => {
    try {
      const selected = await open({
        multiple: false,
        filters: [{ name: 'PowerPoint 演示文稿', extensions: ['pptx'] }],
      });
      if (typeof selected !== 'string' || !selected) return;
      const json = await hostApi.invoke<string>('wps_import_pptx', { path: selected });
      const content = JSON.parse(json) as PptContent;
      if (!content.slides || !Array.isArray(content.slides) || content.slides.length === 0) {
        window.alert('导入的演示文件中未找到幻灯片。');
        return;
      }
      const secs: PptSection[] = Array.isArray(content.sections) ? content.sections : [];
      slidesRef.current = content.slides;
      sectionsRef.current = secs;
      setSlides(content.slides);
      setSections(secs);
      setActiveSlide(0);
      setSelId(null);
      setEditingId(null);
      commit(content.slides, secs);
      window.alert(`已导入 ${content.slides.length} 张幻灯片。`);
    } catch (e) {
      window.alert('导入失败：' + (e instanceof Error ? e.message : String(e)));
    }
  };

  // ---- 拖拽 / 缩放 ----
  const onElPointerDown = (e: React.PointerEvent, el: PptElement) => {
    e.stopPropagation();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    setSelId(el.id);
    dragRef.current = { mode: 'move', id: el.id, sx: e.clientX, sy: e.clientY, ox: el.x, oy: el.y, ow: el.w, oh: el.h };
  };
  const onHandlePointerDown = (e: React.PointerEvent, el: PptElement) => {
    e.stopPropagation();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    setSelId(el.id);
    dragRef.current = { mode: 'resize', id: el.id, sx: e.clientX, sy: e.clientY, ox: el.x, oy: el.y, ow: el.w, oh: el.h };
  };
  const onStagePointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const dx = (e.clientX - d.sx) / scale;
    const dy = (e.clientY - d.sy) / scale;
    const others = (slidesRef.current[activeSlide]?.elements || []).filter((x) => x.id !== d.id);
    if (d.mode === 'move') {
      const { box, guides: g } = snapMove(
        { x: Math.max(0, d.ox + dx), y: Math.max(0, d.oy + dy), w: d.ow, h: d.oh },
        others,
        SNAP,
      );
      setGuides(g);
      updateElement(d.id, { x: Math.round(box.x), y: Math.round(box.y) });
    } else {
      const { box, guides: g } = snapResize(
        { x: d.ox, y: d.oy, w: Math.max(20, d.ow + dx), h: Math.max(20, d.oh + dy) },
        others,
        SNAP,
      );
      setGuides(g);
      updateElement(d.id, { w: Math.round(box.w), h: Math.round(box.h) });
    }
  };
  const onStagePointerUp = () => {
    if (!dragRef.current) return;
    dragRef.current = null;
    setGuides([]);
    scheduleSave(slidesRef.current);
  };

  // ---- 键盘：Delete 删除选中元素 ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (editingRef.current) return;
      if ((e.key === 'Delete' || e.key === 'Backspace') && selId) {
        e.preventDefault();
        deleteElement(selId);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selId]);

  const selEl = curSlide?.elements.find((e) => e.id === selId) || null;

  const toolbarBtn =
    'btn-press px-2.5 py-1 rounded-md text-xs flex items-center gap-1 transition-colors text-neutral-600 dark:text-stone-300 hover:bg-black/5 dark:hover:bg-white/10';

  return (
    <>
    <div className="flex-1 flex flex-col h-full min-h-0 bg-[#f5f5f0] dark:bg-[#1c1917]">
      {/* 顶栏 */}
      <div className="flex items-center gap-1 px-3 py-1.5 border-b border-white/70 dark:border-stone-700/50 flex-wrap shrink-0">
        <span className="text-sm font-medium text-neutral-700 dark:text-stone-200 mr-2 truncate max-w-[180px]">{title}</span>
        <span className="w-px h-5 bg-black/10 dark:bg-white/10 mx-1" />
        <button className={toolbarBtn} onClick={addText} title="插入文本框">文本</button>
        <button className={toolbarBtn} onClick={addImage} title="插入图片">图片</button>
        <button className={toolbarBtn} onClick={() => addShape('rect')} title="插入矩形">矩形</button>
        <button className={toolbarBtn} onClick={() => addShape('roundRect')} title="插入圆角矩形">圆角</button>
        <button className={toolbarBtn} onClick={() => addShape('ellipse')} title="插入椭圆">椭圆</button>
        <button className={toolbarBtn} onClick={() => addShape('triangle')} title="插入三角">三角</button>
        <button className={toolbarBtn} onClick={() => addShape('arrow')} title="插入箭头">箭头</button>
        <button className={toolbarBtn} onClick={() => addShape('line')} title="插入直线">直线</button>
        <span className="flex-1" />
        <button
          className={`${toolbarBtn} text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 disabled:opacity-40`}
          disabled={!selEl}
          onClick={() => selEl && deleteElement(selEl.id)}
          title="删除选中元素（Delete）"
        >删除</button>
        <span className="w-px h-5 bg-black/10 dark:bg-white/10 mx-1" />
        <button className={`${toolbarBtn} text-[var(--element-bg)] hover:bg-[var(--element-bg)]/10`} onClick={startPresent} title="从头放映（或当前页）">放映</button>
        <button className={`${toolbarBtn} hover:bg-black/5 dark:hover:bg-white/10`} onClick={importPptx} title="导入 .pptx 文件">导入PPTX</button>
        <button className={`${toolbarBtn} hover:bg-black/5 dark:hover:bg-white/10`} onClick={exportPptx} title="导出为 .pptx">导出PPTX</button>
        <button className={`${toolbarBtn} hover:bg-black/5 dark:hover:bg-white/10`} onClick={exportPdfLocal} title="导出为 .pdf">导出PDF</button>
      </div>

      <div className="flex-1 flex min-h-0">
        {/* 左侧：幻灯片缩略图条（按章节嵌套，可折叠） */}
        <div className="w-44 shrink-0 border-r border-white/70 dark:border-stone-700/50 flex flex-col min-h-0">
          <div className="flex items-center justify-between px-2 py-1.5 shrink-0">
            <span className="text-[11px] font-medium text-neutral-400 dark:text-stone-500">幻灯片</span>
            <div className="flex items-center gap-0.5">
              <button onClick={addSection} title="新建章节（把当前页起归入新章节）" className="h-6 px-1.5 rounded-md text-neutral-500 dark:text-stone-300 hover:bg-black/5 dark:hover:bg-white/10 flex items-center justify-center text-[11px]">章节</button>
              <button onClick={addSlide} title="新建幻灯片" className="h-6 w-6 rounded-md text-neutral-500 dark:text-stone-300 hover:bg-black/5 dark:hover:bg-white/10 flex items-center justify-center text-base leading-none">+</button>
            </div>
          </div>
          <div className="flex-1 overflow-auto px-2 pb-2 space-y-1.5 min-h-0">
            {slideBlocks.map((block, bi) => {
              const sec = block.section;
              const collapsed = !!sec?.collapsed;
              return (
                <div key={sec ? sec.id : `__u${bi}`} className="space-y-1.5">
                  {sec && (
                    <div className="flex items-center gap-1 px-0.5 pt-1">
                      <button
                        onClick={() => toggleSection(sec.id)}
                        title={collapsed ? '展开' : '收起'}
                        className="w-4 h-4 rounded text-neutral-400 dark:text-stone-500 hover:bg-black/5 dark:hover:bg-white/10 flex items-center justify-center text-[10px]"
                      >{collapsed ? '▸' : '▾'}</button>
                      <span className="text-[11px] font-semibold text-neutral-500 dark:text-stone-400 flex-1 truncate">{sec.title}</span>
                      <button onClick={() => renameSection(sec.id)} title="重命名章节" className="text-[10px] text-neutral-400 hover:text-neutral-700 dark:hover:text-stone-200">✎</button>
                      <button onClick={() => deleteSection(sec.id)} title="删除章节（幻灯片移出分组）" className="text-[10px] text-neutral-400 hover:text-red-500">✕</button>
                    </div>
                  )}
                  {!collapsed && block.slides.map(({ slide: s, idx: i }) => (
                    <div key={s.id} className={`relative group ${sec ? 'ml-3' : ''}`}>
                      <PptThumb slide={s} scale={0.075} active={i === activeSlide} onClick={() => { setActiveSlide(i); setSelId(null); }} />
                      <span className="absolute top-0.5 left-1 text-[10px] text-neutral-500 dark:text-stone-400 tabular-nums">{i + 1}</span>
                      <div className="absolute top-0.5 right-0.5 flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button
                          onClick={(e) => { e.stopPropagation(); duplicateSlide(i); }}
                          title="复制幻灯片"
                          className="h-4 w-4 rounded text-[10px] bg-black/50 text-white flex items-center justify-center hover:bg-black/70"
                        >⧉</button>
                        <button
                          onClick={(e) => { e.stopPropagation(); deleteSlide(i); }}
                          title="删除幻灯片"
                          disabled={slides.length <= 1}
                          className="h-4 w-4 rounded text-[10px] bg-red-500/80 text-white flex items-center justify-center hover:bg-red-500 disabled:opacity-30"
                        >✕</button>
                      </div>
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        </div>

        {/* 中央：编辑画布 */}
        <div ref={areaRef} className="flex-1 overflow-hidden flex items-center justify-center bg-neutral-200/60 dark:bg-stone-800/60 p-4 min-w-0"
          onPointerDown={() => { setSelId(null); setEditingId(null); }}
          onPointerMove={onStagePointerMove}
          onPointerUp={onStagePointerUp}
        >
          {curSlide && (
            <div
              className="relative shadow-xl bg-white select-none"
              style={{ width: LOGICAL_W * scale, height: LOGICAL_H * scale, background: curSlide.background }}
              onPointerDown={(e) => e.stopPropagation()}
            >
              {curSlide.elements.map((el) => {
                const selected = el.id === selId;
                const common: React.CSSProperties = {
                  position: 'absolute',
                  left: el.x * scale,
                  top: el.y * scale,
                  width: el.w * scale,
                  height: el.h * scale,
                };
                let visual: React.ReactNode;
                if (el.type === 'text') {
                  const st = el.style || { fontSize: 24, color: '#000' };
                  visual = editingId === el.id ? (
                    <textarea
                      autoFocus
                      value={el.text || ''}
                      onPointerDown={(e) => e.stopPropagation()}
                      onChange={(e) => updateElement(el.id, { text: e.target.value })}
                      onBlur={() => { setEditingId(null); scheduleSave(slidesRef.current); }}
                      className="w-full h-full resize-none bg-transparent outline-none border-none p-1"
                      style={{ fontSize: st.fontSize * scale, color: st.color, fontWeight: st.bold ? 700 : 400, fontStyle: st.italic ? 'italic' : 'normal', textDecoration: st.underline ? 'underline' : 'none', textAlign: st.align }}
                    />
                  ) : (
                    <div
                      className="w-full h-full overflow-hidden whitespace-pre-wrap break-words p-1"
                      style={{
                        fontSize: st.fontSize * scale,
                        color: st.color,
                        fontWeight: st.bold ? 700 : 400,
                        fontStyle: st.italic ? 'italic' : 'normal',
                        textDecoration: st.underline ? 'underline' : 'none',
                        textAlign: st.align,
                        display: 'flex',
                        alignItems: st.align === 'center' ? 'center' : st.align === 'right' ? 'flex-end' : 'flex-start',
                        lineHeight: 1.3,
                      }}
                    >{el.text}</div>
                  );
                } else if (el.type === 'image') {
                  visual = <img src={el.src} draggable={false} className="w-full h-full object-fill pointer-events-none" alt="" />;
                } else {
                  // shape
                  const s: Record<string, string | number> = { width: '100%', height: '100%', boxSizing: 'border-box' };
                  if (el.shape === 'line') {
                    s.background = el.stroke || '#000';
                    s.height = Math.max(1, (el.strokeWidth ?? 2) * scale);
                  } else {
                    s.background = el.fill || 'transparent';
                    s.border = `${(el.strokeWidth ?? 2) * scale}px solid ${el.stroke || '#000'}`;
                    if (el.shape === 'ellipse') s.borderRadius = '50%';
                  }
                  visual = <div style={s} className="pointer-events-none" />;
                }
                return (
                  <div
                    key={el.id}
                    style={common}
                    className={`${el.type === 'text' && editingId === el.id ? '' : 'cursor-move'} ${selected ? 'outline outline-2 outline-[var(--element-bg)]' : ''}`}
                    onPointerDown={(e) => onElPointerDown(e, el)}
                    onDoubleClick={(e) => { if (el.type === 'text') { e.stopPropagation(); setEditingId(el.id); } }}
                  >
                    {visual}
                    {selected && el.type !== 'text' && (
                      <div
                        onPointerDown={(e) => onHandlePointerDown(e, el)}
                        className="absolute -bottom-1.5 -right-1.5 w-3 h-3 bg-white border-2 border-[var(--element-bg)] rounded-sm cursor-nwse-resize"
                        style={{ touchAction: 'none' }}
                      />
                    )}
                  </div>
                );
              })}
              {/* 吸附参考线 */}
              {guides.map((g, i) =>
                g.axis === 'x' ? (
                  <div key={i} className="pointer-events-none absolute top-0 bottom-0 w-px bg-[var(--element-bg)]/70 z-[60]" style={{ left: g.pos * scale }} />
                ) : (
                  <div key={i} className="pointer-events-none absolute left-0 right-0 h-px bg-[var(--element-bg)]/70 z-[60]" style={{ top: g.pos * scale }} />
                ),
              )}
            </div>
          )}
        </div>

        {/* 右侧：属性面板 */}
        <div className="w-60 shrink-0 border-l border-white/70 dark:border-stone-700/50 overflow-auto p-3 space-y-3 min-h-0">
          {/* 幻灯片背景 */}
          <div>
            <div className="text-[11px] font-medium text-neutral-400 dark:text-stone-500 mb-1">幻灯片背景</div>
            <div className="flex items-center gap-2">
              <input
                type="color"
                value={curSlide?.background || '#ffffff'}
                onChange={(e) => updateSlide((s) => ({ ...s, background: e.target.value }))}
                className="w-8 h-8 rounded cursor-pointer bg-transparent border border-black/10"
              />
              <span className="text-[11px] text-neutral-500 dark:text-stone-400">{curSlide?.background}</span>
              <button
                onClick={() => {
                  const bg = curSlide?.background || '#ffffff';
                  setSlides((prev) => {
                    const next = prev.map((s) => ({ ...s, background: bg }));
                    scheduleSave(next);
                    return next;
                  });
                }}
                title="将本页背景应用到所有幻灯片"
                className="ml-auto text-[11px] px-1.5 py-0.5 rounded bg-black/5 dark:bg-white/10 hover:bg-black/10 dark:hover:bg-white/20"
              >应用到全部</button>
            </div>
            <div className="mt-2">
              <div className="text-[11px] font-medium text-neutral-400 dark:text-stone-500 mb-1">切换动画</div>
              <div className="flex items-center gap-1">
                {(['fade', 'slide', 'none'] as const).map((t) => (
                  <button
                    key={t}
                    onClick={() => updateSlide((s) => ({ ...s, transition: t }))}
                    className={`h-7 px-2 rounded text-xs ${curSlide?.transition === t || (!curSlide?.transition && t === 'fade') ? 'bg-[var(--element-bg)]/15 text-[var(--element-bg)]' : 'text-neutral-600 dark:text-stone-300 hover:bg-black/5 dark:hover:bg-white/10'}`}
                    title={t === 'fade' ? '淡入' : t === 'slide' ? '滑动' : '无'}
                  >{t === 'fade' ? '淡入' : t === 'slide' ? '滑动' : '无'}</button>
                ))}
              </div>
            </div>
          </div>

          {selEl ? (
            <>
              <div className="border-t border-black/5 dark:border-white/5 pt-2" />
              <div>
                <div className="text-[11px] font-medium text-neutral-400 dark:text-stone-500 mb-1">位置与尺寸</div>
                <div className="grid grid-cols-2 gap-2">
                  {(['x', 'y', 'w', 'h'] as const).map((k) => (
                    <label key={k} className="flex items-center gap-1">
                      <span className="text-[11px] text-neutral-500 dark:text-stone-400 w-3 uppercase">{k}</span>
                      <input
                        type="number"
                        value={Math.round(selEl[k])}
                        onChange={(e) => updateElement(selEl.id, { [k]: Math.max(0, parseInt(e.target.value || '0', 10)) } as Partial<PptElement>)}
                        className="w-full min-w-0 px-1.5 py-1 rounded border border-black/10 dark:border-white/10 bg-white dark:bg-stone-800 text-[12px]"
                      />
                    </label>
                  ))}
                </div>
              </div>

              {selEl.type === 'text' && (
                <>
                  <div className="border-t border-black/5 dark:border-white/5 pt-2" />
                  <div>
                    <div className="text-[11px] font-medium text-neutral-400 dark:text-stone-500 mb-1">文本</div>
                    <textarea
                      value={selEl.text || ''}
                      onChange={(e) => updateElement(selEl.id, { text: e.target.value })}
                      className="w-full h-20 resize-none rounded border border-black/10 dark:border-white/10 bg-white dark:bg-stone-800 text-[12px] p-1.5"
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <label className="text-[11px] text-neutral-500 dark:text-stone-400">字号</label>
                    <input
                      type="number"
                      min={8}
                      value={selEl.style?.fontSize ?? 24}
                      onChange={(e) => updateElement(selEl.id, { style: { ...(selEl.style || { fontSize: 24, color: '#000' }), fontSize: Math.max(8, parseInt(e.target.value || '8', 10)) } })}
                      className="w-16 px-1.5 py-1 rounded border border-black/10 dark:border-white/10 bg-white dark:bg-stone-800 text-[12px]"
                    />
                    <input
                      type="color"
                      value={selEl.style?.color || '#000000'}
                      onChange={(e) => updateElement(selEl.id, { style: { ...(selEl.style || { fontSize: 24, color: '#000' }), color: e.target.value } })}
                      className="w-7 h-7 rounded cursor-pointer bg-transparent border border-black/10"
                    />
                  </div>
                  <div className="flex items-center gap-1">
                    {(['bold', 'italic', 'underline'] as const).map((f) => (
                      <button
                        key={f}
                        onClick={() => updateElement(selEl.id, { style: { ...(selEl.style || { fontSize: 24, color: '#000' }), [f]: !selEl.style?.[f] } })}
                        className={`h-7 w-7 rounded text-sm ${selEl.style?.[f] ? 'bg-[var(--element-bg)]/15 text-[var(--element-bg)]' : 'text-neutral-600 dark:text-stone-300 hover:bg-black/5 dark:hover:bg-white/10'}`}
                        title={f}
                      >
                        {f === 'bold' ? 'B' : f === 'italic' ? 'I' : 'U'}
                      </button>
                    ))}
                    {(['left', 'center', 'right'] as const).map((a) => (
                      <button
                        key={a}
                        onClick={() => updateElement(selEl.id, { style: { ...(selEl.style || { fontSize: 24, color: '#000' }), align: a } })}
                        className={`h-7 px-2 rounded text-xs ${selEl.style?.align === a ? 'bg-[var(--element-bg)]/15 text-[var(--element-bg)]' : 'text-neutral-600 dark:text-stone-300 hover:bg-black/5 dark:hover:bg-white/10'}`}
                        title={`对齐 ${a}`}
                      >
                        {a === 'left' ? '⇤' : a === 'center' ? '≡' : '⇥'}
                      </button>
                    ))}
                  </div>
                </>
              )}

              {selEl.type === 'shape' && (
                <>
                  <div className="border-t border-black/5 dark:border-white/5 pt-2" />
                  <div className="text-[11px] font-medium text-neutral-400 dark:text-stone-500 mb-1">形状</div>
                  <div className="flex items-center gap-1 flex-wrap">
                    {SHAPE_KINDS.map((k) => (
                      <button
                        key={k}
                        onClick={() => updateElement(selEl.id, { shape: k })}
                        className={`h-7 px-2 rounded text-xs ${selEl.shape === k ? 'bg-[var(--element-bg)]/15 text-[var(--element-bg)]' : 'text-neutral-600 dark:text-stone-300 hover:bg-black/5 dark:hover:bg-white/10'}`}
                        title={SHAPE_LABEL[k]}
                      >{SHAPE_LABEL[k]}</button>
                    ))}
                  </div>
                  <div className="flex items-center gap-2 mt-2">
                    <label className="text-[11px] text-neutral-500 dark:text-stone-400">填充</label>
                    <input type="color" value={el0(selEl.fill)} disabled={selEl.shape === 'line'} onChange={(e) => updateElement(selEl.id, { fill: e.target.value })} className="w-7 h-7 rounded cursor-pointer bg-transparent border border-black/10 disabled:opacity-40" />
                    <label className="text-[11px] text-neutral-500 dark:text-stone-400 ml-2">描边</label>
                    <input type="color" value={el0(selEl.stroke)} onChange={(e) => updateElement(selEl.id, { stroke: e.target.value })} className="w-7 h-7 rounded cursor-pointer bg-transparent border border-black/10" />
                  </div>
                  {selEl.shape !== 'line' && (
                    <label className="flex items-center gap-2 mt-2">
                      <span className="text-[11px] text-neutral-500 dark:text-stone-400">线宽</span>
                      <input type="number" min={0} value={selEl.strokeWidth ?? 2} onChange={(e) => updateElement(selEl.id, { strokeWidth: Math.max(0, parseInt(e.target.value || '0', 10)) })} className="w-16 px-1.5 py-1 rounded border border-black/10 dark:border-white/10 bg-white dark:bg-stone-800 text-[12px]" />
                    </label>
                  )}
                </>
              )}

              <div className="border-t border-black/5 dark:border-white/5 pt-2" />
              <div className="flex items-center gap-1">
                <button onClick={() => reorderElement(selEl.id, 1)} className={`${toolbarBtn} flex-1 justify-center`} title="上移一层">上移</button>
                <button onClick={() => reorderElement(selEl.id, -1)} className={`${toolbarBtn} flex-1 justify-center`} title="下移一层">下移</button>
              </div>
              <button onClick={() => deleteElement(selEl.id)} className="w-full h-7 rounded-md text-xs text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20">删除元素</button>
            </>
          ) : (
            <div className="text-[12px] text-neutral-400 dark:text-stone-500 mt-4 leading-relaxed">
              选中元素可编辑其文本、字体、颜色、位置与尺寸；拖拽移动，右下角手柄缩放。双击文本进入编辑。
            </div>
          )}
        </div>
      </div>
    </div>
    {presenting && <PresentMode slides={slides} start={presentIndex} onExit={() => setPresenting(false)} />}
    </>
  );
}

// 颜色输入不允许空值
function el0(v?: string): string {
  return v && /^#[0-9a-fA-F]{6}$/.test(v) ? v : '#000000';
}

export default PptEditor;
