// 录屏区域选择覆盖窗：纯 vanilla TS，复用截图覆盖窗的交互逻辑。
//
// 交互（与截图一致，仅边框色不同：录屏=蓝色，截图=绿色）：
// 1. 全屏半透明遮罩 + 提示文字
// 2. 鼠标悬停 → 蓝色高亮框标识当前窗口
// 3. 单击窗口 → 使用窗口矩形作为录屏区域
// 4. 拖拽 → 自由选择矩形区域（蓝色边框 + 半透明填充）
// 5. 松开鼠标 → 启动录屏 → 显示控制台 → 关闭自身
// 6. Esc / 右键 → 取消
//
// 坐标换算（与截图覆盖窗一致）：
//   physical_x = ox + css_x * scale
//   physical_y = oy + css_y * scale
//
// 性能优化（与截图覆盖窗对齐）：
// - 使用 Pointer Events + setPointerCapture，拖拽时不丢失指针追踪（比 mousemove 可靠）
// - 使用 requestAnimationFrame 批量更新 DOM，避免高刷新率屏上每帧多次重排
// - 坐标从 Rust 的 recorder-select-ready 事件获取（virtual_desktop_rect 权威值），
//   不读 outerPosition()（可能带 DWM 边框偏移）
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { videoDir } from "@tauri-apps/api/path";

interface Win {
  hwnd: number;
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
  is_self?: boolean;
  isTaskbar?: boolean;
}

// ========== 坐标信息（从 Rust recorder-select-ready 事件获取）==========
let ox = 0;
let oy = 0;
let scale = 1;
let windows: Win[] = [];
let ready = false;

// ========== DOM 构建 ==========
const root = document.getElementById("root")!;

// 全屏遮罩层（捕获层）
// 背景保持透明：暗化效果由 winHighlight / selection 的 box-shadow 负责扩散
// （与截图覆盖窗一致），否则 30% 暗色 overlay 会盖住高亮的 10% 蓝色填充，几乎不可见。
const overlay = document.createElement("div");
overlay.style.cssText = `
  position: fixed; inset: 0;
  background: transparent;
  cursor: crosshair;
  user-select: none; -webkit-user-select: none;
  z-index: 1;
  touch-action: none;
`;

// 提示文字
const hint = document.createElement("div");
hint.style.cssText = `
  position: fixed; top: 12px; left: 50%;
  transform: translateX(-50%);
  color: rgba(255, 255, 255, 0.85);
  font-size: 13px; font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
  pointer-events: none;
  text-shadow: 0 2px 8px rgba(0, 0, 0, 0.6);
  background: rgba(0, 0, 0, 0.6);
  padding: 6px 14px;
  border-radius: 8px;
  z-index: 10;
`;
hint.textContent = "拖拽选择区域 / 单击选择窗口 · Esc 取消";

// 窗口高亮框（蓝色，悬停时显示）—— will-change 提示浏览器 GPU 加速
// 关键：box-shadow: 0 0 0 9999px rgba(0,0,0,0.5) 让高亮外部全屏暗化，高亮区域保持原色明亮可见。
// 与截图覆盖窗 ScreenshotOverlay.tsx 第 707-718 行的实现一致。
const winHighlight = document.createElement("div");
winHighlight.style.cssText = `
  position: fixed;
  border: 2px solid #3b82f6;
  background: rgba(59, 130, 246, 0.10);
  pointer-events: none;
  display: none;
  z-index: 2;
  will-change: transform, width, height;
  box-shadow: 0 0 0 9999px rgba(0, 0, 0, 0.5);
`;

// 窗口标题标签
const winTitleLabel = document.createElement("span");
winTitleLabel.style.cssText = `
  position: absolute; top: -22px; left: 0;
  background: #3b82f6; color: white;
  font-size: 11px; padding: 2px 8px;
  border-radius: 4px; white-space: nowrap;
  max-width: 280px; overflow: hidden; text-overflow: ellipsis;
  font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
`;
winHighlight.appendChild(winTitleLabel);

// 选区矩形（拖拽时显示）—— will-change 提示浏览器 GPU 加速
const selection = document.createElement("div");
selection.style.cssText = `
  position: fixed;
  border: 2px solid #3b82f6;
  background: rgba(59, 130, 246, 0.12);
  pointer-events: none;
  display: none;
  z-index: 3;
  will-change: transform, width, height;
  box-shadow: 0 0 0 9999px rgba(0, 0, 0, 0.5);
`;

// 选区尺寸标签
const sizeLabel = document.createElement("div");
sizeLabel.style.cssText = `
  position: absolute; top: -28px; left: 0;
  background: #3b82f6; color: white;
  font-size: 12px; padding: 2px 8px;
  border-radius: 4px; white-space: nowrap;
  font-family: "Cascadia Code", "Consolas", monospace;
`;
selection.appendChild(sizeLabel);

root.appendChild(overlay);
root.appendChild(winHighlight);
root.appendChild(selection);
root.appendChild(hint);

// ========== 交互状态 ==========
let dragging = false;
let pointerDown = false; // 必须先 pointerdown 才能进入拖拽判定，否则 mousemove 会因 downX=0 立即触发
let startX = 0;
let startY = 0;
let downX = 0;
let downY = 0;
let downWin: Win | null = null;
let hoverWin: Win | null = null;
let titleCache: Record<number, string> = {};

// 窗口列表实时刷新（修复「只能识别当前一个窗口 / 不随鼠标变化 / 概率卡住」）：
// 覆盖窗复用模式下，仅靠初始化时的事件拉一次窗口列表容易陈旧/残缺。这里在可见期间
// 每 200ms 重新拉取窗口列表（Rust 端已过滤掉自身覆盖窗/控制台/浮窗），
// 保证切换窗口 Z 序、新开窗口时高亮能实时更新。拖拽/按下期间不刷新，避免抖动。
let liveTimer: number | null = null;
let firstMoveLogged = false;

function startLiveWindowRefresh() {
  stopLiveWindowRefresh();
  liveTimer = window.setInterval(async () => {
    if (!ready || dragging || pointerDown) return;
    try {
      const data = await invoke<{ ox: number; oy: number; scale: number; windows?: Win[] }>(
        "get_recorder_select_coords",
      );
      // 仅更新窗口列表，**不**调用 initFromEvent（那会每 200ms 清空 hoverWin / titleCache /
      // 重置 hint，导致高亮框每 200ms 闪烁消失 —— 表现为「鼠标移动没用 / 只能识别一个窗口」）。
      // ox/oy/scale 在初始化后不变，这里只同步窗口矩形（Z 序变化 / 新开窗口实时生效）。
      if (data?.windows) windows = data.windows;
    } catch {
      // 拉取失败忽略，下一周期重试
    }
  }, 200);
}

function stopLiveWindowRefresh() {
  if (liveTimer !== null) {
    clearInterval(liveTimer);
    liveTimer = null;
  }
}

// ========== rAF 批量更新（避免一帧内多次 DOM 写入触发重排）==========
let rafPending = false;
let pendingUpdate: (() => void) | null = null;

function scheduleUpdate(fn: () => void) {
  pendingUpdate = fn;
  if (!rafPending) {
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      if (pendingUpdate) {
        pendingUpdate();
        pendingUpdate = null;
      }
    });
  }
}

// ========== 坐标换算 ==========
function toPhys(cx: number, cy: number): { x: number; y: number } {
  return { x: ox + cx * scale, y: oy + cy * scale };
}

// 命中窗口：EnumWindows 返回顺序即 Z 序（顶→底），取首个包含光标的窗口。
// **关键修复（录屏窗口识别只识别一个 / 鼠标不动）**：本进程主窗口（is_self）在录屏
// 场景下通常是最大化、且位于其他窗口之上的顶层窗口，若纳入命中测试，光标下任何位置
// 都会先命中它 → 永远只识别到主窗口、鼠标移动无效。因此此处跳过 is_self，让光标能
// 穿透到其下方的真实目标窗口。录制主窗口自身可用自由框选（拖拽）实现。
// fullscreen overlay / 控制台 / 截图覆盖窗 / 浮窗剪贴板已在 Rust 端
// filter_self_overlay_windows 中按 hwnd 过滤，不会出现在 windows 列表中。
function hitWindow(cx: number, cy: number): Win | null {
  const p = toPhys(cx, cy);
  for (const w of windows) {
    if (w.is_self) continue;
    if (p.x >= w.x && p.x <= w.x + w.width && p.y >= w.y && p.y <= w.y + w.height) {
      return w;
    }
  }
  return null;
}

// 更新窗口高亮框位置
function updateWinHighlight(win: Win | null) {
  if (!win) {
    winHighlight.style.display = "none";
    return;
  }
  const cssX = (win.x - ox) / scale;
  const cssY = (win.y - oy) / scale;
  const cssW = win.width / scale;
  const cssH = win.height / scale;
  winHighlight.style.left = `${cssX}px`;
  winHighlight.style.top = `${cssY}px`;
  winHighlight.style.width = `${cssW}px`;
  winHighlight.style.height = `${cssH}px`;
  winHighlight.style.display = "block";

  // 懒加载窗口标题
  if (titleCache[win.hwnd] === undefined) {
    titleCache[win.hwnd] = "";
    invoke<string>("get_window_title", { hwnd: win.hwnd })
      .then((t) => { titleCache[win.hwnd] = t; winTitleLabel.textContent = t; })
      .catch(() => { titleCache[win.hwnd] = ""; });
  } else {
    winTitleLabel.textContent = titleCache[win.hwnd];
  }
}

// 更新选区矩形
function updateSelection(x: number, y: number, w: number, h: number) {
  selection.style.left = `${x}px`;
  selection.style.top = `${y}px`;
  selection.style.width = `${w}px`;
  selection.style.height = `${h}px`;
  const pw = Math.round(w * scale);
  const ph = Math.round(h * scale);
  sizeLabel.textContent = `${pw} × ${ph}`;
}

// ========== 错误提示 ==========
function showError(msg: string) {
  const tip = document.createElement("div");
  tip.style.cssText = `
    position: fixed; left: 50%; top: 50%;
    transform: translate(-50%, -50%);
    background: rgba(220, 38, 38, 0.95);
    color: #fff; padding: 16px 24px;
    border-radius: 12px; font-size: 14px;
    max-width: 80vw; z-index: 9999;
    box-shadow: 0 4px 24px rgba(0, 0, 0, 0.4);
    font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
  `;
  tip.textContent = msg;
  root.appendChild(tip);
  setTimeout(() => tip.remove(), 4000);
}

// ========== Pointer Events（比 mouse 事件更可靠：setPointerCapture 确保拖拽中不丢失追踪）==========
overlay.addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;
  // 捕获指针：即使光标移出 overlay 元素，后续 pointermove/up 仍发到此元素
  (e.target as Element).setPointerCapture?.(e.pointerId);
  pointerDown = true;
  downX = e.clientX;
  downY = e.clientY;
  downWin = hitWindow(e.clientX, e.clientY);
  dragging = false;
  startX = e.clientX;
  startY = e.clientY;
});

overlay.addEventListener("pointermove", (e) => {
  if (dragging) {
    // 拖拽中：用 rAF 批量更新选区
    const x = Math.min(startX, e.clientX);
    const y = Math.min(startY, e.clientY);
    const w = Math.abs(e.clientX - startX);
    const h = Math.abs(e.clientY - startY);
    scheduleUpdate(() => updateSelection(x, y, w, h));
  } else if (pointerDown) {
    // 已按下但未拖拽：检查是否超过阈值（从 pointerdown 位置移动 > 5px → 转为拖拽）
    const dx = e.clientX - downX;
    const dy = e.clientY - downY;
    if (Math.abs(dx) > 5 || Math.abs(dy) > 5) {
      dragging = true;
      startX = downX;
      startY = downY;
      hint.style.display = "none";
      winHighlight.style.display = "none";
      selection.style.display = "block";
      const x = Math.min(startX, e.clientX);
      const y = Math.min(startY, e.clientY);
      const w = Math.abs(e.clientX - startX);
      const h = Math.abs(e.clientY - startY);
      updateSelection(x, y, w, h);
    }
  } else {
    // 纯悬停（未按下）：高亮当前窗口
    hoverWin = hitWindow(e.clientX, e.clientY);
    if (!firstMoveLogged) {
      firstMoveLogged = true;
      console.log("[录屏区域] 首次 pointermove 触发，当前窗口列表数:", windows.length);
    }
    updateWinHighlight(hoverWin);
  }
});

// 工作区裁剪：把任务栏那条带从录屏区域中剔除（仅点任务栏本身才整屏含任务栏）
function clipToWorkArea(r: { x: number; y: number; w: number; h: number }) {
  const tb = windows.find((win) => win.isTaskbar);
  if (!tb) return r;
  const vw = window.innerWidth * scale;
  const vh = window.innerHeight * scale;
  const tbx = tb.x, tby = tb.y, tbw = tb.width, tbh = tb.height;
  let wa: { x: number; y: number; w: number; h: number };
  if (tby + tbh >= vh - 2) wa = { x: 0, y: 0, w: vw, h: tby };
  else if (tby <= 2) wa = { x: 0, y: tby + tbh, w: vw, h: vh - (tby + tbh) };
  else if (tbx + tbw >= vw - 2) wa = { x: 0, y: 0, w: tbx, h: vh };
  else wa = { x: tbx + tbw, y: 0, w: vw - (tbx + tbw), h: vh };
  const nx = Math.max(r.x, wa.x), ny = Math.max(r.y, wa.y);
  const nx2 = Math.min(r.x + r.w, wa.x + wa.w), ny2 = Math.min(r.y + r.h, wa.y + wa.h);
  if (nx2 <= nx || ny2 <= ny) return r;
  return { x: nx, y: ny, w: nx2 - nx, h: ny2 - ny };
}

overlay.addEventListener("pointerup", (e) => {
  if (e.button !== 0) return;
  pointerDown = false;
  // 释放指针捕获
  (e.target as Element).releasePointerCapture?.(e.pointerId);

  if (dragging) {
    // 拖拽结束：使用选区（物理像素），并剔除任务栏那条带
    dragging = false;
    const x = Math.min(startX, e.clientX);
    const y = Math.min(startY, e.clientY);
    const w = Math.abs(e.clientX - startX);
    const h = Math.abs(e.clientY - startY);
    if (w < 10 || h < 10) {
      cancel();
      return;
    }
    const physX = Math.round(ox + x * scale);
    const physY = Math.round(oy + y * scale);
    const physW = Math.round(w * scale);
    const physH = Math.round(h * scale);
    const clipped = clipToWorkArea({ x: physX, y: physY, w: physW, h: physH });
    void startRecordingWithRegion(clipped.x, clipped.y, clipped.w, clipped.h);
  } else if (downWin) {
    if (downWin.isTaskbar) {
      // 点任务栏本身 = 整屏录制（含任务栏）
      const vw = Math.round(window.innerWidth * scale);
      const vh = Math.round(window.innerHeight * scale);
      void startRecordingWithRegion(ox, oy, vw, vh);
    } else {
      // 干净单击窗口：使用窗口矩形（物理像素），并剔除任务栏那条带
      const clipped = clipToWorkArea({ x: downWin.x, y: downWin.y, w: downWin.width, h: downWin.height });
      void startRecordingWithRegion(clipped.x, clipped.y, clipped.w, clipped.h);
    }
  } else {
    cancel();
  }

  downWin = null;
});

// 右键取消
overlay.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  cancel();
});

// Esc 取消
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    e.preventDefault();
    cancel();
  }
});

// ========== 核心流程 ==========
async function cancel() {
  stopLiveWindowRefresh();
  try {
    await invoke("hide_recorder_select");
  } catch {
    // 忽略
  }
  await getCurrentWindow().hide();
}

async function startRecordingWithRegion(x: number, y: number, w: number, h: number) {
  // 守卫：坐标无效（如初始化未完成导致 NaN/非正值）时绝不应退化成「录全屏」，
  // 而是提示用户重新框选，避免静默录下整个屏幕。
  if (
    !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(w) || !Number.isFinite(h) ||
    w < 1 || h < 1
  ) {
    showError("录屏区域无效，请重新框选区域");
    await invoke("hide_recorder_select").catch(() => {});
    await getCurrentWindow().hide();
    return;
  }
  try {
    // 1. 隐藏区域选择覆盖窗（必须先隐藏，否则会被截入录屏）
    await invoke("hide_recorder_select");
    await getCurrentWindow().hide();

    // 2. 先显示控制台（给用户即时反馈，避免录屏启动期间的空白等待）
    await invoke("show_recorder_widget");

    // 3. 生成输出路径（使用 Tauri 标准 videoDir API）
    const dir = await videoDir();
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const outputPath = `${dir.replace(/\\/g, "/")}/录屏_${ts}.mp4`;

    // 4. 启动录屏（传入区域物理像素坐标）。
    //    **关键修复（录全屏根因）**：旧实现把区域作为 JS 数组 `region:[x,y,w,h]` 传给后端
    //    `Option<Vec<i32>>`，Tauri v2 反序列化数组为 Vec 会静默回退为 None → 退化全屏。
    //    现改为 4 个独立数字参数（regionX/Y/W/H），i32 序列化最稳妥，彻底修复「选区域却录全屏」。
    console.log("[录屏区域] 传递 region(物理像素):", { x, y, w, h, regionX: x, regionY: y, regionW: w, regionH: h });
    await invoke("start_recording", {
      outputPath,
      fps: 60,
      monitorIndex: null,
      regionX: x,
      regionY: y,
      regionW: w,
      regionH: h,
    });
    console.log("[录屏区域] start_recording 调用成功");
  } catch (e) {
    console.error("[录屏区域] 启动失败:", e);
    // 启动失败 → 隐藏控制台
    await invoke("hide_recorder_widget").catch(() => {});
    const msg = typeof e === "string" ? e : (e as { message?: string })?.message || "录屏启动失败";
    // 重新显示窗口以展示错误
    await getCurrentWindow().show();
    showError(msg);
    setTimeout(() => { void cancel(); }, 3000);
  }
}

// ========== 初始化：使用 Rust 侧预获取的窗口列表 ==========
// Rust 的 show_recorder_select 在 win.show() 之前调用 list_windows 并将窗口列表
// 包含在 recorder-select-ready 事件中。此时覆盖窗尚未可见，不在列表中。
// 前端无需单独调用 list_windows（避免覆盖窗显示后调用导致 is_self 过滤问题）。
async function initFromEvent(data: { ox: number; oy: number; scale: number; windows?: Win[] }) {
  ox = data.ox;
  oy = data.oy;
  // 必须使用 Rust 端 recorder-select-ready 事件下发的同一 `scale`（= 覆盖窗 win.scale_factor()）。
  // 坐标契约：physical = ox + clientX * scale（ox 为虚拟桌面物理原点，scale 为覆盖窗物理/逻辑比）。
  // 覆盖窗的尺寸正是按此 scale 创建，浏览器把 clientX（CSS）映射到物理像素时也使用同一 scale，
  // 因此这里 MUST 沿用 data.scale，绝不能换成 window.devicePixelRatio——
  // 二者在混合 DPI / 多显示器下可能不一致，一旦不一致：选区被放大到超出屏幕 → 裁剪被夹到整屏
  // （既「录全屏」又因编码面积过大而「卡卡」）。
  scale = data.scale;
  windows = data.windows ?? [];
  ready = true;
  // 重置状态
  titleCache = {};
  hoverWin = null;
  dragging = false;
  downWin = null;
  firstMoveLogged = false;
  hint.style.display = "block";
  winHighlight.style.display = "none";
  selection.style.display = "none";
  // 启动窗口列表实时刷新（可见期间持续更新，避免识别陈旧/卡住）
  startLiveWindowRefresh();
}

// 保留事件监听（快速路径：如果事件能到达，立即初始化）
listen<{ ox: number; oy: number; scale: number; windows?: Win[] }>("recorder-select-ready", (event) => {
  void initFromEvent(event.payload);
});

// 持续轮询兜底（参考截图覆盖窗的 peek_screenshot 机制）：
// 1. 首次加载时如果事件丢失，轮询能初始化
// 2. 持续更新窗口列表（用户在录屏覆盖窗打开期间切换窗口 Z 序时也能识别）
// 每 50ms 轮询一次，直到 ready 后停止
//
// **重要**：不要求 windows.length > 0。即使窗口列表为空（极端情况），
// 也必须初始化 ox/oy/scale，否则拖拽选区时坐标换算错误 → region 坐标错误 → 录屏退化为全屏。
async function pollInit() {
  for (let i = 0; i < 40; i++) {  // 最多重试 40 次（2s）
    if (ready) return;
    try {
      const data = await invoke<{ ox: number; oy: number; scale: number; windows?: Win[] }>("get_recorder_select_coords");
      if (data && typeof data.ox === 'number' && typeof data.scale === 'number') {
        await initFromEvent(data);
        return;
      }
    } catch {
      // 窗口可能尚未就绪，稍后重试
    }
    await new Promise(r => setTimeout(r, 50));
  }
  console.error("[录屏区域] 初始化超时：无法获取坐标");
}

void pollInit();

// 接收取消事件（Ctrl+Alt+R 再次按下时触发）
listen<null>("recorder-select-cancel", () => {
  cancel();
});
