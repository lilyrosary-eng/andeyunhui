/**
 * 壁纸取样 —— 给「表面分层」（index.css 的 L1.5/L2）提供两个 CSS 自己算不出来的依据：
 *
 *   lum      衬底之下到底有多亮 → --surface-lum → --state-ink 据此反向取墨，
 *            于是一条 hover/染色规则在白色壁纸与黑色壁纸上都成立。
 *   blurUrl  预模糊后的壁纸图 → 供跑不动 backdrop-filter / filter 的引擎（Linux WebKitGTK）
 *            拿它直接当背景层图源，用"事先模糊好的一张图"替代"运行时模糊"：
 *            观感近似、零合成器成本，且让 bgBlur 滑杆在这些平台上第一次起作用。
 *
 * 铁律：**只在背景源变化时跑一次**。逐帧 readback 在本项目有过的内存事故（单个 Web 进程
 * 4.2GB），所以这里不做任何 animation frame 采样，视频也只取一帧。
 */

/**
 * 壁纸态的衬底不透明度（%）。
 * 2026-11-01 实测回调：曾把它接到「面板透明度」(默认 80) 上并设 55% 保底，
 * 结果整片发奶，用户判定"太淡了，不如原来的"。这里退回旧补丁的实际强度（插件纸面 0.3），
 * 且**不再与 panelOpacity 联动** —— 那个滑杆的语义是 glass 面板，不是壁纸衬底。
 */
export const WALLPAPER_SCRIM_PCT = 32;

/**
 * 把壁纸状态折算成 --scrim-pct。
 * 纯色态恒为 100% → 所有 surface 退回实色，这条路径下新分层不改变任何像素。
 */
export function scrimPctFor(hasWallpaper: boolean): string {
  return hasWallpaper ? `${WALLPAPER_SCRIM_PCT}%` : '100%';
}

/** 亮度取样边长：32×32 足够定"整体偏亮还是偏暗"，且必然不会成为成本 */
const SAMPLE_EDGE = 32;
/** 预模糊输出边长：只用于做背景衬底，放大后糊得干净即可 */
const BLUR_OUTPUT_EDGE = 640;

export interface WallpaperSample {
  /** 0~1 的相对亮度；取样失败（污染画布 / 解码失败）为 null，交由 CSS 的主题默认值兜底 */
  lum: number | null;
  /** 预模糊壁纸的 data URL；未请求或生成失败为 null */
  blurUrl: string | null;
}

/** sRGB 单通道线性化（WCAG 定义） */
function toLinear(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/**
 * RGBA 像素序列的平均相对亮度。
 * 用加权求和而非"先平均 RGB 再算亮度"：后者会让亮暗各半的图算出中间值，
 * 而中间亮度恰好是 hover 墨向最不确定的地方。
 */
export function relativeLuminance(rgba: ArrayLike<number>): number {
  let sum = 0;
  let count = 0;
  for (let i = 0; i + 3 < rgba.length; i += 4) {
    sum += 0.2126 * toLinear(rgba[i]) + 0.7152 * toLinear(rgba[i + 1]) + 0.0722 * toLinear(rgba[i + 2]);
    count += 1;
  }
  if (count === 0) return 0.5;
  return Math.min(1, Math.max(0, sum / count));
}

/** 预模糊的降采样边长：blurPx 越大 → 中间图越小 → 放大后越糊 */
export function blurDownscaleEdge(blurPx: number, outputEdge = BLUR_OUTPUT_EDGE): number {
  const px = Number.isFinite(blurPx) ? Math.max(0, blurPx) : 0;
  return Math.min(240, Math.max(3, Math.round(outputEdge / (1 + px))));
}

interface Drawable {
  source: CanvasImageSource;
  width: number;
  height: number;
}

function loadImageDrawable(src: string): Promise<Drawable> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve({ source: img, width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => reject(new Error('wallpaper decode failed'));
    img.src = src;
  });
}

/**
 * 视频只取一帧（seek 到 1s，失败退回 0s）：亮度对整段视频够用，
 * 且刻意不做逐帧——同时避免跨源像素读取把画布搞污染。
 */
function loadVideoDrawable(src: string): Promise<Drawable> {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.muted = true;
    video.preload = 'auto';
    video.playsInline = true;
    video.crossOrigin = 'anonymous';
    const timeout = window.setTimeout(() => reject(new Error('wallpaper video timeout')), 8000);
    const cleanup = () => {
      window.clearTimeout(timeout);
      video.onloadeddata = null;
      video.onerror = null;
      video.src = '';
    };
    video.onloadeddata = () => {
      if (!video.videoWidth || !video.videoHeight) {
        cleanup();
        reject(new Error('wallpaper video has no size'));
        return;
      }
      const grab = () => {
        cleanup();
        resolve({ source: video, width: video.videoWidth, height: video.videoHeight });
      };
      if (video.currentTime >= 1) {
        grab();
        return;
      }
      video.onseeked = () => {
        video.onseeked = null;
        grab();
      };
      try {
        video.currentTime = 1;
      } catch {
        grab();
      }
    };
    video.onerror = () => {
      cleanup();
      reject(new Error('wallpaper video decode failed'));
    };
    video.src = src;
  });
}

function makeCanvas(w: number, h: number): HTMLCanvasElement | null {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  return canvas.getContext('2d') ? canvas : null;
}

function fitEdge(width: number, height: number, edge: number): { w: number; h: number } {
  const ratio = height / width;
  return { w: edge, h: Math.max(1, Math.round(edge * ratio)) };
}

/**
 * 采样一张壁纸。任何一步失败都不抛给调用方 —— 返回 null 字段，
 * 让 ThemeProvider 继续走 CSS 的主题默认值（宁可不透，不可读不了）。
 */
export async function sampleWallpaper(
  src: string,
  kind: 'image' | 'video',
  options: { blurPx?: number; wantBlur?: boolean } = {},
): Promise<WallpaperSample> {
  const { blurPx = 0, wantBlur = false } = options;
  let drawable: Drawable;
  try {
    drawable = kind === 'video' ? await loadVideoDrawable(src) : await loadImageDrawable(src);
  } catch {
    return { lum: null, blurUrl: null };
  }

  let lum: number | null = null;
  try {
    const size = fitEdge(drawable.width, drawable.height, SAMPLE_EDGE);
    const canvas = makeCanvas(size.w, size.h);
    const ctx = canvas?.getContext('2d', { willReadFrequently: true });
    if (canvas && ctx) {
      ctx.drawImage(drawable.source, 0, 0, size.w, size.h);
      lum = relativeLuminance(ctx.getImageData(0, 0, size.w, size.h).data);
    }
  } catch {
    // 跨源像素读取会抛 SecurityError：退回主题默认墨向
    lum = null;
  }

  let blurUrl: string | null = null;
  if (wantBlur && blurPx > 0) {
    try {
      const down = fitEdge(drawable.width, drawable.height, blurDownscaleEdge(blurPx));
      const small = makeCanvas(down.w, down.h);
      const smallCtx = small?.getContext('2d');
      const out = fitEdge(drawable.width, drawable.height, BLUR_OUTPUT_EDGE);
      const big = makeCanvas(out.w, out.h);
      const bigCtx = big?.getContext('2d');
      if (small && smallCtx && big && bigCtx) {
        smallCtx.imageSmoothingEnabled = true;
        smallCtx.drawImage(drawable.source, 0, 0, down.w, down.h);
        bigCtx.imageSmoothingEnabled = true;
        bigCtx.drawImage(small, 0, 0, down.w, down.h, 0, 0, out.w, out.h);
        blurUrl = big.toDataURL('image/jpeg', 0.72);
      }
    } catch {
      blurUrl = null;
    }
  }

  return { lum, blurUrl };
}
