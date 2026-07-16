// 录屏控制台独立入口：纯 vanilla TS，不加载 React/主应用，确保「秒开」。
// 控制台为屏幕正上方的小条状窗口（320×52px），半透明深色背景。
//
// 交互：
// - Ctrl+Alt+R（Rust 全局热键）→ 先选择录屏区域 → 自动开始录制 → 显示控制台
// - 再次 Ctrl+Alt+R → 停止录制 → 显示「保存 / 取消」结果面板（可选 MP4 或 GIF）
// - 控制台按钮：暂停/恢复、停止
// - 整个控制台可拖拽移动
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";

// ========== DOM 构建 ==========
const root = document.getElementById("root")!;

const bar = document.createElement("div");
bar.style.cssText = `
  display: flex; align-items: center; gap: 10px;
  height: 52px; padding: 0 16px; box-sizing: border-box;
  background: rgba(20, 20, 22, 0.92);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 14px;
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  box-shadow: 0 4px 24px rgba(0, 0, 0, 0.4);
  user-select: none; -webkit-user-select: none;
  cursor: default;
  color: #e8e8e8; font-size: 13px;
  transition: opacity 0.2s;
`;

// 录制状态指示灯（红点）
const dot = document.createElement("div");
dot.style.cssText = `
  width: 10px; height: 10px; border-radius: 50%;
  background: #888; flex-shrink: 0;
  transition: background 0.2s;
`;

// 计时器
const timer = document.createElement("span");
timer.style.cssText = `
  font-family: "Cascadia Code", "Consolas", "SF Mono", monospace;
  font-size: 15px; font-weight: 600; letter-spacing: 0.5px;
  min-width: 72px; text-align: center;
  color: #ccc;
`;
timer.textContent = "00:00";

// 分隔线
const sep = document.createElement("div");
sep.style.cssText = `width: 1px; height: 20px; background: rgba(255,255,255,0.12); flex-shrink: 0;`;

// 暂停/恢复按钮
const pauseBtn = document.createElement("button");
pauseBtn.style.cssText = btnStyle();
pauseBtn.innerHTML = iconPause();
pauseBtn.title = "暂停";

// 停止按钮
const stopBtn = document.createElement("button");
stopBtn.style.cssText = btnStyle();
stopBtn.innerHTML = iconStop();
stopBtn.title = "停止";

bar.appendChild(dot);
bar.appendChild(timer);
bar.appendChild(sep);
bar.appendChild(pauseBtn);
bar.appendChild(stopBtn);
root.appendChild(bar);

// ========== 录屏结果面板（停止后显示：保存 MP4 / 保存 GIF / 取消）==========
const resultPanel = document.createElement("div");
resultPanel.style.cssText = `
  display: none; flex-direction: column; gap: 10px;
  padding: 14px 16px; box-sizing: border-box;
  background: rgba(20, 20, 22, 0.92);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 14px;
  backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);
  box-shadow: 0 4px 24px rgba(0, 0, 0, 0.4);
  color: #e8e8e8; font-size: 13px;
`;

const resultTitle = document.createElement("div");
resultTitle.textContent = "录屏完成";
resultTitle.style.cssText = `font-weight: 600; font-size: 13px; letter-spacing: 0.5px;`;

const resultStatus = document.createElement("div");
resultStatus.style.cssText = `font-size: 11px; color: rgba(255,255,255,0.45); min-height: 14px;`;

const resultBtns = document.createElement("div");
resultBtns.style.cssText = `display: flex; gap: 8px;`;

const saveMp4Btn = document.createElement("button");
saveMp4Btn.textContent = "保存 MP4";
saveMp4Btn.style.cssText = resultBtnStyle("#3b82f6");

const saveGifBtn = document.createElement("button");
saveGifBtn.textContent = "保存 GIF";
saveGifBtn.style.cssText = resultBtnStyle("#8b5cf6");

const cancelBtn = document.createElement("button");
cancelBtn.textContent = "取消";
cancelBtn.style.cssText = resultBtnStyle("rgba(255,255,255,0.12)");

resultBtns.appendChild(saveMp4Btn);
resultBtns.appendChild(saveGifBtn);
resultBtns.appendChild(cancelBtn);
resultPanel.appendChild(resultTitle);
resultPanel.appendChild(resultStatus);
resultPanel.appendChild(resultBtns);
root.appendChild(resultPanel);

function btnStyle(): string {
  return `
    display: flex; align-items: center; justify-content: center;
    width: 30px; height: 30px; border: none; border-radius: 8px;
    background: rgba(255, 255, 255, 0.08); color: #e8e8e8;
    cursor: pointer; flex-shrink: 0; padding: 0;
    transition: background 0.15s;
  `;
}

function resultBtnStyle(bg: string): string {
  return `
    flex: 1; padding: 8px 0; border: none; border-radius: 8px;
    background: ${bg}; color: #fff; cursor: pointer;
    font-size: 12px; font-weight: 600; transition: filter 0.15s;
  `;
}

function iconPause(): string {
  return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><rect x="6" y="5" width="4" height="14" rx="1" fill="currentColor"/><rect x="14" y="5" width="4" height="14" rx="1" fill="currentColor"/></svg>`;
}

function iconPlay(): string {
  return `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M7 5v14l12-7z"/></svg>`;
}

function iconStop(): string {
  return `<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>`;
}

// ========== 状态管理 ==========
let isRecording = false;
let isPaused = false;
let pollTimer: number | null = null;
let resultPath = ""; // 停止后暂存的临时录屏文件路径

function formatTime(secs: number): string {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

async function setWidgetSize(w: number, h: number) {
  try {
    await getCurrentWindow().setSize(new LogicalSize(w, h));
  } catch {
    /* ignore */
  }
}

// 进入「录制中」视图（恢复 320×52 控制台）
function backToRecording() {
  resultPanel.style.display = "none";
  bar.style.display = "flex";
  resultPath = "";
  void setWidgetSize(320, 52);
}

// 进入「结果面板」视图（扩展为 320×150，展示保存/取消）
function showResult(outputPath: string) {
  resultPath = outputPath;
  clearAutoHide(); // 结果面板需保持可见，取消自动隐藏
  bar.style.display = "none";
  resultPanel.style.display = "flex";
  resultStatus.textContent = "选择保存格式，或取消丢弃";
  void setWidgetSize(320, 150);
}

async function refreshStatus() {
  try {
    const status = await invoke<{
      isRecording: boolean;
      isPaused: boolean;
      elapsedSecs: number;
      outputPath: string;
    }>("get_recording_status");
    isRecording = status.isRecording;
    isPaused = status.isPaused;

    if (isRecording) {
      timer.textContent = formatTime(status.elapsedSecs);
      dot.style.background = isPaused ? "#f59e0b" : "#ef4444";
      dot.style.boxShadow = isPaused ? "none" : "0 0 8px rgba(239,68,68,0.6)";
      pauseBtn.innerHTML = isPaused ? iconPlay() : iconPause();
      pauseBtn.title = isPaused ? "恢复" : "暂停";
      pauseBtn.style.opacity = "1";
      pauseBtn.style.pointerEvents = "auto";

      if (!isPaused) {
        // 录制中红点闪烁
        dot.style.animation = "rec-blink 1.2s ease-in-out infinite";
      } else {
        dot.style.animation = "none";
      }
    } else {
      timer.textContent = "00:00";
      dot.style.background = "#888";
      dot.style.boxShadow = "none";
      dot.style.animation = "none";
      pauseBtn.style.opacity = "0.4";
      pauseBtn.style.pointerEvents = "none";
    }
  } catch (e) {
    console.error("[录屏] 状态查询失败:", e);
  }
}

// 停止录制 → 展示结果面板（不再自动存入中转站，交由用户选择 MP4 / GIF / 取消）
async function stopRecording() {
  try {
    const outputPath = await invoke<string>("stop_recording");
    if (outputPath) {
      showResult(outputPath);
      return;
    }
  } catch (e) {
    console.error("[录屏] 停止失败:", e);
  }
  // 无输出（如未真正开始录制）→ 直接收起
  backToRecording();
  await getCurrentWindow().hide();
}

// 保存为 MP4：存入中转站后隐藏
async function saveAsMp4() {
  if (!resultPath) {
    backToRecording();
    await getCurrentWindow().hide();
    return;
  }
  try {
    await invoke("import_to_dropzone", { sourcePath: resultPath });
  } catch (e) {
    console.error("[录屏] 存入中转站失败:", e);
  }
  backToRecording();
  await getCurrentWindow().hide();
}

// 保存为 GIF：ffmpeg 转换后存入中转站（原 MP4 临时文件清理）
async function saveAsGif() {
  if (!resultPath) {
    backToRecording();
    await getCurrentWindow().hide();
    return;
  }
  resultStatus.textContent = "GIF 转换中…";
  try {
    const gifPath: string = await invoke("convert_recording_to_gif", { mp4Path: resultPath });
    await invoke("import_to_dropzone", { sourcePath: gifPath }).catch(() => {});
    // 转换成功，清理原始 MP4 临时文件
    await invoke("delete_recording_file", { path: resultPath }).catch(() => {});
    backToRecording();
    await getCurrentWindow().hide();
  } catch (e) {
    console.error("[录屏] GIF 转换失败:", e);
    resultStatus.textContent = "GIF 转换失败，可改用 MP4";
    setTimeout(() => {
      if (resultPanel.style.display === "flex") resultStatus.textContent = "选择保存格式，或取消丢弃";
    }, 2500);
  }
}

// 取消：二次确认后丢弃（删除临时文件）
async function cancelRecording() {
  if (!resultPath) {
    backToRecording();
    await getCurrentWindow().hide();
    return;
  }
  const ok = window.confirm("确定取消？本次录屏将不会保存。");
  if (!ok) return;
  try {
    await invoke("delete_recording_file", { path: resultPath });
  } catch (e) {
    console.error("[录屏] 删除临时文件失败:", e);
  }
  backToRecording();
  await getCurrentWindow().hide();
}

async function togglePause() {
  try {
    if (isPaused) {
      await invoke("resume_recording");
    } else {
      await invoke("pause_recording");
    }
    await refreshStatus();
  } catch (e) {
    console.error("[录屏] 暂停/恢复失败:", e);
  }
}

function startPolling() {
  if (pollTimer !== null) return;
  pollTimer = window.setInterval(() => { void refreshStatus(); }, 1000);
}

function stopPolling() {
  if (pollTimer !== null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

// ========== 自动隐藏 ==========
// 录制中控制台默认自动隐藏（避免遮挡内容），悬停或按热键可重新唤出。
// 停止后（结果面板）不自动隐藏。
let autoHideTimer: number | null = null;
function clearAutoHide() {
  if (autoHideTimer !== null) {
    clearTimeout(autoHideTimer);
    autoHideTimer = null;
  }
}
function scheduleAutoHide(_delay = 3000) {
  // 用户要求：录屏控制台始终可见（仅排除在录屏画面外），不再自动隐藏。
  clearAutoHide();
}

// ========== 事件绑定 ==========
pauseBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  void togglePause();
});

stopBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  void stopRecording();
});

saveMp4Btn.addEventListener("click", (e) => {
  e.stopPropagation();
  void saveAsMp4();
});

saveGifBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  void saveAsGif();
});

cancelBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  void cancelRecording();
});

// 按钮 hover 效果
[pauseBtn, stopBtn, saveMp4Btn, saveGifBtn, cancelBtn].forEach((btn) => {
  btn.addEventListener("mouseenter", () => {
    btn.style.filter = "brightness(1.15)";
  });
  btn.addEventListener("mouseleave", () => {
    btn.style.filter = "none";
  });
});

// 拖拽窗口（整个 bar 可拖拽，按钮除外）
bar.addEventListener("mousedown", (e) => {
  // 按钮点击不触发拖拽
  if ((e.target as HTMLElement).closest("button")) return;
  void getCurrentWindow().startDragging();
});

// 悬停时取消自动隐藏（保持可见），移开后再延迟隐藏
bar.addEventListener("mouseenter", () => clearAutoHide());
bar.addEventListener("mouseleave", () => scheduleAutoHide(800));

// ========== 全局事件监听 ==========
// Ctrl+Alt+R → Rust handler 管理整个流程：
//   未录制 → 显示区域选择覆盖窗（recorder-select）→ 选择后启动录制 → 显示控制台
//   录制中 → 向控制台发 recorder-toggle 事件 → 停止录制 → 展示结果面板
// 控制台不自动开始录制，仅显示状态和控制
listen<null>("recorder-toggle", async () => {
  if (isRecording) {
    await stopRecording();
  } else {
    // 未录制时收到 toggle → 隐藏控制台（录制由区域选择流程启动）
    await getCurrentWindow().hide();
  }
});

// 监听窗口关闭请求 → 同步状态
getCurrentWindow().onCloseRequested(() => {
  if (isRecording) {
    void stopRecording();
  }
});

// 监听录屏启动事件：立即刷新状态并复位到「录制中」视图（轮询已在页面加载时启动，此处仅加速首次更新）
listen<string>("recording-started", async () => {
  backToRecording();
  await refreshStatus(); // 必须先拿到 isRecording=true，否则 scheduleAutoHide 会直接 return
  scheduleAutoHide(3000); // 录制开始后短暂显示，随后自动隐藏
});

// 监听「唤出控制台」事件（热键在控制台已隐藏时触发）：重新显示并安排自动隐藏
listen("recorder-reveal", () => {
  scheduleAutoHide(3000);
});

// 闪烁动画
const style = document.createElement("style");
style.textContent = `
  @keyframes rec-blink {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.3; }
  }
`;
document.head.appendChild(style);

// 初始化：刷新状态并启动轮询（录制由区域选择流程启动）
void (async () => {
  await refreshStatus();
  startPolling();
})();
