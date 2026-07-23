import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalPosition, LogicalSize } from "@tauri-apps/api/dpi";
import { listen, emit } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";

// 浮窗基础尺寸（scale=1 时）：恰好包住桌宠的小方框，绝不做全屏透明页（否则干扰截图选区）
const WIN_W = 150;
const WIN_H = 170;
const PET = 130; // 宠物显示尺寸（基础）

// 素材语义映射（假设值，集中便于调整）：idle 默认 idle1；work 默认 work1；其余预留
const DEFAULT_STATE = "idle1";
// 可用状态顺序（右键循环切换，便于预览 / 验证懒加载；非最终交互）
const STATE_ORDER = ["idle1", "idle2", "work1", "work2", "work3"] as const;
type StateKey = (typeof STATE_ORDER)[number];

interface DeskpetSettings {
  scale: number;
  opacity: number;
  clickThrough: boolean;
}
const DEFAULT_SETTINGS: DeskpetSettings = { scale: 1, opacity: 1, clickThrough: false };

// 素材清单（镜像原插件 ASSETS，保持 key/rel/mime 一致）。
// 浮窗直接 invoke('read_external_dep_bytes') 读取 → Blob → objectURL 渲染，
// 绕开「插件读字节 → 全局 emit base64 → 浮窗 listen」的大 payload 广播链路（脆弱易损）。
const ASSETS: Record<string, { rel: string; mime: string }> = {
  idle1: { rel: "deskpet-assets/pet/idle1.png", mime: "image/png" },
  idle2: { rel: "deskpet-assets/pet/idle2.png", mime: "image/png" },
  work1: { rel: "deskpet-assets/pet/work1.mp4", mime: "video/mp4" },
  work2: { rel: "deskpet-assets/pet/work2.mp4", mime: "video/mp4" },
  work3: { rel: "deskpet-assets/pet/work3.mp4", mime: "video/mp4" },
};

function inferKind(key: string): "image" | "video" {
  return key.startsWith("work") ? "video" : "image";
}

/**
 * 桌宠渲染组件（运行在独立透明浮窗 deskpet 内）。
 * - 浮窗尺寸恰好包住桌宠；默认定位右下角、不穿透鼠标，可拖拽/交互（不影响截图）。
 * - 素材由浮窗自身直接 invoke('read_external_dep_bytes') 读取（懒加载），
 *   失败在 console 可见（不再静默吞掉）；缺失时回退内置 CSS 小球。
 * - 待机呼吸动画（轻微上下浮动 + 缩放）；在宠物上按下即拖动整个浮窗。
 * - Phase A 基础设置：缩放（resize 窗口 + 外层 scale）、透明度（容器 opacity）、点击穿透（setIgnoreCursorEvents）。
 */
export function DeskpetPet() {
  const [assets, setAssets] = useState<Record<string, string>>({}); // key -> objectURL
  const [state, setState] = useState<string>(DEFAULT_STATE);
  const [settings, setSettings] = useState<DeskpetSettings>(DEFAULT_SETTINGS);
  const [status, setStatus] = useState<string>(""); // 屏上诊断：空=正常/已显示；非空=显示诊断文字

  const ref = useRef<HTMLDivElement | null>(null); // 内层：呼吸动画 transform
  const wrapperRef = useRef<HTMLDivElement | null>(null); // 外层：缩放 / 透明度
  const urlsRef = useRef<string[]>([]); // 已创建 objectURL，卸载时回收
  const assetsRef = useRef<Record<string, string>>(assets);
  const stateRef = useRef<string>(state);
  const settingsRef = useRef<DeskpetSettings>(settings);
  assetsRef.current = assets;
  stateRef.current = state;
  settingsRef.current = settings;

  // 应用设置：缩放 → resize 窗口 + 外层 scale；透明度 → 容器 opacity；点击穿透 → setIgnoreCursorEvents
  const applySettings = (s: DeskpetSettings) => {
    const w = getCurrentWindow();
    const scale = s.scale;
    w.setSize(
      new LogicalSize(Math.round(WIN_W * scale), Math.round(WIN_H * scale)),
    ).catch(() => {});
    w.setIgnoreCursorEvents(s.clickThrough).catch(() => {});
  };

  // 统一：base64 → objectURL → 状态（主路 / 兜底通道共用）
  const applyAsset = (key: string, b64: string) => {
    try {
      const blob = new Blob([Uint8Array.from(atob(b64))], {
        type: ASSETS[key].mime,
      });
      const url = URL.createObjectURL(blob);
      urlsRef.current.push(url);
      setAssets((prev) => ({ ...prev, [key]: url }));
      setStatus(""); // 成功则清除诊断
    } catch (e) {
      setStatus("素材解码失败: " + String(e));
      console.error("[桌宠] 解码失败:", key, e);
    }
  };

  // 双路加载素材（懒加载）：
  // 主路：浮窗直读 read_external_dep_bytes（独立 webview，权限不确定，作为首选）；
  // 兜底：浮窗无权限或直读失败时，emit 事件请插件（主窗，invoke 权限确定）经事件中继。
  // 两者都成功也无害（applyAsset 有 !assetsRef.current[key] 去重）。
  const loadAsset = async (key: string) => {
    if (!ASSETS[key] || assetsRef.current[key]) return;
    setStatus("素材加载中…");
    try {
      const b64 = await invoke<string>("read_external_dep_bytes", {
        relativePath: ASSETS[key].rel,
      });
      if (b64) {
        applyAsset(key, b64);
        return;
      }
    } catch (e) {
      console.warn("[桌宠] 直读失败，回退事件通道:", e);
    }
    // 兜底：请插件经事件中继（插件在主窗，invoke 权限确定；事件广播不需要权限）
    emit("deskpet:request-asset", { keys: [key] }).catch(() => {});
    // 兜底为异步通道，若主路空返回且兜底也无声，3s 后给可见失败提示
    // （applyAsset 成功会清空 status，故此提示仅在确实未加载时显示）
    setTimeout(() => {
      if (!assetsRef.current[key]) {
        setStatus("素材加载失败（请查看控制台 [桌宠] 日志）");
      }
    }, 3000);
  };

  // 切换状态；若目标素材未加载则懒加载
  const selectState = (key: string) => {
    setState(key);
    if (!assetsRef.current[key]) void loadAsset(key);
  };

  // 浮窗初始化：尺寸/位置 + 初始素材加载(idle1) + 初始设置请求
  useEffect(() => {
    const w = getCurrentWindow();
    applySettings(settingsRef.current);
    const sw = window.screen.width || 1280;
    const sh = window.screen.height || 720;
    w.setPosition(
      new LogicalPosition(
        Math.max(0, sw - WIN_W - 40),
        Math.max(0, sh - WIN_H - 60),
      ),
    ).catch(() => {});
    void loadAsset(DEFAULT_STATE);
    emit("deskpet:request-settings").catch(() => {});
    return undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 接收设置（来自面板经全局 emit，或插件回复 request-settings）
  useEffect(() => {
    const un = listen<DeskpetSettings>("deskpet:settings", (e) => {
      const p = e.payload;
      if (!p) return;
      const next: DeskpetSettings = {
        scale: typeof p.scale === "number" ? p.scale : settingsRef.current.scale,
        opacity: typeof p.opacity === "number" ? p.opacity : settingsRef.current.opacity,
        clickThrough:
          typeof p.clickThrough === "boolean"
            ? p.clickThrough
            : settingsRef.current.clickThrough,
      };
      setSettings(next);
      applySettings(next);
    });
    return () => {
      void un.then((f) => f());
    };
  }, []);

  // 兜底素材通道：插件在主窗经事件中继推送 base64（主路直读失败时启用，事件广播不需权限）
  useEffect(() => {
    const un = listen<{ key: string; mime: string; data: string }>(
      "deskpet:asset",
      (e) => {
        const { key, data } = e.payload;
        if (key && data && !assetsRef.current[key]) {
          applyAsset(key, data);
        }
      },
    );
    return () => {
      void un.then((f) => f());
    };
  }, []);

  // 卸载时回收 objectURL，避免内存泄漏
  useEffect(() => {
    return () => {
      urlsRef.current.forEach((u) => {
        try {
          URL.revokeObjectURL(u);
        } catch {
          /* 忽略 */
        }
      });
      urlsRef.current = [];
    };
  }, []);

  // 待机呼吸动画（轻微上下浮动 + 缩放），作用于内层元素，叠加在设置缩放之上
  useEffect(() => {
    let raf = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const el = ref.current;
      if (el) {
        const t = (now - start) / 1000;
        const y = Math.sin(t * 1.6) * 6;
        const s = 1 + Math.sin(t * 1.6) * 0.03;
        el.style.transform = `translateY(${y}px) scale(${s})`;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  // 拖拽：在宠物上按下即拖动整个浮窗
  const onPointerDown = () => {
    getCurrentWindow().startDragging().catch(() => {});
  };

  const currentUrl = assets[state];
  const currentKind = inferKind(state);
  const showVideo = currentKind === "video" && !!currentUrl;
  const showImage = currentKind === "image" && !!currentUrl;

  return (
    <div
      ref={wrapperRef}
      style={{
        width: WIN_W,
        height: WIN_H,
        display: "flex",
        alignItems: "flex-end",
        justifyContent: "center",
        overflow: "visible",
        position: "relative",
        userSelect: "none",
        transformOrigin: "center center",
        opacity: settings.opacity,
        transform: `scale(${settings.scale})`,
        willChange: "transform, opacity",
      }}
    >
      <div
        ref={ref}
        onPointerDown={onPointerDown}
        onContextMenu={(e) => {
          // 右键循环切换状态（Phase A 预览 / 验证懒加载；非最终交互）
          e.preventDefault();
          const idx = STATE_ORDER.indexOf(stateRef.current as StateKey);
          const nextKey = STATE_ORDER[(idx + 1) % STATE_ORDER.length];
          selectState(nextKey);
        }}
        style={{
          width: PET,
          height: PET,
          cursor: "grab",
          willChange: "transform",
          pointerEvents: "auto",
        }}
      >
        {showVideo ? (
          <video
            key={state}
            src={currentUrl}
            width={PET}
            height={PET}
            autoPlay
            loop
            muted
            playsInline
            draggable={false}
            onError={(e) => console.error("[桌宠] 渲染失败:", state, e)}
            style={{
              width: PET,
              height: PET,
              userSelect: "none",
              filter: "drop-shadow(0 6px 12px rgba(0,0,0,0.18))",
              borderRadius: 12,
            }}
          />
        ) : showImage ? (
          <img
            src={currentUrl}
            width={PET}
            height={PET}
            alt="桌宠"
            draggable={false}
            onError={(e) => console.error("[桌宠] 渲染失败:", state, e)}
            style={{
              width: PET,
              height: PET,
              userSelect: "none",
              filter: "drop-shadow(0 6px 12px rgba(0,0,0,0.18))",
            }}
          />
        ) : (
          // 回退：内置 CSS 小球（依赖包素材缺失时保证「看得见」）
          <div
            style={{
              width: PET,
              height: PET,
              borderRadius: "50%",
              background: "#7dd3fc",
              boxShadow: "0 6px 18px rgba(0,0,0,0.18)",
              position: "relative",
            }}
          >
            <span style={{ position: "absolute", left: PET * 0.31, top: PET * 0.375, width: 8, height: 8, borderRadius: "50%", background: "#1f2937" }} />
            <span style={{ position: "absolute", right: PET * 0.31, top: PET * 0.375, width: 8, height: 8, borderRadius: "50%", background: "#1f2937" }} />
            <span style={{ position: "absolute", left: PET * 0.22, top: PET * 0.56, width: 10, height: 6, borderRadius: 6, background: "rgba(244,114,182,0.5)" }} />
            <span style={{ position: "absolute", right: PET * 0.22, top: PET * 0.56, width: 10, height: 6, borderRadius: 6, background: "rgba(244,114,182,0.5)" }} />
          </div>
        )}
      </div>
      {status && (
        <div
          style={{
            position: "absolute",
            left: 4,
            bottom: 4,
            right: 4,
            fontSize: 10,
            color: "#ef4444",
            background: "rgba(0,0,0,0.55)",
            padding: "2px 4px",
            borderRadius: 4,
            lineHeight: 1.3,
            pointerEvents: "none",
          }}
        >
          {status}
        </div>
      )}
    </div>
  );
}
