import React from "react";
import { useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { DeskpetManifest, loadDeskpetManifest, isLegacyDeskpetManifest } from "../deskpetManifest";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalPosition, LogicalSize } from "@tauri-apps/api/dpi";
import { listen, emit } from "@tauri-apps/api/event";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";

// 浮窗基础尺寸（scale=1 时）：恰好包住桌宠的小方框，绝不做全屏透明页（否则干扰截图选区）
const WIN_W = 150;
const WIN_H = 170;
const PET = 130; // 宠物显示尺寸（基础）

// 互动参数
const LEAN_MAX = 6; // 视差/注视：朝光标方向最大偏移（px）
const DRAG_THRESHOLD = 4; // 判定为拖拽的最小移动像素
const CLICK_MS = 350; // 单击（非拖拽）的最大按下时长
const DOUBLE_MS = 320; // 两次点击判定为双击的最大间隔（ms）
const DOUBLE_DELAY = 200; // 单击后延迟触发 walk 的窗口（ms），等待是否出现第二次点击（双击则不播 walk）

// 内存触发工作动画（与薄荷共用 pro-tools-kit::get_system_memory 模板）
// 高于此阈值启动工作动画（work1→work2→work3），回落到阈值以下播放 work3 后回待机。
const MEM_THRESHOLD = 60; // 内存占用百分比阈值（高于此值启动工作动画）
const MEM_POLL_MS = 2000; // 内存轮询间隔（ms）

// 桌宠素材清单改为「动态 manifest」：状态可增删、每状态可绑多张图片/视频，
// 用户可在设置面板导入自己的图片/视频。manifest 由设置面板经全局 emit 下发，
// 浮窗启动时也会向插件请求（插件从 localStorage 回复）。缺省回退内置默认清单。

interface DeskpetSettings {
  scale: number;
  opacity: number;
  clickThrough: boolean;
}
const DEFAULT_SETTINGS: DeskpetSettings = { scale: 1, opacity: 1, clickThrough: false };

// 读取外部依赖的「绝对路径」，再用 convertFileSrc 走 asset 协议加载（无大小限制）。
// 注意：绝不用 base64 经 IPC/事件回传大图（数 MB）→ 易超过载荷上限导致加载失败。
async function readExternalDepPath(relativePath: string): Promise<string> {
  const absPath = await invoke<string>("read-external-dep-path", { relativePath });
  return convertFileSrc(absPath.replace(/\\/g, "/"));
}

// 错误边界：VideoCanvas 一旦崩溃，兜底显示小球并上报错误，避免整棵 DeskpetPet 子树被 React 掀掉
// → 浮窗空白（即「点击消失」且 HUD 跟着没）。便于定位真实崩溃栈。
// 注意：必须定义在模块作用域，绝不可放进组件函数体内——否则每次重渲染都会重新定义该类，
// React 会把它当「新组件类型」导致内部 VideoCanvas 反复卸载重挂，反而造成画面闪没。
class VideoCanvasBoundary extends React.Component<
  { fallback: React.ReactNode; onError?: (msg: string) => void; children: React.ReactNode },
  { hasError: boolean }
> {
  state = { hasError: false };
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  componentDidCatch(error: Error) {
    const msg = error?.stack || error?.message || String(error);
    console.error("[桌宠] VideoCanvas 崩溃:\n" + msg);
    this.props.onError?.(error?.message || String(error));
  }
  render() {
    if (this.state.hasError) return <>{this.props.fallback}</>;
    return <>{this.props.children}</>;
  }
}

// 视频加载：优先「读字节 → 同源 blob URL」（canvas 抠像不被跨源污染）。
// 注意命令注册名是蛇形 `read_external_dep_bytes`（commands.rs 未 rename），前端必须用同名调用，
// 之前误写成连字符 `read-external-dep-bytes` 导致 Tauri 匹配不上 → 报 Command not found（控制台以 500 呈现），
// 视频被迫走 asset:// 兜底链（本浮窗 asset:// 视频加载不可靠 → 易消失）。改回蛇形即让主路生效、消除 500。
// 主路失败才兜底走与图片同款的「read-external-dep-path → asset:// → fetch 成同源 blob」，仍失败返回 null 由事件通道兜底。
async function readExternalDepVideo(
  relativePath: string,
  mime = "video/mp4",
): Promise<string | null> {
  const bytesToBlobUrl = (b64: string) => {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return URL.createObjectURL(new Blob([bytes], { type: mime }));
  };
  // 主路：读字节 → 同源 blob（抠像无污染）
  try {
    const b64 = await invoke<string>("read_external_dep_bytes", { relativePath });
    if (b64) {
      return bytesToBlobUrl(b64);
    }
  } catch (e) {
    console.warn("[桌宠] 读视频字节失败，回退 asset:// + fetch:", e);
  }
  // 兜底：取绝对路径 → asset:// 。优先 fetch 成同源 blob（保留 canvas 抠像）；若 fetch 被跨源 CORS 拦截，
  // 则直接把 asset:// 作为 video src——媒体元素可原生加载跨源资源，代价是 canvas 污染时 VideoCanvas 降级不抠像，
  // 宠物仍可见（仅不抠背景）。主路（base64 同源 blob）在 IPC 载荷上限内覆盖较小素材。
  try {
    const absPath = await invoke<string>("read-external-dep-path", { relativePath });
    const assetUrl = convertFileSrc(absPath.replace(/\\/g, "/"));
    try {
      const resp = await fetch(assetUrl);
      if (resp.ok) return URL.createObjectURL(await resp.blob());
    } catch {
      // fetch 跨源被拦，回退直接 asset://
    }
    console.warn(`[桌宠] 视频走 asset:// 回退: ${relativePath} → ${assetUrl.slice(0, 30)}...`);
    return assetUrl;
  } catch (e) {
    console.warn("[桌宠] 视频 asset:// 回退失败:", e);
  }
  console.error(`[桌宠] 视频加载全部失败: ${relativePath} → null`);
  return null;
}

/**
 * 桌宠渲染组件（运行在独立透明浮窗 deskpet 内）。
 * - 浮窗尺寸恰好包住桌宠；默认定位右下角、不穿透鼠标，可拖拽/交互（不影响截图）。
 * - 素材由浮窗自身直接 invoke('read-external-dep-path') 取绝对路径后 convertFileSrc 走 asset 协议加载（懒加载），
 *   不走 base64（大图易超 IPC 载荷导致破图）；失败在 console 可见（不再静默吞掉）；缺失时回退内置 CSS 小球。
 * - 待机呼吸动画（轻微上下浮动 + 缩放）；单状态多图时循环播放「帧序列」；状态切换淡入淡出。
 * - 互动：悬停时朝光标方向轻微倾斜（B1 视差）；单击=播 walk.mp4（一次性，结束回待机）；双击=切换主窗口显隐；右击=轻跳；按住拖动=移动整个浮窗。
 * - Phase A 基础设置：缩放（resize 窗口 + 外层 scale）、透明度（容器 opacity）、点击穿透（setIgnoreCursorEvents）。
 */
// 桌宠运动学纯函数（朝向解析 / 选帧 / 日落）：见 core/deskpet/motion.ts
import { pickAngleFrame, getSunsetHours } from '../core/deskpet/motion';

// ---- 视频背景抠像（透明桌宠核心）----
// H.264 mp4 不含 alpha 通道，带不透明背景的视频在透明浮窗里会露出方块、宠物像「消失」。
// 做法：把 <video> 画到 <canvas>，逐帧把背景色（默认自动从四角/边缘采样）抠成透明。
// 用户可在 localStorage 用 deskpet:chroma = { color: "#rrggbb", tolerance: 60 } 手动指定背景色/容差。

// 自动检测背景：缩到 40x40，同时统计「边框环」与「整帧」的近黑/近绿占比 + 整帧平均不透明度。
// 背景判定策略（解决「检测一次定终身 → 首帧贴边误判为复杂背景 → 永久黑方块」）：
// - 边框（角色居中时即背景）优先；若角色首帧贴边污染了边框，回退到「整帧近黑/近绿占比」。
// - avgAlpha 低（整体透明）→ 真·带 Alpha 的 WebM，原生透明，无需抠像。
// - 近黑占比 > 0.3（或整帧近黑折算后）→ 抠掉近黑（仅抠极暗像素，保宠物暗部）。
// - 近绿占比 > 0.3 → 抠掉绿幕。
// - 否则（本帧背景不纯）→ 下一帧重试，最多约 90 帧后放弃（避免一直重试）。
function detectBgColor(video: HTMLVideoElement): {
  avgAlpha: number;
  borderBlack: number;
  borderGreen: number;
  frameBlack: number;
  frameGreen: number;
} | null {
  if (video.readyState < 2 || video.videoWidth === 0) return null;
  const S = 40;
  const c = document.createElement("canvas");
  c.width = S;
  c.height = S;
  const ctx = c.getContext("2d");
  if (!ctx) return null;
  try {
    ctx.drawImage(video, 0, 0, S, S);
    const data = ctx.getImageData(0, 0, S, S).data;
    let borderN = 0, borderBlack = 0, borderGreen = 0;
    let frameN = 0, frameBlack = 0, frameGreen = 0, alphaSum = 0;
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const i = (y * S + x) * 4;
        const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
        alphaSum += a;
        frameN++;
        const maxc = Math.max(r, g, b);
        const isBlack = maxc < 40 && Math.sqrt(r * r + g * g + b * b) < 55;
        const isGreen = g > 90 && g - r > 30 && g - b > 30;
        if (isBlack) frameBlack++;
        if (isGreen) frameGreen++;
        const isBorder = x === 0 || y === 0 || x === S - 1 || y === S - 1;
        if (isBorder) {
          borderN++;
          if (isBlack) borderBlack++;
          if (isGreen) borderGreen++;
        }
      }
    }
    if (frameN === 0) return null;
    return {
      avgAlpha: alphaSum / frameN / 255,
      borderBlack: borderN ? borderBlack / borderN : 0,
      borderGreen: borderN ? borderGreen / borderN : 0,
      frameBlack: frameBlack / frameN,
      frameGreen: frameGreen / frameN,
    };
  } catch {
    return null;
  }
}





function loadChromaOverride(): { r: number; g: number; b: number; tolerance: number } | null {
  try {
    const raw = localStorage.getItem("deskpet:chroma");
    if (!raw) return null;
    const o = JSON.parse(raw);
    if (typeof o.color === "string") {
      const m = /^#?([0-9a-f]{6})$/i.exec(o.color);
      if (m) {
        const n = parseInt(m[1], 16);
        return {
          r: (n >> 16) & 255,
          g: (n >> 8) & 255,
          b: n & 255,
          tolerance: typeof o.tolerance === "number" ? o.tolerance : 60,
        };
      }
    }
  } catch {
    /* 忽略错误配置 */
  }
  return null;
}

// 调试开关：localStorage 设 deskpet:chroma-disable = "1" 可关闭运行时抠像，
// 直接显示原始视频（含背景方块），用于区分「素材加载失败」与「背景未扣掉」。
function isChromaDisabled(): boolean {
  try {
    return localStorage.getItem("deskpet:chroma-disable") === "1";
  } catch {
    return false;
  }
}

function VideoCanvas({
  src,
  loop,
  size,
  onEnded,
  onFailed,
  onHint,
  label,
  onReady,
}: {
  src: string;
  loop: boolean;
  size: number;
  onEnded?: () => void;
  onFailed?: () => void;
  onHint?: (msg: string) => void;
  label?: string;
  onReady?: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const keyRef = useRef<{ r: number; g: number; b: number } | null>(null);
  const tolRef = useRef(60);
  const detectedRef = useRef(false);
  const skipKeyRef = useRef(false);
  const realAlphaRef = useRef(false); // 真·带 Alpha 的 WebM（边框透明）→ 无需抠像
  const warnedRef = useRef(false);
    const loggedBgRef = useRef(false); // 背景检测只打印一次

  useEffect(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(size * dpr);
    canvas.height = Math.round(size * dpr);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return;
    const urlType = src.startsWith("blob:") ? "blob" : src.startsWith("asset:") ? "asset" : "其它";
    // 部分 WebView2 下对新插入的 <video> 不触发 autoplay，需显式 play()；
    // muted 用属性设置（React 的 muted JSX 属性有时不落到 DOM property，导致被浏览器拦截）。
    video.muted = true;
    video.play().catch(() => { /* 自动播放被拦截时忽略，readyState 就绪后由 rAF 绘制 */ });

    const override = loadChromaOverride();
    const disabled = isChromaDisabled();
    if (override && !disabled) {
      keyRef.current = { r: override.r, g: override.g, b: override.b };
      tolRef.current = override.tolerance;
      detectedRef.current = true;
    }

    let raf = 0;
    let rvfcId = 0;
    let detectAttempts = 0;
    const draw = () => {
      if (video.readyState >= 2 && video.videoWidth > 0) {
        const W = canvas.width;
        const H = canvas.height;
        // 自动检测背景：无手动覆盖、未禁用时执行。注意：不能按「mime 是否为 webm」判断原生透明，
        // 因为很多 webm 只是「黑底」而非真带 Alpha——必须实测边框 alpha 才知道。
        // 检测到结果才置 detectedRef，否则下一帧重试（视频未就绪时 detectBgColor 会返回 null）。
        if (!detectedRef.current && !override && !disabled) {
          const bg = detectBgColor(video);
          if (bg) {
            if (bg.avgAlpha < 0.5) {
              // 整体透明 → 真·带 Alpha 的 WebM，原生透明，无需抠像
              realAlphaRef.current = true;
              detectedRef.current = true;
            } else {
              // 背景判定：边框（角色居中时即背景）优先；角色首帧贴边污染边框时回退「整帧近黑/近绿占比」。
              // 黑底/绿幕出现即抠除，避免「检测一次定终身」：首帧贴边误判复杂背景后会永久跳过 → 黑方块。
              const blackRatio = Math.max(bg.borderBlack, bg.frameBlack * 0.7);
              const greenRatio = Math.max(bg.borderGreen, bg.frameGreen * 0.7);
              if (blackRatio > 0.3) {
                keyRef.current = { r: 0, g: 0, b: 0 };
                tolRef.current = 32; // 仅抠近黑，保宠物暗部
                detectedRef.current = true;
              } else if (greenRatio > 0.3) {
                keyRef.current = { r: 0, g: 160, b: 0 };
                tolRef.current = 55;
                detectedRef.current = true;
              } else {
                // 本帧背景不纯（可能角色贴边）→ 重试，最多约 90 帧后放弃
                detectAttempts++;
                if (detectAttempts > 90) {
                  skipKeyRef.current = true;
                  detectedRef.current = true;
                  if (!warnedRef.current) {
                    warnedRef.current = true;
                    console.warn("[桌宠] 视频背景非纯色，自动抠像已跳过（请用绿幕素材或重渲为带 Alpha 的 WebM）");
                    onHint?.("背景非纯色，无法自动抠像 → 请用绿幕素材或带透明通道的 WebM");
                  }
                }
              }
            }
            if (detectedRef.current && !loggedBgRef.current) {
              loggedBgRef.current = true;
              let tag: string;
              if (realAlphaRef.current) tag = "alpha透明(不抠)";
              else if (skipKeyRef.current) tag = "跳过抠像(非纯色)";
              else {
                const k = keyRef.current;
                tag = k ? `抠${k.r + k.g + k.b === 0 ? "黑" : "绿"} t${tolRef.current}` : "未知背景";
              }
              console.log(`[桌宠] 背景检测: ${tag}（黑占比 border=${bg.borderBlack.toFixed(2)} frame=${bg.frameBlack.toFixed(2)} avgAlpha=${bg.avgAlpha.toFixed(2)}）`);
            }
          }
        }
        try {
          ctx.clearRect(0, 0, W, H);
          ctx.drawImage(video, 0, 0, W, H);
          if (!skipKeyRef.current && !realAlphaRef.current && !disabled && keyRef.current) {
            const img = ctx.getImageData(0, 0, W, H);
            const d = img.data;
            const k = keyRef.current;
            const tol = tolRef.current;
            const feather = 40; // 柔化边缘，避免硬切锯齿
            for (let i = 0; i < d.length; i += 4) {
              const dr = d[i] - k.r;
              const dg = d[i + 1] - k.g;
              const db = d[i + 2] - k.b;
              const dist = Math.sqrt(dr * dr + dg * dg + db * db);
              if (dist < tol) d[i + 3] = 0;
              else if (dist < tol + feather) d[i + 3] = Math.round((255 * (dist - tol)) / feather);
            }
            ctx.putImageData(img, 0, 0);
          }
        } catch {
          // 画布被跨域污染等异常：退回直接绘制（无抠像，至少可见）
          ctx.clearRect(0, 0, W, H);
          ctx.drawImage(video, 0, 0, W, H);
        }
      }
    };
    // 绘制驱动：优先 requestVideoFrameCallback——视频每呈现一帧即触发，
    // 不受浮窗失焦/后台时 requestAnimationFrame 被节流或停跑的影响（否则 canvas 长期空白→宠物「消失」）。
    const rvfcSupported = typeof video.requestVideoFrameCallback === "function";
    if (rvfcSupported) {
      const schedule = () => {
        rvfcId = video.requestVideoFrameCallback(() => {
          draw();
          schedule();
        });
      };
      schedule();
    } else {
      const loop = () => {
        draw();
        raf = requestAnimationFrame(loop);
      };
      raf = requestAnimationFrame(loop);
    }
    return () => {
      cancelAnimationFrame(raf);
      if (rvfcId && typeof video.cancelVideoFrameCallback === "function") {
        video.cancelVideoFrameCallback(rvfcId);
      }
    };
  }, [src, loop, size]);

  return (
    <>
      <canvas
        ref={canvasRef}
        style={{
          width: size,
          height: size,
          userSelect: "none",
          filter: "drop-shadow(0 6px 12px rgba(0,0,0,0.18))",
          borderRadius: 12,
        }}
      />
      {/* 用 opacity:0 离屏渲染（而非 display:none），确保 WebView2 持续解码帧供 canvas 捕获。
          display:none 在部分 WebView2 配置下会让视频不解码，canvas 永远空白 → 宠物「消失」。 */}
      <video
        ref={videoRef}
        src={src}
        autoPlay
        loop={loop}
        muted
        playsInline
        onEnded={onEnded}
        onError={(e) => {
          const ve = e.currentTarget as HTMLVideoElement;
          const me = ve.error;
          const info = me ? `mediaError.code=${me.code} msg=${me.message || ""}` : "无 error 对象";
          console.error(`[桌宠] 视频解码失败 label=${label} src=${src.slice(0, 48)} ${info}`);
          onFailed?.();
        }}
        onLoadedData={() => {
          onReady?.();
        }}
        onCanPlay={() => {
          onReady?.();
        }}
        style={{ position: "absolute", width: 1, height: 1, opacity: 0, pointerEvents: "none", top: -20, left: -20 }}
      />
    </>
  );
}

// ===== 错误兜底：捕获「整窗消失」类崩溃 =====
// 桌宠浮窗没有外层 React 错误边界：若 DeskpetPet 在重渲染 / 事件回调 / 定时器 / 异步里抛出未捕获异常，
// React 18 会卸载整棵 root → 表现为宠物「消失」（不是窗口被 Rust 隐藏）。
// 错误边界抓不到事件回调/定时器异常，故用 window.onerror / unhandledrejection 全局捕获并打到控制台。
// devtools 开启：浮窗 URL 带 ?devtools=1 自动开；或运行时 emit 事件 deskpet:open-devtools 开。
(function installDeskpetCrashProbe() {
  if ((window as any).__deskpetCrashProbe) return;
  (window as any).__deskpetCrashProbe = true;
  window.addEventListener("error", (e: any) => {
    const msg = e?.error?.stack || e?.message || String(e);
    console.error("[桌宠] 未捕获错误（可能导致整窗卸载/消失）:\n" + msg);
  });
  window.addEventListener("unhandledrejection", (e: any) => {
    const r = e?.reason;
    const msg = r?.stack || r?.message || String(r);
    console.error("[桌宠] 未处理的 Promise 异常:\n" + msg);
  });
  const tryOpenDevtools = () =>
    import("@tauri-apps/api/webview")
      .then((m) => (m.getCurrentWebview() as any).openDevtools?.())
      .catch(() => {});
  if (new URLSearchParams(location.search).has("devtools")) tryOpenDevtools();
  void listen("deskpet:open-devtools", () => tryOpenDevtools());
})();

export function DeskpetPet() {
  const [manifest, setManifest] = useState<DeskpetManifest>(() => loadDeskpetManifest());
  const [stateIndex, setStateIndex] = useState(0);
  const [assets, setAssets] = useState<Record<string, string>>({}); // key(状态:rel) -> asset:// URL
  const [settings, setSettings] = useState<DeskpetSettings>(DEFAULT_SETTINGS);

  const [status, setStatus] = useState<string>(""); // 屏上诊断：空=正常/已显示；非空=显示诊断文字
  const [frameIndex, setFrameIndex] = useState(0); // 当前状态内的帧序号（图片帧序列循环）
  const [fading, setFading] = useState(false); // 状态切换淡入淡出
  const [bounce, setBounce] = useState(false); // 单击弹跳动画
  const [keys, setKeys] = useState<string[]>([]); // 当前按下的键（最多 3 个，半透明、松开后保留 2s）
  const [memPercent, setMemPercent] = useState<number>(0); // 系统内存占用率（%）
  const [workPhase, setWorkPhase] = useState<"start" | "loop" | "end" | null>(null); // 工作动画相位：启动/循环/结束
  const [failedVideos, setFailedVideos] = useState<Record<string, boolean>>({}); // 抠像视频加载失败 → 回退小球

  const ref = useRef<HTMLDivElement | null>(null); // 内层：呼吸动画 transform
  const leanRef = useRef<HTMLDivElement | null>(null); // 交互层：视差 transform + 指针事件
  const wrapperRef = useRef<HTMLDivElement | null>(null); // 外层：缩放 / 透明度
  const assetsRef = useRef<Record<string, string>>(assets);
  const settingsRef = useRef<DeskpetSettings>(settings);
  const stateIndexRef = useRef(stateIndex);
  const manifestRef = useRef(manifest);
  const playReturnRef = useRef(0); // 一次性视频（walk/sleep）结束后返回的状态序号
  const clickTimerRef = useRef<number | null>(null); // 单击延迟计时器（等待是否双击）
  const lastClickRef = useRef(0); // 上次单击时间戳，用于双击判定
  const lastSleepHourRef = useRef(-1); // 上次播放 sleep 的小时，避免同一小时重复
  const sunsetHoursRef = useRef(18); // 今日日落时间（小时，浮点），由睡眠调度器计算
  const dragRef = useRef<{
    startScreenX: number; // 按下瞬间的光标「屏幕逻辑坐标」（与 cursorRef 同空间，用于移动判定）
    startScreenY: number;
    grabOffsetX: number; // 抓取点相对窗口左上角的偏移（取负），使抓取点始终跟在光标下
    grabOffsetY: number;
    moved: boolean;
    down: number;
    active: boolean;
  } | null>(null);
  const memPercentRef = useRef(0);
  const workPhaseRef = useRef<"start" | "loop" | "end" | null>(null);
  assetsRef.current = assets;
  settingsRef.current = settings;
  stateIndexRef.current = stateIndex;
  manifestRef.current = manifest;
  memPercentRef.current = memPercent;
  workPhaseRef.current = workPhase;
  const frameIndexRef = useRef(frameIndex);
  frameIndexRef.current = frameIndex;
  const winPosRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 }); // 浮窗逻辑屏幕坐标（供光标跟随算 pet 中心）
  const cursorRef = useRef<{ x: number; y: number }>({ x: -99999, y: -99999 }); // 全局光标逻辑坐标（rdev 物理像素 / DPR）
  const dprRef = useRef(typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1); // 屏幕缩放比（rdev 物理→逻辑）。用 webview 自身 devicePixelRatio 初始化，避免启动期 dpr=1 造成的物理/逻辑坐标错位
  const keyTimersRef = useRef<Record<string, number | undefined>>({}); // 按键松开后保留 2s 的移除计时器
  const repaintRef = useRef<HTMLDivElement>(null); // 失焦时周期性强制重绘用的透明 1px 元素
  const heldModsRef = useRef<Set<string>>(new Set()); // 当前「按住未松开」的修饰键（用于判定同时按下）
  const keyLabelsRef = useRef<Record<string, string>>({}); // 每键显示标签：按下时按「当时按住的修饰键」计算，避免按时间序误合并

  // 应用设置：缩放 → resize 窗口 + 外层 scale；透明度 → 容器 opacity；点击穿透 → setIgnoreCursorEvents
  const applySettings = (s: DeskpetSettings) => {
    const w = getCurrentWindow();
    const scale = s.scale;
    w.setSize(
      new LogicalSize(Math.round(WIN_W * scale), Math.round(WIN_H * scale)),
    ).catch(() => {});
    w.setIgnoreCursorEvents(s.clickThrough).catch(() => {});
  };

  // 统一：asset:// URL → 状态（主路 / 兜底通道共用）。key 用于去重，素材真实身份由 rel 决定。
  const applyAssetUrl = (key: string, url: string) => {
    if (!url) return;
    setAssets((prev) => ({ ...prev, [key]: url }));
    setStatus(""); // 成功则清除诊断
  };

  // 双路加载素材（懒加载）：加载「某状态全部素材」，供帧序列循环使用。
  // 主路：浮窗直读 read_external_dep_path → convertFileSrc 走 asset 协议（独立 webview，已授权）；
  // 兜底：直读失败/无权限时，emit 事件请插件（主窗，invoke 权限确定）经事件中继返回 asset URL。
  const loadAsset = async (stateId: string) => {
    const stateDef = manifestRef.current.states.find((s) => s.id === stateId);
    if (!stateDef || stateDef.assets.length === 0) {
      setStatus("该状态暂无素材");
      return;
    }
    for (const asset of stateDef.assets) {
      const key = `${stateId}:${asset.rel}`;
      if (assetsRef.current[key]) continue;
      setStatus("素材加载中…");
      try {
        const url =
          asset.kind === "video"
            ? await readExternalDepVideo(asset.rel, asset.mime)
            : await readExternalDepPath(asset.rel);
        if (url) {
          applyAssetUrl(key, url);
          continue;
        }
      } catch (e) {
        console.warn("[桌宠] 直读路径失败，回退事件通道:", e);
      }
      // 兜底：请插件经事件中继（插件在主窗，invoke 权限确定；事件广播不需要权限）
      emit("deskpet:request-asset", { items: [{ key, rel: asset.rel, mime: asset.mime }] }).catch(() => {});
      setTimeout(() => {
        if (!assetsRef.current[key]) {
          setStatus("素材加载失败（请查看控制台 [桌宠] 日志）");
        }
      }, 3000);
    }
  };

  // 加载当前状态（由 manifest / stateIndex 驱动）
  const loadCurrent = () => {
    const order = manifestRef.current.states.map((s) => s.id);
    if (order.length === 0) {
      setStatus("无可用状态");
      return;
    }
    const idx = Math.min(stateIndexRef.current, order.length - 1);
    void loadAsset(order[idx]);
  };

  // 浮窗初始化：尺寸/位置 + 初始素材加载 + 初始设置请求
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
    // 同步记录初始窗口逻辑坐标，使首条鼠标事件即可算出正确朝向（避免开局因 winPosRef 仍为 {0,0} 而转向错误）
    winPosRef.current = { x: Math.max(0, sw - WIN_W - 40), y: Math.max(0, sh - WIN_H - 60) };
    // 向插件请求最新 manifest（插件从 localStorage 回复）；当前状态素材由下方 [manifest,stateIndex] 效应加载
    emit("deskpet:request-manifest").catch(() => {});
    emit("deskpet:request-settings").catch(() => {});
    // 预加载 walk/sleep 视频，保证单击 / 夜间播放即时（未加载时会短暂显示兜底小球）
    void loadAsset("walk");
    void loadAsset("sleep");
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

  // 接收 manifest（设置面板下发 / 插件回复请求）
  useEffect(() => {
    const un = listen<DeskpetManifest>("deskpet:manifest", (e) => {
      const m = e.payload;
      // 忽略插件回发的陈旧清单（引用已更名的 idle1/idle2），保留浮窗本地已修正的缺省清单
      if (m && Array.isArray(m.states) && m.states.length > 0 && !isLegacyDeskpetManifest(m)) {
        setManifest(m);
      }
    });
    return () => {
      void un.then((f) => f());
    };
  }, []);

  // manifest 或 stateIndex 变化 → 重新加载当前状态素材
  useEffect(() => {
    loadCurrent();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manifest, stateIndex]);

  // 兜底素材通道：插件在主窗经事件中继推送 asset:// URL（主路直读失败时启用，事件广播不需权限）
  useEffect(() => {
    const un = listen<{ key: string; url: string }>("deskpet:asset", (e) => {
      const { key, url } = e.payload;
      if (key && url && !assetsRef.current[key]) {
        applyAssetUrl(key, url);
      }
    });
    return () => {
      void un.then((f) => f());
    };
  }, []);

  // 帧序列 + 状态切换淡入淡出：图片状态（且不止一帧）循环播放；视频状态由 <video loop> 自循环，不切帧。
  // ⚠️ fading 的复位【不能只靠 setTimeout】：浮窗后台化（关 devtools / 失焦）时 Chromium 会节流 setTimeout，
  // 220ms 的复位可能迟迟不触发 → fading 卡在 true → 容器 opacity:0 → 整只宠物「隐形消失」。
  // 真·复位由资源就绪事件驱动：<img onLoad> 与 <VideoCanvas onReady>（媒体 load/canplay，不受后台 timer 节流），
  // 这里仅保留一个较长兜底 timer 防极端情况（资源加载事件没收到的兜底）。
  useEffect(() => {
    setFrameIndex(0);
    setFading(true);
    const fadeTimer = setTimeout(() => setFading(false), 800);
    return () => clearTimeout(fadeTimer);
  }, [manifest, stateIndex]);

  // 系统内存轮询：驱动工作动画自动触发（阈值 > 60% 启动，回落 ≤ 60% 退出）
  useEffect(() => {
    const poll = async () => {
      try {
        const info = await invoke<{ used_percent: number }>("get_system_memory");
        const pct = info.used_percent;
        memPercentRef.current = pct;
        setMemPercent(pct);
        evaluateMemory(pct);
      } catch (e) {
        console.warn("[桌宠] 内存查询失败:", e);
      }
    };
    void poll();
    const t = window.setInterval(() => void poll(), MEM_POLL_MS);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 夜间睡眠：系统时间超过今日日落后，每小时（空闲待机时）播放一遍 sleep.mp4。
  // 日落由 getSunsetHours 用系统时区近似推算（无需联网/定位）。
  useEffect(() => {
    sunsetHoursRef.current = getSunsetHours(new Date());
    const check = () => {
      const now = new Date();
      sunsetHoursRef.current = getSunsetHours(now); // 跨天后每天重算
      const h = now.getHours() + now.getMinutes() / 60;
      const sunset = sunsetHoursRef.current;
      if (h <= sunset) {
        lastSleepHourRef.current = -1; // 白天重置，入夜后可再次播放
        return;
      }
      const curId = manifestRef.current.states[stateIndexRef.current]?.id;
      if (curId === "idle" && now.getHours() !== lastSleepHourRef.current) {
        lastSleepHourRef.current = now.getHours();
        playOnce("sleep");
      }
    };
    check();
    const t = window.setInterval(check, 60 * 1000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  // 一次性播放某状态视频（walk/sleep）：切换过去播放，结束后由 onVideoEnded 回到待机。
  // 顺带播一个轻跳，增强反馈。仅当该状态素材已加载才切换；否则先加载再切换，
  // 避免切到未就绪状态而显示兜底小球（看似「消失」）。
  const playOnce = (stateId: string) => {
    const idx = manifestRef.current.states.findIndex((s) => s.id === stateId);
    if (idx < 0) return;
    const firstRel = manifestRef.current.states[idx]?.assets[0]?.rel;
    const key = firstRel ? `${stateId}:${firstRel}` : null;
    setBounce(true);
    window.setTimeout(() => setBounce(false), 430);
    const doSwitch = () => {
      playReturnRef.current = stateIndexRef.current;
      setStateIndex(idx);
    };
    if (key && assetsRef.current[key]) {
      doSwitch();
    } else if (key) {
      void loadAsset(stateId).then(() => {
        if (assetsRef.current[key]) doSwitch();
      });
    } else {
      doSwitch();
    }
  };

  // 双击：切换主窗口显隐（唤出 / 最小化）。主窗口 label 为 "main"。
  const toggleMainWindow = async () => {
    try {
      const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
      const main = await WebviewWindow.getByLabel("main");
      if (!main) return;
      const visible = await main.isVisible().catch(() => false);
      const minimized = await main.isMinimized().catch(() => false);
      if (!visible || minimized) {
        await main.show().catch(() => {});
        await main.setFocus().catch(() => {});
      } else {
        await main.minimize().catch(() => {});
      }
    } catch (e) {
      console.warn("[桌宠] 切换主窗口失败:", e);
    }
  };

  // 单击/双击判定：两次点击间隔 < DOUBLE_MS 视为双击（切换主窗口，且不播 walk）；
  // 否则延迟 DOUBLE_DELAY 后播 walk（单击）。延迟窗口内若收到第二次点击则取消 walk。
  const handleClick = () => {
    const now = Date.now();
    if (now - lastClickRef.current < DOUBLE_MS) {
      lastClickRef.current = 0;
      if (clickTimerRef.current) {
        clearTimeout(clickTimerRef.current);
        clickTimerRef.current = null;
      }
      void toggleMainWindow();
    } else {
      lastClickRef.current = now;
      if (clickTimerRef.current) clearTimeout(clickTimerRef.current);
      clickTimerRef.current = window.setTimeout(() => {
        clickTimerRef.current = null;
        playOnce("walk");
      }, DOUBLE_DELAY);
    }
  };

  // 键盘按键友好显示名（rdev Key 枚举的 Debug 字符串 → 可读标签）。
  // 兼容 rdev 0.3（Digit1 / Enter）与 0.5（Num1 / Return）两套命名，升级无感。
  const friendlyKey = (raw: string): string => {
    if (/^Key[A-Z]$/.test(raw)) return raw.slice(3); // 字母：KeyA → A
    if (/^Digit[0-9]$/.test(raw)) return raw.slice(5); // rdev 0.3 主键盘数字
    if (/^Num[0-9]$/.test(raw)) return raw.slice(3); // rdev 0.5 主键盘数字：Num1 → 1
    if (/^Kp[0-9]$/.test(raw)) return raw.slice(2); // 小键盘数字：Kp1 → 1
    const map: Record<string, string> = {
      Space: "Space", Enter: "Enter", Return: "Enter", KpReturn: "Enter",
      Backspace: "⌫", Tab: "Tab", Escape: "Esc",
      ControlLeft: "Ctrl", ControlRight: "Ctrl",
      ShiftLeft: "Shift", ShiftRight: "Shift",
      AltLeft: "Alt", AltRight: "Alt", AltGr: "AltGr",
      MetaLeft: "Win", MetaRight: "Win",
      CapsLock: "Caps",
      LeftArrow: "←", RightArrow: "→", UpArrow: "↑", DownArrow: "↓",
      Delete: "Del", Insert: "Ins", Home: "Home", End: "End",
      PageUp: "PgUp", PageDown: "PgDn",
      PrintScreen: "PrtSc", ScrollLock: "ScrLk", Pause: "Pause",
      NumLock: "NumLk", Function: "Fn",
    };
    if (map[raw]) return map[raw];
    if (/^F\d{1,2}$/.test(raw)) return raw; // F1..F12
    return raw.replace(/Left$/, "").replace(/Right$/, ""); // 兜底：去掉修饰键方位后缀
  };
  // 修饰键标签（用于判定和弦合并）：Ctrl / Shift / Alt / AltGr / Win
  const MOD_LABELS = new Set(["Ctrl", "Shift", "Alt", "AltGr", "Win"]);
  const isModifier = (raw: string) => MOD_LABELS.has(friendlyKey(raw));
  // 按下：加入（去重 + 最多 3 个）；松开：保留 2s 再移除（延长按键提示可见时间）。
  // 和弦合并严格按「同时按下」判定：仅当某普通键按下时，修饰键集合（heldModsRef）非空，
  // 才把它合成 "Ctrl+C" 形式；先按普通键、后按修饰键不会回退合并（避免误合成）。
  const addKey = (raw: string) => {
    // 清掉该键旧移除计时器（重复按下刷新）
    if (keyTimersRef.current[raw]) {
      clearTimeout(keyTimersRef.current[raw]);
      keyTimersRef.current[raw] = undefined;
    }
    const label = friendlyKey(raw);
    if (isModifier(label)) {
      // 修饰键按下：记入「当前按住」集合；独立显示（如 Ctrl），待普通键按下时再合成和弦
      heldModsRef.current.add(label);
      keyLabelsRef.current[raw] = label;
    } else if (heldModsRef.current.size > 0) {
      // 普通键按下且修饰键正按住 → 合并为和弦（如 Ctrl+C）；
      // 同时移除已显示的独立修饰键 chip，避免既显示 "Ctrl" 又显示 "Ctrl+C"
      const chord = [...heldModsRef.current].join("+") + "+" + label;
      for (const m of heldModsRef.current) {
        const rawM = Object.keys(keyLabelsRef.current).find((k) => keyLabelsRef.current[k] === m);
        if (rawM) {
          delete keyLabelsRef.current[rawM];
          setKeys((prev) => prev.filter((k) => k !== rawM));
        }
      }
      keyLabelsRef.current[raw] = chord;
    } else {
      // 无修饰键按住：普通键独立显示
      keyLabelsRef.current[raw] = label;
    }
    setKeys((prev) => {
      const next = prev.filter((k) => k !== raw);
      next.push(raw);
      return next.length > 3 ? next.slice(next.length - 3) : next;
    });
  };
  const removeKey = (raw: string) => {
    // 松开修饰键：移出「当前按住」集合（不影响已合成的和弦 chip）
    const label = friendlyKey(raw);
    if (isModifier(label)) heldModsRef.current.delete(label);
    if (keyTimersRef.current[raw]) clearTimeout(keyTimersRef.current[raw]);
    keyTimersRef.current[raw] = window.setTimeout(() => {
      keyTimersRef.current[raw] = undefined;
      delete keyLabelsRef.current[raw];
      setKeys((prev) => prev.filter((k) => k !== raw));
    }, 2000);
  };

  // 全局设备监听：光标跟随（全局）、拖拽（根治「拖动时窗口闪没」）、多角度换帧与视差倾斜。
  // 参考 got-it/BongoCat 方案：Rust 端 rdev 全局钩子 emit device-changed，前端按事件驱动。
  // 关键：朝向/倾斜的实时更新放在 device-changed 回调里，而非 rAF——浮窗失焦时浏览器会
  // 节流甚至停跑 requestAnimationFrame，导致「鼠标在窗外时朝向卡死、只显示初始一两帧」。
  useEffect(() => {
    // 全局广播事件：启动监听命令；成功/失败都打印，便于排查钩子是否生效
    invoke("start_device_listening")
      .then(() => console.log("[桌宠] 全局设备监听已启动"))
      .catch((e) => console.error("[桌宠] 全局设备监听启动失败:", e));

    // 让 Rust 侧把 WebView2 背景设为透明，并（仅桌宠）启动「失焦强制重绘」定时器，
    // 根治透明浮窗失焦时朝向/按键提示冻住（聚焦或开 devtools 才恢复）的问题。
    invoke("set_overlay_transparent").catch(() => {});

    let logged = false;
    const unDevice = listen<{ t: string; x?: number; y?: number; key?: string }>(
      "device-changed",
      (e) => {
        if (!logged) {
          logged = true;
          console.log("[桌宠] 收到首条 device-changed:", e.payload.t);
        }
        const p = e.payload;
        if (p.t === "mouse_move") {
          // rdev 给物理像素，转逻辑坐标（除以 DPR）再与浮窗逻辑坐标计算
          if (p.x != null && p.y != null) {
            const cx = p.x / dprRef.current;
            const cy = p.y / dprRef.current;
            cursorRef.current = { x: cx, y: cy };
            // 不在拖拽时，按全局光标方向实时更新待机多角度朝向 + 视差倾斜。
            // 必须放在 device-changed 回调里（而非 rAF）：浮窗失焦/后台时浏览器会节流甚至停跑
            // requestAnimationFrame，导致朝向卡死（只看得到初始一两帧）；全局鼠标事件不受此影响，
            // 确保「鼠标在窗外」时桌宠也能正确转向、显示全部朝向。
            const d = dragRef.current;
            if (!d || !d.active) {
              const scale = settingsRef.current.scale;
              const winW = WIN_W * scale;
              const winH = WIN_H * scale;
              const petCx = winPosRef.current.x + winW / 2;
              const petCy = winPosRef.current.y + winH - (PET * scale) / 2;
              const dx = cx - petCx;
              const dy = cy - petCy;
              const leanEl = leanRef.current;
              if (leanEl) {
                const lx = Math.max(-1, Math.min(1, dx / (winW / 2))) * LEAN_MAX;
                const ly = Math.max(-1, Math.min(1, dy / (winH / 2))) * LEAN_MAX * 0.6;
                leanEl.style.transform = `translate(${lx}px, ${ly}px)`;
              }
              const st = manifestRef.current.states[stateIndexRef.current];
              if (st && st.id !== "work") {
                const imgs = st.assets.filter((a) => a.kind !== "video");
                if (imgs.length > 0) {
                  const idx = pickAngleFrame(imgs, dx, dy);
                  if (idx !== frameIndexRef.current) setFrameIndex(idx);
                }
              }
            }
          }
        } else if (p.t === "mouse_up") {
          endDrag();
        } else if (p.t === "key_down") {
          if (p.key) addKey(p.key);
        } else if (p.t === "key_up") {
          if (p.key) removeKey(p.key);
        }
      },
    );

    const w = getCurrentWindow();
    // 同步取「窗口位置（物理）+ DPR」，把物理坐标换算成逻辑坐标再存入 winPosRef，
    // 与 cursorRef（p.x / dprRef，逻辑）和 e.clientX（逻辑）保持同一坐标系。
    // 否则 outerPosition 返回的是物理像素，直接当逻辑存会让 winPosRef 比真实大 DPR 倍，
    // 导致「点击/拖拽起点错位 → 窗口被推到屏外消失」。这也是「启动点击即消失、拖动后才正常」的根因。
    Promise.all([w.outerPosition(), w.scaleFactor()])
      .then(([pos, sf]) => {
        dprRef.current = sf;
        const lx = pos.x / sf;
        const ly = pos.y / sf;
        winPosRef.current = { x: lx, y: ly };
        const scale = settingsRef.current.scale;
        cursorRef.current = {
          x: lx + (WIN_W * scale) / 2,
          y: ly + WIN_H * scale - (PET * scale) / 2,
        };
      })
      .catch(() => {});

    let raf = 0;
    const tick = () => {
      // 朝向（pickAngleFrame）与视差倾斜已移至 device-changed 回调实时更新（不受浮窗失焦时
      // rAF 节流影响）。这里仅保留拖拽期间窗口跟随：拖拽时浮窗为活动窗口、rAF 正常，
      // 用全局 cursorRef 计算每个新窗口位置。
      const c = cursorRef.current;
      const d = dragRef.current;
      if (d && d.active) {
        const nx = c.x + d.grabOffsetX;
        const ny = c.y + d.grabOffsetY;
        // 移动判定必须在同一坐标系：屏幕光标 vs 按下时的屏幕光标
        if (Math.hypot(c.x - d.startScreenX, c.y - d.startScreenY) > DRAG_THRESHOLD) d.moved = true;
        w.setPosition(new LogicalPosition(nx, ny)).catch(() => {});
        winPosRef.current = { x: nx, y: ny };
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      void unDevice.then((f) => f());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 透明浮窗失焦时 WebView2 会节流/暂停渲染，导致朝向、按键提示等更新「冻住」
  //（聚焦或开 devtools 才恢复）。用定时器周期性切换一个透明 1px 元素的 opacity 强制重绘，
  // 让失焦时也能以约 1fps 低频刷新（透明浮窗已知限制的最佳前端缓解；根治需 Rust 侧
  // 让 WebView2 持续渲染，例如 RootVisualTarget）。
  useEffect(() => {
    const id = window.setInterval(() => {
      if (document.hasFocus()) return;
      const el = repaintRef.current;
      if (el) el.style.opacity = el.style.opacity === "0.99" ? "1" : "0.99";
    }, 250);
    return () => clearInterval(id);
  }, []);

  // 内存占用评估：决定工作动画序列的进入 / 退出（与薄荷共用 get_system_memory 模板）
  const evaluateMemory = (pct: number) => {
    const curId = manifestRef.current.states[stateIndexRef.current]?.id;
    if (curId === "work") {
      // 工作中：内存回落到阈值以下 → 进入「结束」相位（播放 work3 后回待机）
      if (pct <= MEM_THRESHOLD && workPhaseRef.current !== "end") setWorkPhase("end");
      return;
    }
    // 仅在待机态自动启动工作动画（work1→work2→work3）
    if (curId === "idle" && pct > MEM_THRESHOLD) {
      const wi = manifestRef.current.states.findIndex((s) => s.id === "work");
      if (wi >= 0) {
        setStateIndex(wi);
        setWorkPhase("start");
      }
    }
  };

  // 视频结束回调：walk/sleep 一次性播放完 → 回待机；work 按相位推进（start→loop→end→回待机）
  const onVideoEnded = () => {
    const curId = manifestRef.current.states[stateIndexRef.current]?.id;
    if (curId === "walk" || curId === "sleep") {
      const idleIdx = manifestRef.current.states.findIndex((s) => s.id === "idle");
      setStateIndex(idleIdx >= 0 ? idleIdx : playReturnRef.current);
      return;
    }
    if (curId !== "work") return;
    if (workPhaseRef.current === "start") {
      setWorkPhase("loop");
    } else if (workPhaseRef.current === "end") {
      setWorkPhase(null);
      const idleIdx = manifestRef.current.states.findIndex((s) => s.id === "idle");
      if (idleIdx >= 0) setStateIndex(idleIdx);
    }
  };

  // 拖拽终点：松开（本地 pointerup 或全局 mouse_up 都会调用）。未移动且短时按下 = 单击/双击判定。
  const endDrag = () => {
    const d = dragRef.current;
    if (!d || !d.active) return;
    if (!d.moved && Date.now() - d.down < CLICK_MS) handleClick();
    dragRef.current = null;
  };

  // 拖拽起点：在宠物上按下 → 记录抓取偏移与按下时的屏幕坐标，并立即把光标设为当前屏幕坐标
  // （避免拖拽首帧用错误坐标把窗口挪到屏外而「消失」）。后续由全局鼠标事件驱动窗口跟随，见 rAF 循环。
  // 不调用 setPointerCapture：透明浮窗上捕获指针易随窗口移动而丢失，导致拖动中断、「闪没」。
  const onPointerDown = (e: ReactPointerEvent) => {
    e.preventDefault();
    if (settingsRef.current.clickThrough) return; // 点击穿透模式不响应拖拽
    if (e.button !== 0) return; // 仅左键参与拖拽 / 点击（右键交由 onContextMenu）
    const cx = e.clientX; // 窗口内相对坐标（CSS 逻辑像素）
    const cy = e.clientY;
    const w = getCurrentWindow();
    // 同步设置 dragRef：必须用最近已知窗口位置即时赋值，绝不能等异步 outerPosition resolve 后才置 active。
    // 否则快速单击时 pointerup→endDrag 在异步回调前执行、dragRef 仍为 null 提前返回，
    // 异步回调随后把 active=true 写上 → dragRef 永久卡在拖拽态 → rAF 持续把窗口跟随光标 → 推到屏外「消失」。
    const pos = winPosRef.current;
    const screenX = pos.x + cx; // 光标屏幕逻辑坐标（与 cursorRef / rdev 同源）
    const screenY = pos.y + cy;
    // 立即把光标置为当前屏幕坐标，首帧即正确，杜绝跳屏
    cursorRef.current = { x: screenX, y: screenY };
    // grabOffset = -抓取点窗口内偏移：新窗口位置 = 光标屏幕坐标 + grabOffset，
    // 使抓取点始终跟在光标下（拖拽全程光标与窗口同步位移）。
    dragRef.current = {
      startScreenX: screenX,
      startScreenY: screenY,
      grabOffsetX: -cx,
      grabOffsetY: -cy,
      moved: false,
      down: Date.now(),
      active: true,
    };
    // 异步仅用于校正窗口实际位置 / DPR，不参与 active 状态判定，避免竞态
    w.outerPosition().then((p) => { winPosRef.current = { x: p.x, y: p.y }; }).catch(() => {});
    w.scaleFactor().then((sf) => { dprRef.current = sf; }).catch(() => {});
  };
  // 本地兜底：光标在窗口内时直接用浏览器坐标更新屏幕坐标（与全局事件同源）。
  // 仅在「非拖拽」时生效——拖拽全程以全局 rdev 鼠标坐标为唯一真值，避免两套数据源争抢
  // cursorRef 造成窗口跳动（winPosRef 每帧才更新、比全局慢一帧）。
  const onPointerMoveLocal = (e: ReactPointerEvent) => {
    if (dragRef.current?.active) return;
    cursorRef.current = {
      x: winPosRef.current.x + e.clientX,
      y: winPosRef.current.y + e.clientY,
    };
  };
  // 本地收尾：按钮在窗口内松开 → 结束拖拽（全局 mouse_up 未到达时以此兜底）
  const onPointerUpLocal = () => endDrag();

  const order = manifest.states;
  const curIdx = Math.min(stateIndex, Math.max(0, order.length - 1));
  const curState = order[curIdx];
  const curAssets = curState?.assets ?? [];
  const videoAssets = curAssets.filter((a) => a.kind === "video");
  const imageAssets = curAssets.filter((a) => a.kind !== "video");
  const hasVideo = videoAssets.length > 0;
  const isWork = curState?.id === "work";
  // work 状态按相位选择：start=work1 / loop=work2 / end=work3；
  // 其余视频状态播首个视频自循环；图片状态按鼠标方位帧序号循环。
  let displayAsset;
  if (isWork) {
    const phaseIdx = workPhase === "end" ? 2 : workPhase === "loop" ? 1 : 0;
    displayAsset = videoAssets[Math.min(phaseIdx, Math.max(0, videoAssets.length - 1))];
  } else if (hasVideo) {
    displayAsset = videoAssets[0];
  } else if (imageAssets.length > 0) {
    displayAsset = imageAssets[frameIndex % imageAssets.length];
  } else {
    displayAsset = undefined;
  }
  // 工作态仅在 loop 相位循环；walk/sleep 等一次性视频播完即停（由 onVideoEnded 回待机）
  const videoLoop = isWork ? workPhase === "loop" : false;
  const currentKey = displayAsset ? `${curState!.id}:${displayAsset.rel}` : undefined;
  const currentUrl = currentKey ? assets[currentKey] : undefined;
  const showVideo = !!displayAsset && displayAsset.kind === "video" && !!currentUrl;
  const showImage = !!displayAsset && displayAsset.kind !== "video" && !!currentUrl;

  // 兜底复位 fading：当渲染的是「无媒体兜底小球」(既非视频也非图片) 时，没有媒体就绪事件可触发，
  // 用 effect 直接复位，彻底摆脱第十四轮根因——后台浮窗的 setTimeout 被节流导致 fading 卡 true、整只隐形。
  // 视频/图片路径走各自的 onReady/onLoad 复位（媒体事件不受后台 timer 节流）。
  useEffect(() => {
    if (!showVideo && !showImage) setFading(false);
  }, [showVideo, showImage, currentUrl]);

  // 终极兜底：每次切换资源（currentKey 变化 = 点击 walk / 状态切换）都在 commit 阶段强制复位 fading。
  // 不依赖后台被节流的 setTimeout，也不依赖可能挂起的媒体事件，确保「点击后宠物必定 opacity:1 可见」。
  // 代价：失去淡出动画，但彻底杜绝静默消失。
  useEffect(() => {
    setFading(false);
  }, [currentKey]);

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
      <style>{`@keyframes pet-bounce{0%{transform:translateY(0)}30%{transform:translateY(-10px)}55%{transform:translateY(0)}75%{transform:translateY(-4px)}100%{transform:translateY(0)}}`}</style>
      <div
        ref={leanRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMoveLocal}
        onPointerUp={onPointerUpLocal}
        onContextMenu={(e) => {
          // 右键：仅轻跳反馈，不再循环切换状态（旧逻辑会切到未加载状态而显示兜底小球，看似「消失」）
          e.preventDefault();
          setBounce(true);
          window.setTimeout(() => setBounce(false), 430);
        }}
        style={{
          width: PET,
          height: PET,
          cursor: "grab",
          touchAction: "none",
          willChange: "transform",
          pointerEvents: "auto",
          transform: "translate(0px, 0px)",
          transition: "transform 0.15s ease-out",
        }}
      >
        {/* 键盘按键提示：显示在宠物上方，半透明，最多 3 个，2s 自动消失 */}
        {keys.length > 0 && (
          <div
            style={{
              position: "absolute",
              bottom: "100%",
              left: "50%",
              transform: "translateX(-50%)",
              display: "flex",
              gap: 6,
              pointerEvents: "none",
              opacity: 0.6,
              marginBottom: 6,
            }}
          >
            {keys.map((raw) => (
              <span
                key={raw}
                style={{
                  minWidth: 22,
                  height: 22,
                  padding: "0 7px",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 12,
                  fontWeight: 600,
                  color: "#fff",
                  background: "rgba(0,0,0,0.7)",
                  borderRadius: 6,
                  boxShadow: "0 2px 6px rgba(0,0,0,0.3)",
                  whiteSpace: "nowrap",
                }}
              >
                {keyLabelsRef.current[raw] ?? friendlyKey(raw)}
              </span>
            ))}
          </div>
        )}
        <div ref={repaintRef} style={{ position: "absolute", width: 1, height: 1, opacity: 1, pointerEvents: "none" }} />
        <div
          ref={ref}
          style={{
            width: PET,
            height: PET,
            willChange: "transform",
          }}
        >
          <div
            style={{
              width: PET,
              height: PET,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              opacity: fading ? 0 : 1,
              transition: "opacity 0.2s ease",
              animation: bounce ? "pet-bounce 0.43s ease" : undefined,
            }}
          >
            {showVideo && !failedVideos[currentKey ?? ""] ? (
              <VideoCanvasBoundary
                onError={(m) => setStatus(`视频组件崩溃: ${m}（已兜底）`)}
                fallback={
                  <div
                    style={{
                      width: PET,
                      height: PET,
                      borderRadius: "50%",
                      background: "#f59e0b",
                      boxShadow: "0 6px 18px rgba(0,0,0,0.18)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      color: "#fff",
                      fontSize: 12,
                      userSelect: "none",
                    }}
                  >
                    视频崩溃
                  </div>
                }
              >
                <VideoCanvas
                  key={currentKey}
                  src={currentUrl}
                  loop={videoLoop}
                  size={PET}
                  onReady={() => setFading(false)}
                  onEnded={onVideoEnded}
                  onFailed={() =>
                    currentKey && setFailedVideos((p) => ({ ...p, [currentKey]: true }))
                  }
                  onHint={(m) => setStatus(m)}
                  label={curState?.id}
                />
              </VideoCanvasBoundary>
            ) : showImage ? (
              <img
                key={currentKey}
                src={currentUrl}
                width={PET}
                height={PET}
                alt="桌宠"
                draggable={false}
                onLoad={() => setFading(false)}
                onError={(e) => console.error("[桌宠] 渲染失败:", curState?.id ?? "", e)}
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
        </div>
      </div>
      {status && (
        <div
          style={{
            position: "fixed",
            right: 4,
            top: 4,
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
