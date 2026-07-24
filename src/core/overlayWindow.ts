// 浮窗（透明/layered WebView2 子窗）统一创建入口 —— 批次 B：前端收口。
//
// 所有动态浮窗（截图/托盘/剪贴板/中转站/浮窗笔记/插件沙箱）都改走本文件的
// `ensureOverlayWindow`，它只发一个 IPC 命令 `overlay_window_get_or_create` 给 Rust 的
// window_manager 引擎，由 Rust 在主线程安全创建 + 智能重试 + 坏窗自愈。前端不再各自
// `new WebviewWindow`，从而彻底消除「命令里建窗死锁」「坏窗残留」「错误抓不到」三类问题。
//
// 设计要点：
// - 复用优先：已存在且健康（能取到句柄）的窗直接返回，避免重复建窗。
// - 创建由 Rust 收口：参数统一（transparent/decorations/shadow/skip_taskbar/always_on_top/
//   resizable/drag_drop_enabled），绝不用 visible:false（否则 WebView2 报 0x8007139F 坏窗）。
// - 坏窗兜底：监听 `tauri://error`，Rust 侧另有 `scale_factor()` 探测兜底，这里是 JS 侧冗余保障。

import { invoke } from '@tauri-apps/api/core';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';

/** 浮窗创建 profile，字段名与 Rust 端 `OverlayProfile`（snake_case）经 Tauri 自动 camelCase 映射对应。 */
export interface OverlayProfile {
  width?: number;
  height?: number;
  minWidth?: number;
  minHeight?: number;
  x?: number;
  y?: number;
  transparent?: boolean;
  decorations?: boolean;
  shadow?: boolean;
  skipTaskbar?: boolean;
  alwaysOnTop?: boolean;
  resizable?: boolean;
  dragDropEnabled?: boolean;
  /** 预热场景：为 true 时 Rust 在 build 后立刻隐藏窗口（绘制前不可见），用于加载页期间静默预热。 */
  hidden?: boolean;
}

/**
 * 确保某个浮窗存在并返回其句柄。已有则直接复用，否则通过统一 IPC 在 Rust 主线程创建。
 * 失败会抛错（调用方应 catch 并给出可见提示，而非「按了毫无反应」）。
 */
export async function ensureOverlayWindow(
  label: string,
  url: string,
  profile: OverlayProfile = {},
): Promise<WebviewWindow | null> {
  // 复用优先：已存在的健康窗直接返回，绝不销毁重建。
  // 重建整个 WebView2（CoreWebView2Controller）是冷启动、耗时数秒——这正是
  // 「每次启动截图都要好长时间」的根因（dev 下旧逻辑每次都 destroy 再 create）。
  // dev 下也纯复用、不再 reload：reload 会让独立 webview 卸载重挂载，概率卡死甚至拖垮
  // 整个 WebView2 进程。覆盖窗常驻、监听器持久，事件永不因 reload 丢失；首次新建由 poll
  // 兜底自愈。代价是 dev 改独立浮窗/截图窗代码需重启 dev 生效（换取绝对稳定）。
  {
    const existing = await WebviewWindow.getByLabel(label);
    if (existing) {
      // dev 下也纯复用，不再 reload：隐藏态/触发时 reload 会让覆盖窗（及独立浮窗 webview）
      // 卸载重挂载，期间事件丢失 + poll 自愈被吞，概率卡死甚至拖垮整个 WebView2 进程。
      // 纯复用下覆盖窗常驻、监听器持久，事件永不因 reload 丢失；首次新建由 poll 兜底自愈。
      // 代价：dev 改独立浮窗/截图窗代码需重启 dev 生效（换取绝对稳定）。
      return existing;
    }
  }
  // 2. 通过统一 IPC 在主线程（Rust）安全创建，带重试 + 坏窗自愈
  await invoke('overlay_window_get_or_create', { label, url, profile });
  // 3. 取句柄（Rust 已建好并完成 webview 初始化）
  const win = await WebviewWindow.getByLabel(label);
  if (!win) {
    throw new Error(`浮窗创建后无法取得句柄: ${label}`);
  }
  // 坏窗兜底：监听 tauri://error 便于排查（Rust 侧已有 scale_factor 探测兜底）
  win.listen('tauri://error', (e) => {
    console.error(`[overlay] ${label} 窗错误:`, e);
  });
  return win;
}

/** 销毁指定浮窗（与 `ensureOverlayWindow` 配对，统一关闭通道）。 */
export function destroyOverlayWindow(label: string): Promise<unknown> {
  return invoke('overlay_window_destroy', { label });
}
