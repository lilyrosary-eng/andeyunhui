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
const overlay = document.createElement("div");
overlay.style.cssText = `
  position: fixed; inset: 0;
  background: rgba(0, 0, 0, 0.3);
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
const winHighlight = document.createElement("div");
winHighlight.style.cssText = `
  position: fixed;
  border: 2px solid #3b82f6;
  background: rgba(59, 130, 246, 0.10);
  pointer-events: none;
  display: none;
  z-index: 2;
  will-change: transform, width, height;
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

// 命中窗口：取光标下面积最小者（最精确匹配）
function hitWindow(cx: number, cy: number): Win | null {
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
    updateWinHighlight(hoverWin);
  }
});

overlay.addEventListener("pointerup", (e) => {
  if (e.button !== 0) return;
  pointerDown = false;
  // 释放指针捕获
  (e.target as Element).releasePointerCapture?.(e.pointerId);

  if (dragging) {
    // 拖拽结束：使用选区
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
    void startRecordingWithRegion(physX, physY, physW, physH);
  } else if (downWin) {
    // 干净单击窗口：使用窗口矩形作为录屏区域
    void startRecordingWithRegion(downWin.x, downWin.y, downWin.width, downWin.height);
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
  try {
    await invoke("hide_recorder_select");
  } catch {
    // 忽略
  }
  await getCurrentWindow().hide();
}

async function startRecordingWithRegion(x: number, y: number, w: number, h: number) {
  try {
    // 1. 隐藏区域选择覆盖窗（必须先隐藏，否则会被截入录屏）
    await invoke("hide_recorder_select");
    await getCurrentWindow().hide();

    // 2. 生成输出路径（使用 Tauri 标准 videoDir API）
    const dir = await videoDir();
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const outputPath = `${dir.replace(/\\/g, "/")}/录屏_${ts}.mp4`;

    // 3. 启动录屏（传入区域参数 [x, y, w, h]）
    await invoke("start_recording", {
      outputPath,
      fps: 30,
      monitorIndex: null,
      region: [x, y, w, h],
    });

    // 4. 显示录屏控制台
    await invoke("show_recorder_widget");
  } catch (e) {
    console.error("[录屏区域] 启动失败:", e);
    const msg = typeof e === "string" ? e : (e as { message?: string })?.message || "录屏启动失败";
    // 重新显示窗口以展示错误
    await getCurrentWindow().show();
    showError(msg);
    setTimeout(() => { void cancel(); }, 3000);
  }
}

// ========== 初始化：从 recorder-select-ready 事件获取坐标 ==========
// 坐标来源：Rust 的 show_recorder_select 发出，使用 virtual_desktop_rect() 权威值。
// 不再读 outerPosition()——它在 set_position 后可能返回带 DWM 边框偏移的值（如 +7px），
// 导致选区坐标左边偏移（与 screenshot.rs 同理）。
async function initFromEvent(data: { ox: number; oy: number; scale: number }) {
  ox = data.ox;
  oy = data.oy;
  scale = data.scale;
  try {
    windows = await invoke<Win[]>("list_windows");
    ready = true;
  } catch (e) {
    console.error("[录屏区域] 获取窗口列表失败:", e);
    windows = [];
    ready = false;
  }
  // 重置状态
  titleCache = {};
  hoverWin = null;
  dragging = false;
  downWin = null;
  hint.style.display = "block";
  winHighlight.style.display = "none";
  selection.style.display = "none";
}

// 监听 Rust 的 recorder-select-ready 事件（窗口显示时由 show_recorder_select 发出）
let readyEventReceived = false;
listen<{ ox: number; oy: number; scale: number }>("recorder-select-ready", (event) => {
  readyEventReceived = true;
  void initFromEvent(event.payload);
});

// 兜底：push 事件可能因竞态丢失（listen 尚未注册时 Rust 已 emit）。
// 200ms 后若仍未收到事件，主动拉取坐标（与截图覆盖窗的 peek_screenshot 轮询同理）。
setTimeout(() => {
  if (!readyEventReceived && !ready) {
    invoke<{ ox: number; oy: number; scale: number }>("get_recorder_select_coords")
      .then((data) => { void initFromEvent(data); })
      .catch((e) => console.error("[录屏区域] 兜底拉取坐标失败:", e));
  }
}, 200);

// 接收取消事件（Ctrl+Alt+R 再次按下时触发）
listen<null>("recorder-select-cancel", () => {
  cancel();
});
