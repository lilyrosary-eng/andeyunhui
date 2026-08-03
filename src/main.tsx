import React from "react"
import ReactDOM from "react-dom/client"
import { initFileLogger } from "./lib/file-logger"
import { installLocalImageSanitizer } from "./lib/localImage"
import { listen } from "@tauri-apps/api/event"
import "./index.css"

// 尽早初始化前端全局错误捕获：把 window.onerror / unhandledrejection / console.error 写入会话日志文件
initFileLogger();
// 把 Rust 端 SMTC 诊断事件转发到会话日志文件（console.error 会被 file-logger 捕获），
// 便于在打包版下看到任务栏媒体会话的真实状态，定位「未知应用」根因。
listen("smtc-diag", (event) => {
  console.error("[SMTC-DIAG-FE]", JSON.stringify((event as { payload: unknown }).payload));
}).catch(() => {});
// 全局兜底：拦截任何把 localimg:// 直接写进 <img>/<source> 的渲染路径，避免浏览器报
// net::ERR_UNKNOWN_URL_SCHEME（兜底上层 NodeView / markdown 预览的解析遗漏）
installLocalImageSanitizer();

// 启动进度上报（由 index.html 预加载脚本提供的真实进度引擎消费）
const boot = (window as unknown as {
  __bootProgress?: (pct: number, opts?: { text?: string; phase?: string }) => void;
  __bootDone?: (opts?: { text?: string; phase?: string }) => void;
});

/**
 * 浏览器移动端预览：URL 带 ?mobile=1 或 localStorage 设 mobile-preview=1 时，
 * 在浏览器（vite dev / 静态预览）也走 MobileApp，无需打包即可调 UI。
 * Tauri 环境（Android 真机/模拟器）仍由 isAndroid() 判定。
 */
function isMobilePreview(): boolean {
  if (typeof window === "undefined") return false;
  try {
    if (new URLSearchParams(window.location.search).get("mobile") === "1") return true;
    return localStorage.getItem("mobile-preview") === "1";
  } catch {
    return false;
  }
}

// JS 包已就绪（HTML 解析 + 主模块执行完成）
boot.__bootProgress?.(10, { text: "初始化内核", phase: "PHASE 01 / 05" });

// 窗口分流：检测当前窗口标签，分别走轻量组件，避免主 App 初始化开销
// 关键：使用动态 import，子窗口（浮窗/歌词）不会加载主 App 的 JS bundle
async function bootstrap() {
  let windowKind: "lyrics" | "floating-note" | "floating-clipboard" | "floating-dropzone" | "capsule" | "main" = "main";
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const label = getCurrentWindow().label;
    const params = new URLSearchParams(window.location.search);
    const floating = params.get("floating");
    if (label === "lyrics-widget") {
      windowKind = "lyrics";
    } else if (floating === "true") {
      windowKind = "floating-note";
    } else if (floating === "clipboard") {
      windowKind = "floating-clipboard";
    } else if (floating === "dropzone") {
      windowKind = "floating-dropzone";
    } else if (floating === "capsule") {
      windowKind = "capsule";
    }
  } catch {
    // 非 Tauri 环境（浏览器开发），检查 URL 参数
    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      const floating = params.get("floating");
      if (floating === "true") windowKind = "floating-note";
      else if (floating === "clipboard") windowKind = "floating-clipboard";
      else if (floating === "dropzone") windowKind = "floating-dropzone";
      else if (floating === "capsule") windowKind = "capsule";
    }
  }

  // 子窗口（歌词 / 浮窗 / 截图覆盖层）不显示哥特加载层：立即收尾，避免遮挡
  if (windowKind !== "main") {
    boot.__bootDone?.();
  }

  // 截图覆盖窗口不再走 index.html：Rust 直接以独立轻量入口 screenshot-overlay.html 创建，
  // 仅加载 ScreenshotOverlay 组件（src/overlay-screenshot.ts），不加载主应用，
  // 从而彻底避免「整站 JS 包解析」带来的数秒延迟，实现截图秒开。

  // 托盘右键菜单窗口（自定义 UI，承载「回到主界面 / 关闭软件」）
  if (typeof window !== "undefined" && window.location.search.includes('overlay=tray-menu')) {
    boot.__bootDone?.();
    document.documentElement.style.background = 'transparent';
    document.body.style.background = 'transparent';
    document.body.style.margin = '0';
    document.body.style.overflow = 'hidden';
    const root = document.getElementById("root") as HTMLElement;
    const { TrayMenu } = await import('./components/TrayMenu');
    ReactDOM.createRoot(root).render(
      React.createElement(React.StrictMode, null, React.createElement(TrayMenu))
    );
    return;
  }

  const root = document.getElementById("root") as HTMLElement;
  if (windowKind === "lyrics") {
    // 歌词窗口：强制 html/body 背景透明
    document.documentElement.style.background = 'transparent';
    document.body.style.background = 'transparent';
    const { LyricsWidget } = await import('./core/lyrics/LyricsWidget');
    ReactDOM.createRoot(root).render(
      <React.StrictMode>
        <LyricsWidget />
      </React.StrictMode>,
    );
  } else if (windowKind === "floating-note") {
    // 浮窗子窗口：独立渲染，不初始化整个 App（性能优化）
    document.documentElement.style.background = 'transparent';
    document.body.style.background = 'transparent';
    const { FloatingNoteView } = await import('./core/notes/FloatingNoteView');
    ReactDOM.createRoot(root).render(
      <React.StrictMode>
        <FloatingNoteView />
      </React.StrictMode>,
    );
  } else if (windowKind === "floating-clipboard") {
    // 剪贴板浮窗：透明背景，独立渲染，不初始化主 App
    document.documentElement.style.background = 'transparent';
    document.body.style.background = 'transparent';
    const { FloatingClipboardView } = await import('./core/clipboard/FloatingClipboardView');
    ReactDOM.createRoot(root).render(
      <React.StrictMode>
        <FloatingClipboardView />
      </React.StrictMode>,
    );
  } else if (windowKind === "floating-dropzone") {
    // 中转站浮窗：透明背景，独立渲染，不初始化主 App
    document.documentElement.style.background = 'transparent';
    document.body.style.background = 'transparent';
    const { FloatingDropzoneView } = await import('./components/FloatingDropzoneView');
    ReactDOM.createRoot(root).render(
      <React.StrictMode>
        <FloatingDropzoneView />
      </React.StrictMode>,
    );
  } else if (windowKind === "capsule") {
    // 灵动岛胶囊：透明背景，独立渲染，不初始化主 App
    document.documentElement.style.background = 'transparent';
    document.body.style.background = 'transparent';
    const Capsule = (await import('./Capsule')).default;
    ReactDOM.createRoot(root).render(
      <React.StrictMode>
        <Capsule />
      </React.StrictMode>,
    );
  } else {
    // 主界面即将构建（React 将挂载 App）
    boot.__bootProgress?.(28, { text: "构建界面", phase: "PHASE 02 / 05" });
    // 平台分流（§5.4.2）：Android 走 MobileApp，桌面走 App。
    // 🔴 桌面分支渲染的组件树与改动前完全相同 —— isAndroid() 在桌面恒返回 false。
    const [{ ThemeProvider }, { I18nProvider }, { isAndroid }] = await Promise.all([
      import('./lib/ThemeProvider'),
      import('./lib/i18n'),
      import('./platform/isMobile'),
    ]);
    if (isAndroid() || isMobilePreview()) {
      const { default: MobileApp } = await import('./mobile/MobileApp');
      ReactDOM.createRoot(root).render(
        <React.StrictMode>
          <I18nProvider>
            <ThemeProvider>
              <MobileApp />
            </ThemeProvider>
          </I18nProvider>
        </React.StrictMode>,
      );
      // 🔴 Android 快速开屏：移动端不存在桌面那套 notes/overlays 启动门（__bootGate 永远不会被置位），
      // 若不主动收尾，加载层要一直等到 index.html 的 25s 硬超时才淡出。
      // 移动端内容轻量，React 挂载完即可直接结束开屏（下一帧确保首屏已上屏，避免闪白）。
      requestAnimationFrame(() => {
        requestAnimationFrame(() => boot.__bootDone?.({ text: "就绪", phase: "" }));
      });
    } else {
      const { default: App } = await import('./App');
      ReactDOM.createRoot(root).render(
        <React.StrictMode>
          <I18nProvider>
            <ThemeProvider>
              <App />
            </ThemeProvider>
          </I18nProvider>
        </React.StrictMode>,
      );
    }
  }
}

bootstrap();
