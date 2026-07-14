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
}

const ThemeContext = createContext<ThemeContextType>({
  theme: 'system',
  resolved: 'light',
  setTheme: () => {},
  themeColor: '默认',
  setThemeColor: () => {},
  elementColor: '经典绿',
  setElementColor: () => {},
  reverseColor: false,
  setReverseColor: () => {},
  zoom: 100,
  setZoom: () => {},
  panelOpacity: 80,
  setPanelOpacity: () => {},
  fontFamily: '系统默认',
  setFontFamily: () => {},
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

// 主题配色定义（元素强调色）
const COLOR_PRESETS: Record<string, string> = {
  '经典绿': '#5a7f5d',
  '经典蓝': '#4a6fa5',
  '紫色':   '#7c5c9e',
  '橙色':   '#c97a3a',
};

// 元素强调色：应用到 --element-color-raw（按钮、hover、激活态等）
function applyElementColor(colorName: string) {
  const color = COLOR_PRESETS[colorName];
  if (!color) return;
  const root = document.documentElement;
  root.style.setProperty('--element-color-raw', color);
}

// 主题面板色：应用到 --theme-panel-color（导航栏、面板背景色）
// 通过 color-mix 混合白色/深色得到不同层级的背景色
function applyThemePanelColor(colorName: string) {
  const color = COLOR_PRESETS[colorName];
  if (!color) return;
  const root = document.documentElement;
  root.style.setProperty('--theme-panel-color', color);
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
    return localStorage.getItem('elementColor') || '经典绿';
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

  // UI 缩放包裹层：zoom 只作用于应用内容，不作用于 documentElement，
  // 因此挂在 documentElement/body 上的加载页 iframe、预览 overlay 不受缩放影响
  // （否则被放大后装饰层越界消失、只剩居中莲花）。App 根容器用 h-screen，不受包裹层高度影响。
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
    applyThemePanelColor(color);
  }, []);

  const setElementColor = useCallback((color: string) => {
    setElementColorState(color);
    localStorage.setItem('elementColor', color);
    applyElementColor(color);
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

  // 应用主题 + 反转配色
  useEffect(() => {
    applyThemeClass(resolved);
    document.documentElement.classList.toggle('reverse-color', reverseColor);
  }, [resolved, reverseColor]);

  // 应用元素配色
  useEffect(() => {
    applyElementColor(elementColor);
  }, [elementColor]);

  // 初始化缩放和透明度
  useEffect(() => {
    document.documentElement.style.setProperty('--panel-opacity', String(panelOpacity / 100));
    if (fontFamily !== '系统默认') {
      document.body.style.fontFamily = `"${fontFamily}", sans-serif`;
    }
    // 初始化主题面板色
    applyThemePanelColor(themeColor);
    // 初始化元素强调色
    applyElementColor(elementColor);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅 mount 时批量应用全部主题设置
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

  return (
    <ThemeContext.Provider value={{ theme, resolved, setTheme, themeColor, setThemeColor, elementColor, setElementColor, reverseColor, setReverseColor, zoom, setZoom, panelOpacity, setPanelOpacity, fontFamily, setFontFamily }}>
      <div ref={zoomRef} style={{ zoom: `${zoom}%` }}>
        {children}
      </div>
    </ThemeContext.Provider>
  );
}