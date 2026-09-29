/**
 * 主窗口引用（模块级单例）。
 *
 * 打包后静态 import 可能因 CSP / 模块解析失败，故保留「动态 import + window.__TAURI__ 全局兜底」两条路径。
 * 原先只存在于 Titlebar.tsx，沉浸模式（ImmersiveChrome）也需要控制键，抽到这里共用同一份引用，
 * 避免两处各自探测（探测结果不一致会导致其中一处按钮点了没反应）。
 */
type AppWindow = {
  minimize: () => void;
  toggleMaximize: () => void;
  close: () => void;
};

let appWindow: AppWindow | null = null;
try {
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  appWindow = getCurrentWindow();
} catch {
  // 生产环境可能因 CSP/模块解析失败，尝试全局对象 fallback
  appWindow = null;
}
if (!appWindow && typeof window !== 'undefined') {
  const tauriGlobal = (window as unknown as {
    __TAURI__?: { window?: { getCurrentWindow?: () => AppWindow } };
  }).__TAURI__;
  if (tauriGlobal?.window?.getCurrentWindow) {
    appWindow = tauriGlobal.window.getCurrentWindow();
  }
}

export { appWindow };