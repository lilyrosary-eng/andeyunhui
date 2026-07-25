import { createContext, useContext, useState, useEffect, useCallback, useRef, type ReactNode } from 'react';

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
  bgBlur: number;
  setBgBlur: (val: number) => void;
  bgAngle: number;
  setBgAngle: (val: number) => void;
  bgFlip: boolean;
  setBgFlip: (val: boolean) => void;
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
  bgBlur: 0,
  setBgBlur: () => {},
  bgAngle: 0,
  setBgAngle: () => {},
  bgFlip: false,
  setBgFlip: () => {},
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

  // 切换自定义背景时，标记 <html> 以便 CSS 让主面板背景透明，露出背景层
  useEffect(() => {
    document.documentElement.classList.toggle('has-custom-bg', !!bgImage);
  }, [bgImage]);

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
    <ThemeContext.Provider value={{ theme, resolved, setTheme, themeColor, setThemeColor, elementColor, setElementColor, reverseColor, setReverseColor, zoom, setZoom, panelOpacity, setPanelOpacity, fontFamily, setFontFamily, bgImage, setBgImage, bgBlur, setBgBlur, bgAngle, setBgAngle, bgFlip, setBgFlip }}>
      {bgImage && (
        <div
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
