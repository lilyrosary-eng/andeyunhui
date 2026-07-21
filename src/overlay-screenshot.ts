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
    let loaded = false;
    let safetyTimer: number | null = null;

    const buildMeta = (payload: any) => ({
      ox: payload?.ox || 0,
      oy: payload?.oy || 0,
      scale: payload?.scale || 1,
      windows: payload?.windows || [],
      noteId: payload?.noteId || "",
    });

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
              loaded = true;
              setData((prev) => {
                if (prev && prev.image && prev.image.startsWith("blob:")) URL.revokeObjectURL(prev.image);
                return { image: url, ...meta };
              });
            },
            "image/jpeg",
            0.96,
          );
        })
        .catch((err) => {
          loadingRef.current = false;
          const msg = String(err || "");
          // 「尚无截屏数据」是捕获线程尚未完成的预期瞬时态，轮询会重试，无需告警刷屏。
          // 不关闭覆盖窗，等待 screenshot-ready / 轮询兜底真正注入冻结图。
          if (!msg.includes("尚无截屏数据")) {
            console.warn("[截图] 读取冻结图失败（可能捕获进行中，稍后重试）:", err);
          }
        });
    };

    // 快路径①：截图启动（仅推送 meta，进入透明待加载态，选区交互立即可用）
    const p1 = listen("screenshot-start", (event: any) => {
      const meta = buildMeta(event.payload);
      setData((prev) => {
        if (prev && prev.image && prev.image.startsWith("blob:")) URL.revokeObjectURL(prev.image);
        return { image: "", ...meta };
      });
    });

    // 快路径②：冻结图就绪（后台捕获线程完成）→ 注入截图
    const p2 = listen("screenshot-ready", (event: any) => {
      loadShot(buildMeta(event.payload));
    });

    // 兜底路径：轮询 peek_screenshot。打包版 WebView2 偶发丢失 push 事件时，
    // 只要 session 增大且尚未注入冻结图，即主动拉取渲染，根治「只有透明遮罩、无实际功能」。
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
          // 检测到新一次截图：复位就绪标记并立即尝试加载。
          // 不保留上次截图的 loaded=true，否则后续截图会被轮询兜底漏掉。
          handledSession.current = session;
          loaded = false;
          if (!loaded) loadShot(buildMeta(snap));
          return;
        }
        // 关键修复：start_screenshot 在进入捕获线程前就同步把 session 自增，
        // 而冻结图要等捕获线程写完 SHOT 才就绪。若本轮轮询抢在捕获完成前检测到
        // session 变化并调用一次 read_screenshot，会拿到「尚无截屏数据」。
        // 此处持续重试直到真正注入冻结图，避免「screenshot-ready 事件丢失时
        // 只失败一次就 4s 超时关窗」的问题。
        if (session === handledSession.current && session > 0 && !loaded && !loadingRef.current) {
          loadShot(buildMeta(snap));
        }
        })
        .catch(() => {});
    }, 120);

    // 安全时限：若 4s 内仍未注入冻结图（捕获异常等），关闭覆盖窗避免永久卡死。
    safetyTimer = window.setTimeout(() => {
      if (!loaded && !cancelled) {
        console.error("[截图] 4s 内未获取到冻结图，关闭覆盖窗");
        handleClose();
      }
    }, 4000);

    return () => {
      cancelled = true;
      if (safetyTimer !== null) window.clearTimeout(safetyTimer);
      window.clearInterval(poll);
      p1.then((un) => un());
      p2.then((un) => un());
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
