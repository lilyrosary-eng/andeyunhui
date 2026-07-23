import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { X, Save, Undo2, Eraser, Pen, Square, ArrowUpRight, Type, Trash2, StretchVertical } from "lucide-react";
import { emitDropzoneChange } from "@/components/TransferStationPanel";

interface Win {
  hwnd: number;
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
  isTaskbar?: boolean;
  is_self?: boolean;
  z?: number;
}

interface ScreenshotOverlayProps {
  /** 预览图（前端 read_screenshot 后零编码构造的 ImageBitmap，原生物理分辨率，1:1 清晰）；null 表示冻结图尚未注入（透明待加载态） */
  image?: ImageBitmap | null;
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
  /** 冻结图真正解码完成（ready）后回调，用于通知外层此时再显示覆盖窗，避免「图未注入即显示→黑底抢先」的黑屏 */
  onImageReady?: () => void;
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

/**
 * 截完即复制：把选区图写入系统剪贴板。
 *
 * 优先用 WebView2 的 JS Clipboard API（navigator.clipboard.write + ClipboardItem）。
 * 原因：Chromium 会正确设置自身剪贴板状态，粘到微信/QQ/浏览器等场景最兼容，
 * 且不受本进程其它 WebView2 窗口（录屏浮窗等）焦点变化清空的影响。
 * 若 JS 不可用（非安全上下文 / 权限被拒 / 旧环境），回退 Rust Win32 双格式写入。
 *
 * 注意：本函数内部自行处理 async，调用处无需 await（截完即复制是「尽力而为」的旁路）。
 */
async function copyScreenshotToClipboard(
  dataUrl: string,
  onResult?: (msg: string) => void,
): Promise<void> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard && "write" in navigator.clipboard) {
      const res = await fetch(dataUrl);
      const blob = await res.blob();
      if (typeof ClipboardItem === "undefined") throw new Error("ClipboardItem 不可用");
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      onResult?.("✓ 已复制到剪贴板，去任意应用 Ctrl+V");
      return;
    }
    throw new Error("navigator.clipboard.write 不可用");
  } catch {
    // 回退 Rust Win32 写入
    try {
      await invoke("clipboard_write_image", { base64Png: dataUrl });
      onResult?.("✓ 已用系统接口复制到剪贴板（Ctrl+V）");
    } catch {
      onResult?.("⚠ 复制到剪贴板失败，已存入中转站，可从中转站取用");
    }
  }
}

export function ScreenshotOverlay({ image, ox, oy, scale, windows, noteId, onClose, onImageReady }: ScreenshotOverlayProps) {
  const [ready, setReady] = useState(false);
  const [mode, setMode] = useState<"select" | "edit">("select");
  const [longMode, setLongMode] = useState(false); // 长截图：窗口挑选态
  const [isLong, setIsLong] = useState(false); // 当前编辑的是长截图（整窗）
  const [hoverWin, setHoverWin] = useState<Win | null>(null);
  // 窗口列表（悬停命中测试 + 任务栏识别用）：以 props.windows 在开启时一次性种子（Rust 已预取完整列表）。
  // **hover 期间不再轮询 list_windows**——同步命令会阻塞 Tauri 主线程跑整条窗口树枚举，正是「更卡 / 开启卡」根因。
  // 静态完整列表 + 缓存 miss 时 window_at_point 兜底即可，零后台枚举、零卡顿。
  const [liveWindows] = useState<Win[]>(windows ?? []);
  const liveWindowsRef = useRef<Win[]>(windows ?? []);
  // 窗口标题懒加载缓存：枚举时不再读标题（避免跨线程阻塞导致截图卡 4-5s），悬停时按需拉取单个窗口标题
  const [titleMap, setTitleMap] = useState<Record<number, string>>({});

  const fullImgRef = useRef<HTMLImageElement | HTMLCanvasElement | null>(null);
  const fullCanvasRef = useRef<HTMLCanvasElement | null>(null); // 整屏预览绘制画布
  const editBaseRef = useRef<HTMLCanvasElement | null>(null); // 编辑态整屏底图画布
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
  // 截图复制到剪贴板的结果提示（可见反馈，替代仅输出到 DevTools 的日志）
  const [copyTip, setCopyTip] = useState<string | null>(null);
  const [mag, setMag] = useState<{ x: number; y: number; show: boolean }>({ x: 0, y: 0, show: false });

  // 选区外暗化遮罩：用 4 个纯色矩形（上/下/左/右）围出选区外区域，替代
  // `box-shadow: 0 0 0 9999px` 的超大模糊——后者在 4K 全屏每帧重绘代价极高，
  // 是悬停高亮/选区拖拽卡顿主因之一（录屏选区覆盖窗 overlay-recorder-select.ts 已采用同方案）。
  // 4 矩形均为纯色、由 GPU 合成，移动时几乎零重绘成本。
  const dimmerRef = useRef<HTMLDivElement | null>(null);
  const dTopRef = useRef<HTMLDivElement | null>(null);
  const dBotRef = useRef<HTMLDivElement | null>(null);
  const dLeftRef = useRef<HTMLDivElement | null>(null);
  const dRightRef = useRef<HTMLDivElement | null>(null);

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

  // 载入整屏预览图（ImageBitmap，零编码），绘制到 canvas 并构建放大镜源。
  // useLayoutEffect：绘制在浏览器首次 paint 前完成，配合 reveal 时序确保「先有冻结图、再显示」，杜绝黑闪。
  useLayoutEffect(() => {
    // 截图会话已建立但冻结图尚未注入（image 为 null）：立即渲染透明选区 UI，
    // 让框选交互秒开（与录屏选区窗一致），无需等待冻结图加载完成。
    if (!image) {
      setReady(true);
      return;
    }
    const canvas = fullCanvasRef.current;
    if (!canvas) {
      setReady(true);
      onImageReady?.();
      return;
    }
    canvas.width = image.width;
    canvas.height = image.height;
    const ctx = canvas.getContext("2d");
    if (ctx) ctx.drawImage(image, 0, 0);
    // 放大镜源（预览原图）
    const off = document.createElement("canvas");
    off.width = image.width;
    off.height = image.height;
    const octx = off.getContext("2d");
    if (octx) octx.drawImage(image, 0, 0);
    offRef.current = off;
    fullImgRef.current = canvas;
    setReady(true);
    // 冻结图已在上方（useLayoutEffect，浏览器首次 paint 前）同步绘制到 fullCanvasRef；
    // reveal 由 Rust run_on_main_thread 异步 show，落到下一帧合成时 canvas 已就位，
    // 首帧即冻结图、无黑闪。无需 rAF/timeout 延迟（隐藏窗的 rAF 会被节流，反而 ~150ms 卡顿）。
    onImageReady?.();
  }, [image, onClose, onImageReady]);

  // 编辑态整屏底图：进入 edit 模式时画布挂载，立即把 ImageBitmap 绘制上去（零解码）。
  useLayoutEffect(() => {
    const canvas = editBaseRef.current;
    if (!canvas || !image) return;
    canvas.width = image.width;
    canvas.height = image.height;
    const ctx = canvas.getContext("2d");
    if (ctx) ctx.drawImage(image, 0, 0);
  }, [image, mode]);

  // CSS 坐标 → 物理坐标
  const toPhys = useCallback(
    (cx: number, cy: number) => ({ x: ox + cx * scale, y: oy + cy * scale }),
    [ox, oy, scale],
  );

  // 实时命中测试：直接以 OS 为权威（Rust window_at_point 内部用 WindowFromPoint +
  // 沿 Z 序跳过自身覆盖窗），彻底摆脱对「冻结窗口列表 + JS 矩形求交」的依赖——
  // 那份列表是截图时刻的一次性枚举，偶发漏窗时表现为「只识别一个窗口 / 悬停高亮不动」。
  // 每次悬停/单击都实时问 OS，永远返回光标下真实窗口，天然处理 z 序/透明/UWP 现代应用。
  // 单击/长截图取窗口：仍以 OS 为权威（window_at_point），单次调用不卡；返回 null 时回退列表命中。
  const hitAt = useCallback(
    async (cx: number, cy: number): Promise<Win | null> => {
      const p = toPhys(cx, cy);
      try {
        const raw = await invoke<string>("window_at_point", { x: p.x, y: p.y });
        return raw === "null" ? null : JSON.parse(raw) as Win;
      } catch (e) {
        console.error("[hitAt] window_at_point 失败:", e);
        return null;
      }
    },
    [toPhys],
  );

  // 悬停命中测试（纯前端，零 IPC）：在实时窗口列表里找包含光标、且 z 序最靠前（最上层可见）的窗口。
  // 用 z 序而非最小面积，才能正确识别「重叠窗口」之上真实可见的那个，避免被遮挡的小窗口误判为命中。
  // 不跳过 is_self：本应用自身窗口（主窗 / 浮窗）同样可见、可截图，覆盖窗不在列表中。
  const hitWindow = useCallback(
    (cx: number, cy: number): Win | null => {
      const p = toPhys(cx, cy);
      const list = liveWindowsRef.current;
      let best: Win | null = null;
      let bestZ = Infinity;
      for (const w of list) {
        if (
          p.x >= w.x && p.x <= w.x + w.width &&
          p.y >= w.y && p.y <= w.y + w.height
        ) {
          const z = w.z == null ? Infinity : w.z;
          if (z < bestZ) {
            best = w;
            bestZ = z;
          }
        }
      }
      return best;
    },
    [toPhys],
  );

  // rAF 节流悬停：合并同帧多次 pointermove，每帧最多一次同步命中测试（零 IPC，平滑跟手）。
  // 主路径 = 静态列表 hitWindow（即时、跟手、始终作为常驻兜底）；权威校正值 = OS window_at_point
  // （每帧、worker 线程、零 UI 阻塞，非 null 时覆盖静态结果，修正 z 序不可靠/漏 topmost 窗口）。
  // OS 返回 null（桌面/合成层）或失败时回退静态命中 → 悬停永不整体崩溃。单击/长截图仍走 OS 单次权威。
  // applyHover 内部按命中 hwnd 去重，命中窗口不变时不重渲染，进一步消除卡顿。
  const hoverRafRef = useRef<number | null>(null);
  const hoverPendingRef = useRef<{ x: number; y: number } | null>(null);
  const lastHoverHwndRef = useRef<number | null>(null);
  const osInFlightRef = useRef(false); // OS 调用在途保护（单并发，天然匹配 worker 吞吐，零堆积）
  const osLastDispatchRef = useRef(0); // OS 调用节流时间戳（>=80ms 才再派发，降低 worker 线程压力）
  const OS_THROTTLE_MS = 80;
  const lastHitRef = useRef<Win | null>(null); // 每帧静态命中快照：OS 返回 null/失败时回退，悬停永不整体崩溃
  // 命中窗口未变时不重渲染（仅在 hwnd 变化时 setHoverWin），消除每帧 React 重渲染卡顿。
  const applyHover = useCallback((w: Win | null) => {
    const hw = w?.hwnd ?? null;
    if (hw === lastHoverHwndRef.current) return;
    lastHoverHwndRef.current = hw;
    setHoverWin(w);
  }, []);
    const requestHover = useCallback(
    (x: number, y: number) => {
      hoverPendingRef.current = { x, y };
      if (hoverRafRef.current == null) {
        hoverRafRef.current = requestAnimationFrame(() => {
          hoverRafRef.current = null;
          const pt = hoverPendingRef.current;
          hoverPendingRef.current = null;
          if (!pt) return;
          // 即时命中：静态列表零 IPC、平滑跟手，且始终作为常驻兜底（绝不因 OS 结果被永久关闭）。
          const hit = hitWindow(pt.x, pt.y);
          lastHitRef.current = hit;
          if (hit) applyHover(hit); // 静态为 null（后开的窗不在种子列表）时不隐藏，留给 OS 校正，避免闪烁
          // 权威校正：OS window_at_point（每帧、worker 线程、零 UI 阻塞）。
          // 非 null 时覆盖静态结果，修正「静态列表 z 序不可靠/漏 topmost 窗口 → 卡在一个窗」；
          // 为 null（桌面/合成层）或失败时回退最新静态命中 → 悬停永不整体崩溃。
          const now = performance.now();
          const needOs = !osInFlightRef.current && (now - osLastDispatchRef.current >= OS_THROTTLE_MS || !hit);
          if (needOs) {
            osInFlightRef.current = true;
            osLastDispatchRef.current = now;
            hitAt(pt.x, pt.y)
              .then((w) => {
                osInFlightRef.current = false;
                applyHover(w ?? lastHitRef.current);
              })
              .catch(() => {
                osInFlightRef.current = false;
                if (lastHitRef.current) applyHover(lastHitRef.current);
              });
          }
        });
      }
    },
    [hitWindow, applyHover, hitAt],
  );

  // 悬停窗口时按需拉取标题（单次、Rust 侧 30ms 超时、绝不阻塞截图路径）
  useEffect(() => {
    if (hoverWin?.hwnd == null || titleMap[hoverWin.hwnd] !== undefined) return;
    const hw = hoverWin.hwnd;
    let cancelled = false;
    invoke<string>("get_window_title", { hwnd: hw })
      .then((t) => {
        if (!cancelled) setTitleMap((m) => ({ ...m, [hw]: t }));
      })
      .catch(() => {
        if (!cancelled) setTitleMap((m) => ({ ...m, [hw]: "" }));
      });
    return () => {
      cancelled = true;
    };
  }, [hoverWin, titleMap]);

  // 窗口列表缓存不轮询、不事件刷新：开启时由 props.windows（Rust 预取完整列表）一次性种子。
  // 悬停命中统一走 OS window_at_point（每帧、worker 线程、零 UI 阻塞），结果永远与系统一致、
  // 无 stale 列表问题；静态列表仅保留供 clipToWorkArea 找任务栏（任务栏不移动）。
  // 替代已移除的 window-list-changed 监听，这里仅把 props.windows 同步进 ref 供任务栏识别。
  useEffect(() => {
    if (windows && windows.length) liveWindowsRef.current = windows;
  }, [windows]);

  // 微信式暗化遮罩：随「当前选择区域」更新 4 矩形（纯 GPU 合成，零全屏重绘）。
  // 选择区域 = 拖拽中的 selRect，或悬停高亮的窗口(hoverWin)；拖拽态优先。
  // 非选择区域被 0.5 暗色遮罩，选择/悬停窗口保持原样亮（与 overlay-recorder-select.ts 一致）。
  // 用 useLayoutEffect（绘制前同步）而非 useEffect（绘制后），使暗化矩形与高亮边框同帧更新，
  // 杜绝跨窗口快速移动时「旧 dimmer 残留 + 新边框」造成的「双重遮罩」闪烁。
  useLayoutEffect(() => {
    const dimmer = dimmerRef.current;
    if (!dimmer) return;
    // 计算「保持明亮的区域」：算术坐标→覆盖窗 CSS 像素。
    const clearRect =
      selRect ??
      (hoverWin
        ? {
            x: (hoverWin.x - ox) / scale,
            y: (hoverWin.y - oy) / scale,
            w: hoverWin.width / scale,
            h: hoverWin.height / scale,
          }
        : null);
    if (!clearRect) {
      dimmer.style.display = "none";
      return;
    }
    const VW = window.innerWidth;
    const VH = window.innerHeight;
    const { x, y, w, h } = clearRect;
    const place = (el: HTMLDivElement | null, left: number, top: number, width: number, height: number) => {
      if (!el) return;
      el.style.left = left + "px";
      el.style.top = top + "px";
      el.style.width = Math.max(0, width) + "px";
      el.style.height = Math.max(0, height) + "px";
    };
    place(dTopRef.current, 0, 0, VW, y);
    place(dBotRef.current, 0, y + h, VW, VH - (y + h));
    place(dLeftRef.current, 0, y, x, h);
    place(dRightRef.current, x + w, y, VW - (x + w), h);
    dimmer.style.display = "block";
  }, [selRect, hoverWin, ox, oy, scale]);

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
      const iw = (img as HTMLCanvasElement).width || (img as HTMLImageElement).naturalWidth || 1;
      const cssW = window.innerWidth || iw;
      const ps = iw / cssW;
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
      // 微信/QQ 式「截完即复制」：确认选区的瞬间就把选区图写入系统剪贴板，
      // 用户无需点「保存」即可直接 Ctrl+V 粘贴（CF_DIB + PNG 双格式，兼容传统与现代应用）。
      // 优先用 WebView2 的 JS Clipboard API 写入（Chromium 自身 clipboard 状态被正确设置，
      // 最兼容「粘到微信/QQ/浏览器」等场景，且不受本进程其它 WebView2 窗口焦点变化影响）；
      // 若 JS 不可用则回退 Rust Win32 双格式写入。
      try {
        const n = selNativeRef.current;
        if (n && n.w > 0 && n.h > 0) {
          // 直接取原生分辨率裁剪（crop_native_rgba）写入剪贴板，保证清晰度不受预览降采样影响。
          invoke<ArrayBuffer>("crop_native_rgba", { x: n.x, y: n.y, w: n.w, h: n.h })
            .then((buf) => {
              const rgba = new Uint8Array(buf);
              const c = document.createElement("canvas");
              c.width = n.w;
              c.height = n.h;
              const ctx = c.getContext("2d");
              if (ctx) {
                ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba.buffer), n.w, n.h), 0, 0);
                copyScreenshotToClipboard(c.toDataURL("image/png"), setCopyTip);
              }
            })
            .catch(() => {
              const cc = baseRef.current;
              if (cc && cc.width > 0) copyScreenshotToClipboard(cc.toDataURL("image/png"), setCopyTip);
            });
          window.setTimeout(() => setCopyTip(null), 2600);
        } else {
          console.warn("[截图] 自动复制跳过：选区为空，未写入剪贴板");
        }
      } catch (e) {
        console.error("[截图] 自动复制异常:", e);
      }
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
  const onPointerDown = async (e: React.PointerEvent) => {
    if (mode !== "select") return;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const x = e.clientX;
    const y = e.clientY;
    // 实时命中测试取光标下真实窗口（OS 权威，null 时回退列表命中）
    const w = (await hitAt(x, y)) ?? hitWindow(x, y);
    if (longMode) {
      if (w) captureLong(w.hwnd);
      return;
    }
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
        // 悬停高亮（rAF 节流：同步 hitWindow 主命中，缓存 miss 时 OS 兜底）
        requestHover(x, y);
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
      // 实时命中测试高亮（rAF 节流，OS 权威，永不残缺）
      requestHover(x, y);
    }
  };

  // 工作区裁剪：把任务栏那条带从选区中剔除（仅点任务栏本身才整屏含任务栏）。
  // 任务栏窗口由 Rust list_windows 以 isTaskbar 标记并加入列表；其矩形为物理像素，
  // 这里换算到覆盖窗 CSS 坐标后，与「整屏剔除任务栏所在那条边」求交。
  const clipToWorkArea = (r: { x: number; y: number; w: number; h: number }) => {
    const tb = liveWindows.find((w) => w.isTaskbar);
    if (!tb) return r;
    const iw = window.innerWidth, ih = window.innerHeight;
    const tbx = (tb.x - ox) / scale, tby = (tb.y - oy) / scale;
    const tbw = tb.width / scale, tbh = tb.height / scale;
    // 工作区 = 整屏去掉任务栏那条带（底 / 顶 / 右 / 左）
    let wa: { x: number; y: number; w: number; h: number };
    if (tby + tbh >= ih - 2) wa = { x: 0, y: 0, w: iw, h: tby };
    else if (tby <= 2) wa = { x: 0, y: tby + tbh, w: iw, h: ih - (tby + tbh) };
    else if (tbx + tbw >= iw - 2) wa = { x: 0, y: 0, w: tbx, h: ih };
    else wa = { x: tbx + tbw, y: 0, w: iw - (tbx + tbw), h: ih };
    const nx = Math.max(r.x, wa.x), ny = Math.max(r.y, wa.y);
    const nx2 = Math.min(r.x + r.w, wa.x + wa.w), ny2 = Math.min(r.y + r.h, wa.y + wa.h);
    if (nx2 <= nx || ny2 <= ny) return r; // 完全落在任务栏内等极端情况保持原样
    return { x: nx, y: ny, w: nx2 - nx, h: ny2 - ny };
  };

  const onPointerUp = async () => {
    if (mode !== "select") return;
    const p = pendingRef.current;
    const drag = dragRef.current;
    pendingRef.current = null;
    dragRef.current = null;
    setMag((m) => ({ ...m, show: false }));
    if (!p) return;
    if (!p.dragging) {
      // 干净单击窗口 → 整窗截取（OS 实时命中，最权威，绝不依赖冻结列表）
      const w = (await hitAt(p.x0, p.y0)) ?? hitWindow(p.x0, p.y0);
      if (w) {
        if (w.isTaskbar) {
          // 点任务栏本身 = 整屏捕获（含任务栏）
          commitCrop({ x: 0, y: 0, w: window.innerWidth, h: window.innerHeight });
          return;
        }
        // 普通窗口：矩形是物理像素，需换算成覆盖窗 CSS 像素（÷scale）再截取，
        // 并剔除任务栏那条带，做到「其余一律不截任务栏」。
        commitCrop(clipToWorkArea({
          x: (w.x - ox) / scale,
          y: (w.y - oy) / scale,
          w: w.width / scale,
          h: w.height / scale,
        }));
        return;
      }
      setSelRect(null);
      return;
    }
    if (drag) {
      const { x0, y0, x1, y1 } = drag;
      const w = Math.abs(x1 - x0);
      const h = Math.abs(y1 - y0);
      if (w > 12 && h > 12) {
        commitCrop(clipToWorkArea({ x: Math.min(x0, x1), y: Math.min(y0, y1), w, h }));
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

  if (!ready && !image) {
    // 不透明黑底：transparent:true 窗是 WS_EX_LAYERED 分层窗，逐像素命中——
    // 透明像素鼠标直接穿透落下层窗（默认光标+无法选窗）。冻结图尚未注入（image 为 null）时必须不透明，恒可点。
    // 关键：一旦 image 已注入（预览帧就绪），即便 ready 尚未翻转也要渲染选区 UI 并挂载 fullCanvasRef，
    // 以便下方 useLayoutEffect 同步 drawImage 之后再 reveal——否则 canvas 未挂载会落到 `if(!canvas)` 分支、
    // reveal 在绘帧前触发、露出下方 #000 形成黑闪。
    return <div className="fixed inset-0 z-[9999]" style={{ background: "#000" }} />;
  }

  // ====== 选择态 ======
  if (mode === "select") {
    return (
      <div
        className="fixed inset-0 z-[9999] select-none"
        style={{ background: image ? "transparent" : "#000" }}
        onContextMenu={(e) => {
          e.preventDefault();
          onClose();
        }}
      >
        {/* 整屏预览（object-fill 铺满，分辨率==CSS 像素 → 1:1，无缩放无偏移）；冻结图未注入前不渲染，保留透明底 */}
        {image && (
          <canvas ref={fullCanvasRef} className="absolute inset-0 w-full h-full pointer-events-none" />
        )}

        {/* 选区外暗化遮罩：4 矩形（纯 GPU 合成，替代 box-shadow 9999px 全屏重绘）。zIndex 低于高亮框，高于冻结图。 */}
        <div ref={dimmerRef} className="absolute inset-0 pointer-events-none" style={{ display: "none", zIndex: 1 }}>
          <div ref={dTopRef} style={{ position: "absolute", background: "rgba(0,0,0,0.5)" }} />
          <div ref={dBotRef} style={{ position: "absolute", background: "rgba(0,0,0,0.5)" }} />
          <div ref={dLeftRef} style={{ position: "absolute", background: "rgba(0,0,0,0.5)" }} />
          <div ref={dRightRef} style={{ position: "absolute", background: "rgba(0,0,0,0.5)" }} />
        </div>

        {/* 微信式高亮：非选择区域被暗色遮罩（见 dimmer 4 矩形），选择/悬停窗口保持原样亮。
            描边仅描边、不填充（选择区域即原屏幕内容，不再染绿）。拖拽态显示尺寸，悬停态显示窗口标题。 */}
        {(() => {
          const cr = selRect
            ? selRect
            : hoverWin
              ? {
                  x: (hoverWin.x - ox) / scale,
                  y: (hoverWin.y - oy) / scale,
                  w: hoverWin.width / scale,
                  h: hoverWin.height / scale,
                }
              : null;
          if (!cr) return null;
          const isDrag = !!selRect;
          const wtitle = hoverWin ? titleMap[hoverWin.hwnd] ?? hoverWin.title : "";
          return (
            <div
              className="absolute pointer-events-none border-2"
              style={{
                left: cr.x,
                top: cr.y,
                width: cr.w,
                height: cr.h,
                borderColor: GREEN,
                zIndex: 3,
              }}
            >
              {isDrag ? (
                <span className="absolute -top-6 left-0 px-1.5 py-0.5 rounded bg-black/70 text-white text-[11px] tabular-nums">
                  {Math.round(cr.w * scale)} × {Math.round(cr.h * scale)}
                </span>
              ) : wtitle ? (
                <span className="absolute -top-5 left-0 px-1.5 py-0.5 text-[11px] text-white bg-emerald-500 rounded truncate max-w-[280px]">
                  {wtitle}
                </span>
              ) : null}
            </div>
          );
        })()}

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
        {copyTip && (
          <div className="fixed top-4 left-1/2 -translate-x-1/2 z-[10001] px-3 py-1.5 rounded-md bg-black/80 text-white text-sm shadow-lg pointer-events-none">
            {copyTip}
          </div>
        )}
        {/* 整屏底图（暗化）：编辑态同样直接绘制 ImageBitmap，避免 <img src=URL> 解码开销 */}
        {image && (
          <canvas ref={editBaseRef} className="absolute inset-0 w-full h-full object-fill pointer-events-none opacity-100" />
        )}
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
