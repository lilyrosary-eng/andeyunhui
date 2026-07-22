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
  z?: number;
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
// 关键：高亮外部的全屏暗化由下方 dimmer 的 4 个纯色矩形实现（替代 box-shadow: 0 0 0 9999px
// 的超大模糊，后者在 4K 全屏每帧重绘代价极高，是悬停高亮卡顿主因之一）。高亮区域保持原色明亮可见。
// 与截图覆盖窗 ScreenshotOverlay.tsx 的暗化思路一致。
const winHighlight = document.createElement("div");
winHighlight.style.cssText = `
  position: fixed;
  border: 2px solid #3b82f6;
  background: rgba(59, 130, 246, 0.10);
  pointer-events: none;
  display: none;
  z-index: 3;
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
  z-index: 4;
  will-change: transform, width, height;
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
    // 暗化遮罩：用 4 个纯色矩形（上/下/左/右）围出高亮以外的区域，替代
    // `box-shadow: 0 0 0 9999px` 的超大模糊——后者在 4K 全屏每帧重绘代价极高，
    // 是悬停高亮卡顿的主因之一。4 矩形均为纯色、由 GPU 合成，移动时几乎零重绘成本。
    const dimmer = document.createElement("div");
    dimmer.style.cssText = "position: fixed; inset: 0; pointer-events: none; z-index: 2; display: none;";
    const dTop = document.createElement("div");
    const dBottom = document.createElement("div");
    const dLeft = document.createElement("div");
    const dRight = document.createElement("div");
    for (const d of [dTop, dBottom, dLeft, dRight]) {
      d.style.cssText = "position: absolute; background: rgba(0,0,0,0.5);";
    }
    dimmer.append(dTop, dBottom, dLeft, dRight);
    root.appendChild(dimmer);

    function updateDimmer(x: number, y: number, w: number, h: number) {
      const VW = window.innerWidth;
      const VH = window.innerHeight;
      dTop.style.left = "0px"; dTop.style.top = "0px";
      dTop.style.width = VW + "px"; dTop.style.height = Math.max(0, y) + "px";
      dBottom.style.left = "0px"; dBottom.style.top = (y + h) + "px";
      dBottom.style.width = VW + "px"; dBottom.style.height = Math.max(0, VH - (y + h)) + "px";
      dLeft.style.left = "0px"; dLeft.style.top = y + "px";
      dLeft.style.width = Math.max(0, x) + "px"; dLeft.style.height = h + "px";
      dRight.style.left = (x + w) + "px"; dRight.style.top = y + "px";
      dRight.style.width = Math.max(0, VW - (x + w)) + "px"; dRight.style.height = h + "px";
      dimmer.style.display = "block";
    }
    function hideDimmer() { dimmer.style.display = "none"; }
    root.appendChild(hint);

// 倒计时提示（选择窗口/区域后、正式开录前的 2 秒醒目提示）。
// 屏幕在倒计时期间保持实时（仅暗化遮罩 + 选区/窗口高亮 + 此红字提示），
// 倒计时结束才隐藏覆盖窗并 start_recording，因此倒计时提示绝不会被录进去。
const countdownEl = document.createElement("div");
countdownEl.style.cssText = `
  position: fixed; left: 50%; top: 50%;
  transform: translate(-50%, -50%);
  display: none; z-index: 50; pointer-events: none;
  flex-direction: column; align-items: center; gap: 14px;
  color: #fff; font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
  text-shadow: 0 2px 12px rgba(0,0,0,0.7);
`;
const cdNum = document.createElement("div");
cdNum.style.cssText = `
  font-size: 150px; font-weight: 800; line-height: 1;
  color: #ff4d4f; text-shadow: 0 0 48px rgba(255,77,79,0.9), 0 6px 20px rgba(0,0,0,0.6);
`;
const cdText = document.createElement("div");
cdText.style.cssText = `font-size: 22px; font-weight: 700; letter-spacing: 3px;`;
cdText.textContent = "即将开始录制…";
countdownEl.appendChild(cdNum);
countdownEl.appendChild(cdText);
root.appendChild(countdownEl);

// 倒计时数字弹跳动画（每次换数字重新触发）
const cdStyle = document.createElement("style");
cdStyle.textContent = `
@keyframes cd-pop {
  0% { transform: scale(0.4); opacity: 0; }
  30% { transform: scale(1.15); opacity: 1; }
  100% { transform: scale(1); opacity: 1; }
}`;
document.head.appendChild(cdStyle);

// ========== 交互状态 ==========
let dragging = false;
let pointerDown = false; // 必须先 pointerdown 才能进入拖拽判定，否则 mousemove 会因 downX=0 立即触发
let startX = 0;
let startY = 0;
let downX = 0;
let downY = 0;
let titleCache: Record<number, string> = {};

// 最近一次悬停坐标（用于列表刷新后用新列表重算高亮）
let hoverLast: { x: number; y: number } | null = null;

// 倒计时状态：选择窗口/区域后、正式开录前的 2 秒醒目倒计时期间为 true，
// 此时忽略所有指针交互，避免误触重新选择。
let countingDown = false;
let countdownTimer: number | null = null;
const COUNTDOWN_SECONDS = 2;

// 悬停命中测试（纯前端，零 IPC）：在实时窗口列表里找包含光标、且 z 序最靠前（最上层可见）的窗口。
// 用 z 序而非最小面积，才能正确识别「重叠窗口」之上真实可见的那个，避免被遮挡的小窗口误判为命中。
// 不跳过 is_self：本应用自身的窗口（主窗 / 浮窗）同样是用户可能想录制的可见窗口，
// 截图/录屏覆盖窗本身已在枚举时隐藏或经 filter_self_overlay_windows 剔除，不会混入列表。
function hitWindow(cx: number, cy: number): Win | null {
  const p = toPhys(cx, cy);
  let best: Win | null = null;
  let bestZ = Infinity;
  for (const w of windows) {
    if (p.x >= w.x && p.x <= w.x + w.width && p.y >= w.y && p.y <= w.y + w.height) {
      const z = w.z == null ? Infinity : w.z;
      if (z < bestZ) { best = w; bestZ = z; }
    }
  }
  return best;
}

// 单击 / 长截图 / 缓存缺失兜底的权威命中：走 Rust `window_at_point`（WindowFromPoint 取光标下真实顶层窗口
// + 沿 Z 序跳过本应用覆盖窗/控制台/浮窗）。单次、权威，处理 z 序裁剪、透明、被遮挡与 UWP。
// 重要：它经 Tauri 阻塞线程池（spawn_blocking + 整条 z 序遍历），**绝不用于每帧悬停热路径**
// （否则重蹈「更卡 / 开启卡」）；仅在单击（单次）与同步 hitWindow 缓存 miss 时按需调用。
async function hitAt(cx: number, cy: number): Promise<Win | null> {
  const p = toPhys(cx, cy);
  try {
    return await invoke<Win | null>("window_at_point", { x: p.x, y: p.y });
  } catch {
    return null;
  }
}

// rAF 节流的悬停高亮：合并同一帧内多次 pointermove，每帧最多一次同步命中测试（零 IPC，平滑跟手）。
// 命中走纯前端 hitWindow（基于开启时 Rust 预取的**完整**窗口列表，**全程不轮询 list_windows**）。
// 关键：list_windows 是**同步** Tauri 命令，会在主线程跑整条窗口树枚举（EnumWindows + 独立的 zorder_ranks），
// 每 100ms 一次正是「频繁更卡 / 开启卡」真凶——故 hover 期彻底不调用它；新开窗口落到光标下时，
// hitWindow 返回 null，由下方 window_at_point 兜底（**异步**命令，不阻塞主线程）。单击仍用 OS 单次权威。
// updateWinHighlight 内部按命中 hwnd 去重，命中窗口不变时不重绘，进一步消除卡顿。
let hoverRaf: number | null = null;
let hoverPending: { x: number; y: number } | null = null;
let lastOsFallback = 0; // 缓存 miss 时 OS 兜底（window_at_point）节流时间戳
let hoverSeq = 0;       // 异步 OS 兜底结果乱序防护
function requestHover(cx: number, cy: number) {
  hoverLast = { x: cx, y: cy };
  hoverPending = { x: cx, y: cy };
  if (hoverRaf === null) {
    hoverRaf = requestAnimationFrame(() => {
      hoverRaf = null;
      const pt = hoverPending;
      hoverPending = null;
      if (!pt) return;
      const now = performance.now();
      // 即时命中：同步 hitWindow（零 IPC、实时跟手、不卡），用于平滑过渡。
      const hit = hitWindow(pt.x, pt.y);
      updateWinHighlight(hit);
      // 每 60ms 用 OS 权威接口（WindowFromPoint）校正一次：列表 z 序在置顶窗口 / 重叠场景下
      // 不可靠（GetTopWindow+GW_HWNDNEXT 只遍历普通 z 序链、漏掉 topmost 窗口），会导致
      // 「只能识别一个窗口 / 鼠标移动没用」。window_at_point 走真实 Z 序、跳过本应用覆盖窗，
      // 始终返回光标下真正的顶层窗口；60ms 节流下开销极低、不卡。
      if (now - lastOsFallback >= 60) {
        lastOsFallback = now;
        const seq = ++hoverSeq;
        hitAt(pt.x, pt.y)
          .then((w) => {
            if (seq !== hoverSeq) return; // 丢弃过期结果，防快移跳回旧窗
            updateWinHighlight(w ?? null);
          })
          .catch(() => {});
      }
      // 注：hover 期**不再**轮询 list_windows（同步命令阻塞主线程跑整窗树枚举 = 卡顿真凶）。
      // 列表在开启时由 recorder-select-ready 事件一次性种子（完整），静态即可；新窗由上方兜底覆盖。
    });
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

// 更新窗口高亮框位置
// 命中窗口未变且当前高亮仍可见时跳过重绘（避免每帧 DOM 写入与标题 IPC，消除卡顿）。
let lastHoverHwnd: number | null = null;
function updateWinHighlight(win: Win | null) {
  const hw = win?.hwnd ?? null;
  if (hw === lastHoverHwnd && winHighlight.style.display !== "none") return;
  lastHoverHwnd = hw;
  if (!win) {
    winHighlight.style.display = "none";
    if (!countingDown) hideDimmer();  // 倒计时期间保留已选区域的暗化，不随悬停闪烁
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
  if (!countingDown) updateDimmer(cssX, cssY, cssW, cssH);  // 倒计时期间暗化固定在已选区域，不随悬停跳变
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
  updateDimmer(x, y, w, h);
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
  if (countingDown) { abortCountdown(); }  // 倒计时中点一下即可重新选择，不再冻结
  if (e.button !== 0) return;
  // 捕获指针：即使光标移出 overlay 元素，后续 pointermove/up 仍发到此元素
  (e.target as Element).setPointerCapture?.(e.pointerId);
  pointerDown = true;
  downX = e.clientX;
  downY = e.clientY;
  dragging = false;
  startX = e.clientX;
  startY = e.clientY;
});

overlay.addEventListener("pointermove", (e) => {
  // 倒计时期间不再冻结：保持悬停高亮实时更新，界面“活”着不卡死
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
    // 纯悬停（未按下）：实时命中测试高亮当前窗口（rAF 节流，OS 权威，永不残缺）
    requestHover(e.clientX, e.clientY);
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

overlay.addEventListener("pointerup", async (e) => {
  if (countingDown) return;
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
    void startCountdown(clipped.x, clipped.y, clipped.w, clipped.h);
  } else {
    // 干净单击：以 OS 实时命中测试取光标下真实窗口（down 位置，最权威）；为空时回退列表命中。
    const w = await hitAt(downX, downY);
    const downWin = w ?? hitWindow(downX, downY);
    if (downWin) {
      if (downWin.isTaskbar) {
        // 点任务栏本身 = 整屏录制（含任务栏）
        const vw = Math.round(window.innerWidth * scale);
        const vh = Math.round(window.innerHeight * scale);
        void startCountdown(ox, oy, vw, vh);
      } else {
        // 干净单击窗口：使用窗口矩形（物理像素），并剔除任务栏那条带
        const clipped = clipToWorkArea({ x: downWin.x, y: downWin.y, w: downWin.width, h: downWin.height });
        void startCountdown(clipped.x, clipped.y, clipped.w, clipped.h);
      }
    } else {
      cancel();
    }
  }
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
  if (countdownTimer !== null) { clearInterval(countdownTimer); countdownTimer = null; }
  countingDown = false;
  countdownEl.style.display = "none";
  countdownEl.style.pointerEvents = "none";
  overlay.style.pointerEvents = "";  // 恢复指针事件捕获
  window.removeEventListener("contextmenu", onCtxDuringCountdown);
  countdownEl.removeEventListener("pointerdown", abortCountdownViaDisplay);
  try {
    await invoke("hide_recorder_select");
  } catch {
    // 忽略
  }
  await getCurrentWindow().hide();
}

// 中止倒计时：恢复选择模式，允许重新框选/点击窗口
function abortCountdown() {
  if (!countingDown) return;
  if (countdownTimer !== null) { clearInterval(countdownTimer); countdownTimer = null; }
  countingDown = false;
  countdownEl.style.display = 'none';
  countdownEl.style.pointerEvents = 'none';
  overlay.style.pointerEvents = '';  // 恢复指针事件捕获
  window.removeEventListener('contextmenu', onCtxDuringCountdown);
  countdownEl.removeEventListener('pointerdown', abortCountdownViaDisplay);
  hint.style.display = 'block';      // 恢复提示，允许重新选择
}

// 倒计时期间右键取消（因为 overlay pointer-events:none，需 window 级监听）
function onCtxDuringCountdown(e: MouseEvent) {
  e.preventDefault();
  void cancel();
}

// 点击倒计时数字 = 中止倒计时（因为 overlay 已 click-through，只有数字区域可交互）
function abortCountdownViaDisplay(e: PointerEvent) {
  e.stopPropagation();
  abortCountdown();
}

// 倒计时数字弹跳动画（每次换数字重新触发一次）
function showCountdownNumber(n: number) {
  cdNum.textContent = String(n);
  cdNum.style.animation = "none";
  void cdNum.offsetWidth; // 触发重排以重启 CSS 动画
  cdNum.style.animation = "cd-pop 1s ease-out";
}

// 选择窗口/区域后：先展示 2 秒醒目倒计时，屏幕在此期间保持实时（仅暗化遮罩 + 选区/窗口高亮 + 红字提示），
// 倒计时结束才隐藏覆盖窗并真正开录 —— 因此倒计时提示绝不会被录进视频。
function startCountdown(x: number, y: number, w: number, h: number) {
  // 守卫：坐标无效时提示重新框选，绝不退化全屏（也不必走倒计时）
  if (
    !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(w) || !Number.isFinite(h) ||
    w < 1 || h < 1
  ) {
    showError("录屏区域无效，请重新框选区域");
    void cancel();
    return;
  }
  countingDown = true;
  hint.style.display = "none";
  // 保留当前已选中的选区/窗口高亮（selection 或 winHighlight），让用户看清将录制的范围。
  // 倒计时期间 overlay 变为 click-through，允许用户操作底层应用（打字、换模块、开浏览器等）
  overlay.style.pointerEvents = "none";
  // countdownEl 保持可交互：点击数字即可中止倒计时，重新选择区域
  countdownEl.style.pointerEvents = "auto";
  countdownEl.addEventListener("pointerdown", abortCountdownViaDisplay, { once: true });
  // 倒计时期间右键整窗取消（overlay 已 click-through，需 window 级监听）
  window.addEventListener("contextmenu", onCtxDuringCountdown);
  let remaining = COUNTDOWN_SECONDS;
  countdownEl.style.display = "flex";
  showCountdownNumber(remaining);
  countdownTimer = window.setInterval(() => {
    remaining -= 1;
    if (remaining <= 0) {
      if (countdownTimer !== null) { clearInterval(countdownTimer); countdownTimer = null; }
      countdownEl.style.display = "none";
      countdownEl.style.pointerEvents = "none";
      countingDown = false;
      overlay.style.pointerEvents = "";  // 恢复指针事件捕获
      window.removeEventListener("contextmenu", onCtxDuringCountdown);
      countdownEl.removeEventListener("pointerdown", abortCountdownViaDisplay);
      void beginRecording(x, y, w, h);
    } else {
      showCountdownNumber(remaining);
    }
  }, 1000);
}

// 正式开录：隐藏选择覆盖窗（避免被截入）→ 显示控制台 → 启动录屏。
async function beginRecording(x: number, y: number, w: number, h: number) {
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
    // 目标 60fps（用户要求：目标 60、最低 30、游戏锁定 60）。能否稳住 60 取决于编码器：
    // 有硬件编码器（nvenc/qsv/amf，游戏/独显机均具备）→ 60fps 流畅；无硬件编码器时
    // Rust 侧自动降到 30fps（软编码 60fps 必卡）。前台全屏游戏走 GPU → 必有硬件编码器 → 自动锁 60。
    const fps = 60;
    await invoke("start_recording", {
      outputPath,
      fps,
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
  const wasReady = ready;
  ready = true;
  if (!wasReady) {
    // 首次初始化：复位倒计时 / 交互状态（防止上次中断残留）
    countingDown = false;
    if (countdownTimer !== null) { clearInterval(countdownTimer); countdownTimer = null; }
    countdownEl.style.display = "none";
    countdownEl.style.pointerEvents = "none";
    overlay.style.pointerEvents = "";  // 恢复指针事件
    window.removeEventListener("contextmenu", onCtxDuringCountdown);
    countdownEl.removeEventListener("pointerdown", abortCountdownViaDisplay);
    titleCache = {};
    lastHoverHwnd = null;
    dragging = false;
    hint.style.display = "block";
    winHighlight.style.display = "none";
    selection.style.display = "none";
    hideDimmer();
  } else {
    // 重复事件（首开 150ms 兜底重推 / 竞态晚到）：仅刷新坐标与窗口列表，
    // **不重置正在进行的拖拽 / 倒计时 / 高亮**，避免高亮闪烁或交互被打断（「开启卡」来源之一）。
    titleCache = {};
  }
}

// 保留事件监听（快速路径：如果事件能到达，立即初始化）
listen<{ ox: number; oy: number; scale: number; windows?: Win[] }>("recorder-select-ready", (event) => {
  void initFromEvent(event.payload);
});

// 窗口变化事件驱动更新（B.2）：Rust 侧 WinEventHook 在窗口 创建/销毁/移动/前台变化 时防抖
// 推送最新列表，替代 hover 期轮询。静止桌面零事件；动态场景（新开/移动/切换窗口）高亮始终准确。
listen<{ windows?: Win[] }>("window-list-changed", (event) => {
  const ws = event.payload?.windows;
  if (!ws || ws.length === 0) return;
  windows = ws;
  // 用新列表重算当前悬停高亮（非拖拽 / 非倒计时时）。
  if (!pointerDown && !dragging && hoverLast && !countingDown) {
    updateWinHighlight(hitWindow(hoverLast.x, hoverLast.y));
  }
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
