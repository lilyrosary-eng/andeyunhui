import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalPosition, LogicalSize } from "@tauri-apps/api/dpi";
import { listen, emit } from "@tauri-apps/api/event";

// 浮窗尺寸：恰好包住桌宠的小方框，绝不做全屏透明页（否则会干扰截图选区）。
const WIN_W = 150;
const WIN_H = 170;
const PET = 130; // 宠物显示尺寸

/**
 * 桌宠渲染组件（运行在独立透明浮窗 deskpet 内）。
 * - 浮窗尺寸恰好包住桌宠；默认定位右下角、不穿透鼠标，可拖拽/交互（不影响截图）。
 * - 素材优先来自依赖包（插件经 deskpet:asset 事件下发 base64 SVG）；缺失时回退内置 CSS 小球。
 * - 待机呼吸动画（轻微上下浮动 + 缩放）；在宠物上按下即拖动整个浮窗。
 */
export function DeskpetPet() {
  const [assetUrl, setAssetUrl] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement | null>(null);

  // 浮窗：恰好包住桌宠的小方框，常驻桌面、默认定位右下角、可交互（非全屏透明）
  useEffect(() => {
    const w = getCurrentWindow();
    w.setIgnoreCursorEvents(false).catch(() => {});
    w.setSize(new LogicalSize(WIN_W, WIN_H)).catch(() => {});
    const sw = window.screen.width || 1280;
    const sh = window.screen.height || 720;
    w.setPosition(
      new LogicalPosition(Math.max(0, sw - WIN_W - 40), Math.max(0, sh - WIN_H - 60))
    ).catch(() => {});
  }, []);

  // 接收插件下发的依赖包素材（base64 SVG）；缺失时回退 CSS 小球
  useEffect(() => {
    const un = listen<string>("deskpet:asset", (e) => {
      if (e.payload) setAssetUrl(`data:image/svg+xml;base64,${e.payload}`);
    });
    // 浮窗就绪后主动向插件来要素材（闭合「插件先 emit、浮窗未监听」的竞态）
    emit("deskpet:request-asset").catch(() => {});
    return () => {
      void un.then((f) => f());
    };
  }, []);

  // 待机呼吸动画（轻微上下浮动 + 缩放）
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

  return (
    <div
      style={{
        width: WIN_W,
        height: WIN_H,
        display: "flex",
        alignItems: "flex-end",
        justifyContent: "center",
        overflow: "visible",
        userSelect: "none",
      }}
    >
      <div
        ref={ref}
        onPointerDown={onPointerDown}
        style={{
          width: PET,
          height: PET,
          cursor: "grab",
          willChange: "transform",
          pointerEvents: "auto",
        }}
      >
        {assetUrl ? (
          <img
            src={assetUrl}
            width={PET}
            height={PET}
            alt="桌宠"
            draggable={false}
            style={{ width: PET, height: PET, userSelect: "none", filter: "drop-shadow(0 6px 12px rgba(0,0,0,0.18))" }}
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
    </div>
  );
}
