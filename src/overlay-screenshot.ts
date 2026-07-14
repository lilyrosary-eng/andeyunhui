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
  // 记录已处理的截图会话号：push 事件与 peek 轮询共享它，避免同一次截图被重复加载。
  const handledSession = React.useRef<number>(0);
  // 当前是否正在加载冻结图（读取 + 编码），避免并发重复触发。
  const loadingRef = React.useRef<boolean>(false);

  const handleClose = React.useCallback(() => {
    setData((prev) => {
      if (prev && prev.image.startsWith("blob:")) URL.revokeObjectURL(prev.image);
      return null;
    });
    invoke("hide_overlay_window").catch(() => {});
  }, []);

  React.useEffect(() => {
    let cancelled = false;

    // 读取冻结图并渲染。meta 为本次截图的坐标/窗口信息。
    const loadShot = (meta: {
      ox: number;
      oy: number;
      scale: number;
      windows: any[];
      noteId: string;
    }) => {
      if (loadingRef.current) return;
      loadingRef.current = true;
      invoke<ArrayBuffer>("read_screenshot", { scale: meta.scale || 1 })
        .then((buf) => {
          loadingRef.current = false;
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
            0.96,
          );
        })
        .catch((err) => {
          loadingRef.current = false;
          console.error("[截图] 读取失败:", err);
          // 读取失败也要退出覆盖层，杜绝「透明遮罩卡死、全屏无法操作」。
          if (!cancelled) handleClose();
        });
    };

    // 快路径：push 事件（正常情况下毫秒级到达）
    const p = listen("screenshot-start", (event: any) => {
      const payload = event.payload || {};
      const meta = {
        ox: payload.ox || 0,
        oy: payload.oy || 0,
        scale: payload.scale || 1,
        windows: payload.windows || [],
        noteId: payload.noteId || "",
      };
      loadShot(meta);
    });

    // 兜底路径：轮询 peek_screenshot。打包版 WebView2 偶发丢失 push 事件时，
    // 只要 session 增大即主动拉取冻结图渲染，根治「只有透明遮罩、无实际功能」。
    // 首次挂载时把 handledSession 同步为当前 session，避免加载启动时的历史空快照。
    let initialized = false;
    const poll = window.setInterval(() => {
      invoke<any>("peek_screenshot")
        .then((snap) => {
          if (cancelled || !snap) return;
          const session = snap.session || 0;
          if (!initialized) {
            initialized = true;
            handledSession.current = session;
            return;
          }
          if (session > handledSession.current) {
            handledSession.current = session;
            loadShot({
              ox: snap.ox || 0,
              oy: snap.oy || 0,
              scale: snap.scale || 1,
              windows: snap.windows || [],
              noteId: snap.noteId || "",
            });
          }
        })
        .catch(() => {});
    }, 120);

    return () => {
      cancelled = true;
      window.clearInterval(poll);
      p.then((un) => un());
    };
  }, [handleClose]);

  // 逃生通道：无论是否已渲染冻结图，按 Esc / 右键始终能退出覆盖层，
  // 彻底杜绝用户反馈的「全屏无法操作，只能按 Win 键杀进程」。
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        handleClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [handleClose]);

  if (!data) {
    return React.createElement("div", {
      onContextMenu: (e: any) => {
        // 无冻结图时右键直接退出，避免「透明遮罩盖住全屏、右键菜单穿透错乱」。
        e.preventDefault();
        handleClose();
      },
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
