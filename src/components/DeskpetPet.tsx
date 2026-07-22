import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalPosition, LogicalSize } from "@tauri-apps/api/dpi";
import { listen, emit } from "@tauri-apps/api/event";

type StyleKey = "bounce" | "float" | "idle";

const COLORS: Record<StyleKey, string> = {
  bounce: "#7dd3fc", // 低饱和天蓝
  float: "#c4b5fd", // 低饱和紫
  idle: "#fcd34d", // 低饱和暖黄
};

const SIZE = 96; // 宠物显示尺寸（px）

/**
 * 桌宠渲染组件（运行在独立透明浮窗 deskpet 内）。
 * - 浮窗启动即全屏化 + 点击穿透，常驻桌面、不挡操作。
 * - 素材优先来自依赖包（插件经 deskpet:asset 事件下发 base64 SVG）；缺失时回退内置 CSS 小球。
 * - 沿屏幕底部漫游的简单动画；风格由宿主「全局设置·常规」经 deskpet:set-style 事件下发切换。
 */
export function DeskpetPet() {
  const [style, setStyle] = useState<StyleKey>("bounce");
  const [assetUrl, setAssetUrl] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement | null>(null);

  // 浮窗全屏化 + 点击穿透：常驻桌面、不拦截桌面点击
  useEffect(() => {
    const w = getCurrentWindow();
    w.setIgnoreCursorEvents(true).catch(() => {});
    w.setPosition(new LogicalPosition(0, 0)).catch(() => {});
    w.setSize(new LogicalSize(window.screen.width, window.screen.height)).catch(() => {});
  }, []);

  // 接收宿主设置面板下发的样式切换
  useEffect(() => {
    const un = listen<StyleKey>("deskpet:set-style", (e) => {
      if (e.payload) setStyle(e.payload);
    });
    return () => {
      void un.then((f) => f());
    };
  }, []);

  // 接收插件下发的依赖包素材（base64 SVG）
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

  // 沿屏幕底部漫游的简单动画
  useEffect(() => {
    let raf = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const el = ref.current;
      if (el) {
        const t = (now - start) / 1000;
        const vw = window.screen.width;
        const vh = window.screen.height;
        const x = (Math.sin(t * 0.6) * 0.5 + 0.5) * (vw - SIZE);
        let y = vh - SIZE - 24;
        if (style === "bounce") y -= Math.abs(Math.sin(t * 3)) * 90;
        else if (style === "float") y -= (Math.sin(t * 1.2) * 0.5 + 0.5) * (vh * 0.45);
        el.style.transform = `translate(${x}px, ${y}px)`;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [style]);

  const color = COLORS[style] ?? COLORS.bounce;
  return (
    <div
      ref={ref}
      style={{
        position: "fixed",
        left: 0,
        top: 0,
        width: SIZE,
        height: SIZE,
        willChange: "transform",
        pointerEvents: "none",
      }}
    >
      {assetUrl ? (
        <img
          src={assetUrl}
          width={SIZE}
          height={SIZE}
          alt="桌宠"
          draggable={false}
          style={{ width: SIZE, height: SIZE, userSelect: "none", filter: "drop-shadow(0 6px 12px rgba(0,0,0,0.18))" }}
        />
      ) : (
        // 回退：内置 CSS 小球（依赖包素材缺失时保证「看得见」）
        <div
          style={{
            width: SIZE,
            height: SIZE,
            borderRadius: "50%",
            background: color,
            boxShadow: "0 6px 18px rgba(0,0,0,0.18)",
            position: "relative",
          }}
        >
          <span style={{ position: "absolute", left: SIZE * 0.31, top: SIZE * 0.375, width: 8, height: 8, borderRadius: "50%", background: "#1f2937" }} />
          <span style={{ position: "absolute", right: SIZE * 0.31, top: SIZE * 0.375, width: 8, height: 8, borderRadius: "50%", background: "#1f2937" }} />
          <span style={{ position: "absolute", left: SIZE * 0.22, top: SIZE * 0.56, width: 10, height: 6, borderRadius: 6, background: "rgba(244,114,182,0.5)" }} />
          <span style={{ position: "absolute", right: SIZE * 0.22, top: SIZE * 0.56, width: 10, height: 6, borderRadius: 6, background: "rgba(244,114,182,0.5)" }} />
        </div>
      )}
    </div>
  );
}
