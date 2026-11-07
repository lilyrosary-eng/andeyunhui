import { createContext, useContext, useState, useEffect, useCallback, useRef, type ReactNode, type RefObject } from 'react';
import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { emit, listen } from '@tauri-apps/api/event';
import { isAndroid } from '../platform/isMobile';
import { HEAVY_FX } from '../platform/isLinux';
import { LIQUID_GLASS_REFRACTION, startLiquidGlass, stopLiquidGlass } from '../core/theme/liquidGlass';
import { sampleWallpaper, scrimPctFor, type WallpaperSample } from './wallpaperProbe';
import { storage } from '../core/storage';
import { KEYS } from '../core/storage/keys';

type Theme = 'system' | 'light' | 'dark';

interface ThemeContextType {
  theme: Theme;
  resolved: 'light' | 'dark';
  setTheme: (t: Theme) => void;
  liquidGlass: boolean;
  setLiquidGlass: (val: boolean) => void;
  themeColor: string;
  setThemeColor: (color: string) => void;
  elementColor: string;
  setElementColor: (color: string) => void;
  reverseColor: boolean;
  setReverseColor: (val: boolean) => void;
  zoom: number;
  setZoom: (val: number) => void;
  panelOpacity: number;
  setPanelOpacity: (val: number) => void;
  fontFamily: string;
  setFontFamily: (val: string) => void;
  bgImage: string | null;
  setBgImage: (val: string | null) => void;
  bgVideo: string | null;
  setBgVideo: (val: string | null) => void;
  bgVideoPersist: boolean;
  setBgVideoPersist: (val: boolean) => void;
  bgBlur: number;
  setBgBlur: (val: number) => void;
  bgAngle: number;
  setBgAngle: (val: number) => void;
  bgFlip: boolean;
  setBgFlip: (val: boolean) => void;
  bgScrub: boolean;
  setBgScrub: (val: boolean) => void;
}

const ThemeContext = createContext<ThemeContextType>({
  theme: 'system',
  resolved: 'light',
  setTheme: () => {},
  liquidGlass: false,
  setLiquidGlass: () => {},
  themeColor: '默认',
  setThemeColor: () => {},
  elementColor: '默认',
  setElementColor: () => {},
  reverseColor: false,
  setReverseColor: () => {},
  zoom: 100,
  setZoom: () => {},
  panelOpacity: 80,
  setPanelOpacity: () => {},
  fontFamily: '系统默认',
  setFontFamily: () => {},
  bgImage: null,
  setBgImage: () => {},
  bgVideo: null,
  setBgVideo: () => {},
  bgVideoPersist: false,
  setBgVideoPersist: () => {},
  bgBlur: 0,
  setBgBlur: () => {},
  bgAngle: 0,
  setBgAngle: () => {},
  bgFlip: false,
  setBgFlip: () => {},
  bgScrub: false,
  setBgScrub: () => {},
});

export function useTheme() {
  return useContext(ThemeContext);
}

function getSystemTheme(): 'light' | 'dark' {
  if (typeof window === 'undefined') return 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function resolveTheme(theme: Theme): 'light' | 'dark' {
  if (theme === 'system') return getSystemTheme();
  return theme;
}

function applyThemeClass(resolved: 'light' | 'dark') {
  document.documentElement.classList.toggle('dark', resolved === 'dark');
}

// 主题配色定义
const COLOR_PRESETS: Record<string, string> = {
  '经典绿': '#5a7f5d',
  '经典蓝': '#4a6fa5',
  '紫色':   '#7c5c9e',
  '橙色':   '#c97a3a',
};

// "默认"色名解析：浅色→经典绿，深色→紫色。
// 仅当用户选择"默认"时动态生效；选择具体色名则直接使用，不受主题切换影响。
// themeColor 和 elementColor 独立判断：其中一个为"默认"另一个为具体色时，仅"默认"那个随主题切换。
function resolveColorName(colorName: string, resolved: 'light' | 'dark'): string {
  if (colorName === '默认') {
    return resolved === 'dark' ? '紫色' : '经典绿';
  }
  return colorName;
}

// 元素强调色：应用到 --element-color-raw（按钮、hover、激活态等）
function applyElementColor(colorName: string, resolved: 'light' | 'dark') {
  const resolvedName = resolveColorName(colorName, resolved);
  const color = COLOR_PRESETS[resolvedName];
  if (!color) return;
  document.documentElement.style.setProperty('--element-color-raw', color);
}

// 主题面板色：应用到 --theme-panel-color（导航栏、面板背景色）
function applyThemePanelColor(colorName: string, resolved: 'light' | 'dark') {
  const resolvedName = resolveColorName(colorName, resolved);
  const color = COLOR_PRESETS[resolvedName];
  if (!color) return;
  document.documentElement.style.setProperty('--theme-panel-color', color);
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(() => {
    return (storage.getString(KEYS.theme.theme.key, '') as Theme) || 'system';
  });
  const [resolved, setResolved] = useState<'light' | 'dark'>(() => resolveTheme(theme));
  const [themeColor, setThemeColorState] = useState<string>(() => {
    return storage.getString(KEYS.theme.themeColor.key, '') || '默认';
  });
  const [elementColor, setElementColorState] = useState<string>(() => {
    return storage.getString(KEYS.theme.elementColor.key, '') || '默认';
  });
  const [reverseColor, setReverseColorState] = useState<boolean>(() => {
    return storage.getString(KEYS.theme.reverseColor.key, '') === 'true';
  });
  const [liquidGlass, setLiquidGlassState] = useState<boolean>(() => {
    return storage.getString(KEYS.theme.liquidGlass.key, '') === '1';
  });
  const [zoom, setZoomState] = useState<number>(() => {
    return Number(storage.getString(KEYS.theme.zoom.key, '')) || 100;
  });
  const [panelOpacity, setPanelOpacityState] = useState<number>(() => {
    return Number(storage.getString(KEYS.theme.panelOpacity.key, '')) || 80;
  });
  const [fontFamily, setFontFamilyState] = useState<string>(() => {
    return storage.getString(KEYS.theme.fontFamily.key, '') || '系统默认';
  });
  // appBgImage 现在存的是**文件路径**（Rust 命令 save_wallpaper 落盘）；旧版本存的是 data URL。
  // data URL 可以直接当 src 用（挂载时顺手迁成文件，配额立刻回血）；路径要异步读回来。
  const [bgImage, setBgImageState] = useState<string | null>(() => {
    const v = storage.getString(KEYS.theme.appBgImage.key, '');
    return v.startsWith('data:') ? v : null;
  });
  const [bgBlur, setBgBlurState] = useState<number>(() => {
    return Number(storage.getString(KEYS.theme.appBgBlur.key, '')) || 0;
  });
  const [bgAngle, setBgAngleState] = useState<number>(() => {
    return Number(storage.getString(KEYS.theme.appBgAngle.key, '')) || 0;
  });
  const [bgFlip, setBgFlipState] = useState<boolean>(() => {
    return storage.getString(KEYS.theme.appBgFlip.key, '') === '1';
  });
  const [bgScrub, setBgScrubState] = useState<boolean>(() => {
    return storage.getString(KEYS.theme.appBgScrub.key, '') === '1';
  });
  // 视频背景：用 object URL，刷新后失效（不持久化）；与 bgImage 互斥，由调用方在切换时清理另一类型
  const [bgVideo, setBgVideoState] = useState<string | null>(null);
  // 视频背景是否跨重启保留（存 IndexedDB）：默认关，用户自行决定
  const [bgVideoPersist, setBgVideoPersistState] = useState<boolean>(() => {
    return storage.getString(KEYS.theme.appBgVideoPersist.key, '') === '1';
  });
  // 壁纸取样结果（见 lib/wallpaperProbe）：lum 决定交互叠色的墨向，
  // blurUrl 是被全局关掉 backdrop-filter 的引擎（Linux）替代运行时模糊用的预糊图。
  const [wallpaperFx, setWallpaperFx] = useState<WallpaperSample>({ lum: null, blurUrl: null });

  // resolved 的 ref，供 useCallback 内读取最新值而不触发依赖变化
  const resolvedRef = useRef(resolved);
  useEffect(() => { resolvedRef.current = resolved; }, [resolved]);

  // UI 缩放包裹层：zoom 只作用于应用内容，不作用于 documentElement，
  // 因此挂在 documentElement/body 上的加载页 iframe、预览 overlay 不受缩放影响
  const zoomRef = useRef<HTMLDivElement>(null);

  const setTheme = useCallback((t: Theme) => {
    setThemeState(t);
    storage.setString(KEYS.theme.theme.key, t);
    const r = resolveTheme(t);
    setResolved(r);
    applyThemeClass(r);
  }, []);

  const setThemeColor = useCallback((color: string) => {
    setThemeColorState(color);
    storage.setString(KEYS.theme.themeColor.key, color);
    applyThemePanelColor(color, resolvedRef.current);
  }, []);

  const setElementColor = useCallback((color: string) => {
    setElementColorState(color);
    storage.setString(KEYS.theme.elementColor.key, color);
    applyElementColor(color, resolvedRef.current);
  }, []);

  const setReverseColor = useCallback((val: boolean) => {
    setReverseColorState(val);
    storage.setString(KEYS.theme.reverseColor.key, String(val));
  }, []);

  const setLiquidGlass = useCallback((val: boolean) => {
    setLiquidGlassState(val);
    storage.setString(KEYS.theme.liquidGlass.key, val ? '1' : '0');
  }, []);

  // 液态玻璃：CSS 光照层始终生效；折射层（SVG 位移图 backdrop-filter）只在 Chromium 内核启动，
  // WebKitGTK 无 backdrop-filter 引用能力且历史上会打爆显存（见 platform/isLinux.ts）。
  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle('liquid-glass', liquidGlass);
    if (liquidGlass && LIQUID_GLASS_REFRACTION) startLiquidGlass();
    else stopLiquidGlass();
    return () => stopLiquidGlass();
  }, [liquidGlass]);

  const setZoom = useCallback((val: number) => {
    setZoomState(val);
    storage.setString(KEYS.theme.zoom.key, String(val));
  }, []);

  const setPanelOpacity = useCallback((val: number) => {
    setPanelOpacityState(val);
    storage.setString(KEYS.theme.panelOpacity.key, String(val));
    document.documentElement.style.setProperty('--panel-opacity', String(val / 100));
  }, []);

  const setFontFamily = useCallback((val: string) => {
    setFontFamilyState(val);
    storage.setString(KEYS.theme.fontFamily.key, val);
    if (val === '系统默认') {
      document.body.style.fontFamily = '';
    } else {
      document.body.style.fontFamily = `"${val}", sans-serif`;
    }
    // 广播给独立浮窗（笔记浮窗 / 歌词窗等）——其 localStorage 可能与主窗口隔离，
    // 靠事件同步才能让「应用内字体设置」对浮窗同样生效。
    try { emit('app-font-changed', { fontFamily: val }).catch(() => {}); } catch { /* ignore */ }
  }, []);

  const setBgImage = useCallback((val: string | null) => {
    setBgImageState(val);
    if (!val) {
      storage.remove(KEYS.theme.appBgImage.key);
      return;
    }
    // 只往 localStorage 写路径：data URL 挤的是和会话/记忆共用的那份配额，实测 235KB
    // 就能抛 QuotaExceededError，而且失败时提示的还是「对话记录可能丢了」。
    // 落盘失败 → 本次仍可用、重启不保留，只在日志留痕，不再误报丢会话。
    if (!val.startsWith('data:')) {
      storage.setString(KEYS.theme.appBgImage.key, val);
      return;
    }
    invoke<string>('save_wallpaper', { dataUrl: val })
      .then((p) => storage.setString(KEYS.theme.appBgImage.key, p))
      .catch((err) => console.error('[theme] 壁纸落盘失败（本次仍可用，重启后不保留）:', err));
  }, []);

  // 启动时恢复壁纸：路径 → 读回 data URL 供背景层与亮度取样使用；
  // 读到旧的 data URL 直接迁成文件。
  const bgRestoredRef = useRef(false);
  useEffect(() => {
    if (bgRestoredRef.current) return;
    bgRestoredRef.current = true;
    const raw = storage.getString(KEYS.theme.appBgImage.key, '');
    if (!raw) return;
    if (raw.startsWith('data:')) {
      setBgImage(raw);
      return;
    }
    void invoke<string>('read_file_base64', { filePath: raw })
      .then((url) => {
        if (url) setBgImageState(url);
      })
      .catch((err) => console.error('[theme] 壁纸文件读取失败:', err));
  }, [setBgImage]);

  const setBgBlur = useCallback((val: number) => {
    setBgBlurState(val);
    storage.setString(KEYS.theme.appBgBlur.key, String(val));
  }, []);

  const setBgAngle = useCallback((val: number) => {
    setBgAngleState(val);
    storage.setString(KEYS.theme.appBgAngle.key, String(val));
  }, []);

  const setBgFlip = useCallback((val: boolean) => {
    setBgFlipState(val);
    storage.setString(KEYS.theme.appBgFlip.key, val ? '1' : '0');
  }, []);

  const setBgScrub = useCallback((val: boolean) => {
    setBgScrubState(val);
    storage.setString(KEYS.theme.appBgScrub.key, val ? '1' : '0');
  }, []);

  // 视频背景不持久化（object URL 刷新即失效）；仅维护状态，互斥清理由调用方负责。
  // 切换时若旧值是之前创建的 object URL（blob:）则回收，避免内存泄漏。
  const setBgVideo = useCallback((val: string | null) => {
    setBgVideoState((prev) => {
      if (prev && prev.startsWith('blob:') && prev !== val) URL.revokeObjectURL(prev);
      return val;
    });
  }, []);

  // 保留开关：持久化开关本身；关闭时一并清除已保存的视频路径
  const setBgVideoPersist = useCallback((val: boolean) => {
    setBgVideoPersistState(val);
    if (val) {
      storage.setString(KEYS.theme.appBgVideoPersist.key, '1');
    } else {
      storage.setString(KEYS.theme.appBgVideoPersist.key, '0');
      storage.remove(KEYS.theme.appBgVideoPath.key);
    }
  }, []);

  // 启动时若开启了“保留”，读取上次选择的视频文件路径，经 asset 协议重建为可用 URL。
  // 走文件路径（而非 IndexedDB 存 Blob）：dev/生产表现一致、无体积上限、恢复更稳。
  const restoredRef = useRef(false);
  useEffect(() => {
    if (restoredRef.current) return;
    restoredRef.current = true;
    if (!bgVideoPersist) return;
    const p = storage.getString(KEYS.theme.appBgVideoPath.key, '');
    if (p) setBgVideo(convertFileSrc(p));
  }, [bgVideoPersist, setBgVideo]);

  // 切换自定义背景时，标记 <html> 以便 CSS 把表面涂层降档（见 index.css 的分层令牌）
  useEffect(() => {
    document.documentElement.classList.toggle('has-custom-bg', !!(bgImage || bgVideo));
  }, [bgImage, bgVideo]);

  // 唯一旋钮 --scrim-pct：纯色态 100%（分层不改变任何像素），壁纸态用固定衬底强度。
  // 刻意不跟 panelOpacity 联动：那个滑杆管的是 glass 面板，接到壁纸衬底上会变成 80% 的
  // 奶白幕（2026-11-01 用户实测否决）。要出「壁纸衬底」独立滑杆时再接。
  useEffect(() => {
    document.documentElement.style.setProperty('--scrim-pct', scrimPctFor(!!(bgImage || bgVideo)));
  }, [bgImage, bgVideo]);

  // 壁纸取样：只在背景源/模糊度变化时跑一次（逐帧取样在本项目有过的内存事故）
  useEffect(() => {
    const src = bgImage || bgVideo;
    if (!src) {
      setWallpaperFx({ lum: null, blurUrl: null });
      return;
    }
    // 预糊图只在「引擎跑不动 backdrop-filter + 背景是图片 + 用户要模糊」时才生成：
    // Windows/macOS 走 filter: blur 效果更好，不必多花一次画布成本。
    const wantBlur = !HEAVY_FX && !bgVideo && bgBlur > 0;
    let alive = true;
    sampleWallpaper(src, bgVideo ? 'video' : 'image', { blurPx: bgBlur, wantBlur }).then((fx) => {
      if (alive) setWallpaperFx(fx);
    });
    return () => {
      alive = false;
    };
  }, [bgImage, bgVideo, bgBlur]);

  // 把取样结果写成 CSS 变量。无背景时必须 remove：内联变量比 .dark 类规则优先级高，
  // 留着会让纯色态继续吃上一张图的亮度，主题切换就失效了。
  useEffect(() => {
    const root = document.documentElement;
    const hasWallpaper = !!(bgImage || bgVideo);
    if (!hasWallpaper || wallpaperFx.lum === null) {
      root.style.removeProperty('--surface-lum');
      return;
    }
    root.style.setProperty('--surface-lum', String(wallpaperFx.lum));
  }, [bgImage, bgVideo, wallpaperFx]);

  // 背景层 DOM 引用 + 是否“超高图”（高度比大于视口，cover 下纵向溢出被截断）
  const bgLayerRef = useRef<HTMLElement | null>(null);
  const [isTallBg, setIsTallBg] = useState(false);
  useEffect(() => {
    if (bgVideo) {
      const v = document.createElement('video');
      v.preload = 'metadata';
      v.onloadedmetadata = () => {
        if (!v.videoWidth || !v.videoHeight) return;
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        setIsTallBg(v.videoHeight / v.videoWidth > vh / vw);
      };
      v.src = bgVideo;
      return () => { v.onloadedmetadata = null; };
    }
    if (bgImage) {
      const img = new Image();
      img.onload = () => {
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        setIsTallBg(img.naturalHeight / img.naturalWidth > vh / vw);
      };
      img.src = bgImage;
      return;
    }
    setIsTallBg(false);
  }, [bgImage, bgVideo]);

  // 光标纵向平移（壁纸式）：仅当开启且为超高图时，按光标 Y 映射到纵向位置，
  // 用 rAF 限频直接写 DOM，避免触发整棵应用重渲染。背景层 pointerEvents:none，故监听挂在 window。
  // 图片用 background-position，视频用 object-position。
  useEffect(() => {
    const layer = bgLayerRef.current;
    const isVideo = !!bgVideo;
    if (!bgScrub || !isTallBg) {
      if (layer) {
        if (isVideo) layer.style.objectPosition = 'center';
        else layer.style.backgroundPosition = 'center';
      }
      return;
    }
    let raf = 0;
    const onMove = (e: MouseEvent) => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const y = Math.min(1, Math.max(0, e.clientY / window.innerHeight));
        const el = bgLayerRef.current;
        if (el) {
          if (isVideo) el.style.objectPosition = `50% ${y * 100}%`;
          else {
            el.style.backgroundPositionX = '50%';
            el.style.backgroundPositionY = `${y * 100}%`;
          }
        }
      });
    };
    window.addEventListener('mousemove', onMove);
    return () => {
      window.removeEventListener('mousemove', onMove);
      if (raf) cancelAnimationFrame(raf);
      const el = bgLayerRef.current;
      if (el) {
        if (isVideo) el.style.objectPosition = 'center';
        else el.style.backgroundPosition = 'center';
      }
    };
  }, [bgScrub, isTallBg, bgVideo]);

  // 应用主题类 + 反转配色 + 重新应用配色（"默认"会随 resolved 动态切换）
  useEffect(() => {
    applyThemeClass(resolved);
    document.documentElement.classList.toggle('reverse-color', reverseColor);
    applyThemePanelColor(themeColor, resolved);
    applyElementColor(elementColor, resolved);
  }, [resolved, reverseColor, themeColor, elementColor]);

  // 初始化缩放和透明度
  useEffect(() => {
    document.documentElement.style.setProperty('--panel-opacity', String(panelOpacity / 100));
    if (fontFamily !== '系统默认') {
      document.body.style.fontFamily = `"${fontFamily}", sans-serif`;
    }
    // mount 时也广播一次当前字体：让已打开的独立浮窗（笔记/歌词）拿不到隔离 localStorage
    // 时，仍能同步到「应用内统一设置」的字体。
    try { emit('app-font-changed', { fontFamily }).catch(() => {}); } catch { /* ignore */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅 mount 时批量应用
  }, []);

  // 监听浮窗的字体请求（浮窗 localStorage 可能与主窗隔离、URL 参数仅覆盖新建窗）：
  // 收到 app-font-request 就把当前生效字体广播回去，保证任何时刻打开的浮窗都能同步。
  useEffect(() => {
    let un: (() => void) | undefined;
    listen('app-font-request', () => {
      try { emit('app-font-changed', { fontFamily }).catch(() => {}); } catch { /* ignore */ }
    }).then((u) => { un = u; }).catch(() => {});
    return () => { un?.(); };
  }, [fontFamily]);

  // 监听系统主题变化
  useEffect(() => {
    if (theme !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = (e: MediaQueryListEvent) => {
      const r: 'light' | 'dark' = e.matches ? 'dark' : 'light';
      setResolved(r);
      applyThemeClass(r);
    };
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [theme]);

  // 旋转/翻转通过 CSS transform 应用在背景层上，避免导出后四角透出底色；
  // 同时按角度自适应放大，保证 cover 时仍铺满窗口。
  const angleRad = (Math.abs(bgAngle) * Math.PI) / 180;
  const coverScale = 1 / Math.max(Math.cos(angleRad), Math.SQRT1_2);
  const layerScale = Math.max(1.08, coverScale);
  const layerTransform = `rotate(${bgAngle}deg) scaleX(${bgFlip ? -1 : 1}) scale(${layerScale})`;
  // 跑不动重特效的引擎（Linux WebKitGTK）用预糊图替代 filter: blur ——
  // 之前 bgBlur 滑杆在这些平台上是静默失效的（HEAVY_FX=false 直接把 filter 关掉）。
  const wallpaperSrc = !HEAVY_FX && wallpaperFx.blurUrl ? wallpaperFx.blurUrl : bgImage;

  return (
    <ThemeContext.Provider value={{ theme, resolved, setTheme, liquidGlass, setLiquidGlass, themeColor, setThemeColor, elementColor, setElementColor, reverseColor, setReverseColor, zoom, setZoom, panelOpacity, setPanelOpacity, fontFamily, setFontFamily, bgImage, setBgImage, bgVideo, setBgVideo, bgVideoPersist, setBgVideoPersist, bgBlur, setBgBlur, bgAngle, setBgAngle, bgFlip, setBgFlip, bgScrub, setBgScrub }}>
      {bgVideo ? (
        <video
          ref={bgLayerRef as RefObject<HTMLVideoElement>}
          aria-hidden
          src={bgVideo}
          autoPlay
          muted
          loop
          playsInline
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 'var(--layer-wallpaper, 0)',
            width: '100%',
            height: '100%',
            display: 'block',
            objectFit: 'cover',
            objectPosition: 'center',
            filter: HEAVY_FX ? `blur(${bgBlur}px)` : 'none',
            transform: layerTransform,
            transformOrigin: 'center center',
            pointerEvents: 'none',
          }}
        />
      ) : bgImage && (
        <div
          ref={bgLayerRef as RefObject<HTMLDivElement>}
          aria-hidden
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 'var(--layer-wallpaper, 0)',
            backgroundImage: `url("${wallpaperSrc}")`,
            backgroundSize: 'cover',
            backgroundPosition: 'center',
            backgroundRepeat: 'no-repeat',
            filter: HEAVY_FX ? `blur(${bgBlur}px)` : 'none',
            transform: layerTransform,
            transformOrigin: 'center center',
            pointerEvents: 'none',
          }}
        />
      )}
      {/* 平台隔离（Android v1）：移动端禁用 zoom 包裹层。
          CSS zoom 在 Android WebView 中会破坏 vh/vw 与媒体查询断点的对应关系（§5.4.3 D7）。
          桌面端行为逐字节不变——isAndroid() 在桌面恒为 false，走原 style 对象。 */}
      <div
        ref={zoomRef}
        style={
          isAndroid()
            ? { position: 'relative', zIndex: 'var(--layer-content, 1)' }
            : { zoom: `${zoom}%`, position: 'relative', zIndex: 'var(--layer-content, 1)' }
        }
      >
        {children}
      </div>
    </ThemeContext.Provider>
  );
}
