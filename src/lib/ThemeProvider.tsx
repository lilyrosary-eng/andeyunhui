import { createContext, useContext, useState, useEffect, useCallback, useRef, type ReactNode, type RefObject } from 'react';
import { loadBgVideoBlob } from '@/lib/bgVideoStore';

type Theme = 'system' | 'light' | 'dark';

interface ThemeContextType {
  theme: Theme;
  resolved: 'light' | 'dark';
  setTheme: (t: Theme) => void;
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
    return (localStorage.getItem('theme') as Theme) || 'system';
  });
  const [resolved, setResolved] = useState<'light' | 'dark'>(() => resolveTheme(theme));
  const [themeColor, setThemeColorState] = useState<string>(() => {
    return localStorage.getItem('themeColor') || '默认';
  });
  const [elementColor, setElementColorState] = useState<string>(() => {
    return localStorage.getItem('elementColor') || '默认';
  });
  const [reverseColor, setReverseColorState] = useState<boolean>(() => {
    return localStorage.getItem('reverseColor') === 'true';
  });
  const [zoom, setZoomState] = useState<number>(() => {
    return Number(localStorage.getItem('zoom')) || 100;
  });
  const [panelOpacity, setPanelOpacityState] = useState<number>(() => {
    return Number(localStorage.getItem('panelOpacity')) || 80;
  });
  const [fontFamily, setFontFamilyState] = useState<string>(() => {
    return localStorage.getItem('fontFamily') || '系统默认';
  });
  const [bgImage, setBgImageState] = useState<string | null>(() => {
    try { return localStorage.getItem('appBgImage') || null; } catch { return null; }
  });
  const [bgBlur, setBgBlurState] = useState<number>(() => {
    try { return Number(localStorage.getItem('appBgBlur')) || 0; } catch { return 0; }
  });
  const [bgAngle, setBgAngleState] = useState<number>(() => {
    try { return Number(localStorage.getItem('appBgAngle')) || 0; } catch { return 0; }
  });
  const [bgFlip, setBgFlipState] = useState<boolean>(() => {
    try { return localStorage.getItem('appBgFlip') === '1'; } catch { return false; }
  });
  const [bgScrub, setBgScrubState] = useState<boolean>(() => {
    try { return localStorage.getItem('appBgScrub') === '1'; } catch { return false; }
  });
  // 视频背景：用 object URL，刷新后失效（不持久化）；与 bgImage 互斥，由调用方在切换时清理另一类型
  const [bgVideo, setBgVideoState] = useState<string | null>(null);
  // 视频背景是否跨重启保留（存 IndexedDB）：默认关，用户自行决定
  const [bgVideoPersist, setBgVideoPersistState] = useState<boolean>(() => {
    try { return localStorage.getItem('appBgVideoPersist') === '1'; } catch { return false; }
  });

  // resolved 的 ref，供 useCallback 内读取最新值而不触发依赖变化
  const resolvedRef = useRef(resolved);
  useEffect(() => { resolvedRef.current = resolved; }, [resolved]);

  // UI 缩放包裹层：zoom 只作用于应用内容，不作用于 documentElement，
  // 因此挂在 documentElement/body 上的加载页 iframe、预览 overlay 不受缩放影响
  const zoomRef = useRef<HTMLDivElement>(null);

  const setTheme = useCallback((t: Theme) => {
    setThemeState(t);
    localStorage.setItem('theme', t);
    const r = resolveTheme(t);
    setResolved(r);
    applyThemeClass(r);
  }, []);

  const setThemeColor = useCallback((color: string) => {
    setThemeColorState(color);
    localStorage.setItem('themeColor', color);
    applyThemePanelColor(color, resolvedRef.current);
  }, []);

  const setElementColor = useCallback((color: string) => {
    setElementColorState(color);
    localStorage.setItem('elementColor', color);
    applyElementColor(color, resolvedRef.current);
  }, []);

  const setReverseColor = useCallback((val: boolean) => {
    setReverseColorState(val);
    localStorage.setItem('reverseColor', String(val));
  }, []);

  const setZoom = useCallback((val: number) => {
    setZoomState(val);
    localStorage.setItem('zoom', String(val));
  }, []);

  const setPanelOpacity = useCallback((val: number) => {
    setPanelOpacityState(val);
    localStorage.setItem('panelOpacity', String(val));
    document.documentElement.style.setProperty('--panel-opacity', String(val / 100));
  }, []);

  const setFontFamily = useCallback((val: string) => {
    setFontFamilyState(val);
    localStorage.setItem('fontFamily', val);
    if (val === '系统默认') {
      document.body.style.fontFamily = '';
    } else {
      document.body.style.fontFamily = `"${val}", sans-serif`;
    }
  }, []);

  const setBgImage = useCallback((val: string | null) => {
    setBgImageState(val);
    try {
      if (val) localStorage.setItem('appBgImage', val);
      else localStorage.removeItem('appBgImage');
    } catch { /* 忽略持久化失败 */ }
  }, []);

  const setBgBlur = useCallback((val: number) => {
    setBgBlurState(val);
    try { localStorage.setItem('appBgBlur', String(val)); } catch { /* 忽略持久化失败 */ }
  }, []);

  const setBgAngle = useCallback((val: number) => {
    setBgAngleState(val);
    try { localStorage.setItem('appBgAngle', String(val)); } catch { /* 忽略持久化失败 */ }
  }, []);

  const setBgFlip = useCallback((val: boolean) => {
    setBgFlipState(val);
    try { localStorage.setItem('appBgFlip', val ? '1' : '0'); } catch { /* 忽略持久化失败 */ }
  }, []);

  const setBgScrub = useCallback((val: boolean) => {
    setBgScrubState(val);
    try { localStorage.setItem('appBgScrub', val ? '1' : '0'); } catch { /* 忽略持久化失败 */ }
  }, []);

  // 视频背景不持久化（object URL 刷新即失效）；仅维护状态，互斥清理由调用方负责。
  // 切换时若旧值是之前创建的 object URL（blob:）则回收，避免内存泄漏。
  const setBgVideo = useCallback((val: string | null) => {
    setBgVideoState((prev) => {
      if (prev && prev.startsWith('blob:') && prev !== val) URL.revokeObjectURL(prev);
      return val;
    });
  }, []);

  // 保留开关：仅持久化开关本身；真正的数据存取由调用方在选定/移除时负责
  const setBgVideoPersist = useCallback((val: boolean) => {
    setBgVideoPersistState(val);
    try { localStorage.setItem('appBgVideoPersist', val ? '1' : '0'); } catch { /* 忽略持久化失败 */ }
  }, []);

  // 启动时若开启了“保留”，从 IndexedDB 取回视频 Blob 并重建 object URL 设为背景；
  // 仅执行一次（会话刚开始 bgVideo 必为空，不会覆盖本次会话内已选的视频）。
  const restoredRef = useRef(false);
  useEffect(() => {
    if (restoredRef.current) return;
    restoredRef.current = true;
    if (!bgVideoPersist) return;
    loadBgVideoBlob()
      .then((blob) => {
        if (!blob) return;
        const url = URL.createObjectURL(blob);
        setBgVideo(url);
      })
      .catch(() => { /* 读取失败则静默不恢复，后果由用户承担 */ });
  }, [bgVideoPersist, setBgVideo]);

  // 切换自定义背景时，标记 <html> 以便 CSS 让主面板背景透明，露出背景层
  useEffect(() => {
    document.documentElement.classList.toggle('has-custom-bg', !!(bgImage || bgVideo));
  }, [bgImage, bgVideo]);

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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅 mount 时批量应用
  }, []);

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

  return (
    <ThemeContext.Provider value={{ theme, resolved, setTheme, themeColor, setThemeColor, elementColor, setElementColor, reverseColor, setReverseColor, zoom, setZoom, panelOpacity, setPanelOpacity, fontFamily, setFontFamily, bgImage, setBgImage, bgVideo, setBgVideo, bgVideoPersist, setBgVideoPersist, bgBlur, setBgBlur, bgAngle, setBgAngle, bgFlip, setBgFlip, bgScrub, setBgScrub }}>
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
            zIndex: 0,
            width: '100%',
            height: '100%',
            display: 'block',
            objectFit: 'cover',
            objectPosition: 'center',
            filter: `blur(${bgBlur}px)`,
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
            zIndex: 0,
            backgroundImage: `url("${bgImage}")`,
            backgroundSize: 'cover',
            backgroundPosition: 'center',
            backgroundRepeat: 'no-repeat',
            filter: `blur(${bgBlur}px)`,
            transform: layerTransform,
            transformOrigin: 'center center',
            pointerEvents: 'none',
          }}
        />
      )}
      <div ref={zoomRef} style={{ zoom: `${zoom}%`, position: 'relative', zIndex: 1 }}>
        {children}
      </div>
    </ThemeContext.Provider>
  );
}
