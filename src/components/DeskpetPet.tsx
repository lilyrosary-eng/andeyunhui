import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { PhysicalPosition, PhysicalSize } from "@tauri-apps/api/dpi";
import { listen } from "@tauri-apps/api/event";

type StyleKey = "bounce" | "float" | "idle";

const COLORS: Record<StyleKey, string> = {
  bounce: "#7dd3fc", // 低饱和天蓝
  float: "#c4b5fd", // 低饱和紫
  idle: "#fcd34d", // 低饱和暖黄
};

/**
 * 桌宠渲染组件（运行在独立透明浮窗 deskpet 内）。
 * - 浮窗启动即全屏化 + 点击穿透，常驻桌面、不挡操作。
 * - 沿屏幕底部漫游的简单动画；风格由宿主设置面板经 Tauri 事件下发切换。
 * - MVP：纯 CSS 拟人小球，rdev 全局鼠标跟随 / Live2D 模型加载为后续阶段。
 */
export function DeskpetPet() {
  const [style, setStyle] = useState<StyleKey>("bounce");
  const ref = useRef<HTMLDivElement | null>(null);

  // 浮窗全屏化 + 点击穿透：常驻桌面、不拦截桌面点击
  useEffect(() => {
    const w = getCurrentWindow();
    w.setIgnoreCursorEvents(true).catch(() => {});
    w.setPosition(new PhysicalPosition(0, 0)).catch(() => {});
    w.setSize(new PhysicalSize(window.screen.width, window.screen.height)).catch(() => {});
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
        const size = 64;
        const x = (Math.sin(t * 0.6) * 0.5 + 0.5) * (vw - size);
        let y = vh - size - 24;
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
        width: 64,
        height: 64,
        willChange: "transform",
        pointerEvents: "none",
      }}
    >
      <div
        style={{
          width: 64,
          height: 64,
          borderRadius: "50%",
          background: color,
          boxShadow: "0 6px 18px rgba(0,0,0,0.18)",
          position: "relative",
        }}
      >
        <span style={{ position: "absolute", left: 20, top: 24, width: 8, height: 8, borderRadius: "50%", background: "#1f2937" }} />
        <span style={{ position: "absolute", right: 20, top: 24, width: 8, height: 8, borderRadius: "50%", background: "#1f2937" }} />
        <span style={{ position: "absolute", left: 14, top: 36, width: 10, height: 6, borderRadius: 6, background: "rgba(244,114,182,0.5)" }} />
        <span style={{ position: "absolute", right: 14, top: 36, width: 10, height: 6, borderRadius: 6, background: "rgba(244,114,182,0.5)" }} />
      </div>
    </div>
  );
}
