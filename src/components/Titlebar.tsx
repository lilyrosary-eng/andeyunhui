import { Minus, Square, X } from 'lucide-react';

// 安全获取 Tauri 窗口引用（打包后静态导入更可靠）
let appWindow: { minimize: () => void; toggleMaximize: () => void; close: () => void } | null = null;
try {
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  appWindow = getCurrentWindow();
} catch {
  // 生产环境可能因 CSP/模块解析失败，尝试同步 fallback
  appWindow = null;
}
// 打包后异步导入失败时，用 window.__TAURI__ 全局对象兜底
if (!appWindow && typeof window !== 'undefined') {
  const tauriGlobal = (window as unknown as {
    __TAURI__?: { window?: { getCurrentWindow?: () => typeof appWindow } };
  }).__TAURI__;
  if (tauriGlobal?.window?.getCurrentWindow) {
    appWindow = tauriGlobal.window.getCurrentWindow() as typeof appWindow;
  }
}

export function Titlebar() {
  return (
    <div
      data-tauri-drag-region
      className="h-[38px] flex items-center justify-between bg-[#f5f5f0] dark:bg-[#1c1917] border-b border-neutral-200/50 dark:border-stone-700/50 select-none flex-shrink-0"
    >
      {/* 左侧：拖拽区域 + 标题 */}
      <div className="flex items-center h-full pl-4 gap-2">
        <div className="w-5 h-5 rounded-full element-primary flex items-center justify-center text-[10px] font-bold">
          岸
        </div>
        <span className="text-xs text-neutral-400 dark:text-stone-500 font-medium tracking-wide">岸灯鸳花</span>
      </div>

      {/* 右侧：窗口控制按钮 */}
      <div className="flex h-full">
        <button
          onClick={() => appWindow?.minimize()}
          className="btn-press w-[46px] h-full flex items-center justify-center text-neutral-400 hover:text-neutral-700 hover:bg-black/5 dark:text-stone-500 dark:hover:text-stone-300 dark:hover:bg-white/5 transition-colors"
          title="最小化"
        >
          <Minus size={15} />
        </button>
        <button
          onClick={() => appWindow?.toggleMaximize()}
          className="btn-press w-[46px] h-full flex items-center justify-center text-neutral-400 hover:text-neutral-700 hover:bg-black/5 dark:text-stone-500 dark:hover:text-stone-300 dark:hover:bg-white/5 transition-colors"
          title="最大化"
        >
          <Square size={13} />
        </button>
        <button
          onClick={() => appWindow?.close()}
          className="btn-press w-[46px] h-full flex items-center justify-center text-neutral-400 hover:text-white hover:bg-red-500 transition-colors"
          title="关闭"
        >
          <X size={16} />
        </button>
      </div>
    </div>
  );
}