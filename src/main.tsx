import React from "react"
import ReactDOM from "react-dom/client"
import App from "./App"
import { ThemeProvider } from "./lib/ThemeProvider"
import { LyricsWidget } from "./core/lyrics/LyricsWidget"
import { FloatingNoteView } from "./core/notes/FloatingNoteView"
import "./index.css"

// 启动进度上报（由 index.html 预加载脚本提供的真实进度引擎消费）
const boot = (window as unknown as {
  __bootProgress?: (pct: number, opts?: { text?: string; phase?: string }) => void;
  __bootDone?: (opts?: { text?: string; phase?: string }) => void;
});

// JS 包已就绪（HTML 解析 + 主模块执行完成）
boot.__bootProgress?.(10, { text: "初始化内核", phase: "PHASE 01 / 05" });

// 窗口分流：检测当前窗口标签，分别走轻量组件，避免主 App 初始化开销
// 这样 App 组件本身不需要条件 return，符合 React Hooks 规则
async function bootstrap() {
  let windowKind: "lyrics" | "floating-note" | "main" = "main";
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const label = getCurrentWindow().label;
    if (label === "lyrics-widget") {
      windowKind = "lyrics";
    } else if (new URLSearchParams(window.location.search).get("floating") === "true") {
      windowKind = "floating-note";
    }
  } catch {
    // 非 Tauri 环境（浏览器开发），检查 URL 参数
    if (typeof window !== "undefined" && new URLSearchParams(window.location.search).get("floating") === "true") {
      windowKind = "floating-note";
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
    import('./components/TrayMenu').then(({ TrayMenu }) => {
      ReactDOM.createRoot(root).render(
        React.createElement(React.StrictMode, null, React.createElement(TrayMenu))
      );
    }).catch(() => {});
    return;
  }

  const root = document.getElementById("root") as HTMLElement;
  if (windowKind === "lyrics") {
    // 歌词窗口：强制 html/body 背景透明（index.html 默认 CSS 是 #f4f2ec 不透明白底）
    document.documentElement.style.background = 'transparent';
    document.body.style.background = 'transparent';
    ReactDOM.createRoot(root).render(
      <React.StrictMode>
        <LyricsWidget />
      </React.StrictMode>,
    );
  } else if (windowKind === "floating-note") {
    // 浮窗子窗口：独立渲染，不初始化整个 App（性能优化）
    // 必须和歌词窗口一样强制 html/body 背景透明，否则 index.css 的
    // body { background-color: var(--main-panel-bg); } 会阻挡 transparent: true 效果。
    document.documentElement.style.background = 'transparent';
    document.body.style.background = 'transparent';
    ReactDOM.createRoot(root).render(
      <React.StrictMode>
        <FloatingNoteView />
      </React.StrictMode>,
    );
  } else {
    // 主界面即将构建（React 将挂载 App）
    boot.__bootProgress?.(28, { text: "构建界面", phase: "PHASE 02 / 05" });
    ReactDOM.createRoot(root).render(
      <React.StrictMode>
        <ThemeProvider>
          <App />
        </ThemeProvider>
      </React.StrictMode>,
    );
  }
}

bootstrap();
