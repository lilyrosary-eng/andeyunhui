// 可复用的缩放/平移相机（图片查看器先用，绘画模块可直接接）。
//
// 设计对齐 photocraft 的 canvas 视图：
// - 相机 {scale, x, y}，统一 translate(x,y) scale(scale)，transform-origin: 0 0；
// - 滚轮每档 ×1.1（ZOOM_NOTCH），默认最小 1×；
// - 缩放不硬跳：缓动改为 55~110ms 的 ease-out（photocraft 的 220ms smoothstep 尾巴
//   太长，滚轮停下后画面还在动，易驱性差）；
// - 同向连续滚轮改走“匀速跟随”：每帧位移恒定，一档到下一档之间没有停顿/闪格，
//   速度按最近两次事件的间隔推算（并对速度做平滑），目标始终由事件累乘决定；
// - 缓动过程中锚点也保持不动（不是只让终点对）；
// - 放大锚光标，缩小锚视口中心（zoomOutAnchor），锚点夹到图片范围内；
// - 拖动平移即时跟手，并取消未完成的缩放动画。
import { useCallback, useEffect, useRef, useState } from 'react';

export interface ZoomPanCamera {
  scale: number;
  x: number;
  y: number;
}

export type ZoomDirection = 'in' | 'out';

export interface ZoomPanOptions {
  min?: number;
  max?: number;
  /** 缩小的锚点：viewport = 视口中心（默认）；cursor = 光标。 */
  zoomOutAnchor?: 'viewport' | 'cursor';
  /** 是否缓动；默认遵循 prefers-reduced-motion。 */
  animated?: boolean;
  /**
   * 直接给出未变换的内容矩形（视口坐标）。canvas 渲染时用它：
   * 几何由容器 + 原图尺寸算，不再依赖 DOM 上的 transform（大图不会每帧生成巨型图层）。
   */
  getBaseRect?: () => { left: number; top: number; width: number; height: number; view: DOMRect } | null;
}

/** 一档滚轮对应的缩放倍率。 */
export const ZOOM_NOTCH = 1.1;
/** 浏览器滚轮一档大约 100px；用于把 deltaY 换算成档数。 */
export const ZOOM_NOTCH_PX = 100;
/** 单档缓动的基准时长（ms）。 */
const ZOOM_ANIM_MS = 110;
/** 落后越多（连续滚轮把目标推得很远）时长越短，最先追回来。 */
const ZOOM_ANIM_MIN_MS = 55;
/** log 倍率差达到这个值就按最短时长处理。 */
const ZOOM_ANIM_FULL_LOG = 0.5;
/** 单档的 ease-out 指数（3 = 现在的轻柔手感）。 */
const ZOOM_EASE_POWER = 3;
/** 落后越多曲线越陡（指数加到 6），快速连滚时不再“尾段慢慢滑”。 */
const ZOOM_EASE_EXTRA_POWER = 3;
/** 同向滚轮间隔不超过这个值视为连续输入，改走“匀速跟随”（ms）。 */
const ZOOM_FOLLOW_GAP_MS = 80;

const DEFAULT_CAMERA: ZoomPanCamera = { scale: 1, x: 0, y: 0 };

interface BaseRect {
  left: number;
  top: number;
  width: number;
  height: number;
  view: DOMRect;
}

interface ZoomAnimation {
  base: BaseRect;
  /** 锚点在屏幕上的当前位置（夹到图片内后的位置）。 */
  anchorX: number;
  anchorY: number;
  /** 锚点在未变换图片里的相对坐标（0~1）。 */
  rx: number;
  ry: number;
  toScale: number;
  /**
   * ease：单档，按时长 + 指数缓动；
   * follow：连续滚轮，按“每毫秒对数速度”匀速逼近目标（每帧位移恒定，不闪格）。
   */
  mode: 'ease' | 'follow';
  fromScale: number;
  duration: number;
  /** ease-out 指数：单档 3，落后越多越陡。 */
  power: number;
  start: number;
  /** follow 的速度（对数倍率 / 毫秒）。 */
  rate: number;
  /** follow 的上一帧时间。 */
  lastTime: number;
  instant: boolean;
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

/** ease-out：第一帧就吃掉大部分位移，尾巴短 —— 滚轮停下画面立刻停。 */
function easeOut(t: number, power: number): number {
  return 1 - Math.pow(1 - t, power);
}

function prefersReducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function useZoomPan(
  viewportRef: React.RefObject<HTMLElement>,
  contentRef: React.RefObject<HTMLElement>,
  options: ZoomPanOptions = {},
) {
  const min = options.min ?? 1;
  const max = options.max ?? 8;
  const zoomOutAnchor = options.zoomOutAnchor ?? 'viewport';
  const animated = options.animated ?? !prefersReducedMotion();
  const getBaseRect = options.getBaseRect;

  const [camera, setCamera] = useState<ZoomPanCamera>(DEFAULT_CAMERA);
  const cameraRef = useRef(camera);
  const animRef = useRef<ZoomAnimation | null>(null);
  const rafRef = useRef<number | null>(null);
  /** 上一次滚轮事件的时间/方向：用于识别快速连滚。 */
  const lastWheelRef = useRef<{ t: number; dir: ZoomDirection } | null>(null);

  const apply = useCallback((next: ZoomPanCamera) => {
    cameraRef.current = next;
    setCamera(next);
  }, []);

  const stop = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    animRef.current = null;
  }, []);

  const frame = useCallback((now: number) => {
    const anim = animRef.current;
    if (!anim) {
      rafRef.current = null;
      return;
    }
    let scale: number;
    let done = false;
    if (anim.instant) {
      scale = anim.toScale;
      done = true;
    } else if (anim.mode === 'follow') {
      // 匀速跟随：每帧位移只取决于帧间隔，不因滚轮事件落在两帧之间而忽大忽小。
      const dt = clamp(now - anim.lastTime, 0, 48);
      anim.lastTime = now;
      const curLog = Math.log(Math.max(cameraRef.current.scale, 1e-6));
      const targetLog = Math.log(Math.max(anim.toScale, 1e-6));
      const remain = targetLog - curLog;
      const step = anim.rate * dt;
      if (Math.abs(remain) <= step) {
        scale = anim.toScale;
        done = true;
      } else {
        scale = Math.exp(curLog + Math.sign(remain) * step);
      }
    } else {
      const t = clamp((now - anim.start) / anim.duration, 0, 1);
      const eased = easeOut(t, anim.power);
      scale = anim.fromScale + (anim.toScale - anim.fromScale) * eased;
      done = t >= 1;
    }
    // 每一帧都从锚点反推 x/y：动画全程光标下的内容点都不动。
    const x = anim.anchorX - anim.base.left - anim.rx * anim.base.width * scale;
    const y = anim.anchorY - anim.base.top - anim.ry * anim.base.height * scale;
    apply({ scale, x, y });
    if (done) {
      rafRef.current = null;
      animRef.current = null;
    } else {
      rafRef.current = requestAnimationFrame(frame);
    }
  }, [apply]);

  useEffect(() => () => stop(), [stop]);

  /** 当前视觉矩形反推未变换矩形；相机在动画中也能正确反推。 */
  const baseRect = useCallback((): BaseRect | null => {
    const custom = getBaseRect?.();
    if (custom) return custom;
    const view = viewportRef.current;
    const el = contentRef.current;
    if (!view || !el) return null;
    const r = el.getBoundingClientRect();
    const cur = cameraRef.current;
    const s = cur.scale > 0 ? cur.scale : 1;
    if (r.width <= 0 || r.height <= 0) return null;
    return {
      left: r.left - cur.x,
      top: r.top - cur.y,
      width: r.width / s,
      height: r.height / s,
      view: view.getBoundingClientRect(),
    };
  }, [getBaseRect, viewportRef, contentRef]);

  /**
   * 指定倍率缩放（捏合/绘画模块可复用）。
   * @param direction in = 锚光标；out = 默认锚视口中心。
   * @param gapMs 距上一档同向滚轮的间隔；连续滚轮时用它推算匀速跟随的速度。
   */
  const zoomAt = useCallback((clientX: number, clientY: number, factor: number, direction: ZoomDirection = 'in', gapMs?: number) => {
    if (!Number.isFinite(factor) || factor <= 0) return;
    const base = baseRect();
    if (!base || base.width <= 0 || base.height <= 0) return;

    const cur = cameraRef.current;
    // 当前视觉矩形由相机直接算出（不再读 DOM transform）：canvas/dom 两种渲染都一致。
    const r = {
      left: base.left + cur.x,
      top: base.top + cur.y,
      width: base.width * cur.scale,
      height: base.height * cur.scale,
    };
    if (r.width <= 0 || r.height <= 0) return;
    // 连续同向滚轮按“目标档”累乘（响应快）；反向时从当前画面起算，
    // 避免“已经往回滚了，画面还在继续放大/缩小”的滞后感。
    const currentTarget = animRef.current ? animRef.current.toScale : cur.scale;
    const baseScale = factor >= 1 ? Math.max(currentTarget, cur.scale) : Math.min(currentTarget, cur.scale);
    const toScale = clamp(baseScale * factor, min, max);
    if (Math.abs(toScale - cur.scale) < 1e-6) return;

    let ax = clientX;
    let ay = clientY;
    if (direction === 'out' && zoomOutAnchor === 'viewport') {
      ax = base.view.left + base.view.width / 2;
      ay = base.view.top + base.view.height / 2;
    }
    // 用当前视觉矩形算相对坐标；夹到 0~1 后，光标在留白/视口外时锚到图片最近边缘。
    const rx = clamp((ax - r.left) / r.width, 0, 1);
    const ry = clamp((ay - r.top) / r.height, 0, 1);
    const anchorX = r.left + rx * r.width;
    const anchorY = r.top + ry * r.height;

    // 连续滚轮（同向、间隔 ≤ 80ms）：改走匀速跟随。每帧只前进固定对数速度，
    // 目标由事件累乘；事件落在两帧之间也不会出现“一帧不走、一帧猛走”的闪格。
    if (gapMs != null && gapMs > 0 && gapMs <= ZOOM_FOLLOW_GAP_MS) {
      const prevTarget = currentTarget > 0 ? currentTarget : 1;
      const logInc = Math.abs(Math.log(toScale / prevTarget));
      const prevRate = animRef.current?.mode === 'follow' ? animRef.current.rate : 0;
      const raw = logInc > 1e-6 ? logInc / gapMs : prevRate;
      // 速度做一点平滑，滚轮间隔抖动时不会一档快一档慢。
      const rate = prevRate > 0 ? prevRate * 0.4 + raw * 0.6 : raw;
      const now = performance.now();
      const prev = animRef.current;
      // 跟随动画已在跑：原地换目标/锚点，不重置时钟 —— 否则每来一档都重开一帧的
      // 计时，画面又会出现“事件后那一帧走得少”的抖动。
      if (prev && prev.mode === 'follow' && !prev.instant && rafRef.current !== null) {
        prev.base = base;
        prev.anchorX = anchorX;
        prev.anchorY = anchorY;
        prev.rx = rx;
        prev.ry = ry;
        prev.toScale = toScale;
        prev.rate = rate;
        return;
      }
      animRef.current = {
        base,
        anchorX,
        anchorY,
        rx,
        ry,
        toScale,
        mode: 'follow',
        fromScale: cur.scale,
        duration: 0,
        power: 0,
        start: now,
        rate: rate > 0 ? rate : Math.log(ZOOM_NOTCH) / gapMs,
        lastTime: now,
        instant: !animated,
      };
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(frame);
      return;
    }

    const fromScale = cur.scale;
    // 单档约 100ms；距目标越远时长越短（下限 55ms），曲线也更陡（3 → 6）。
    const dist = Math.abs(Math.log(toScale / (fromScale > 0 ? fromScale : 1)));
    const durU = clamp(dist / ZOOM_ANIM_FULL_LOG, 0, 1);
    const duration = ZOOM_ANIM_MS - (ZOOM_ANIM_MS - ZOOM_ANIM_MIN_MS) * durU;
    const power = ZOOM_EASE_POWER + ZOOM_EASE_EXTRA_POWER * durU;

    animRef.current = {
      base,
      anchorX,
      anchorY,
      rx,
      ry,
      toScale,
      mode: 'ease',
      fromScale,
      duration,
      power,
      start: performance.now(),
      rate: 0,
      lastTime: performance.now(),
      instant: !animated,
    };
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(frame);
  }, [baseRect, min, max, zoomOutAnchor, animated, frame]);

  /** 滚轮缩放：每档 ×1.1，deltaY 以 100px 为一档；同向连滚按间隔自适应时长。 */
  const zoomByWheel = useCallback((clientX: number, clientY: number, deltaY: number, direction: ZoomDirection) => {
    const now = performance.now();
    const prev = lastWheelRef.current;
    const gap = prev && prev.dir === direction ? now - prev.t : null;
    lastWheelRef.current = { t: now, dir: direction };
    const factor = clamp(Math.pow(ZOOM_NOTCH, -deltaY / ZOOM_NOTCH_PX), 0.5, 2);
    zoomAt(clientX, clientY, factor, direction, gap ?? undefined);
  }, [zoomAt]);

  /** 拖动平移：即时跟手；同时取消未完成的缩放动画。 */
  const panBy = useCallback((dx: number, dy: number) => {
    stop();
    const cur = cameraRef.current;
    apply({ ...cur, x: cur.x + dx, y: cur.y + dy });
  }, [apply, stop]);

  /** 复位：切图/切模式/重置按钮都立即回 1× 居中（不走缩放缓动，避免旧相机漂移）。 */
  const reset = useCallback(() => {
    stop();
    lastWheelRef.current = null;
    apply(DEFAULT_CAMERA);
  }, [apply, stop]);

  const transformStyle: React.CSSProperties = {
    transform: `translate(${camera.x}px, ${camera.y}px) scale(${camera.scale})`,
    transformOrigin: '0 0',
    willChange: 'transform',
  };

  return { camera, transformStyle, zoomAt, zoomByWheel, panBy, reset };
}
