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
const HAPPY_MS = 1200; // happy 反应持续时长

// 内存触发工作动画（与薄荷共用 pro-tools-kit::get_system_memory 模板）
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

/**
 * 桌宠渲染组件（运行在独立透明浮窗 deskpet 内）。
 * - 浮窗尺寸恰好包住桌宠；默认定位右下角、不穿透鼠标，可拖拽/交互（不影响截图）。
 * - 素材由浮窗自身直接 invoke('read-external-dep-path') 取绝对路径后 convertFileSrc 走 asset 协议加载（懒加载），
 *   不走 base64（大图易超 IPC 载荷导致破图）；失败在 console 可见（不再静默吞掉）；缺失时回退内置 CSS 小球。
 * - 待机呼吸动画（轻微上下浮动 + 缩放）；单状态多图时循环播放「帧序列」；状态切换淡入淡出。
 * - 互动：悬停时朝光标方向轻微倾斜（B1 视差）；单击=弹跳+切 happy 动作，按住拖动=移动整个浮窗；右键循环切换状态。
 * - Phase A 基础设置：缩放（resize 窗口 + 外层 scale）、透明度（容器 opacity）、点击穿透（setIgnoreCursorEvents）。
 */
// 由文件名推断该待机图朝向（屏幕坐标 y 向下）：正脸 / 左 / 左上 / 右上 / 右下 / 左下…
// 用于「鼠标方位 → 多角度待机图」的帧选择（与 got-it/桌宠 的多角度素材命名约定一致）。
function dirVectorOf(name: string): { x: number; y: number } | null {
  const n = name.toLowerCase();
  const hasLeft = n.includes("left") || n.includes("左");
  const hasRight = n.includes("right") || n.includes("右");
  const hasUp = n.includes("up") || n.includes("上");
  const hasDown = n.includes("down") || n.includes("下");
  const hasFront = n.includes("face") || n.includes("front") || n.includes("正脸") || n.includes("正面") || n.includes("前");
  if (hasFront && !hasLeft && !hasRight && !hasUp && !hasDown) return { x: 0, y: 0 };
  const x = (hasRight ? 1 : 0) - (hasLeft ? 1 : 0);
  const y = (hasDown ? 1 : 0) - (hasUp ? 1 : 0);
  if (x === 0 && y === 0) return null; // 无方向信息的图（如单一 idle），按普通图处理
  return { x, y };
}

// 根据鼠标相对宠物中心的向量，挑出最匹配朝向的待机图序号（点积最大）。
function pickAngleFrame(imgs: { file: string; rel: string }[], dx: number, dy: number): number {
  const dirs = imgs.map((a, i) => ({ i, v: dirVectorOf(a.file || a.rel) }));
  const front = dirs.find((d) => d.v && d.v.x === 0 && d.v.y === 0);
  const len = Math.hypot(dx, dy);
  if (len < 18) return front ? front.i : 0; // 鼠标贴近中心 → 正脸
  const ux = dx / len;
  const uy = dy / len;
  let best = -1;
  let bestDot = -Infinity;
  for (const d of dirs) {
    if (!d.v || (d.v.x === 0 && d.v.y === 0)) continue;
    const dot = ux * d.v.x + uy * d.v.y;
    if (dot > bestDot) {
      bestDot = dot;
      best = d.i;
    }
  }
  if (best < 0) return front ? front.i : 0;
  return best;
}

export function DeskpetPet() {
  const [manifest, setManifest] = useState<DeskpetManifest>(() => loadDeskpetManifest());
  const [stateIndex, setStateIndex] = useState(0);
  const [assets, setAssets] = useState<Record<string, string>>({}); // key(状态:rel) -> asset:// URL
  const [settings, setSettings] = useState<DeskpetSettings>(DEFAULT_SETTINGS);
  const [status, setStatus] = useState<string>(""); // 屏上诊断：空=正常/已显示；非空=显示诊断文字
  const [frameIndex, setFrameIndex] = useState(0); // 当前状态内的帧序号（图片帧序列循环）
  const [fading, setFading] = useState(false); // 状态切换淡入淡出
  const [bounce, setBounce] = useState(false); // 单击弹跳动画
  const [lean, setLean] = useState<{ x: number; y: number }>({ x: 0, y: 0 }); // 悬停视差偏移
  const [memPercent, setMemPercent] = useState<number>(0); // 系统内存占用率（%）
  const [workPhase, setWorkPhase] = useState<"start" | "loop" | "end" | null>(null); // 工作动画相位：启动/循环/结束

  const ref = useRef<HTMLDivElement | null>(null); // 内层：呼吸动画 transform
  const leanRef = useRef<HTMLDivElement | null>(null); // 交互层：视差 transform + 指针事件
  const wrapperRef = useRef<HTMLDivElement | null>(null); // 外层：缩放 / 透明度
  const assetsRef = useRef<Record<string, string>>(assets);
  const settingsRef = useRef<DeskpetSettings>(settings);
  const stateIndexRef = useRef(stateIndex);
  const manifestRef = useRef(manifest);
  const happyTimer = useRef<number | null>(null);
  const dragRef = useRef<{ sx: number; sy: number; wx: number; wy: number; moved: boolean; down: number } | null>(null);
  const memPercentRef = useRef(0);
  const workPhaseRef = useRef<"start" | "loop" | "end" | null>(null);
  assetsRef.current = assets;
  settingsRef.current = settings;
  stateIndexRef.current = stateIndex;
  manifestRef.current = manifest;
  memPercentRef.current = memPercent;
  workPhaseRef.current = workPhase;

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
        const url = await readExternalDepPath(asset.rel);
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
    // 向插件请求最新 manifest（插件从 localStorage 回复）；当前状态素材由下方 [manifest,stateIndex] 效应加载
    emit("deskpet:request-manifest").catch(() => {});
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
  useEffect(() => {
    setFrameIndex(0);
    setFading(true);
    const fadeTimer = setTimeout(() => setFading(false), 220);
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

  // 单击反应：弹跳 + 切到 happy 动作（若 manifest 有该状态），随后回到原状态
  const triggerBounce = () => {
    setBounce(true);
    window.setTimeout(() => setBounce(false), 430);
    const hi = manifestRef.current.states.findIndex((s) => s.id === "happy");
    if (hi >= 0 && hi !== stateIndexRef.current) {
      const prev = stateIndexRef.current;
      setStateIndex(hi);
      if (happyTimer.current) clearTimeout(happyTimer.current);
      happyTimer.current = window.setTimeout(() => setStateIndex(prev), HAPPY_MS);
    }
  };

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

  // 工作视频结束回调：start→loop（work2 循环），end→回待机
  const onVideoEnded = () => {
    const curId = manifestRef.current.states[stateIndexRef.current]?.id;
    if (curId !== "work") return;
    if (workPhaseRef.current === "start") {
      setWorkPhase("loop");
    } else if (workPhaseRef.current === "end") {
      setWorkPhase(null);
      const idleIdx = manifestRef.current.states.findIndex((s) => s.id === "idle");
      if (idleIdx >= 0) setStateIndex(idleIdx);
    }
  };

  // 悬停视差（B1）：根据光标相对宠物中心的方向，计算轻微偏移（注视/倾斜）；
  // 同时驱动「多角度图片」：按鼠标相对宠物的方位（atan2 角度）选择待机帧，绕一圈即换一轮角度图。
  const updateLean = (clientX: number, clientY: number) => {
    const el = leanRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const nx = (clientX - cx) / (r.width / 2);
    const ny = (clientY - cy) / (r.height / 2);
    setLean({
      x: Math.max(-1, Math.min(1, nx)) * LEAN_MAX,
      y: Math.max(-1, Math.min(1, ny)) * LEAN_MAX * 0.6,
    });
    const st = manifestRef.current.states[stateIndexRef.current];
    if (st && st.id !== "work") {
      const imgs = st.assets.filter((a) => a.kind !== "video");
      if (imgs.length > 0) {
        // 按鼠标相对宠物中心的方位，选最匹配朝向的待机图（多角度换帧）
        const idx = pickAngleFrame(imgs, clientX - cx, clientY - cy);
        setFrameIndex(idx);
      }
    }
  };

  // 交互：区分「单击（弹跳）」与「按住拖动（移动窗口）」
  const onPointerDown = async (e: ReactPointerEvent) => {
    e.preventDefault();
    // 必须在 await 前捕获元素：React 会在事件处理函数返回后将 e.currentTarget 置空，
    // 而本函数因 await 异步执行，届时再访问会取到 null 导致 setPointerCapture 崩溃。
    const target = e.currentTarget as HTMLElement | null;
    const w = getCurrentWindow();
    const pos = await w.outerPosition();
    dragRef.current = {
      sx: e.clientX,
      sy: e.clientY,
      wx: pos.x,
      wy: pos.y,
      moved: false,
      down: Date.now(),
    };
    target?.setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: ReactPointerEvent) => {
    const d = dragRef.current;
    if (!d) {
      updateLean(e.clientX, e.clientY);
      return;
    }
    const dx = e.clientX - d.sx;
    const dy = e.clientY - d.sy;
    if (!d.moved && Math.hypot(dx, dy) > DRAG_THRESHOLD) d.moved = true;
    if (d.moved) {
      getCurrentWindow()
        .setPosition(new LogicalPosition(d.wx + dx, d.wy + dy))
        .catch(() => {});
    } else {
      updateLean(e.clientX, e.clientY);
    }
  };
  const onPointerUp = () => {
    const d = dragRef.current;
    dragRef.current = null;
    if (d && !d.moved && Date.now() - d.down < CLICK_MS) triggerBounce();
    setLean({ x: 0, y: 0 });
  };

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
  const videoLoop = isWork ? workPhase === "loop" : true;
  const currentKey = displayAsset ? `${curState!.id}:${displayAsset.rel}` : undefined;
  const currentUrl = currentKey ? assets[currentKey] : undefined;
  const showVideo = !!displayAsset && displayAsset.kind === "video" && !!currentUrl;
  const showImage = !!displayAsset && displayAsset.kind !== "video" && !!currentUrl;

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
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => setLean({ x: 0, y: 0 })}
        onContextMenu={(e) => {
          // 右键循环切换状态（预览 / 验证懒加载；非最终交互）
          e.preventDefault();
          const len = manifestRef.current.states.length;
          if (len === 0) return;
          setStateIndex((i) => (i + 1) % len);
        }}
        style={{
          width: PET,
          height: PET,
          cursor: "grab",
          touchAction: "none",
          willChange: "transform",
          pointerEvents: "auto",
          transform: `translate(${lean.x}px, ${lean.y}px)`,
          transition: "transform 0.25s ease-out",
        }}
      >
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
            {showVideo ? (
              <video
                key={currentKey}
                src={currentUrl}
                width={PET}
                height={PET}
                autoPlay
                loop={videoLoop}
                muted
                playsInline
                draggable={false}
                onEnded={onVideoEnded}
                onError={(e) => console.error("[桌宠] 渲染失败:", curState?.id ?? "", e)}
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
                key={currentKey}
                src={currentUrl}
                width={PET}
                height={PET}
                alt="桌宠"
                draggable={false}
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
