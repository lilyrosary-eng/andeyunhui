// 截图覆盖窗独立轻量入口：只加载 ScreenshotOverlay 与极少量依赖，
// 不加载主应用（App / ThemeProvider / 各业务模块），确保「截图秒开」。
import React from "react";
import ReactDOM from "react-dom/client";
import { ScreenshotOverlay } from "./components/ScreenshotOverlay";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import "./index.css";

interface OverlayData {
  image: string;
  ox: number;
  oy: number;
  scale: number;
  windows: any[];
  noteId: string;
}

function OverlayApp() {
  const [data, setData] = React.useState<OverlayData | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    const p = listen("screenshot-start", (event: any) => {
      const payload = event.payload || {};
      const meta = {
        ox: payload.ox || 0,
        oy: payload.oy || 0,
        scale: payload.scale || 1,
        windows: payload.windows || [],
        noteId: payload.noteId || "",
      };
      invoke<ArrayBuffer>("read_screenshot")
        .then((buf) => {
          if (cancelled) return;
          const url = URL.createObjectURL(new Blob([buf], { type: "image/jpeg" }));
          setData((prev) => {
            if (prev && prev.image.startsWith("blob:")) URL.revokeObjectURL(prev.image);
            return { image: url, ...meta };
          });
        })
        .catch((err) => console.error("[截图] 读取失败:", err));
    });
    return () => {
      cancelled = true;
      p.then((un) => un());
    };
  }, []);

  const handleClose = React.useCallback(() => {
    setData((prev) => {
      if (prev && prev.image.startsWith("blob:")) URL.revokeObjectURL(prev.image);
      return null;
    });
    invoke("hide_overlay_window").catch(() => {});
  }, []);

  if (!data) {
    return React.createElement("div", {
      style: {
        position: "fixed",
        inset: 0,
        background: "transparent",
        zIndex: 9999,
      },
    });
  }

  return React.createElement(ScreenshotOverlay, {
    image: data.image,
    ox: data.ox,
    oy: data.oy,
    scale: data.scale,
    windows: data.windows,
    noteId: data.noteId,
    onClose: handleClose,
  });
}

const root = document.getElementById("root");
if (root) {
  ReactDOM.createRoot(root).render(
    React.createElement(React.StrictMode, null, React.createElement(OverlayApp)),
  );
}
