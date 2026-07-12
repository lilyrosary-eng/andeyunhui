// 截图覆盖窗独立轻量入口：只加载 ScreenshotOverlay 与极少量依赖，
// 不加载主应用（App / ThemeProvider / 各业务模块），确保「截图秒开」。
import React from "react";
import ReactDOM from "react-dom/client";
import { ScreenshotOverlay } from "./components/ScreenshotOverlay";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import "./index.css";
// 必须在 index.css 之后导入：用 !important 覆盖其 @layer base 里
// body 设置的不透明背景（var(--main-panel-bg) ≈ 85% 白），消除触发瞬间「全屏变白」。
import "./overlay-transparent.css";

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
      invoke<ArrayBuffer>("read_screenshot", { scale: meta.scale || 1 })
        .then((buf) => {
          if (cancelled) return;
          // 前 8 字节为逻辑分辨率宽/高（u32 LE），其后为已降采样的 RGBA 字节
          // （Rust 侧按 scale 降采样，体积约为原图 1/scale²，前端不再建 33MP 画布）
          const dv = new DataView(buf);
          const w = dv.getUint32(0, true);
          const h = dv.getUint32(4, true);
          const rgba = new Uint8ClampedArray(buf, 8);
          const src = document.createElement("canvas");
          src.width = w;
          src.height = h;
          const sctx = src.getContext("2d");
          if (!sctx) return;
          sctx.putImageData(new ImageData(rgba, w, h), 0, 0);
          // 浏览器原生编码（release 级性能，不受 Tauri dev 放大），取代 Rust 侧 CatmullRom+JPEG
          src.toBlob(
            (blob) => {
              if (!blob || cancelled) return;
              const url = URL.createObjectURL(blob);
              setData((prev) => {
                if (prev && prev.image.startsWith("blob:")) URL.revokeObjectURL(prev.image);
                return { image: url, ...meta };
              });
            },
            "image/jpeg",
            0.92,
          );
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
