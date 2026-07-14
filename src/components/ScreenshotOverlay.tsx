import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { X, Save, Undo2, Eraser, Pen, Square, ArrowUpRight, Type, Trash2, StretchVertical } from "lucide-react";
import { emitDropzoneChange } from "@/components/TransferStationPanel";

interface Win {
  hwnd: number;
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface ScreenshotOverlayProps {
  /** 预览图（降采样 JPEG，分辨率 == 窗口 CSS 像素，故「图像像素 ≡ CSS 像素」） */
  image: string;
  /** 覆盖窗真实原点（物理像素），用于把 CSS 坐标换算回物理/原生坐标 */
  ox: number;
  oy: number;
  /** 覆盖窗 scale_factor（物理/逻辑比） */
  scale: number;
  /** 可见窗口矩形（物理像素坐标） */
  windows: Win[];
  /** 触发截图时主窗口所在的笔记 id（空串表示不在笔记页） */
  noteId?: string;
  /** 关闭（丢弃截图） */
  onClose: () => void;
}

type Tool = "pen" | "eraser" | "rect" | "arrow" | "text";

const GREEN = "rgba(74, 222, 128, 0.95)";

/** 把画布导出为 PNG 字节（用于标注层回传，透明区域压缩后极小）。 */
const canvasToPng = (c: HTMLCanvasElement): Promise<Uint8Array> =>
  new Promise((resolve, reject) => {
    c.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error("标注层 toBlob 失败"));
          return;
        }
        blob.arrayBuffer().then((b) => resolve(new Uint8Array(b))).catch(reject);
      },
      "image/png",
    );
  });

export function ScreenshotOverlay({ image, ox, oy, scale, windows, noteId, onClose }: ScreenshotOverlayProps) {
  const [ready, setReady] = useState(false);
  const [mode, setMode] = useState<"select" | "edit">("select");
  const [longMode, setLongMode] = useState(false); // 长截图：窗口挑选态
  const [isLong, setIsLong] = useState(false); // 当前编辑的是长截图（整窗）
  const [hoverHwnd, setHoverHwnd] = useState<number | null>(null);
  // 窗口标题懒加载缓存：枚举时不再读标题（避免跨线程阻塞导致截图卡 4-5s），悬停时按需拉取单个窗口标题
  const [titleMap, setTitleMap] = useState<Record<number, string>>({});

  const fullImgRef = useRef<HTMLImageElement | null>(null);
  const offRef = useRef<HTMLCanvasElement | null>(null); // 放大镜源（预览原图）
  const captureRef = useRef<HTMLDivElement | null>(null);

  // 选择态拖拽矩形（CSS 像素，== 图像像素）
  const dragRef = useRef<{ x0: number; y0: number; x1: number; y1: number; aspect?: number } | null>(null);
  // 按下时的候选信息：起点 + 命中的窗口 + 是否已转为拖拽。用于区分「干净单击窗口」与「拖拽框选」
  const pendingRef = useRef<{ x0: number; y0: number; win: Win | null; dragging: boolean } | null>(null);
  // 保存/复制防重入：避免卡顿时用户连点导致重复生成多张截图
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  // 标注脏标记：进入编辑态后是否真正画过标注（用于决定走「原生裁剪快路径」还是「画布合成路径」）
  const dirtyRef = useRef(false);
  const [selRect, setSelRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [mag, setMag] = useState<{ x: number; y: number; show: boolean }>({ x: 0, y: 0, show: false });

  // 编辑态
  const baseRef = useRef<HTMLCanvasElement | null>(null);           // 预览分辨率底图（用于 UI 显示/编辑）
  const baseNativeRef = useRef<HTMLCanvasElement | null>(null);     // 原生分辨率底图（用于保存时合成，消除标注分辨率降级）
  const drawRef = useRef<HTMLCanvasElement | null>(null);
  const [tool, setTool] = useState<Tool>("pen");
  const [color, setColor] = useState("#ef4444");
  const [size, setSize] = useState(4);
  const undoRef = useRef<string[]>([]);
  const drawStateRef = useRef<{ drawing: boolean; sx: number; sy: number }>({ drawing: false, sx: 0, sy: 0 });
  const [, force] = useState(0);

  const textInputRef = useRef<HTMLInputElement | null>(null);
  const [textInputPos, setTextInputPos] = useState<{ x: number; y: number } | null>(null);

  // 选区在「原生物理像素」下的矩形（保存时用于 crop_native 重裁，保证清晰）
  const selNativeRef = useRef<{ x: number; y: number; w: number; h: number } | null>(null);
  const longImgRef = useRef<{ url: string; w: number; h: number } | null>(null);
  // 长截图原始 PNG 字节（capture_window_full 返回），无标注时直接用它保存，省去画布重编码
  const longBytesRef = useRef<Uint8Array | null>(null);

  // 载入整屏预览图，并构建放大镜源画布
  useEffect(() => {
    const img = new Image();
    img.onload = () => {
      fullImgRef.current = img;
      const off = document.createElement("canvas");
      off.width = img.naturalWidth;
      off.height = img.naturalHeight;
      const octx = off.getContext("2d");
      if (octx) octx.drawImage(img, 0, 0);
      offRef.current = off;
      setReady(true);
    };
    // 预览解码失败：直接关闭覆盖窗，避免永久停留在白色 loading 态（假死）
    img.onerror = () => {
      console.error("[截图] 预览图解码失败，关闭覆盖窗");
      onClose();
    };
    img.src = image;
  }, [image, onClose]);

  // CSS 坐标 → 物理坐标
  const toPhys = useCallback(
    (cx: number, cy: number) => ({ x: ox + cx * scale, y: oy + cy * scale }),
    [ox, oy, scale],
  );

  // 命中窗口（取光标下面积最小者）
  const hitWindow = useCallback(
    (cx: number, cy: number): Win | null => {
      const p = toPhys(cx, cy);
      let best: Win | null = null;
      let bestArea = Infinity;
      for (const w of windows) {
        if (p.x >= w.x && p.x <= w.x + w.width && p.y >= w.y && p.y <= w.y + w.height) {
          const area = w.width * w.height;
          if (area < bestArea) {
            bestArea = area;
            best = w;
          }
        }
      }
      return best;
    },
    [windows, toPhys],
  );

  // 悬停窗口时按需拉取标题（单次、Rust 侧 30ms 超时、绝不阻塞截图路径）
  useEffect(() => {
    if (hoverHwnd == null || titleMap[hoverHwnd] !== undefined) return;
    let cancelled = false;
    invoke<string>("get_window_title", { hwnd: hoverHwnd })
      .then((t) => {
        if (!cancelled) setTitleMap((m) => ({ ...m, [hoverHwnd]: t }));
      })
      .catch(() => {
        if (!cancelled) setTitleMap((m) => ({ ...m, [hoverHwnd]: "" }));
      });
    return () => {
      cancelled = true;
    };
  }, [hoverHwnd, titleMap]);

  // Esc 取消 / Enter 确认 / 方向键微调选区
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (longMode) {
          setLongMode(false);
          setIsLong(false);
        } else {
          onClose();
        }
        return;
      }
      if (mode === "select" && selRect) {
        if (e.key === "Enter") {
          commitCrop(selRect);
          return;
        }
        // 方向键微调选区位置（逻辑像素）
        const step = e.shiftKey ? 10 : 1;
        const map: Record<string, [number, number]> = {
          ArrowLeft: [-step, 0],
          ArrowRight: [step, 0],
          ArrowUp: [0, -step],
          ArrowDown: [0, step],
        };
        if (map[e.key]) {
          e.preventDefault();
          const [dx, dy] = map[e.key];
          setSelRect((r) => (r ? { ...r, x: r.x + dx, y: r.y + dy } : r));
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, selRect, longMode]);

  // 进入编辑态：构建选区底图（预览分辨率），并建立原生坐标
  const commitCrop = useCallback(
    (rect: { x: number; y: number; w: number; h: number }) => {
      const img = fullImgRef.current;
      if (!img) return;
      // 预览图实际分辨率（原生物理像素）与覆盖窗 CSS 宽度的比值。
      // 关键：read_screenshot 自 Issue6 起返回原生物理分辨率（不再降采样到 CSS），
      // 故「图像像素 ≠ CSS 像素」。必须用 ps 把 CSS 选区坐标换算到预览图像坐标，
      // 否则在 scale>1 的高 DPI 屏上会采样到错误的（更小）区域，导致选区被放大 / 左移显示。
      const cssW = window.innerWidth || img.naturalWidth;
      const ps = img.naturalWidth / cssW;
      const cw = Math.max(1, Math.round(rect.w * ps));
      const ch = Math.max(1, Math.round(rect.h * ps));
      const c = document.createElement("canvas");
      c.width = cw;
      c.height = ch;
      const ctx = c.getContext("2d");
      if (!ctx) return;
      // 按缩放比用「物理坐标」从原图截取该区域（canvas 物理像素 → 显示 CSS 像素 1:1，清晰且无放大）
      ctx.drawImage(img, -rect.x * ps, -rect.y * ps);
      baseRef.current = c;
      undoRef.current = [];
      setSelRect(rect);
      dragRef.current = null;
      // 原生坐标（物理像素），用于保存时 crop_native 重裁
      const p = toPhys(rect.x, rect.y);
      selNativeRef.current = {
        x: Math.round(p.x),
        y: Math.round(p.y),
        w: Math.round(rect.w * scale),
        h: Math.round(rect.h * scale),
      };
      setIsLong(false);
      dirtyRef.current = false;
      setMode("edit");
      // 异步拉取原生分辨率底图（保存标注时使用）；不阻塞 UI。
      fetchBaseNative();
      force((n) => n + 1);
    },
    [toPhys, scale],
  );

  // 从 Rust 端拉取「原生物理像素裁剪」，构造 baseNativeRef，用于标注保存时的高分辨率合成。
  const fetchBaseNative = async () => {
    const n = selNativeRef.current;
    if (!n) return;
    try {
      const buf = await invoke<ArrayBuffer>("crop_native_rgba", {
        x: n.x,
        y: n.y,
        w: n.w,
        h: n.h,
      });
      const rgba = new Uint8Array(buf);
      const c = document.createElement("canvas");
      c.width = n.w;
      c.height = n.h;
      const ctx = c.getContext("2d");
      if (!ctx) return;
      const imgData = new ImageData(new Uint8ClampedArray(rgba.buffer), n.w, n.h);
      ctx.putImageData(imgData, 0, 0);
      baseNativeRef.current = c;
    } catch {
      // 拉取失败时回退到预览分辨率（composeBytes 自动降级）
      baseNativeRef.current = null;
    }
  };

  // 长截图：捕获整窗完整内容，进入编辑态
  const captureLong = useCallback(
    async (hwnd: number) => {
      try {
        const buf = await invoke<ArrayBuffer>("capture_window_full", { hwnd });
        longBytesRef.current = new Uint8Array(buf.slice(0));
        const url = URL.createObjectURL(new Blob([buf], { type: "image/png" }));
        const img = new Image();
        img.onload = () => {
          const c = document.createElement("canvas");
          c.width = img.naturalWidth;
          c.height = img.naturalHeight;
          const ctx = c.getContext("2d");
          if (ctx) ctx.drawImage(img, 0, 0);
          baseRef.current = c;
          undoRef.current = [];
          longImgRef.current = { url, w: img.naturalWidth, h: img.naturalHeight };
          dirtyRef.current = false;
          setSelRect(null);
          setLongMode(false);
          setIsLong(true);
          setMode("edit");
          force((n) => n + 1);
        };
        img.src = url;
      } catch (err) {
        console.error("[截图] 长截图失败:", err);
        // 失败/超时后退出长截图挑选态，避免覆盖窗卡在选择态无法操作
        setLongMode(false);
        setIsLong(false);
      }
    },
    [],
  );

  // ====== 选择态交互 ======
  const onPointerDown = (e: React.PointerEvent) => {
    if (mode !== "select") return;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const x = e.clientX;
    const y = e.clientY;
    if (longMode) {
      const w = hitWindow(x, y);
      if (w) captureLong(w.hwnd);
      return;
    }
    const w = hitWindow(x, y);
    pendingRef.current = { x0: x, y0: y, win: w, dragging: false };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (mode !== "select") return;
    const x = e.clientX;
    const y = e.clientY;
    setMag({ x, y, show: true });
    const p = pendingRef.current;
    if (p && !p.dragging) {
      const dx = x - p.x0;
      const dy = y - p.y0;
      // 超过阈值才判定为「拖拽框选」（即使起点在窗口上也转为自由截图）；
      // 否则保持悬停高亮、不提前画选区 —— 保证「干净单击窗口」能稳定触发整窗捕获。
      if (Math.abs(dx) > 5 || Math.abs(dy) > 5) {
        p.dragging = true;
        dragRef.current = { x0: p.x0, y0: p.y0, x1: x, y1: y, aspect: undefined };
      } else {
        const w = hitWindow(x, y);
        setHoverHwnd(w ? w.hwnd : null);
        return;
      }
    }
    if (dragRef.current) {
      const { x0, y0 } = dragRef.current;
      let cx = x;
      let cy = y;
      // Shift 锁定长宽比（以起点为锚，取位移较大边）
      if (e.shiftKey && dragRef.current.aspect === undefined && Math.abs(x - x0) > 4 && Math.abs(y - y0) > 4) {
        dragRef.current.aspect = Math.abs((y - y0) / (x - x0 || 1));
      }
      if (dragRef.current.aspect !== undefined) {
        const a = dragRef.current.aspect;
        const dirX = x >= x0 ? 1 : -1;
        const dirY = y >= y0 ? 1 : -1;
        const dx2 = Math.abs(x - x0);
        let dy2 = dx2 * a;
        cx = x0 + dirX * dx2;
        cy = y0 + dirY * dy2;
      }
      dragRef.current.x1 = cx;
      dragRef.current.y1 = cy;
      setSelRect({
        x: Math.min(x0, cx),
        y: Math.min(y0, cy),
        w: Math.abs(cx - x0),
        h: Math.abs(cy - y0),
      });
    } else {
      const w = hitWindow(x, y);
      setHoverHwnd(w ? w.hwnd : null);
    }
  };

  const onPointerUp = () => {
    if (mode !== "select") return;
    const p = pendingRef.current;
    const drag = dragRef.current;
    pendingRef.current = null;
    dragRef.current = null;
    setMag((m) => ({ ...m, show: false }));
    if (!p) return;
    if (p.win && !p.dragging) {
      // 干净单击窗口 → 整窗截取：窗口矩形是物理像素，需换算成覆盖窗 CSS 像素（÷scale）再截取，避免放大偏移
      commitCrop({
        x: (p.win.x - ox) / scale,
        y: (p.win.y - oy) / scale,
        w: p.win.width / scale,
        h: p.win.height / scale,
      });
      return;
    }
    if (drag) {
      const { x0, y0, x1, y1 } = drag;
      const w = Math.abs(x1 - x0);
      const h = Math.abs(y1 - y0);
      if (w > 12 && h > 12) {
        commitCrop({ x: Math.min(x0, x1), y: Math.min(y0, y1), w, h });
      } else {
        setSelRect(null);
      }
    } else {
      setSelRect(null);
    }
  };

  // ====== 编辑态绘制 ======
  const snapshot = () => {
    if (drawRef.current) undoRef.current.push(drawRef.current.toDataURL());
  };
  const restore = (dataUrl: string | null) => {
    const d = drawRef.current;
    if (!d) return;
    const ctx = d.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, d.width, d.height);
    if (dataUrl) {
      const img = new Image();
      img.onload = () => ctx.drawImage(img, 0, 0);
      img.src = dataUrl;
    }
  };

  const drawShapePreview = (x1: number, y1: number) => {
    const d = drawRef.current;
    const base = baseRef.current;
    if (!d || !base) return;
    const ctx = d.getContext("2d");
    if (!ctx) return;
    const last = undoRef.current[undoRef.current.length - 1];
    ctx.clearRect(0, 0, d.width, d.height);
    if (last) {
      const img = new Image();
      img.onload = () => ctx.drawImage(img, 0, 0);
      img.src = last;
    }
    drawAnnotation(ctx, tool, drawStateRef.current.sx, drawStateRef.current.sy, x1, y1, color, size);
  };

  const onDrawDown = (e: React.PointerEvent) => {
    const d = drawRef.current;
    if (!d) return;
    const rect = d.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * d.width;
    const y = ((e.clientY - rect.top) / rect.height) * d.height;
    if (tool === "text") {
      setTextInputPos({ x: e.clientX, y: e.clientY });
      setTimeout(() => textInputRef.current?.focus(), 50);
      return;
    }
    drawStateRef.current = { drawing: true, sx: x, sy: y };
    (e.target as Element).setPointerCapture?.(e.pointerId);
    if (tool === "pen" || tool === "eraser") {
      dirtyRef.current = true;
      const ctx = d.getContext("2d");
      if (ctx) {
        ctx.globalCompositeOperation = tool === "eraser" ? "destination-out" : "source-over";
        ctx.strokeStyle = color;
        ctx.lineWidth = size;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + 0.1, y + 0.1);
        ctx.stroke();
      }
    } else {
      snapshot();
    }
  };

  const onDrawMove = (e: React.PointerEvent) => {
    if (!drawStateRef.current.drawing) return;
    const d = drawRef.current;
    if (!d) return;
    const rect = d.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * d.width;
    const y = ((e.clientY - rect.top) / rect.height) * d.height;
    const ctx = d.getContext("2d");
    if (!ctx) return;
    if (tool === "pen" || tool === "eraser") {
      ctx.globalCompositeOperation = tool === "eraser" ? "destination-out" : "source-over";
      ctx.strokeStyle = color;
      ctx.lineWidth = size;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.lineTo(x, y);
      ctx.stroke();
    } else {
      drawShapePreview(x, y);
      dirtyRef.current = true;
    }
  };

  const onDrawUp = () => {
    if (!drawStateRef.current.drawing) return;
    drawStateRef.current.drawing = false;
    const d = drawRef.current;
    if (d && (tool === "pen" || tool === "eraser")) snapshot();
    force((n) => n + 1);
  };

  const confirmText = () => {
    const d = drawRef.current;
    const pos = textInputPos;
    if (!d || !pos) return;
    const rect = d.getBoundingClientRect();
    const x = ((pos.x - rect.left) / rect.width) * d.width;
    const y = ((pos.y - rect.top) / rect.height) * d.height;
    const text = textInputRef.current?.value.trim();
    if (text) {
      const ctx = d.getContext("2d");
      if (ctx) {
        snapshot();
        ctx.font = `${Math.max(12, size * 5)}px sans-serif`;
        ctx.fillStyle = color;
        ctx.textBaseline = "top";
        ctx.fillText(text, x, y);
        dirtyRef.current = true;
        force((n) => n + 1);
      }
    }
    setTextInputPos(null);
  };

  const undo = () => {
    undoRef.current.pop();
    restore(undoRef.current[undoRef.current.length - 1] ?? null);
    force((n) => n + 1);
  };
  const clearDraw = () => {
    snapshot();
    const d = drawRef.current;
    if (d) {
      const ctx = d.getContext("2d");
      ctx?.clearRect(0, 0, d.width, d.height);
    }
    dirtyRef.current = false;
    force((n) => n + 1);
  };

  // 判断画布是否为空（无任何标注像素）
  const isCanvasBlank = (c: HTMLCanvasElement | null): boolean => {
    if (!c) return true;
    const ctx = c.getContext("2d");
    if (!ctx) return true;
    const { data } = ctx.getImageData(0, 0, c.width, c.height);
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] !== 0) return false;
    }
    return true;
  };

  // 合成最终图像：返回原生 RGBA 字节 + 尺寸，交给 save_screenshot 一次性写入剪贴板 + 中转站。
  // 关键优化（毫秒级保存）：
  // - 无标注且非长截图：走 Rust 原生裁剪快路径 crop_native_rgba，直接拿原生 RGBA，不经 PNG 编码。
  // - 无标注的长截图：capture_window_full 返回的原始 PNG 字节（save_screenshot 自动识别 PNG 魔数）。
  // - 有标注：画布合成后用 getImageData 取原生 RGBA（替代 toBlob 的 PNG 编码，省掉最慢一环）。
  const composeBytes = async (): Promise<{ bytes: Uint8Array; width: number; height: number } | null> => {
    const base = baseRef.current;
    const draw = drawRef.current;
    if (!base) return null;
    const blank = !draw || isCanvasBlank(draw);
    if (blank) {
      if (isLong && longBytesRef.current) {
        return { bytes: longBytesRef.current, width: 0, height: 0 };
      }
      const n = selNativeRef.current;
      if (!n) return null;
      const buf = await invoke<ArrayBuffer>("crop_native_rgba", {
        x: n.x,
        y: n.y,
        w: n.w,
        h: n.h,
      });
      return { bytes: new Uint8Array(buf), width: n.w, height: n.h };
    }
    // 有标注时：优先用原生分辨率底图合成，标注坐标按 scale 因子换算，彻底消除分辨率降级。
    const native = baseNativeRef.current;
    const out = document.createElement("canvas");
    out.width = native ? native.width : base.width;
    out.height = native ? native.height : base.height;
    const ctx = out.getContext("2d");
    if (!ctx) return null;
    if (native) {
      ctx.drawImage(native, 0, 0);
      if (draw) {
        const sx = native.width / base.width;
        const sy = native.height / base.height;
        ctx.drawImage(draw, 0, 0, draw.width * sx, draw.height * sy);
      }
    } else {
      // 降级路径：原生底图尚未拉取完成时，使用预览分辨率（保守、不会崩溃）
      ctx.drawImage(base, 0, 0);
      if (draw) ctx.drawImage(draw, 0, 0, out.width, out.height);
    }
    // 直接取像素级 RGBA，跳过 toBlob 的 PNG 编码（整条保存链路中最慢的一步）
    const imgData = ctx.getImageData(0, 0, out.width, out.height);
    return {
      bytes: new Uint8Array(imgData.data.buffer),
      width: out.width,
      height: out.height,
    };
  };

  const save = () => {
    if (savingRef.current) return;
    savingRef.current = true;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const name = `截图_${stamp}.png`;
    const n = selNativeRef.current;
    const hasDraw = !!drawRef.current && !isCanvasBlank(drawRef.current);
    const noteIdLocal = noteId;

    // 保存成功后：立即刷新图标栏中转站（让刚保存的截图秒出现），
    // 若处于笔记页则同时把图片引用导入当前笔记
    const finish = (ref: string | null) => {
      if (ref) {
        emitDropzoneChange();
        if (noteIdLocal) {
          import("@tauri-apps/api/event").then(({ emit }) =>
            emit("screenshot-note-import", { ref, name, noteId: noteIdLocal }),
          );
        }
      }
    };
    const fail = (err: unknown) => console.error("[截图] 保存失败:", err);

    // 关键 UX：先异步合成（有标注时需从底图绘制，毫秒级），随后**立即关闭覆盖窗**，
    // 把最慢的「剪贴板写入 + PNG 落盘」放到后台 Rust 线程执行，用户点击保存即可瞬间回到桌面，
    // 无需傻等（即便后端已 async 化，等待结果本身仍是糟糕体验）。
    const run = async () => {
      try {
        // 无标注普通截图：零传输快路径，立即关窗 + 后台保存
        if (n && !hasDraw && !isLong) {
          const p = invoke<string>("save_cropped", {
            x: n.x,
            y: n.y,
            w: n.w,
            h: n.h,
            name,
          });
          onClose();
          p.then(finish).catch(fail);
          return;
        }
    // 有标注（非长截图）：前端只回传极小标注层 PNG，Rust 在 SHOT 原生裁剪图上合成，
    // 彻底消除整屏 132MB 像素的 getImageData 冻结与 IPC 回传（极致优化）
    if (n && hasDraw && !isLong) {
      const draw = drawRef.current;
      if (draw) {
        const ann = await canvasToPng(draw);
        const p = invoke<string>("save_annotated", {
          x: n.x,
          y: n.y,
          w: n.w,
          h: n.h,
          annotation_png: ann,
          name,
        });
        onClose();
        p.then(finish).catch(fail);
        return;
      }
    }
    // 长截图（含长图标注）：保留画布合成路径
    const composed = await composeBytes();
        if (!composed) {
          onClose();
          return;
        }
        const { bytes, width, height } = composed;
        const p = invoke<string>("save_screenshot", { bytes, width, height, name });
        onClose();
        p.then(finish).catch(fail);
      } catch (err) {
        fail(err);
        onClose();
      } finally {
        savingRef.current = false;
        setSaving(false);
      }
    };
    run();
  };

  // 编辑态：建立 draw 画布尺寸（与底图一致）
  useEffect(() => {
    if (mode === "edit" && baseRef.current && drawRef.current) {
      drawRef.current.width = baseRef.current.width;
      drawRef.current.height = baseRef.current.height;
      const ctx = drawRef.current.getContext("2d");
      ctx?.clearRect(0, 0, drawRef.current.width, drawRef.current.height);
    }
  }, [mode, ready]);

  if (!ready) {
    return <div className="fixed inset-0 z-[9999] bg-transparent" />;
  }

  // ====== 选择态 ======
  if (mode === "select") {
    return (
      <div
        className="fixed inset-0 z-[9999] select-none"
        onContextMenu={(e) => {
          e.preventDefault();
          onClose();
        }}
      >
        {/* 整屏预览（object-fill 铺满，分辨率==CSS 像素 → 1:1，无缩放无偏移） */}
        <img src={image} alt="" className="absolute inset-0 w-full h-full object-fill pointer-events-none" draggable={false} />

        {/* 窗口绿色轮廓（悬停高亮当前窗口） */}
        {(() => {
          const activeWin = windows.find((w) => w.hwnd === hoverHwnd);
          if (!activeWin) return null;
          const w = activeWin;
          const wtitle = titleMap[w.hwnd] ?? w.title;
          return (
            <div
              className="absolute pointer-events-none border-2 transition-colors"
              style={{
                left: (w.x - ox) / scale,
                top: (w.y - oy) / scale,
                width: w.width / scale,
                height: w.height / scale,
                borderColor: GREEN,
                backgroundColor: "rgba(74,222,128,0.10)",
                boxShadow: "0 0 0 9999px rgba(0,0,0,0.5)",
              }}
            >
              {wtitle && (
                <span className="absolute -top-5 left-0 px-1.5 py-0.5 text-[11px] text-white bg-emerald-500 rounded truncate max-w-[280px]">
                  {wtitle}
                </span>
              )}
            </div>
          );
        })()}

        {/* 自由选区：向外阴影只压暗选区外，选区本身清晰（微信式） */}
        {selRect && (
          <div
            className="absolute border-2 border-emerald-400 bg-transparent pointer-events-none"
            style={{
              left: selRect.x,
              top: selRect.y,
              width: selRect.w,
              height: selRect.h,
              boxShadow: "0 0 0 9999px rgba(0,0,0,0.5)",
            }}
          >
            <span className="absolute -top-6 left-0 px-1.5 py-0.5 rounded bg-black/70 text-white text-[11px] tabular-nums">
              {Math.round(selRect.w * scale)} × {Math.round(selRect.h * scale)}
            </span>
          </div>
        )}

        {/* 放大镜（像素级对齐辅助） */}
        {mag.show && offRef.current && !selRect && (
          <Magnifier off={offRef.current} x={mag.x} y={mag.y} zoom={4} size={132} />
        )}

        {/* 统一捕获层 */}
        <div
          ref={captureRef}
          className="absolute inset-0 cursor-crosshair"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
        />

        {/* 顶部提示 + 长截图入口 */}
        <div className="absolute top-3 left-1/2 -translate-x-1/2 px-3 py-1.5 rounded-xl bg-black/70 text-white text-xs flex items-center gap-2">
          {longMode ? (
            <>
              <span className="text-emerald-300">长截图：</span>
              <span>点击目标窗口以捕获其完整内容</span>
              <span className="text-neutral-400">·</span>
              <button className="text-emerald-300 hover:underline" onClick={() => setLongMode(false)}>退出</button>
            </>
          ) : (
            <>
              <span>拖拽框选 / 单击窗口 / 悬停高亮窗口</span>
              <span className="text-neutral-400">·</span>
              <button className="text-emerald-300 hover:underline flex items-center gap-1" onClick={() => setLongMode(true)}>
                <StretchVertical size={12} />长截图
              </button>
              <span className="text-neutral-400">·</span>
              <span>Esc 取消</span>
            </>
          )}
        </div>
      </div>
    );
  }

  // ====== 编辑态（微信式「保持状态」）======
  const base = baseRef.current;
  const toolbar = (
    <div className="flex items-center gap-1.5 px-2 py-1.5 rounded-xl bg-white/95 shadow-lg text-neutral-700 ring-1 ring-black/5">
      <ToolBtn active={tool === "pen"} onClick={() => setTool("pen")} title="画笔"><Pen size={16} /></ToolBtn>
      <ToolBtn active={tool === "eraser"} onClick={() => setTool("eraser")} title="橡皮"><Eraser size={16} /></ToolBtn>
      <ToolBtn active={tool === "rect"} onClick={() => setTool("rect")} title="矩形"><Square size={16} /></ToolBtn>
      <ToolBtn active={tool === "arrow"} onClick={() => setTool("arrow")} title="箭头"><ArrowUpRight size={16} /></ToolBtn>
      <ToolBtn active={tool === "text"} onClick={() => setTool("text")} title="文字"><Type size={16} /></ToolBtn>
      <span className="w-px h-5 bg-black/10 mx-1" />
      {["#ef4444", "#f59e0b", "#22c55e", "#3b82f6", "#ffffff", "#111827"].map((c) => (
        <button
          key={c}
          onClick={() => setColor(c)}
          className="w-5 h-5 rounded-full border-2 transition-transform hover:scale-110"
          style={{ backgroundColor: c, borderColor: color === c ? "#10b981" : "transparent" }}
        />
      ))}
      <span className="w-px h-5 bg-black/10 mx-1" />
      <input type="range" min={1} max={24} value={size} onChange={(e) => setSize(parseInt(e.target.value, 10))} className="w-20 accent-emerald-500" />
      <span className="w-px h-5 bg-black/10 mx-1" />
      <ToolBtn onClick={undo} title="撤销"><Undo2 size={16} /></ToolBtn>
      <ToolBtn onClick={clearDraw} title="清空标注"><Trash2 size={16} /></ToolBtn>
      <span className="w-px h-5 bg-black/10 mx-1" />
      <button onClick={save} disabled={saving} className={`px-3 py-1.5 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-white text-xs font-medium flex items-center gap-1 ${saving ? "opacity-50 cursor-not-allowed" : ""}`}><Save size={14} />保存</button>
      <button onClick={onClose} className="px-3 py-1.5 rounded-lg bg-neutral-100 hover:bg-neutral-200 text-xs flex items-center gap-1"><X size={14} />取消</button>
    </div>
  );

  // 长截图：整图适配显示（可滚动），工具栏固定顶部
  if (isLong) {
    return (
      <div
        className="fixed inset-0 z-[9999] bg-black/80 flex flex-col items-center justify-center gap-3 p-4 overflow-auto"
        onContextMenu={(e) => { e.preventDefault(); onClose(); }}
      >
        <div className="fixed top-3 z-10">{toolbar}</div>
        <div className="relative mt-12" style={{ maxWidth: "92vw", maxHeight: "78vh" }}>
          {base && (
            <canvas
              ref={(el) => { if (el) { el.width = base.width; el.height = base.height; const ctx = el.getContext("2d"); if (ctx) ctx.drawImage(base, 0, 0); } }}
              className="block max-w-[92vw] max-h-[78vh] rounded-lg shadow-2xl"
            />
          )}
          <canvas
            ref={drawRef}
            className="absolute inset-0 w-full h-full rounded-lg cursor-crosshair touch-none"
            onPointerDown={onDrawDown}
            onPointerMove={onDrawMove}
            onPointerUp={onDrawUp}
          />
        </div>
        {textInputPos && (
          <div className="fixed z-20" style={{ left: textInputPos.x, top: textInputPos.y }}>
            <input
              ref={textInputRef}
              className="bg-black/80 text-white text-sm px-2 py-1 rounded outline-none border border-white/30 min-w-[120px]"
              placeholder="输入文字…"
              onKeyDown={(e) => { if (e.key === "Enter") confirmText(); if (e.key === "Escape") setTextInputPos(null); }}
              onBlur={confirmText}
            />
          </div>
        )}
      </div>
    );
  }

  // 普通编辑：保持整屏为底（暗化），选区明亮浮起 + 浮动工具栏（微信式）
  if (selRect && base) {
    const tw = 360;
    const toolbarH = 52;
    const margin = 8;
    const vh = window.innerHeight;
    const vw = window.innerWidth;
    // 工具栏优先置于选区下方；下方空间不够且上方够则置上方；都不足则贴底（允许压住选区，同微信全屏截图）。
    // 关键修复：ty 必须 clamp 在视口内 —— 旧逻辑对全屏选区（selRect.y≈0 且 selRect.h≈窗口高）会把
    // 工具栏放到 selRect.y+selRect.h+12 = 窗口高+12，超出视口被裁掉，导致「全屏截图时操作框看不见」。
    const roomBelow = vh - (selRect.y + selRect.h) - 12;
    const roomAbove = selRect.y - 12;
    const toolbarBelow = roomBelow >= toolbarH || roomAbove < toolbarH;
    let ty = toolbarBelow ? selRect.y + selRect.h + 12 : selRect.y - toolbarH - 4;
    ty = Math.max(margin, Math.min(ty, vh - toolbarH - margin));
    const tx = Math.min(Math.max(selRect.x + selRect.w / 2 - tw / 2, margin), vw - tw - margin);
    // 尺寸标注与工具栏分居选区两侧；全屏时选区上沿无空间，则贴选区内部下沿，确保始终可见。
    let labelTop = toolbarBelow ? selRect.y - 22 : selRect.y + selRect.h + 8;
    if (toolbarBelow && selRect.y < 24) labelTop = selRect.y + selRect.h - 24;
    labelTop = Math.max(margin, Math.min(labelTop, vh - 20));
    return (
      <div
        className="fixed inset-0 z-[9999] select-none"
        onContextMenu={(e) => { e.preventDefault(); onClose(); }}
      >
        {/* 整屏底图（暗化） */}
        <img src={image} alt="" className="absolute inset-0 w-full h-full object-fill pointer-events-none opacity-100" draggable={false} />
        <div className="absolute inset-0 bg-black/45 pointer-events-none" />
        {/* 选区明亮浮起 */}
        <div className="absolute" style={{ left: selRect.x, top: selRect.y, width: selRect.w, height: selRect.h }}>
          <canvas ref={(el) => { if (el) { el.width = base.width; el.height = base.height; const ctx = el.getContext("2d"); if (ctx) ctx.drawImage(base, 0, 0); } }} className="block w-full h-full rounded-sm shadow-2xl" />
          <canvas
            ref={drawRef}
            className="absolute inset-0 w-full h-full rounded-sm cursor-crosshair touch-none"
            onPointerDown={onDrawDown}
            onPointerMove={onDrawMove}
            onPointerUp={onDrawUp}
          />
        </div>
        {/* 浮动工具栏 */}
        <div className="absolute z-10" style={{ left: tx, top: ty }}>{toolbar}</div>
        {/* 选区尺寸标注 */}
        <span className="absolute z-10 px-1.5 py-0.5 rounded bg-black/70 text-white text-[11px] tabular-nums" style={{ left: selRect.x, top: labelTop }}>
          {Math.round(selRect.w * scale)} × {Math.round(selRect.h * scale)}
        </span>
        {textInputPos && (
          <div className="fixed z-20" style={{ left: textInputPos.x, top: textInputPos.y }}>
            <input
              ref={textInputRef}
              className="bg-black/80 text-white text-sm px-2 py-1 rounded outline-none border border-white/30 min-w-[120px]"
              placeholder="输入文字…"
              onKeyDown={(e) => { if (e.key === "Enter") confirmText(); if (e.key === "Escape") setTextInputPos(null); }}
              onBlur={confirmText}
            />
          </div>
        )}
      </div>
    );
  }

  return <div className="fixed inset-0 z-[9999] bg-transparent" />;
}

function ToolBtn({ active, onClick, title, children }: { active?: boolean; onClick: () => void; title: string; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`w-8 h-8 rounded-lg flex items-center justify-center transition-colors ${active ? "bg-emerald-500 text-white" : "hover:bg-neutral-200 text-neutral-700"}`}
    >
      {children}
    </button>
  );
}

// 放大镜：在光标处显示像素级放大圆，辅助边缘对齐
function Magnifier({ off, x, y, zoom, size }: { off: HTMLCanvasElement; x: number; y: number; zoom: number; size: number }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, size, size);
    ctx.save();
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size / 2 - 2, 0, Math.PI * 2);
    ctx.clip();
    // off 为原生物理分辨率画布，光标坐标 x/y 是 CSS 像素，需按预览比例 ps 换算到原图坐标
    const ps = off.width / (window.innerWidth || off.width);
    const sw = size / zoom;
    const swp = sw * ps;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(off, x * ps - swp / 2, y * ps - swp / 2, swp, swp, 0, 0, size, size);
    ctx.restore();
    // 十字准线
    ctx.strokeStyle = "rgba(16,185,129,0.9)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(size / 2, 0);
    ctx.lineTo(size / 2, size);
    ctx.moveTo(0, size / 2);
    ctx.lineTo(size, size / 2);
    ctx.stroke();
    ctx.strokeStyle = "rgba(0,0,0,0.4)";
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size / 2 - 2, 0, Math.PI * 2);
    ctx.stroke();
  }, [off, x, y, zoom, size]);
  return (
    <div className="absolute z-[10000] pointer-events-none" style={{ left: x + 16, top: y + 16 }}>
      <canvas ref={ref} width={size} height={size} />
    </div>
  );
}

function drawAnnotation(
  ctx: CanvasRenderingContext2D,
  tool: Tool,
  sx: number,
  sy: number,
  x: number,
  y: number,
  color: string,
  size: number,
) {
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = size;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  if (tool === "rect") {
    ctx.strokeRect(sx, sy, x - sx, y - sy);
  } else if (tool === "arrow") {
    const head = Math.max(10, size * 3);
    const angle = Math.atan2(y - sy, x - sx);
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.lineTo(x, y);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x - head * Math.cos(angle - Math.PI / 6), y - head * Math.sin(angle - Math.PI / 6));
    ctx.lineTo(x - head * Math.cos(angle + Math.PI / 6), y - head * Math.sin(angle + Math.PI / 6));
    ctx.closePath();
    ctx.fill();
  }
}
