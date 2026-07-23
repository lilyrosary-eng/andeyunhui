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
  image: ImageBitmap | null;
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
      if (prev && prev.image) {
        if (typeof prev.image === "string") {
          if (prev.image.startsWith("blob:")) URL.revokeObjectURL(prev.image);
        } else if (typeof (prev.image as ImageBitmap).close === "function") {
          (prev.image as ImageBitmap).close();
        }
      }
      return null;
    });
    invoke("hide_overlay_window").catch(() => {});
    // 注意：dev 下**不再**在关闭后自我 reload（旧方案）。隐藏态 reload 会让覆盖窗卸载重挂载，
    // 期间 poll 的 initialized 首次 peek 把 handledSession 吸成最新 session，而 screenshot-start
    // 事件在 reload 期间已丢失、sessionActive 永远 false → poll 自愈分支永不触发，永久卡在
    // data=null（默认光标、无法选择）；反复 reload 隐藏 WebView2 还会概率拖垮整个 WebView2 进程
    // （整软件卡死）。现改为纯复用（与生产一致）：覆盖窗常驻、监听器持久，事件永不因 reload 丢失，
    // 首次新建时由 poll 兜底自愈。dev 下改截图覆盖窗代码需重启 dev 生效（换取绝对稳定）。
  }, []);

  // 显示覆盖窗（仅显示，复用不销毁）。由 ScreenshotOverlay 在冻结图真正 onLoad 就绪后调用，
  // 确保「先有冻结图、再显示」——根治「图未注入即显示→黑底抢先」的全屏黑屏。
  const reveal = React.useCallback(() => {
    invoke("reveal_screenshot_overlay").catch(() => {});
  }, []);

  React.useEffect(() => {
    let cancelled = false;
    let loaded = false;
    // 本次「有效截图会话」是否已开始：仅由 screenshot-start 事件或 poll 检测到 session 增大触发。
    // 用于门控安全时限与轮询重试——避免 dev 下「覆盖窗关闭后自我 reload 的空闲页面」误触发
    // 4s 安全关窗（进而 reload 死循环），或误加载上一次会话的冻结图。
    let sessionActive = false;
    let safetyTimer: number | null = null;
    // 安全时限：会话开始后若 4s 内仍未注入冻结图（捕获异常等）则关窗避免永久卡死。
    // 只在会话开始时武装、冻结图加载成功即解除——绝不在 mount 时无条件武装。
    const armSafety = () => {
      if (safetyTimer !== null) window.clearTimeout(safetyTimer);
      safetyTimer = window.setTimeout(() => {
        if (!loaded && !cancelled) {
          console.error("[截图] 4s 内未获取到冻结图，关闭覆盖窗");
          handleClose();
        }
      }, 4000);
    };
    const clearSafety = () => {
      if (safetyTimer !== null) {
        window.clearTimeout(safetyTimer);
        safetyTimer = null;
      }
    };

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
          const imageData = new ImageData(rgba, w, h);
          // 零编码：直接把 RGBA 构造成 ImageBitmap（GPU 加速，毫秒级），取代 toBlob JPEG 重编码
          // + objectURL + <img> 解码这一圈最贵的 CPU 开销，截图启动进入毫秒级。
          createImageBitmap(imageData)
            .then((bitmap) => {
              if (cancelled) {
                bitmap.close();
                return;
              }
              loaded = true;
              clearSafety();
              setData((prev) => {
                if (prev && prev.image) {
                  if (typeof prev.image === "string") {
                    if (prev.image.startsWith("blob:")) URL.revokeObjectURL(prev.image);
                  } else if (typeof (prev.image as ImageBitmap).close === "function") {
                    (prev.image as ImageBitmap).close();
                  }
                }
                return { image: bitmap, ...meta };
              });
              // 覆盖窗显示推迟到 ScreenshotOverlay 内冻结图真正绘制就绪之后（见 onImageReady）。
            })
            .catch((err) => {
              console.error("[截图] 预览位图构建失败:", err);
            });
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

    // 快路径①：截图启动（仅推送 meta，进入透明待加载态，选区交互立即可用）。
    // dev 下覆盖窗在上次关闭后已自我 reload → 监听器就绪，本事件可稳定命中，十字选区秒显、无竞态。
    const p1 = listen("screenshot-start", (event: any) => {
      sessionActive = true;
      loaded = false;
      armSafety();
      const meta = buildMeta(event.payload);
      setData((prev) => {
        if (prev && prev.image) {
          if (typeof prev.image === "string") {
            if (prev.image.startsWith("blob:")) URL.revokeObjectURL(prev.image);
          } else if (typeof (prev.image as ImageBitmap).close === "function") {
            (prev.image as ImageBitmap).close();
          }
        }
        return { image: null, ...meta };
      });
    });

    // 快路径②：冻结图就绪（后台捕获线程完成）→ 注入截图
    const p2 = listen("screenshot-ready", (event: any) => {
      loadShot(buildMeta(event.payload));
    });

    // 快路径③：后台枚举完成的窗口列表 → 仅补充 data.windows（不影响已注入的冻结图 / 选区交互），
    // 使鼠标悬停窗口高亮立即可用，同时避免 list_windows 同步阻塞覆盖窗显示（截图启动卡顿根因）。
    const p3 = listen("screenshot-windows", (event: any) => {
      const wins = event.payload?.windows || [];
      setData((prev) => (prev ? { ...prev, windows: wins } : prev));
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
            // 检测到新一次截图：标记会话开始、武装安全时限并立即尝试加载。
            handledSession.current = session;
            sessionActive = true;
            loaded = false;
            armSafety();
            loadShot(buildMeta(snap));
            return;
          }
          // 仅在会话已开始且冻结图尚未加载时重试（start_screenshot 先自增 session、
          // 冻结图要等捕获线程写完 SHOT 才就绪，故持续重试直到注入成功）。
          // 门控 sessionActive：dev 空闲已 reload 的页面不会误加载上一次会话的冻结图。
          if (sessionActive && session === handledSession.current && session > 0 && !loaded && !loadingRef.current) {
            loadShot(buildMeta(snap));
          }
        })
        .catch(() => {});
    }, 120);

    return () => {
      cancelled = true;
      clearSafety();
      window.clearInterval(poll);
      p1.then((un) => un());
      p2.then((un) => un());
      p3.then((un) => un());
      // 卸载 / 热启动（HMR）时若截图窗仍开着则自动取消，避免旧 webview 残留黑屏。
      // 正常关闭走 handleClose 已 hide，此处为幂等兜底。
      invoke("hide_overlay_window").catch(() => {});
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
        // 不透明黑底：分层窗逐像素命中，透明态会穿透；该态仅在启动离屏出现（data 在 show 前已由 screenshot-start 置好），置黑无可见影响且防竞态穿透。
        background: "#000",
        zIndex: 9999,
        // 兜底：即便瞬时 data=null，也保持十字光标，杜绝「概率出现默认光标」的观感。
        cursor: "crosshair",
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
    onImageReady: reveal,
  });
}

const root = document.getElementById("root");
if (root) {
  ReactDOM.createRoot(root).render(
    React.createElement(React.StrictMode, null, React.createElement(OverlayApp)),
  );
}

// dev 热启动（Vite HMR）：模块被替换前先取消截图窗，避免旧 webview 残留、黑屏不消。
// 注意：独立 webview 在 dev 下默认不随 HMR 重建（坑11），故必须显式 hide 兜底。
if ((import.meta as any).hot) {
  (import.meta as any).hot.dispose(() => {
    invoke("hide_overlay_window").catch(() => {});
  });
}
